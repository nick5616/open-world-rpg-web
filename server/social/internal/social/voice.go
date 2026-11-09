package social

// WP11 proximity voice glue: the `voice_token` handler and the Host the voice
// package (server/social/voice) reads parties, blocks and mutes through. The
// voice logic itself (tokens, reconcile, leader lease) lives in that package.

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"

	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/social/voice"
)

// SetVoice attaches the voice service (nil = voice unavailable). Call before
// serving.
func (h *Hub) SetVoice(v *voice.Service) { h.voice = v }

// SetVoiceLocalListenOnly makes local profiles listen-only again (WP11's
// original rule). Call before serving.
func (h *Hub) SetVoiceLocalListenOnly(on bool) { h.voiceLocalListenOnly = on }

// VoiceHost is the voice package's view of this hub.
func (h *Hub) VoiceHost() voice.Host { return voiceHost{h} }

// voiceToken answers `voice_token` with a LiveKit join token.
// Moderator-muted players get listen-only tokens (a moderator mute is "can
// read, can't send" for chat, so the same for voice). Local profiles may
// talk since playtest 2 (proximity voice only: earshot, /mute and /block
// apply to them like to anyone, and a moderator mute by profile id makes
// them listen-only); LODESTONE_VOICE_LOCAL_LISTEN_ONLY=1 restores spec
// 10/11's "can hear voice but not transmit".
func (s *Session) voiceToken(ctx context.Context) {
	if s.hub.voice == nil {
		s.sendErr(sp.ErrorCodeNotAllowed, "Voice is not available on this server.")
		return
	}
	s.mu.Lock()
	canPublish := !s.modMuted && !(s.local && s.hub.voiceLocalListenOnly)
	s.mu.Unlock()
	url, tok, room, err := s.hub.voice.Token(s.worldID, s.charID, s.name, canPublish)
	if err != nil {
		s.hub.log.Error("voice token", "err", err)
		s.sendErr(sp.ErrorCodeInternal, "Voice is unavailable right now.")
		return
	}
	s.send(sp.S2CVoiceToken{Type: sp.S2CTypeVoiceToken, URL: url, Token: tok, Room: room})
}

type voiceHost struct{ h *Hub }

func (v voiceHost) Worlds(ctx context.Context) ([]string, error) {
	return v.h.rdb.SMembers(ctx, keyWorlds).Result()
}

// PartyMates reads partyof:{id} then each party once, in two pipelined round
// trips.
func (v voiceHost) PartyMates(ctx context.Context, ids []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(ids) == 0 {
		return out, nil
	}
	pipe := v.h.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.Get(ctx, keyPartyOf(id))
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	pids := map[string]bool{}
	for _, c := range cmds {
		if pid, err := c.Result(); err == nil && pid != "" {
			pids[pid] = true
		}
	}
	for pid := range pids {
		p, err := readParty(ctx, v.h.rdb, pid)
		if err != nil {
			return nil, err
		}
		if p == nil {
			continue
		}
		for _, a := range p.Members {
			for _, b := range p.Members {
				if a.ID != b.ID {
					out[a.ID] = append(out[a.ID], b.ID)
				}
			}
		}
	}
	return out, nil
}

// Relations returns every block and mute where either side is in ids, in one
// query (the voice leader refreshes the whole room every couple of seconds).
func (v voiceHost) Relations(ctx context.Context, ids []string) (blocked, muted [][2]string, err error) {
	if len(ids) == 0 {
		return nil, nil, nil
	}
	rows, err := v.h.store.Pool.Query(ctx, `
		SELECT 'b', blocker::text, blocked::text FROM social_blocks WHERE blocker = ANY($1::uuid[]) OR blocked = ANY($1::uuid[])
		UNION ALL
		SELECT 'm', muter::text, muted::text FROM social_mutes WHERE muter = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, a, b string
		if err := rows.Scan(&kind, &a, &b); err != nil {
			return nil, nil, err
		}
		if kind == "b" {
			blocked = append(blocked, [2]string{a, b})
		} else {
			muted = append(muted, [2]string{a, b})
		}
	}
	return blocked, muted, rows.Err()
}
