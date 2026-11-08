// Package game is the zone server's authoritative simulation: sessions, the
// entity store, the 30 Hz tick, interest management and delta snapshots.
//
// Threading model (the one rule that keeps this simple): ONE goroutine, the
// scheduler's, owns all simulation state. Connection goroutines only decode
// frames, rate-limit them and append them to their session's inbox; the tick
// drains inboxes, steps movement, rebuilds the AOI grid, and encodes and
// queues every snapshot. Nothing in a tick waits on the network or Postgres:
// sends go to per-connection queues (transport) and durable writes go to the
// write-behind queue.
package game

import (
	"context"
	"crypto/ed25519"
	"hash/fnv"
	"log/slog"
	"math"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/gameloop"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/aoi"
	"lodestone/server/zone/internal/explore"
)

// Config is everything a zone needs; main.go fills it from env.
type Config struct {
	ZoneID     string
	WorldID    string
	Seed       uint64
	GenVersion string
	MaxPlayers int
	// DevSpawn lets a client pick its spawn with /ws?spawn=x,z. Only for dev
	// and soak bots (main enables it only with the dev ticket key or
	// LODESTONE_ZONE_DEV_SPAWN=1); real spawns come from the character row.
	DevSpawn  bool
	TicketKey ed25519.PublicKey
	Ground    movement.Ground
	// WP10: the updraft hook for the movement step (debug columns from
	// LODESTONE_ZONE_DEBUG_UPDRAFTS until WP15 feeds it) and a rain
	// override (nil: the weather stub decides from seed + world time).
	Updraft      movement.UpdraftField
	Rain         *bool
	SpinTail     time.Duration
	SaveInterval time.Duration
	// DownBudgetKbps caps each client's snapshot bytes (decision 0005); the
	// ring table stays the maximum rate. 0 = unlimited (WP03 behavior).
	DownBudgetKbps float64
	Store          CharacterStore // nil: no persistence
	// Mining (WP09): vein respawn window (spec 7: a seeded 6-24 h; tests
	// shorten it), world edit persistence and the item grant hook (WP14).
	VeinRespawnMin, VeinRespawnMax time.Duration
	EditStore                      EditStore // nil: edits live in memory only
	Granter                        Granter   // nil: grants are logged and evented only
	Earshot                        Earshot   // WP11 proximity voice (earshot.go); nil: none
	Queue                          *writebehind.Queue
	Metrics                        *svc.Metrics
	Log                            *slog.Logger
	// WP12 exploration (explore.go, party.go): the world's sites and towers
	// (nil: no exploration, e.g. flat ground), the social service's parties
	// (nil: no party ring) and the local-profile save store (nil: blobs in
	// Hello are ignored, as before WP12).
	Explore *explore.World
	Parties PartyDirectory
	Saves   *localsave.Store
	// WP13 combat (combat.go): camps, packs, bosses from the atlas; nil =
	// combat without atlas groups.
	Combat *CombatSetup
	// Now is the wall clock (tickets, server time); tests override it.
	Now func() time.Time
}

// Server is one zone process's simulation.
type Server struct {
	cfg   Config
	log   *slog.Logger
	sched *gameloop.Scheduler
	loop  *gameloop.Loop
	stats *gameloop.Stats

	joins    chan *session
	stopping atomic.Bool
	stopped  chan struct{} // closed once the tick has halted
	stopOnce sync.Once

	// Tick-owned state.
	tick     uint32
	nextID   uint32
	ents     []*Entity // sorted by ID (IDs only grow, removal keeps order)
	sessions []*session
	byChar   map[string]*session
	parties  map[uint32][]*Entity
	grid     *aoi.Grid
	idxs     []int32
	cands    []snapshot.Candidate
	w        proto.Writer
	saveDiv  uint32
	mine     mining              // WP09 (mining.go)
	calls    chan func()         // run on the tick goroutine (Do, caves.go)
	env      movement.Env        // WP10: this tick's movement env (stepEnv)
	hap      []explore.Happening // scratch for exploreTick
	party    partyState
	cbt      combatGlue // WP13 (combat.go)
	// WP11: next earshot hand-off (earshot.go).
	earshotNext time.Time

	// Shared with the metrics goroutine.
	connsMu sync.Mutex
	conns   map[*session]struct{}
	m       metrics
}

// New builds a server; call Start to begin ticking.
func New(cfg Config) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Ground == nil {
		cfg.Ground = movement.Flat{}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Metrics == nil {
		cfg.Metrics = svc.NewMetrics()
	}
	if cfg.MaxPlayers <= 0 {
		cfg.MaxPlayers = 400
	}
	if cfg.VeinRespawnMin <= 0 {
		cfg.VeinRespawnMin = 6 * time.Hour
	}
	if cfg.VeinRespawnMax <= 0 {
		cfg.VeinRespawnMax = 24 * time.Hour
	}
	if cfg.SaveInterval <= 0 {
		cfg.SaveInterval = constants.SaveIntervalS * time.Second
	}
	interval := time.Second / constants.TickRateHz
	s := &Server{
		cfg:     cfg,
		log:     cfg.Log,
		joins:   make(chan *session, 256),
		calls:   make(chan func(), 16),
		stopped: make(chan struct{}),
		byChar:  map[string]*session{},
		parties: map[uint32][]*Entity{},
		grid:    aoi.NewWorld(),
		conns:   map[*session]struct{}{},
		nextID:  1,
		stats:   gameloop.NewStats(interval, 60*constants.TickRateHz),
		saveDiv: uint32(cfg.SaveInterval / interval),
	}
	if s.saveDiv == 0 {
		s.saveDiv = 1
	}
	s.m.init(cfg.Metrics)
	s.initCombat() // WP13 (combat.go)
	s.loop = &gameloop.Loop{Interval: interval, Stats: s.stats, OnTick: s.onTick}
	return s
}

// Start begins ticking on a fresh shared scheduler.
func (s *Server) Start() {
	s.sched = gameloop.New(s.cfg.SpinTail)
	s.sched.Add(s.loop)
	s.startParties()
	s.log.Info("zone ticking", "hz", constants.TickRateHz, "spinTail", s.cfg.SpinTail.String(), "clock", gameloop.PreciseClock)
}

// Players is the number of connected players (safe from any goroutine).
func (s *Server) Players() int { return int(s.m.players.Load()) }

// TickStats exposes scheduler stats (metrics, tests, evidence).
func (s *Server) TickStats() gameloop.Summary { return s.stats.Summary() }

// Stop halts the tick (waiting for one in progress), kicks everyone with
// `shutdown`, checkpoints every character, and flushes the write-behind queue
// until ctx expires.
func (s *Server) Stop(ctx context.Context) {
	s.stopOnce.Do(func() {
		s.stopping.Store(true)
		if s.sched != nil {
			s.sched.Close() // waits for the current tick; no tick runs after this
		}
		close(s.stopped)
		for {
			select {
			case sess := <-s.joins:
				s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
				close(sess.joined)
				continue
			default:
			}
			break
		}
		for _, sess := range slices.Clone(s.sessions) {
			s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
			s.leave(sess)
		}
		if s.cfg.Queue != nil {
			if err := s.cfg.Queue.Flush(ctx); err != nil {
				s.log.Error("write-behind flush", "err", err, "left", s.cfg.Queue.Depth())
			} else {
				s.log.Info("write-behind flushed")
			}
		}
	})
}

// serverTimeMs is the protocol's server clock: Unix milliseconds with
// sub-millisecond precision (Welcome, Snapshot, ClockPong all use it).
func (s *Server) serverTimeMs() float64 {
	return float64(s.cfg.Now().UnixMicro()) / 1000
}

// onTick is one 1/30 s simulation step. Order: joins, inputs, grid,
// checkpoints, snapshots.
func (s *Server) onTick() {
	s.tick++
	tick := s.tick
	now := time.Now()
	s.env = s.stepEnv() // WP10: rain + updrafts for every step this tick

	for {
		select {
		case sess := <-s.joins:
			s.join(sess)
			continue
		default:
		}
		break
	}

	for i := 0; i < len(s.sessions); {
		sess := s.sessions[i]
		if sess.closed.Load() {
			s.leave(sess) // removes sessions[i]; don't advance
			continue
		}
		s.drain(sess, now)
		i++
	}
	for { // Do (caves.go): debug reads and test pokes, between ticks' phases
		select {
		case f := <-s.calls:
			f()
			continue
		default:
		}
		break
	}
	s.terrainTick(tick)             // WP07: chunk cache interest (terrain.go)
	s.exploreTick(tick)             // WP12: towers, waypoints, discoveries, party ring (explore.go)
	s.caveTick(tick)                // WP09: cave cell interest + each entity's cave system (caves.go)
	s.miningTick(tick, s.cfg.Now()) // WP09: pickups, respawns, WorldEdits interest (mining.go)
	s.combatTick(tick)              // WP13: enemies, strikes, claims, respawns (combat.go)

	// Quantize once per entity and rebuild the grid; every client's snapshot
	// reads these.
	s.grid.Reset()
	for i, e := range s.ents {
		e.idx = int32(i)
		e.updateView(s.cfg.Ground, s.env)
		e.quantize(s.cfg.Ground)
		s.grid.Insert(int32(i), e.Move.Pos.X, e.Move.Pos.Z)
	}
	s.earshotTick(now) // WP11: proximity voice positions every 250 ms (earshot.go)

	// Checkpoint each character every SAVE_INTERVAL_S, staggered by id so
	// the queue sees a trickle, not a burst every 30 s.
	if s.cfg.Queue != nil {
		for _, e := range s.ents {
			if e.Kind == proto.EntityKindPlayer && (tick+e.ID)%s.saveDiv == 0 {
				s.checkpoint(e)
			}
		}
	}

	serverTime := s.serverTimeMs()
	var sumNear, sumMid, sumFar, sumParty, maxSet, snapBytes int64
	for _, sess := range s.sessions {
		n, md, f, p, b := s.sendSnapshot(sess, tick, serverTime)
		sumNear += int64(n)
		sumMid += int64(md)
		sumFar += int64(f)
		sumParty += int64(p)
		snapBytes += int64(b)
		if t := int64(n + md + f + p); t > maxSet {
			maxSet = t
		}
	}
	s.m.aoiAccum(len(s.sessions), sumNear, sumMid, sumFar, sumParty, maxSet, snapBytes)
}

// join admits a handshaken session (tick goroutine).
func (s *Server) join(sess *session) {
	defer close(sess.joined)
	if s.stopping.Load() {
		s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
		return
	}
	if sess.closed.Load() {
		return
	}
	spawn := sess.spawn
	// Duplicate login: the newest connection wins (a player reconnecting after
	// a dropped socket must not be locked out by their own ghost). The old
	// session is kicked and the new one continues from its live position.
	if old := s.byChar[sess.claims.CharacterID]; old != nil {
		spawn = old.ent.Move.Pos
		s.kick(old, proto.KickCodeDuplicateLogin, "logged in from another connection")
		s.leave(old)
	}
	if len(s.sessions) >= s.cfg.MaxPlayers {
		s.kick(sess, proto.KickCodeServerFull, "zone full")
		return
	}
	e := &Entity{
		ID:          s.nextID,
		Kind:        proto.EntityKindPlayer,
		Name:        sess.claims.CharacterName,
		CharacterID: sess.claims.CharacterID,
		Level:       1,
		Health:      100,
		HealthMax:   100,
		ListenOnly:  sess.claims.IsLocalProfile, // WP11: local profiles hear voice but never transmit (spec 11)
	}
	s.nextID++
	e.Move = movement.NewState(spawn) // WP10: full stamina wheel, ground mode
	if g := movement.GroundAt(s.cfg.Ground, spawn.X, spawn.Y, spawn.Z); e.Move.Pos.Y < g {
		e.Move.Pos.Y = g
	}
	e.prevValid = e.Move
	e.view = e.Move
	e.quantize(s.cfg.Ground)
	sess.ent = e
	if s.cfg.DownBudgetKbps > 0 {
		// Charge each snapshot its transport framing so the cap matches what
		// the per-client kbps metric (and the spec 9 budget) measures.
		overhead := 4 // WebSocket header of a 126..65535-byte server frame
		if sess.conn.Kind() == proto.TransportWebtransport {
			overhead = transport.WTDatagramOverhead
		}
		sess.enc.SetBudget(s.cfg.DownBudgetKbps*1000/8, constants.TickRateHz, budgetBurstTicks, overhead)
	}
	if k := sess.conn.Kind(); int(k) < len(s.m.transports) {
		s.m.transports[k].Add(1)
	}
	s.ents = append(s.ents, e)
	s.sessions = append(s.sessions, sess)
	s.byChar[e.CharacterID] = sess
	if e.PartyID != 0 {
		s.parties[e.PartyID] = append(s.parties[e.PartyID], e)
	}
	s.connsMu.Lock()
	s.conns[sess] = struct{}{}
	s.connsMu.Unlock()
	s.m.players.Store(int64(len(s.sessions)))

	welcome := &proto.Welcome{
		ProtocolVersion: proto.ProtocolVersion,
		EntityID:        e.ID,
		Tick:            s.tick,
		TickRate:        constants.TickRateHz,
		ServerTime:      s.serverTimeMs(),
		WorldID:         s.cfg.WorldID,
		Seed:            s.cfg.Seed,
		GenVersion:      s.cfg.GenVersion,
		X:               proto.MetersToCm(e.Move.Pos.X),
		Y:               proto.MetersToCm(e.Move.Pos.Y),
		Z:               proto.MetersToCm(e.Move.Pos.Z),
		Name:            e.Name,
	}
	if err := sess.conn.SendReliable(proto.Encode(welcome)); err != nil {
		sess.closed.Store(true)
	}
	s.exploreJoin(sess) // WP12: progress, pins (after Welcome, which the client needs first)
	s.combatJoin(sess)  // WP13: loadouts, health, combat_sync (combat.go)
	s.log.Info("join", "entity", e.ID, "character", e.CharacterID, "name", e.Name, "remote", sess.conn.RemoteAddr(),
		"x", math.Round(spawn.X*100)/100, "z", math.Round(spawn.Z*100)/100)
}

// leave removes a session and its entity, checkpointing the character
// (spec 11: saved on logout).
func (s *Server) leave(sess *session) {
	if sess.left {
		return
	}
	sess.left = true
	sess.closed.Store(true)
	sess.conn.Close(1000, "")
	if i := slices.Index(s.sessions, sess); i >= 0 {
		s.sessions = slices.Delete(s.sessions, i, i+1)
	}
	s.connsMu.Lock()
	delete(s.conns, sess)
	s.connsMu.Unlock()
	s.m.players.Store(int64(len(s.sessions)))
	e := sess.ent
	if e == nil {
		return
	}
	if k := sess.conn.Kind(); int(k) < len(s.m.transports) {
		s.m.transports[k].Add(-1)
	}
	if s.byChar[e.CharacterID] == sess {
		delete(s.byChar, e.CharacterID)
	}
	if i, ok := slices.BinarySearchFunc(s.ents, e.ID, func(x *Entity, id uint32) int { return cmpU32(x.ID, id) }); ok {
		s.ents = slices.Delete(s.ents, i, i+1)
	}
	if e.PartyID != 0 {
		ps := s.parties[e.PartyID]
		if i := slices.Index(ps, e); i >= 0 {
			s.parties[e.PartyID] = slices.Delete(ps, i, i+1)
		}
		if len(s.parties[e.PartyID]) == 0 {
			delete(s.parties, e.PartyID)
		}
	}
	s.combatLeave(sess)  // WP13: combat profile save (combat.go)
	s.exploreLeave(sess) // WP12: progress save
	if s.cfg.Queue != nil {
		s.checkpoint(e)
	}
	s.log.Info("leave", "entity", e.ID, "character", e.CharacterID)
}

// checkpoint queues a position save (never blocks).
func (s *Server) checkpoint(e *Entity) {
	s.exploreCheckpoint(e) // WP12: changed progress rides the same cadence
	if s.cfg.Store == nil || s.cfg.Queue == nil {
		return
	}
	id, pos, store, log := e.CharacterID, e.Move.Pos, s.cfg.Store, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "pos:" + id, Run: func(ctx context.Context) error {
		err := store.SavePosition(ctx, id, pos)
		if err != nil && errorsIsSkip(err) {
			// Expected until WP04 creates character rows: log once per
			// character, not every 30 s.
			if _, seen := loggedMissing.LoadOrStore(id, true); !seen {
				log.Info("checkpoint skipped: no character row (WP04 creates characters)", "character", id)
			}
		}
		return err
	}})
}

var loggedMissing sync.Map

// defaultSpawn scatters players within 8 m of the world center by character
// id, so dev logins without a character row don't stack on one point.
func defaultSpawn(characterID string) movement.Vec3 {
	h := fnv.New64a()
	h.Write([]byte(characterID))
	v := h.Sum64()
	a := float64(v&0xffff) / 65536 * 2 * math.Pi
	r := float64((v>>16)&0xffff) / 65536 * 8
	c := float64(constants.WorldSizeM) / 2
	return movement.Vec3{X: c + r*math.Cos(a), Z: c + r*math.Sin(a)}
}

func cmpU32(a, b uint32) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
