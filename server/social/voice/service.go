package voice

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/earshot"
	"lodestone/server/pkg/svc"
)

// Host is what voice needs from the rest of the social service.
type Host interface {
	// Worlds with live social sessions (each process campaigns for these).
	Worlds(ctx context.Context) ([]string, error)
	// PartyMates maps each character to the other members of its party.
	PartyMates(ctx context.Context, ids []string) (map[string][]string, error)
	// Relations returns (a blocked b) and (a muted b) pairs touching ids.
	Relations(ctx context.Context, ids []string) (blocked, muted [][2]string, err error)
}

// Config tunes the service; zero values take the defaults in defaults().
type Config struct {
	PublicURL string // LiveKit URL clients connect to (ws:// or wss://)
	APIKey    string
	APISecret string
	API       API // nil: LiveKit's HTTP API at APIURL(PublicURL) (or APIBase)
	APIBase   string

	TokenTTL       time.Duration // join token lifetime (only checked at join)
	RosterEvery    time.Duration // ListParticipants poll
	RelationsEvery time.Duration // parties, blocks, mutes refresh
	HealEvery      time.Duration // re-assert every desired subscription
	LeaseTTL       time.Duration // leader lease per world
	DiscoverEvery  time.Duration // how often to look for worlds to campaign for
	Workers        int           // parallel UpdateSubscriptions calls per pass
}

func (c *Config) defaults() {
	if c.TokenTTL == 0 {
		c.TokenTTL = 10 * time.Minute
	}
	if c.RosterEvery == 0 {
		// The roster tells us who joined and who published a track (first
		// push-to-talk). 500 ms keeps a new speaker's first words from being
		// lost for long; one ListParticipants of one room is cheap. LiveKit
		// webhooks would remove the poll (STATUS).
		c.RosterEvery = 500 * time.Millisecond
	}
	if c.RelationsEvery == 0 {
		c.RelationsEvery = 2 * time.Second // a block reaches voice within ~2 s
	}
	if c.HealEvery == 0 {
		c.HealEvery = 10 * time.Second
	}
	if c.LeaseTTL == 0 {
		c.LeaseTTL = 3 * time.Second
	}
	if c.DiscoverEvery == 0 {
		c.DiscoverEvery = 5 * time.Second
	}
	if c.Workers == 0 {
		c.Workers = 8
	}
	if c.API == nil {
		base := c.APIBase
		if base == "" {
			base = APIURL(c.PublicURL)
		}
		c.API = NewLiveKit(base, c.APIKey, c.APISecret)
	}
}

// Service issues tokens and, for every world where this process holds the
// voice lease, runs the reconciler. Exactly one process per world reconciles
// (a Redis lease, voicelead:{worldId}), because LiveKit has one room per
// world and two reconcilers would fight over its subscriptions.
type Service struct {
	cfg     Config
	rdb     *redis.Client
	host    Host
	log     *slog.Logger
	metrics *svc.Metrics
	node    string

	mu     sync.Mutex
	worlds map[string]*world

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	lat latencyRing
}

type world struct {
	id     string
	leader atomic.Bool
	nudge  chan struct{}
	stats  atomic.Pointer[leaderStats]
}

type leaderStats struct {
	Participants int     `json:"participants"`
	Applied      int     `json:"appliedSubscriptions"`
	Listeners    int     `json:"listenersWithEarshot"`
	LastPassMs   float64 `json:"lastPassMs"`
}

// New builds the service; call Start.
func New(cfg Config, rdb *redis.Client, host Host, log *slog.Logger, metrics *svc.Metrics, node string) *Service {
	cfg.defaults()
	if metrics == nil {
		metrics = svc.NewMetrics()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{cfg: cfg, rdb: rdb, host: host, log: log, metrics: metrics, node: node,
		worlds: map[string]*world{}, ctx: ctx, cancel: cancel}
}

// Start begins world discovery.
func (s *Service) Start() {
	m := s.metrics
	m.Help("voice_leader_worlds", "Worlds whose voice reconciler runs on this process.")
	m.Help("voice_participants", "LiveKit participants in rooms this process reconciles.")
	m.Help("voice_subscriptions", "Subscriptions (listener, track) this process believes are applied.")
	m.Help("voice_sub_changes_total", "Track subscriptions changed through the LiveKit API, by op.")
	m.Help("voice_api_errors_total", "Failed LiveKit API calls, by method.")
	m.Help("voice_earshot_msgs_total", "Earshot messages received from zones.")
	m.Help("voice_apply_latency_ms", "Zone earshot computation -> LiveKit UpdateSubscriptions answered, quantiles over the last 2048 changes.")
	m.Help("voice_pass_ms", "Duration of the last reconcile pass.")
	m.Help("voice_tokens_total", "Join tokens issued, by mode.")
	for _, op := range []string{"subscribe", "unsubscribe"} {
		m.Add(`voice_sub_changes_total{op="`+op+`"}`, 0)
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.discoverLoop() }()
}

// Stop ends every loop and releases held leases so another process takes
// over at once instead of after the lease TTL.
func (s *Service) Stop() {
	s.cancel()
	s.wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range s.worlds {
		if w.leader.Load() {
			_, _ = delIfEq.Run(ctx, s.rdb, []string{leaseKey(w.id)}, s.node).Result()
		}
	}
}

// Token issues a join token for one player and makes sure someone reconciles
// their world.
func (s *Service) Token(worldID, identity, name string, canPublish bool) (url, token, room string, err error) {
	room = RoomName(worldID)
	token, err = JoinToken(s.cfg.APIKey, s.cfg.APISecret, room, identity, name, canPublish, s.cfg.TokenTTL, time.Now())
	if err != nil {
		return "", "", "", err
	}
	mode := "publish"
	if !canPublish {
		mode = "listen"
	}
	s.metrics.Add(`voice_tokens_total{mode="`+mode+`"}`, 1)
	s.touch(worldID)
	return s.cfg.PublicURL, token, room, nil
}

// Nudge asks a world's leader (if it is this process) to refresh relations
// now, e.g. right after a block, instead of within RelationsEvery.
func (s *Service) Nudge(worldID string) {
	s.mu.Lock()
	w := s.worlds[worldID]
	s.mu.Unlock()
	if w != nil {
		select {
		case w.nudge <- struct{}{}:
		default:
		}
	}
}

func (s *Service) touch(worldID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.worlds[worldID]; ok || s.ctx.Err() != nil {
		return
	}
	w := &world{id: worldID, nudge: make(chan struct{}, 1)}
	s.worlds[worldID] = w
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.campaign(w) }()
}

func (s *Service) discoverLoop() {
	t := time.NewTicker(s.cfg.DiscoverEvery)
	defer t.Stop()
	for {
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
		ws, err := s.host.Worlds(ctx)
		cancel()
		if err == nil {
			for _, w := range ws {
				s.touch(w)
			}
		}
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
	}
}

func leaseKey(worldID string) string { return "voicelead:" + worldID }

// Lua: renew a lease only if we still hold it.
var renewIfEq = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`)

var delIfEq = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`)

// campaign holds or waits for the world's lease; while held, the leader
// loop runs. Renewal every third of the TTL survives two lost renewals.
func (s *Service) campaign(w *world) {
	var stop context.CancelFunc
	var done chan struct{}
	release := func() {
		if stop != nil {
			stop()
			<-done
			stop = nil
		}
		w.leader.Store(false)
		s.updateLeaderGauge()
	}
	defer release()
	t := time.NewTicker(s.cfg.LeaseTTL / 3)
	defer t.Stop()
	for {
		ctx, cancel := context.WithTimeout(s.ctx, s.cfg.LeaseTTL/3)
		if stop == nil {
			ok, err := s.rdb.SetNX(ctx, leaseKey(w.id), s.node, s.cfg.LeaseTTL).Result()
			if err == nil && ok {
				w.leader.Store(true)
				s.updateLeaderGauge()
				s.log.Info("voice leader", "world", w.id, "node", s.node)
				stop, done = s.startLeading(w)
			}
		} else {
			n, err := renewIfEq.Run(ctx, s.rdb, []string{leaseKey(w.id)}, s.node, s.cfg.LeaseTTL.Milliseconds()).Int()
			if err == nil && n == 0 {
				s.log.Warn("voice lease lost", "world", w.id)
				release()
			}
			// A Redis error keeps leading until the lease would have expired
			// anyway; another process cannot take it while Redis is down.
		}
		cancel()
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
	}
}

// startLeading runs lead on its own goroutine; stop ends it, done closes
// when it has returned.
func (s *Service) startLeading(w *world) (stop context.CancelFunc, done chan struct{}) {
	ctx, stop := context.WithCancel(s.ctx)
	done = make(chan struct{})
	go func() { defer close(done); s.lead(ctx, w) }()
	return stop, done
}

func (s *Service) updateLeaderGauge() {
	s.mu.Lock()
	n := 0
	for _, w := range s.worlds {
		if w.leader.Load() {
			n++
		}
	}
	s.mu.Unlock()
	s.metrics.SetInt("voice_leader_worlds", int64(n))
}

// lead runs one world's reconciler until ctx ends (lease lost or shutdown).
// One goroutine owns the Reconciler; earshot messages, roster polls and
// relation refreshes are serialized through it, and each pass fans its API
// calls out to Workers goroutines.
func (s *Service) lead(ctx context.Context, w *world) {
	room := RoomName(w.id)
	rec := NewReconciler()
	sub := s.rdb.Subscribe(ctx, earshot.Channel(w.id))
	defer sub.Close()
	msgs := sub.Channel(redis.WithChannelSize(256))

	roster := time.NewTicker(s.cfg.RosterEvery)
	defer roster.Stop()
	rel := time.NewTicker(s.cfg.RelationsEvery)
	defer rel.Stop()
	heal := time.NewTicker(s.cfg.HealEvery)
	defer heal.Stop()
	expire := time.NewTicker(time.Second)
	defer expire.Stop()

	var errAt time.Time
	logErr := func(what string, err error) {
		if time.Since(errAt) > 10*time.Second {
			errAt = time.Now()
			s.log.Warn("voice "+what, "world", w.id, "err", err)
		}
	}
	var rosterAt time.Time
	refreshRoster := func() {
		// An empty room (a world with players but nobody in voice yet) is
		// polled every 5 s instead of twice a second.
		if len(rec.parts) == 0 && time.Since(rosterAt) < 5*time.Second && !rosterAt.IsZero() {
			return
		}
		rosterAt = time.Now()
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ps, err := s.cfg.API.ListParticipants(cctx, room)
		cancel()
		if err != nil {
			s.metrics.Add(`voice_api_errors_total{method="ListParticipants"}`, 1)
			logErr("roster", err)
			return
		}
		rec.SetParticipants(ps)
	}
	refreshRelations := func() {
		ids := rec.Identities()
		if len(ids) == 0 {
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		party, err := s.host.PartyMates(cctx, ids)
		if err != nil {
			logErr("parties", err)
			return
		}
		blocked, muted, err := s.host.Relations(cctx, ids)
		if err != nil {
			logErr("relations", err)
			return
		}
		rec.SetRelations(party, blocked, muted)
	}
	pass := func(healAll bool) {
		start := time.Now()
		changes := rec.Plan(healAll)
		ok := s.apply(ctx, room, changes)
		for i, c := range changes {
			rec.Done(c, ok[i])
			if ok[i] && !healAll {
				op := "subscribe"
				if !c.Subscribe {
					op = "unsubscribe"
				}
				s.metrics.Add(`voice_sub_changes_total{op="`+op+`"}`, int64(len(c.Tracks)))
				if c.PendingT > 0 {
					s.lat.add(float64(time.Now().UnixMicro())/1000 - c.PendingT)
				}
			}
		}
		rec.ClearPending()
		passMs := float64(time.Since(start).Microseconds()) / 1000
		s.metrics.SetFloat("voice_pass_ms", passMs)
		listeners := 0
		for _, id := range rec.Identities() {
			if _, ok := rec.listenerZone[id]; ok {
				listeners++
			}
		}
		w.stats.Store(&leaderStats{Participants: len(rec.parts), Applied: rec.AppliedPairs(), Listeners: listeners, LastPassMs: passMs})
		s.metrics.SetInt("voice_participants", int64(len(rec.parts)))
		s.metrics.SetInt("voice_subscriptions", int64(rec.AppliedPairs()))
		for q, v := range s.lat.quantiles() {
			s.metrics.SetFloat(fmt.Sprintf(`voice_apply_latency_ms{q="%s"}`, q), v)
		}
	}

	refreshRoster()
	refreshRelations()
	pass(false)
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-msgs:
			if !ok {
				return
			}
			s.applyMsg(rec, m)
			// Coalesce whatever else is queued (several zones, or a pass
			// that ran long) into one pass.
		drain:
			for {
				select {
				case m, ok := <-msgs:
					if !ok {
						return
					}
					s.applyMsg(rec, m)
				default:
					break drain
				}
			}
			pass(false)
		case <-roster.C:
			refreshRoster()
			pass(false)
		case <-rel.C:
			refreshRelations()
			pass(false)
		case <-w.nudge:
			refreshRelations()
			pass(false)
		case <-heal.C:
			pass(true)
		case <-expire.C:
			rec.ExpireZones(float64(time.Now().UnixMicro()) / 1000)
		}
	}
}

func (s *Service) applyMsg(rec *Reconciler, m *redis.Message) {
	var em earshot.Message
	if err := json.Unmarshal([]byte(m.Payload), &em); err != nil {
		return
	}
	s.metrics.Add("voice_earshot_msgs_total", 1)
	rec.ApplyEarshot(&em)
}

// apply runs the changes with bounded parallelism and reports which worked.
func (s *Service) apply(ctx context.Context, room string, changes []Change) []bool {
	ok := make([]bool, len(changes))
	if len(changes) == 0 {
		return ok
	}
	sem := make(chan struct{}, s.cfg.Workers)
	var wg sync.WaitGroup
	for i := range changes {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			c := changes[i]
			cctx, cancel := context.WithTimeout(ctx, time.Second) // a participant who just left can make LiveKit hang; never stall the pass long
			err := s.cfg.API.UpdateSubscriptions(cctx, room, c.Identity, c.Tracks, c.Subscribe)
			cancel()
			if err != nil {
				s.metrics.Add(`voice_api_errors_total{method="UpdateSubscriptions"}`, 1)
				if !NotFound(err) {
					s.log.Debug("voice update subscriptions", "identity", c.Identity, "err", err)
				}
				return
			}
			ok[i] = true
		}(i)
	}
	wg.Wait()
	return ok
}

// DebugHandler serves /debug/voice: worlds, leadership and pass stats.
func (s *Service) DebugHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		type row struct {
			World  string       `json:"world"`
			Leader bool         `json:"leader"`
			Stats  *leaderStats `json:"stats,omitempty"`
		}
		s.mu.Lock()
		out := make([]row, 0, len(s.worlds))
		for _, w := range s.worlds {
			r := row{World: w.id, Leader: w.leader.Load()}
			if r.Leader {
				r.Stats = w.stats.Load()
			}
			out = append(out, r)
		}
		s.mu.Unlock()
		sort.Slice(out, func(i, j int) bool { return out[i].World < out[j].World })
		rw.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(rw).Encode(map[string]any{"node": s.node, "worlds": out, "applyLatencyMs": s.lat.quantiles()})
	})
}

// latencyRing keeps the last 2048 apply latencies for quantile metrics.
type latencyRing struct {
	mu  sync.Mutex
	buf [2048]float64
	n   int
}

func (l *latencyRing) add(v float64) {
	l.mu.Lock()
	l.buf[l.n%len(l.buf)] = v
	l.n++
	l.mu.Unlock()
}

func (l *latencyRing) quantiles() map[string]float64 {
	l.mu.Lock()
	n := min(l.n, len(l.buf))
	v := slices.Clone(l.buf[:n])
	l.mu.Unlock()
	if n == 0 {
		return map[string]float64{}
	}
	slices.Sort(v)
	at := func(q float64) float64 { return v[min(n-1, int(q*float64(n)))] }
	return map[string]float64{"0.5": at(0.5), "0.95": at(0.95), "0.99": at(0.99), "1": v[n-1]}
}
