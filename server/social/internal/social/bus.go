package social

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	sp "lodestone/server/pkg/socialproto"
)

// Cross-process delivery (spec 11: pub/sub social:{worldId}). Every event,
// even one whose sender and recipient share this process, is published to
// Redis and delivered from the subscription. One code path means a whisper
// between players on two social processes (or presenting two different
// zones) behaves exactly like one between neighbours, and the integration
// test that runs two processes exercises the same code a single process does.
// Cost: one Redis round trip (~0.2 ms locally) per event, at chat volume.
//
// Routing is decided by the receiving process against its own sessions'
// state (region, position, mutes), so senders never need to know who is
// where.

// Envelope kinds.
const (
	kindChat     = "chat"     // a ChatMessage; recipients chosen by channel rules
	kindFrame    = "frame"    // a prebuilt s2c frame for explicit targets
	kindFriends  = "friends"  // targets recompute and resend their friends list
	kindKick     = "kick"     // close the target's sessions other than Keep
	kindAdmin    = "admin"    // moderation status changed for targets
	kindPresence = "presence" // a target's online state or region changed (party frames refresh)
)

type envelope struct {
	Kind    string          `json:"k"`
	World   string          `json:"w"`
	Targets []string        `json:"t,omitempty"`
	Msg     *sp.ChatMessage `json:"m,omitempty"`
	Region  string          `json:"r,omitempty"` // zone channel scope
	Frame   json.RawMessage `json:"f,omitempty"`
	Keep    string          `json:"keep,omitempty"`   // kick: the session that stays
	Status  string          `json:"status,omitempty"` // admin
	// Party membership as of this frame; receivers cache it for party chat
	// routing and whisper permission (local profiles may whisper party).
	Party *partyRef `json:"p,omitempty"`
}

type partyRef struct {
	ID      string   `json:"id"` // "" = no party
	Members []string `json:"members,omitempty"`
}

func (h *Hub) publish(ctx context.Context, e *envelope) {
	b, err := json.Marshal(e)
	if err != nil {
		h.log.Error("bus marshal", "err", err)
		return
	}
	if err := h.rdb.Publish(ctx, Channel(e.World), b).Err(); err != nil {
		h.log.Error("bus publish", "err", err, "kind", e.Kind)
		h.metrics.Add("social_bus_errors_total", 1)
	}
}

// subscribe pattern-subscribes to every world's channel, so one process can
// host sessions from any number of worlds without bookkeeping.
func (h *Hub) subscribe(ctx context.Context, ready chan<- struct{}) {
	ps := h.rdb.PSubscribe(ctx, "social:*")
	defer ps.Close()
	// Wait for the subscription to be live before reporting ready: anything
	// published before that would be lost, and the first thing a new session
	// does is publish.
	if _, err := ps.Receive(ctx); err != nil && ctx.Err() == nil {
		h.log.Error("bus subscribe", "err", err)
	}
	close(ready)
	// A deep buffer: a burst of global chat must not make go-redis drop
	// messages while route() fans out to thousands of sessions.
	ch := ps.Channel(redis.WithChannelSize(4096))
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			var e envelope
			if err := json.Unmarshal([]byte(m.Payload), &e); err != nil {
				h.metrics.Add("social_bus_errors_total", 1)
				continue
			}
			h.metrics.Add("social_bus_events_total", 1)
			h.route(&e)
		}
	}
}

// route hands an envelope to every local session that should get it.
func (h *Hub) route(e *envelope) {
	switch e.Kind {
	case kindChat:
		if e.Msg == nil {
			return
		}
		if len(e.Targets) > 0 {
			for _, id := range e.Targets {
				if s := h.session(id); s != nil && s.worldID == e.World {
					s.deliverChat(e)
				}
			}
			return
		}
		for _, s := range h.worldSessions(e.World) {
			if s.wantsChat(e) {
				s.deliverChat(e)
			}
		}
	case kindFrame:
		for _, id := range e.Targets {
			if s := h.session(id); s != nil && s.worldID == e.World {
				if e.Party != nil {
					s.setParty(e.Party)
				}
				s.sendRaw(e.Frame)
			}
		}
	case kindFriends:
		for _, id := range e.Targets {
			if s := h.session(id); s != nil && s.worldID == e.World {
				s.refreshFriends()
			}
		}
	case kindKick:
		for _, id := range e.Targets {
			if s := h.session(id); s != nil && s.id != e.Keep {
				s.closeWith(sp.ErrorCodeReplaced, "signed in from another window", false)
			}
		}
	case kindAdmin:
		for _, id := range e.Targets {
			if s := h.session(id); s != nil {
				s.applyStatus(e.Status)
			}
		}
	}
}

// wantsChat applies the broadcast channel rules (global, zone, local) for one
// recipient. Targeted channels (party, whisper, system) never get here.
func (s *Session) wantsChat(e *envelope) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch e.Msg.Channel {
	case sp.ChannelGlobal:
		return true
	case sp.ChannelZone:
		return s.region != "" && s.region == e.Region
	case sp.ChannelLocal:
		if e.Msg.FromID == s.charID {
			return true // your own bubble, even before your first presence frame
		}
		return s.hasPos && within(s.x, s.z, e.Msg.X, e.Msg.Z, constants.LocalChatRadiusM)
	}
	return false
}

func within(x1, z1, x2, z2, r float64) bool {
	return math.Hypot(x1-x2, z1-z2) <= r
}

// visibleText is what a recipient reads: muted/blocked senders vanish,
// global and zone get the profanity filter unless the reader opted out.
// ok=false means drop.
func (s *Session) visibleText(m *sp.ChatMessage) (string, bool) {
	s.mu.Lock()
	ignored := m.FromID != s.charID && (s.muted[m.FromID] != "" || s.blocked[m.FromID] != "")
	filter := s.filter
	s.mu.Unlock()
	if ignored {
		return "", false
	}
	if filter && (m.Channel == sp.ChannelGlobal || m.Channel == sp.ChannelZone) {
		return defaultFilter.Clean(m.Text), true
	}
	return m.Text, true
}

func (s *Session) deliverChat(e *envelope) {
	m := *e.Msg
	text, ok := s.visibleText(&m)
	if !ok {
		return
	}
	m.Text = text
	if m.Channel == sp.ChannelWhisper && m.FromID != s.charID {
		s.mu.Lock()
		s.lastWhisperFrom = m.FromName
		s.mu.Unlock()
	}
	if m.Channel == sp.ChannelLocal {
		s.rememberLocal(*e.Msg) // raw text: reports capture what was written
	}
	s.send(sp.S2CChat{Type: sp.S2CTypeChat, Message: m})
}


// nowMs is server unix milliseconds, the ts on every ChatMessage.
func nowMs() int64 { return time.Now().UnixMilli() }

func lower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
