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
	"errors"
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
	"lodestone/server/zone/internal/npc"
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
	// SnapshotWorkers builds clients' snapshots on this many goroutines
	// (WP19, snapshots.go); 0 = GOMAXPROCS, 1 = on the tick goroutine.
	SnapshotWorkers int
	Store           CharacterStore // nil: no persistence
	// Mining (WP09): vein respawn window (spec 7: a seeded 6-24 h; tests
	// shorten it), world edit persistence and the item grant hook (WP14).
	VeinRespawnMin, VeinRespawnMax time.Duration
	EditStore                      EditStore // nil: edits live in memory only
	Granter                        Granter   // nil: grants are logged and evented only
	Earshot                        Earshot   // WP11 proximity voice (earshot.go); nil: none
	// VoiceLocalListenOnly: local profiles' speaking bit is never shown
	// (WP11's listen-only rule, LODESTONE_VOICE_LOCAL_LISTEN_ONLY=1, as on
	// the social service). Off by default since playtest 2: local profiles
	// may talk.
	VoiceLocalListenOnly bool
	Queue                *writebehind.Queue
	Metrics              *svc.Metrics
	Log                  *slog.Logger
	// WP12 exploration (explore.go, party.go): the world's sites and towers
	// (nil: no exploration, e.g. flat ground), the social service's parties
	// (nil: no party ring) and the local-profile save store (nil: blobs in
	// Hello are ignored, as before WP12).
	Explore *explore.World
	Parties PartyDirectory
	Saves   *localsave.Store
	// WP16 multiple zones (cluster.go, handoff.go, ghosts.go): nil = one zone
	// owning the whole world (pre-WP16 behavior). IDBase starts the
	// zone-local entity id counter (cluster zones: a per-zone range).
	Cluster Cluster
	IDBase  uint32
	// WP13 combat (combat.go): camps, packs, bosses from the atlas; nil =
	// combat without atlas groups.
	Combat *CombatSetup
	// WP20 towns (towns.go): the world's townsfolk (nil: no NPCs), the
	// forge/anvil hook for WP14 (nil: Event 805 only) and an offset added to
	// the zone clock for the NPC day (tests, evidence; WP15 owns the clock).
	Towns       *npc.World
	Stations    Stations
	TimeOffsetS float64
	// Building door states (doors_sync.go): persisted by the zone owning
	// each door's region; nil = zone memory only.
	DoorStore DoorStore
	// WP14 items (items.go): persistence, world containers, loot themes,
	// the drop despawn timer, the Bitchin' announcement; nil = memory-only
	// items with the spec's timers.
	Items *ItemsSetup
	// WP15 night, demons and chemistry (night.go); nil = none. TimeOffsetS
	// above is the world clock's offset (same env on every zone of a world).
	Night *NightSetup
	// Playtest 1 discovery-stamped difficulty (difficulty.go); nil = the
	// WP13 region danger curve.
	Difficulty *DifficultySetup
	// PartyChat posts a system line to these characters' party chat (the
	// social bus; playtest 2 duel results, duel.go); nil = none.
	PartyChat func(characterIDs []string, text string)
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
	inBatch  []*session         // WP19b: plain sessions waiting for a parallel run (inputs.go)
	cbtEnc   [][]byte           // WP19b: this tick's encoded combat events (deliverCombatAll)
	held     []transport.Holder // WP19b: connections held for this tick (inputs.go)
	byChar   map[string]*session
	parties  map[uint32][]*Entity
	emoters  map[*session]struct{} // playtest 2: sessions holding a looping emote or a line (emotes.go)
	grid     *aoi.Grid             // players (and anything with a party id): far ring reach
	// gridOthers holds every other entity (WP19, snapshots.go gridFor):
	// they are never sent beyond the mid ring, so clients query it 200 m out.
	gridOthers *aoi.Grid
	snapScr    []*snapScratch // WP19: one per snapshot worker (snapshots.go)
	views      []entView      // WP19: per grid index, this tick (snapshots.go buildViews)
	qs         []snapshot.EntState
	hist       snapshot.History // G5: the tick's states, shared by every client's encoder (snapshots.go)
	saveDiv    uint32
	mine       mining              // WP09 (mining.go)
	calls      chan func()         // run on the tick goroutine (Do, caves.go)
	env        movement.Env        // WP10: this tick's movement env (stepEnv)
	hap        []explore.Happening // scratch for exploreTick
	party      partyState
	cl         clusterState  // WP16 (handoff.go)
	cbt        combatGlue    // WP13 (combat.go)
	town       townsState    // WP20 (towns.go)
	itm        itemsState    // WP14 (items.go)
	night      nightState    // WP15 (night.go)
	diff       diffState     // playtest 1 (difficulty.go)
	qst        questsGlue    // playtest 1: quest logs (quests.go)
	obst       obstacleState // enemies respect buildings (obstacles.go)
	pvp        pvpState      // playtest 2: PvP flags, safe zones, duels (pvp.go, duel.go)
	cnt        contentGlue   // playtest 2 content (CR 023): content.go, content_quests.go, worldevents.go, dungeons.go
	// WP11: next earshot hand-off (earshot.go).
	earshotNext time.Time
	phases      tickPhases // WP19: per-phase tick timing (phases.go)

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
		cfg:        cfg,
		log:        cfg.Log,
		joins:      make(chan *session, 256),
		calls:      make(chan func(), 16),
		stopped:    make(chan struct{}),
		byChar:     map[string]*session{},
		parties:    map[uint32][]*Entity{},
		grid:       aoi.NewWorld(),
		gridOthers: aoi.NewWorld(),
		conns:      map[*session]struct{}{},
		nextID:     1,
		stats:      gameloop.NewStats(interval, 60*constants.TickRateHz),
		saveDiv:    uint32(cfg.SaveInterval / interval),
	}
	if s.saveDiv == 0 {
		s.saveDiv = 1
	}
	if cfg.IDBase > 0 {
		s.nextID = cfg.IDBase
	}
	s.m.init(cfg.Metrics)
	s.initCombat()     // WP13 (combat.go)
	s.initObstacles()  // enemies respect buildings (obstacles.go): after combat
	s.initItems()      // WP14 (items.go): after combat (loot hook)
	s.initDifficulty() // playtest 1 (difficulty.go): after combat (World.Areas)
	s.initQuests()     // quests.go: after combat (kill hook)
	s.initContent()    // content.go: after quests (kill hook)
	s.loop = &gameloop.Loop{Interval: interval, Stats: s.stats, OnTick: s.onTick}
	return s
}

// Start begins ticking on a fresh shared scheduler.
func (s *Server) Start() {
	s.sched = gameloop.New(s.cfg.SpinTail)
	s.sched.Add(s.loop)
	s.startParties()
	s.startCluster()    // WP16
	s.startItems()      // WP14: the item journal (items.go)
	s.startDifficulty() // playtest 1: area stamps (difficulty.go)
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
		s.clusterStop() // WP16: standby connections, held handoff states
		for {
			select {
			case sess := <-s.joins:
				s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
				sess.markJoined()
				continue
			default:
			}
			break
		}
		s.finalLocalSaves(ctx) // playtest 2: local profiles keep where they stood (explore.go)
		for _, sess := range slices.Clone(s.sessions) {
			s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
			s.leave(sess)
		}
		s.flushDoors() // doors changed in the last second (doors_sync.go)
		if s.cfg.Queue != nil {
			if err := s.cfg.Queue.Flush(ctx); err != nil {
				s.log.Error("write-behind flush", "err", err, "left", s.cfg.Queue.Depth())
			} else {
				s.log.Info("write-behind flushed")
			}
		}
		s.stopItems(ctx) // WP14: the item journal, in order (items.go)
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
	s.phases.start() // WP19 (phases.go)
	defer s.endTick(tick)
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

	// WP19b: hold every connection's writer wake-ups until the tick is done
	// (transport.Holder): sends queue, the writers run after the tick
	// instead of competing with its workers for the zone's cores.
	s.holdConns()
	defer s.releaseConns()

	// Leaves and every session's messages, in session order; plain
	// movement runs on the workers (WP19b, inputs.go).
	s.takeInputs()
	s.applyInputs(now)
	s.phases.mark(phInputs)
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
	s.difficultyTick(tick)          // playtest 1: area stamps (difficulty.go)
	s.caveTick(tick)                // WP09: cave cell interest + each entity's cave system (caves.go)
	s.itemsTick(tick, s.cfg.Now())  // WP14: gear, dropped-item despawn, containers (items.go)
	s.miningTick(tick, s.cfg.Now()) // WP09: pickups, respawns, WorldEdits interest (mining.go)
	s.handoffTick(tick, now)        // WP16: handoffs, mirrored entities, presence (handoff.go, ghosts.go)
	s.phases.mark(phWorld)
	s.combatTick(tick) // WP13: enemies, strikes, claims, respawns (combat.go)
	s.pvpTick(tick)    // playtest 2: PvP flag timers, safe zones, duels (pvp.go, duel.go)
	s.phases.mark(phCombat)
	s.townsTick(tick, s.cfg.Now()) // WP20: townsfolk near players (towns.go)
	s.phases.mark(phTowns)
	s.nightTick(tick)       // WP15: clock, demons, defense events, chemistry (night.go)
	s.questsTick(tick)      // quests: flagged rechecks, 2 Hz reach/clear checks (quests.go)
	s.contentTick(tick)     // CR 023 content: regions, feats, titles, places, followers, world events, vaults (content.go)
	s.friendTravelTick(now) // playtest 2: travel-to-friend channels (friendtravel.go)
	s.emotesTick(tick)      // playtest 2: looping emotes and lines in the water (emotes.go, fishing.go)
	s.phases.mark(phNight)

	// Quantize once per entity and rebuild the grid; every client's snapshot
	// reads these.
	// View extrapolation and quantization touch only their own entity, so
	// they run on the workers (WP19b, par.go); the grids fill in id order.
	parallelFor(len(s.ents), s.phaseWorkers(len(s.ents)), viewChunk, func(_, i int) {
		e := s.ents[i]
		e.idx = int32(i)
		e.updateView(s.cfg.Ground, s.env)
		e.quantize(s.cfg.Ground)
	})
	s.grid.Reset()
	s.gridOthers.Reset()
	for i, e := range s.ents {
		s.gridFor(e).Insert(int32(i), e.Move.Pos.X, e.Move.Pos.Z)
	}
	s.gridRemotes()    // WP16: mirrored entities after the local ones (ghosts.go)
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

	// Every client's snapshot, built in parallel (WP19, snapshots.go). Must
	// stay the tick's last phase: workers read the world while they run.
	s.phases.mark(phGrid)
	s.sendSnapshots(tick, s.serverTimeMs())
	s.phases.mark(phSnapshots)
}

// join admits a handshaken session (tick goroutine).
func (s *Server) join(sess *session) {
	defer sess.markJoined()
	if s.stopping.Load() {
		s.kick(sess, proto.KickCodeShutdown, "zone shutting down")
		return
	}
	if sess.closed.Load() {
		return
	}
	if sess.ho != nil && sess.ho.standby {
		s.joinStandby(sess) // WP16: pre-connected, not owned here yet (handoff.go)
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
		ID:          s.joinID(sess), // WP16: world-stable ids in a cluster
		Kind:        proto.EntityKindPlayer,
		Name:        sess.claims.CharacterName,
		CharacterID: sess.claims.CharacterID,
		Level:       1,
		Health:      100,
		HealthMax:   100,
		ListenOnly:  sess.claims.IsLocalProfile && s.cfg.VoiceLocalListenOnly, // WP11 rule, off since playtest 2 (Config)
	}
	e.Move = movement.NewState(spawn) // WP10: full stamina wheel, ground mode
	if g := movement.GroundAt(s.cfg.Ground, spawn.X, spawn.Y, spawn.Z); e.Move.Pos.Y < g {
		e.Move.Pos.Y = g
	}
	e.prevValid = e.Move
	e.view = e.Move
	s.joinState(sess, e) // WP16: a handed-over character continues its exact state
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
	s.insertEntity(e)
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
	s.exploreJoin(sess)     // WP12: progress, pins (after Welcome, which the client needs first)
	s.combatJoin(sess)      // WP13: loadouts, health, combat_sync (combat.go)
	s.progressionJoin(sess) // playtest 1: level stats, tower boons, Event 900 (progression.go)
	s.difficultyJoin(sess)  // playtest 1: the area you stand in (difficulty.go)
	s.itemsJoin(sess)       // WP14: inventory, gear, consumables (items.go)
	s.nightJoin(sess)       // WP15: world clock, pillars, defense state (night.go)
	s.questsJoin(sess)      // quests: the log, the starter quest (quests.go)
	s.contentJoin(sess)     // CR 023: codex, feats, reputation, vaults (content.go)
	s.clusterJoined(sess)   // WP16: owner record, arrival checkpoint
	s.log.Info("join", "entity", e.ID, "character", e.CharacterID, "name", e.Name, "remote", sess.conn.RemoteAddr(),
		"x", math.Round(e.Move.Pos.X*100)/100, "z", math.Round(e.Move.Pos.Z*100)/100)
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
	s.questsLeave(sess)  // quests: log save (quests.go)
	s.contentLeave(sess) // CR 023 (content.go)
	s.emotesLeave(sess)  // playtest 2: emotes, fishing (emotes.go)
	if s.cfg.Queue != nil {
		s.checkpoint(e)
	}
	s.clusterLeave(e) // WP16
	s.log.Info("leave", "entity", e.ID, "character", e.CharacterID)
}

// checkpoint queues a position save (never blocks).
func (s *Server) checkpoint(e *Entity) {
	s.exploreCheckpoint(e) // WP12: changed progress rides the same cadence
	if s.cfg.Store == nil || s.cfg.Queue == nil {
		return
	}
	id, pos, store, log := e.CharacterID, e.Move.Pos, s.cfg.Store, s.log
	epoch, fenced := e.epoch, &s.cl.stats.fenced // WP16: checkpoint fence (persist.go)
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "pos:" + id, Run: func(ctx context.Context) error {
		err := savePosition(ctx, store, id, pos, epoch)
		if errors.Is(err, ErrFenced) {
			fenced.Add(1)
			return err
		}
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
