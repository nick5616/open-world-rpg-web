package social

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

// resolveName finds a character by name in this world: Redis name records
// first (every character that ever connected has one), then Postgres for
// characters that never have. Returns the canonical display name.
func (h *Hub) resolveName(ctx context.Context, worldID, name string) (id, display string, ok bool) {
	name = trimTo(name, 32)
	if lower(name) == "" {
		return "", "", false
	}
	if id, err := h.rdb.Get(ctx, keyName(worldID, name)).Result(); err == nil && id != "" {
		if d, err := h.rdb.Get(ctx, keyCharName(id)).Result(); err == nil && d != "" {
			return id, d, true
		}
		return id, name, true
	}
	id, display, ok, err := h.store.LookupName(ctx, worldID, name)
	if err != nil || !ok {
		return "", "", false
	}
	pipe := h.rdb.Pipeline()
	pipe.Set(ctx, keyName(worldID, display), id, 0)
	pipe.Set(ctx, keyCharName(id), display, 0)
	_, _ = pipe.Exec(ctx)
	return id, display, true
}

// namesOf maps ids to display names: Redis charname records, then Postgres.
func (h *Hub) namesOf(ctx context.Context, worldID string, ids []string) map[string]string {
	out := map[string]string{}
	if len(ids) == 0 {
		return out
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = keyCharName(id)
	}
	var missing []string
	if vals, err := h.rdb.MGet(ctx, keys...).Result(); err == nil {
		for i, v := range vals {
			if s, ok := v.(string); ok && s != "" {
				out[ids[i]] = s
			} else {
				missing = append(missing, ids[i])
			}
		}
	} else {
		missing = ids
	}
	if len(missing) > 0 {
		if m, err := h.store.NamesByIDs(ctx, missing); err == nil {
			for id, n := range m {
				out[id] = n
				h.rdb.Set(ctx, keyCharName(id), n, 0)
			}
		}
	}
	return out
}

func (s *Session) whisperStatus(to string, st sp.WhisperStatus) {
	s.send(sp.S2CWhisperStatus{Type: sp.S2CTypeWhisperStatus, To: to, Status: st})
}

// whisper implements spec 10 "Whispers in detail".
func (s *Session) whisper(ctx context.Context, now time.Time, to, raw string) {
	text, code := cleanText(raw)
	if code == sp.ErrorCodeTooLong {
		s.reject(code, fmt.Sprintf("Messages are limited to %d characters.", constants.ChatMaxLen))
		return
	}
	if code != "" {
		return
	}
	s.mu.Lock()
	modMuted := s.modMuted
	s.mu.Unlock()
	if modMuted {
		s.reject(sp.ErrorCodeMuted, "You are muted by a moderator.")
		return
	}
	targetID, targetName, ok := s.hub.resolveName(ctx, s.worldID, to)
	if !ok {
		s.reject(sp.ErrorCodeUnknownTarget, fmt.Sprintf("There is no one called %s.", trimTo(to, 32)))
		return
	}
	if targetID == s.charID {
		s.reject(sp.ErrorCodeNotAllowed, "You can't whisper yourself.")
		return
	}
	s.mu.Lock()
	iBlocked := s.blocked[targetID] != ""
	isFriend := s.friends[targetID]
	inParty := s.partyMembers[targetID]
	s.mu.Unlock()
	if iBlocked {
		s.whisperStatus(targetName, sp.WhisperStatusNotAllowed)
		s.system(fmt.Sprintf("You have blocked %s. Unblock them to whisper.", targetName))
		return
	}
	// Spec 10: local-profile players can whisper only party members and friends.
	if s.local && !isFriend && !inParty {
		if p, _ := s.hub.loadParty(ctx, s.charID); p == nil || !p.has(targetID) {
			s.whisperStatus(targetName, sp.WhisperStatusNotAllowed)
			s.system("Local profiles can whisper only friends and party members.")
			return
		}
	}
	if !s.lim.whisper.Take(now) {
		s.limited(now, sp.ErrorCodeRateLimited, "You are sending messages too quickly.")
		return
	}
	// Offline: say so, store nothing (offline mail is out of scope for v1).
	if n, _ := s.hub.rdb.Exists(ctx, keyPresence(targetID)).Result(); n == 0 {
		s.hub.metrics.Add(`social_whispers_total{status="offline"}`, 1)
		s.whisperStatus(targetName, sp.WhisperStatusOffline)
		return
	}
	m := &sp.ChatMessage{ID: newMsgID(), Channel: sp.ChannelWhisper, FromID: s.charID, FromName: s.name, ToName: targetName,
		Text: text, Ts: float64(nowMs())}
	// Blocked by the target: the sender sees exactly what a delivered whisper
	// looks like (their own echo plus "delivered") and nothing else happens.
	// Telling them would let anyone probe who blocked them. Not stored, so an
	// unblock later never surfaces it.
	if blocked, err := s.hub.store.IsBlocked(ctx, targetID, s.charID); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "Whisper not sent; try again.")
		return
	} else if blocked {
		s.hub.metrics.Add(`social_whispers_total{status="dropped_blocked"}`, 1)
		s.hub.publish(ctx, &envelope{Kind: kindChat, World: s.worldID, Msg: m, Targets: []string{s.charID}})
		s.whisperStatus(targetName, sp.WhisperStatusDelivered)
		return
	}

	ttl := time.Duration(constants.HistoryWhisperTtlS) * time.Second
	key := keyChat(s.worldID, sp.ChannelWhisper, convScope(s.charID, targetID))
	pipe := s.hub.rdb.TxPipeline()
	appendCapped(ctx, pipe, key, m, constants.HistoryWhisper)
	pipe.Expire(ctx, key, ttl)
	for _, pair := range [][2]string{{s.charID, targetID}, {targetID, s.charID}} {
		ck := keyWhisperConv(s.worldID, pair[0])
		pipe.ZAdd(ctx, ck, redis.Z{Score: m.Ts, Member: pair[1]})
		pipe.Expire(ctx, ck, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		s.sendErr(sp.ErrorCodeInternal, "Whisper not sent; try again.")
		return
	}
	s.hub.metrics.Add(`social_whispers_total{status="delivered"}`, 1)
	s.hub.metrics.Add(`social_chat_accepted_total{channel="whisper"}`, 1)
	// Both ends get the same message: the recipient's copy reads "from",
	// the sender's echo reads "to" (toName).
	s.hub.publish(ctx, &envelope{Kind: kindChat, World: s.worldID, Msg: m, Targets: []string{targetID, s.charID}})
	s.whisperStatus(targetName, sp.WhisperStatusDelivered)
}
