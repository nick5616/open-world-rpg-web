package social

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

// historyLen is how many messages each stored channel keeps (spec 10 table).
// Local keeps none: it is proximity talk, and a newcomer reading what was
// said nearby before they arrived would be eavesdropping.
func historyLen(ch sp.Channel) int64 {
	switch ch {
	case sp.ChannelGlobal:
		return constants.HistoryGlobal
	case sp.ChannelZone:
		return constants.HistoryZone
	case sp.ChannelParty:
		return constants.HistoryParty
	case sp.ChannelWhisper:
		return constants.HistoryWhisper
	case sp.ChannelSystem:
		return constants.HistorySystem
	}
	return 0
}

func newMsgID() string { return fmt.Sprintf("%x-%s", nowMs(), randHex(4)) }

// cleanText trims, rejects empty and enforces CHAT_MAX_LEN in characters
// (runes, not bytes: the limit is what the player sees).
func cleanText(text string) (string, sp.ErrorCode) {
	text = strings.TrimSpace(strings.ToValidUTF8(text, ""))
	if text == "" {
		return "", sp.ErrorCodeNotAllowed
	}
	if utf8.RuneCountInString(text) > constants.ChatMaxLen {
		return "", sp.ErrorCodeTooLong
	}
	// Control characters would let a message fake line breaks or system text.
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, text)
	return text, ""
}

// appendCapped is the-circle's append_chat (backend/rooms/room_state.py):
// RPUSH then LTRIM to the newest n, in one MULTI.
func appendCapped(ctx context.Context, pipe redis.Pipeliner, key string, m *sp.ChatMessage, n int64) {
	b, _ := json.Marshal(m)
	pipe.RPush(ctx, key, b)
	pipe.LTrim(ctx, key, -n, -1)
}

func (s *Session) chatSend(ctx context.Context, now time.Time, ch sp.Channel, raw string) {
	if ch == sp.ChannelWhisper {
		s.sendErr(sp.ErrorCodeNotAllowed, "Use /w Name message to whisper.")
		return
	}
	if ch == sp.ChannelSystem {
		s.sendErr(sp.ErrorCodeNotAllowed, "Players cannot post to the system channel.")
		return
	}
	text, code := cleanText(raw)
	if code == sp.ErrorCodeTooLong {
		s.reject(code, fmt.Sprintf("Messages are limited to %d characters.", constants.ChatMaxLen))
		return
	}
	if code != "" {
		return // empty: nothing to say, nothing to answer
	}
	s.mu.Lock()
	modMuted, region, x, z, hasPos, pid := s.modMuted, s.region, s.x, s.z, s.hasPos, s.partyID
	s.mu.Unlock()
	if modMuted {
		s.reject(sp.ErrorCodeMuted, "You are muted by a moderator.")
		return
	}
	// Spec 10/11: local profiles can't use global chat (they still read it).
	if ch == sp.ChannelGlobal && s.local {
		s.reject(sp.ErrorCodeNotAllowed, "Global chat needs an account. Local profiles can use local and party chat.")
		return
	}
	bucket, limitCode := s.lim.chat(ch)
	if bucket == nil {
		return
	}
	scope := ""
	switch ch {
	case sp.ChannelZone:
		if region == "" {
			s.reject(sp.ErrorCodeNotAllowed, "Zone chat is available once you are in the world.")
			return
		}
		scope = region
	case sp.ChannelParty:
		// Redis is the truth for membership; the cached id may lag a frame.
		if p, err := s.hub.loadParty(ctx, s.charID); err == nil && p != nil {
			pid = p.ID
		} else {
			pid = ""
		}
		if pid == "" {
			s.reject(sp.ErrorCodeNotAllowed, "You are not in a party.")
			return
		}
		scope = pid
	}
	// Bucket last: a message refused for another reason costs no token.
	if !bucket.Take(now) {
		msg := "You are sending messages too quickly."
		if limitCode == sp.ErrorCodeSlowMode {
			msg = fmt.Sprintf("Global chat is in slow mode: one message every %d seconds.", constants.GlobalSlowModeMs/1000)
		}
		s.limited(now, limitCode, msg)
		return
	}

	m := &sp.ChatMessage{ID: newMsgID(), Channel: ch, FromID: s.charID, FromName: s.name, Text: text, Ts: float64(nowMs())}
	e := &envelope{Kind: kindChat, World: s.worldID, Msg: m}
	switch ch {
	case sp.ChannelLocal:
		if !hasPos {
			// No position yet: only you would hear it. Deliver the echo so the
			// UI is consistent, without pretending anyone else did.
			e.Targets = []string{s.charID}
		}
		m.X, m.Z = x, z
	case sp.ChannelZone:
		e.Region = region
	case sp.ChannelParty:
		p, _ := s.hub.loadPartyByID(ctx, pid)
		if p == nil {
			s.reject(sp.ErrorCodeNotAllowed, "You are not in a party.")
			return
		}
		e.Targets = p.memberIDs()
	}
	if n := historyLen(ch); n > 0 {
		pipe := s.hub.rdb.TxPipeline()
		key := keyChat(s.worldID, ch, scope)
		appendCapped(ctx, pipe, key, m, n)
		if ch == sp.ChannelParty {
			// Outlives a short disband/re-form, but not forever.
			pipe.Expire(ctx, key, 24*time.Hour)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			s.sendErr(sp.ErrorCodeInternal, "Message not sent; try again.")
			return
		}
	}
	s.hub.metrics.Add(`social_chat_accepted_total{channel="`+string(ch)+`"}`, 1)
	s.hub.publish(ctx, e)
}

// reject sends an error for a refused message and counts it.
func (s *Session) reject(code sp.ErrorCode, msg string) {
	s.hub.metrics.Add(`social_chat_rejected_total{reason="`+string(code)+`"}`, 1)
	s.sendErr(code, msg)
}

// readHistory returns a stored channel oldest first, dropping whispers older
// than HISTORY_WHISPER_TTL_S (the list key's TTL is refreshed by every new
// message, so an active conversation would otherwise keep old lines).
func (h *Hub) readHistory(ctx context.Context, key string, n int64) []sp.ChatMessage {
	raw, err := h.rdb.LRange(ctx, key, -n, -1).Result()
	if err != nil {
		return nil
	}
	cutoff := float64(nowMs() - constants.HistoryWhisperTtlS*1000)
	out := make([]sp.ChatMessage, 0, len(raw))
	for _, r := range raw {
		var m sp.ChatMessage
		if json.Unmarshal([]byte(r), &m) != nil {
			continue
		}
		if m.Channel == sp.ChannelWhisper && m.Ts < cutoff {
			continue
		}
		out = append(out, m)
	}
	return out
}

// sendHistory sends one channel's history through this reader's filters.
func (s *Session) sendHistory(ctx context.Context, ch sp.Channel, conversation, key string, n int64) []sp.ChatMessage {
	msgs := s.hub.readHistory(ctx, key, n)
	visible := make([]sp.ChatMessage, 0, len(msgs))
	for _, m := range msgs {
		text, ok := s.visibleText(&m)
		if !ok {
			continue
		}
		m.Text = text
		visible = append(visible, m)
	}
	s.send(sp.S2CHistory{Type: sp.S2CTypeHistory, Channel: ch, Conversation: conversation, Messages: visible})
	return msgs
}

// sendJoinHistory sends everything a fresh session should see: global,
// system, and the last 24 h of whisper conversations. Zone history follows
// the first presence frame (region unknown until then); party history
// follows rejoinParty.
func (s *Session) sendJoinHistory(ctx context.Context) {
	s.sendHistory(ctx, sp.ChannelGlobal, "", keyChat(s.worldID, sp.ChannelGlobal, ""), constants.HistoryGlobal)
	s.sendHistory(ctx, sp.ChannelSystem, "", keyChat(s.worldID, sp.ChannelSystem, s.charID), constants.HistorySystem)

	cutoff := nowMs() - constants.HistoryWhisperTtlS*1000
	convKey := keyWhisperConv(s.worldID, s.charID)
	s.hub.rdb.ZRemRangeByScore(ctx, convKey, "-inf", fmt.Sprint(cutoff))
	partners, err := s.hub.rdb.ZRangeByScore(ctx, convKey, &redis.ZRangeBy{Min: fmt.Sprint(cutoff), Max: "+inf"}).Result()
	if err != nil {
		return
	}
	var lastIn sp.ChatMessage
	for _, pid := range partners {
		msgs := s.hub.readHistory(ctx, keyChat(s.worldID, sp.ChannelWhisper, convScope(s.charID, pid)), constants.HistoryWhisper)
		if len(msgs) == 0 {
			continue
		}
		// The conversation is named after the partner, as the client tabs are.
		partner := ""
		for _, m := range msgs {
			if m.FromID == pid {
				partner = m.FromName
			} else if m.ToName != "" {
				partner = m.ToName
			}
			if m.FromID != s.charID && m.Ts > lastIn.Ts {
				lastIn = m
			}
		}
		s.sendHistory(ctx, sp.ChannelWhisper, partner, keyChat(s.worldID, sp.ChannelWhisper, convScope(s.charID, pid)), constants.HistoryWhisper)
	}
	if lastIn.FromName != "" {
		s.mu.Lock()
		if s.lastWhisperFrom == "" {
			s.lastWhisperFrom = lastIn.FromName
		}
		s.mu.Unlock()
	}
}

// SystemMessage stores a system line for a character and delivers it if
// they are online anywhere. Zones and other services can publish the same
// envelope to social:{worldId} (see README "Bus") for loot and discoveries.
func (h *Hub) SystemMessage(ctx context.Context, worldID, charID, text string) {
	m := &sp.ChatMessage{ID: newMsgID(), Channel: sp.ChannelSystem, FromID: "", FromName: "", Text: text, Ts: float64(nowMs())}
	pipe := h.rdb.TxPipeline()
	key := keyChat(worldID, sp.ChannelSystem, charID)
	appendCapped(ctx, pipe, key, m, constants.HistorySystem)
	pipe.Expire(ctx, key, 7*24*time.Hour)
	_, _ = pipe.Exec(ctx)
	h.publish(ctx, &envelope{Kind: kindChat, World: worldID, Msg: m, Targets: []string{charID}})
}
