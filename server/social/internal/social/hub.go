// Package social is the social service (spec 10, WP08): chat channels,
// whispers, parties, friends, presence and moderation over a JSON WebSocket
// (contracts/social.yaml).
//
// Shape: one Hub per process holds the local sessions. Durable state is in
// Postgres (store.go), ephemeral state in Redis (keys.go), and every
// delivery goes through Redis pub/sub (bus.go) so several processes can
// share a world. Each session has one reader goroutine that handles its
// messages in order and one writer goroutine that drains a bounded queue;
// the bus goroutine only ever enqueues, so a slow client cannot stall
// delivery to anyone else.
package social

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/svc"
)

// Config tunes a Hub. Zero values take production defaults.
type Config struct {
	TicketPub      ed25519.PublicKey
	Limits         LimitConfig
	OriginPatterns []string      // browser origins; empty or "*" = any (dev)
	PresenceTTL    time.Duration // PRESENCE_TTL_S
	Heartbeat      time.Duration // how often live sessions refresh presence
	ReapEvery      time.Duration // how often the reaper looks for dead sessions
	PartyGrace     time.Duration // PARTY_RECONNECT_GRACE_S
	PingEvery      time.Duration // WebSocket ping to detect dead sockets
	AuthTimeout    time.Duration
	VoiceURL       string // LiveKit URL; voice tokens are a later package
}

func (c *Config) defaults() {
	if c.Limits == (LimitConfig{}) {
		c.Limits = DefaultLimits()
	}
	if c.PresenceTTL == 0 {
		c.PresenceTTL = constants.PresenceTtlS * time.Second
	}
	if c.Heartbeat == 0 {
		// A third of the TTL: two heartbeats can be lost before presence lapses.
		c.Heartbeat = c.PresenceTTL / 3
	}
	if c.ReapEvery == 0 {
		c.ReapEvery = 10 * time.Second
	}
	if c.PartyGrace == 0 {
		c.PartyGrace = constants.PartyReconnectGraceS * time.Second
	}
	if c.PingEvery == 0 {
		c.PingEvery = 20 * time.Second
	}
	if c.AuthTimeout == 0 {
		c.AuthTimeout = 10 * time.Second
	}
}

// Hub owns this process's sessions.
type Hub struct {
	cfg     Config
	rdb     *redis.Client
	store   *Store
	log     *slog.Logger
	metrics *svc.Metrics
	node    string // this process, for presence records and logs

	mu       sync.RWMutex
	sessions map[string]*Session // by character id (one live session per character)

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewHub builds a hub; call Start before serving.
func NewHub(cfg Config, rdb *redis.Client, store *Store, log *slog.Logger, metrics *svc.Metrics) *Hub {
	cfg.defaults()
	ctx, cancel := context.WithCancel(context.Background())
	if metrics == nil {
		metrics = svc.NewMetrics()
	}
	return &Hub{cfg: cfg, rdb: rdb, store: store, log: log, metrics: metrics, node: "social-" + randHex(4),
		sessions: map[string]*Session{}, ctx: ctx, cancel: cancel}
}

// Start subscribes to the bus and starts the heartbeat and reaper. It
// returns once the subscription is live.
func (h *Hub) Start() {
	h.metrics.Help("social_sessions", "Live WebSocket sessions on this process.")
	h.metrics.Help("social_chat_accepted_total", "Chat messages accepted, by channel.")
	h.metrics.Help("social_chat_rejected_total", "Chat messages refused, by reason.")
	ready := make(chan struct{})
	h.wg.Add(3)
	go func() { defer h.wg.Done(); h.subscribe(h.ctx, ready) }()
	go func() { defer h.wg.Done(); h.heartbeatLoop() }()
	go func() { defer h.wg.Done(); h.reapLoop() }()
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		h.log.Error("bus subscription not ready after 10 s")
	}
}

// Stop closes every session (running the clean offline path, so friends see
// them leave and party grace starts) and stops background loops.
func (h *Hub) Stop(ctx context.Context) {
	h.mu.RLock()
	all := make([]*Session, 0, len(h.sessions))
	for _, s := range h.sessions {
		all = append(all, s)
	}
	h.mu.RUnlock()
	for _, s := range all {
		s.closeWith("", "server restarting", true)
	}
	for _, s := range all {
		select {
		case <-s.done:
		case <-ctx.Done():
		}
	}
	h.cancel()
	h.wg.Wait()
}

// Node is this process's id.
func (h *Hub) Node() string { return h.node }

// Handler serves the /ws endpoint.
func (h *Hub) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opts := &websocket.AcceptOptions{}
		if len(h.cfg.OriginPatterns) == 0 || (len(h.cfg.OriginPatterns) == 1 && h.cfg.OriginPatterns[0] == "*") {
			opts.InsecureSkipVerify = true
		} else {
			opts.OriginPatterns = h.cfg.OriginPatterns
		}
		c, err := websocket.Accept(w, r, opts)
		if err != nil {
			return
		}
		// Chat frames are tiny; 8 KB fits the longest legal frame (280
		// characters of 4-byte UTF-8 plus JSON) with room to spare and stops
		// anyone making us buffer megabytes.
		c.SetReadLimit(8 << 10)
		s := newSession(h, c, r.RemoteAddr)
		s.run()
	})
}

func (h *Hub) session(charID string) *Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessions[charID]
}

func (h *Hub) worldSessions(worldID string) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.sessions))
	for _, s := range h.sessions {
		if s.worldID == worldID {
			out = append(out, s)
		}
	}
	return out
}

// register makes s the local session for its character, returning the one
// it replaced (if any) so the caller can close it.
func (h *Hub) register(s *Session) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	old := h.sessions[s.charID]
	h.sessions[s.charID] = s
	h.metrics.SetInt("social_sessions", int64(len(h.sessions)))
	return old
}

func (h *Hub) unregister(s *Session) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[s.charID] != s {
		return false
	}
	delete(h.sessions, s.charID)
	h.metrics.SetInt("social_sessions", int64(len(h.sessions)))
	return true
}

// heartbeatLoop refreshes presence for every live local session. The
// WebSocket ping in each session is what proves the socket is alive; this
// loop turns that into the Redis TTL everyone else reads.
func (h *Hub) heartbeatLoop() {
	t := time.NewTicker(h.cfg.Heartbeat)
	defer t.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-t.C:
		}
		h.mu.RLock()
		all := make([]*Session, 0, len(h.sessions))
		for _, s := range h.sessions {
			all = append(all, s)
		}
		h.mu.RUnlock()
		if len(all) == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
		pipe := h.rdb.Pipeline()
		now := nowMs()
		for _, s := range all {
			if !s.authed.Load() {
				continue
			}
			pipe.HSet(ctx, keyPresence(s.charID), "ts", now)
			pipe.Expire(ctx, keyPresence(s.charID), h.cfg.PresenceTTL)
		}
		if _, err := pipe.Exec(ctx); err != nil && ctx.Err() == nil {
			h.log.Warn("heartbeat", "err", err)
		}
		cancel()
	}
}

// reapLoop is the-circle's reap_dead (backend/rooms/room_state.py): an
// online entry whose presence key expired belongs to a process that died
// without running disconnect, so we run the offline path for it. Every
// process reaps; HDEL returning 1 decides which one does the work.
func (h *Hub) reapLoop() {
	t := time.NewTicker(h.cfg.ReapEvery)
	defer t.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(h.ctx, 10*time.Second)
		h.reapOnce(ctx)
		cancel()
	}
}

// reapOnce runs one reaper pass (exported to tests through ReapNow).
func (h *Hub) reapOnce(ctx context.Context) {
	worlds, err := h.rdb.SMembers(ctx, keyWorlds).Result()
	if err != nil {
		return
	}
	for _, w := range worlds {
		online, err := h.rdb.HGetAll(ctx, keyOnline(w)).Result()
		if err != nil {
			continue
		}
		for charID, sid := range online {
			n, err := h.rdb.Exists(ctx, keyPresence(charID)).Result()
			if err != nil || n == 1 {
				continue
			}
			// Only reap the entry we saw: a fresh login may have replaced it.
			if removed, _ := hdelIfEq.Run(ctx, h.rdb, []string{keyOnline(w)}, charID, sid).Int(); removed == 1 {
				h.metrics.Add("social_reaped_total", 1)
				h.log.Info("reaped dead session", "char", charID, "world", w)
				h.wentOffline(ctx, w, charID)
			}
		}
		h.expireParties(ctx, w)
	}
}

// ReapNow runs the reaper immediately (tests, admin).
func (h *Hub) ReapNow(ctx context.Context) { h.reapOnce(ctx) }

// wentOffline is the shared tail of a clean disconnect and a reap: friends
// refresh their list, party mates see the member offline, and the party
// grace clock starts.
func (h *Hub) wentOffline(ctx context.Context, worldID, charID string) {
	if pid, _ := h.rdb.Get(ctx, keyPartyOf(charID)).Result(); pid != "" {
		deadline := time.Now().Add(h.cfg.PartyGrace).UnixMilli()
		h.rdb.ZAdd(ctx, keyPartyGrace(worldID), redis.Z{Score: float64(deadline), Member: charID})
		h.publishPartyState(ctx, worldID, pid)
	}
	h.notifyFriends(ctx, worldID, charID)
}

// Lua: delete hash field only if it still holds the expected value, so a
// late cleanup never removes a newer session's entry.
var hdelIfEq = redis.NewScript(`
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0`)

// Lua: delete a presence key only if it belongs to the given session.
var delPresenceIfSid = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'sid') == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`)

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ParseOrigins splits LODESTONE_CORS_ORIGIN-style lists into host patterns
// for websocket.AcceptOptions (which wants hosts, not URLs).
func ParseOrigins(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		p = strings.TrimPrefix(strings.TrimPrefix(p, "https://"), "http://")
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
