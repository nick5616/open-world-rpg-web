package game

// Night, demons, weather and chemistry in the zone (WP15, spec 8; CR 011).
// The glue between sessions and the pure packages:
//
//   - The world clock (server/pkg/weather): world time = wall clock + the
//     world's offset (Config.TimeOffsetS, the same env on every zone of a
//     world, so WP16's zones agree). Event 500 tells clients the offset, so
//     the sky, NPC schedules (towns.go), rain and the chemistry wind run on
//     one clock.
//   - Demons (internal/night + combat/demon.go): at dusk lesser packs rise
//     around players in the open, now and then a greater demon by the
//     region's element, and on new-moon nights a lord at a demon lair. Dawn
//     burns those in the open; those near a lair or cave mouth flee. Wards
//     keep demons out of settlements and away from the players inside.
//   - Town defense events: on some nights a town's ward weakens; three waves
//     come for the ward garden; anyone nearby joins; Events 510-514.
//   - Chemistry (internal/chem): the zone schedules ops (Fire/Ice/Earth
//     spells landing, burning enemies, dev tools) CHEM_OP_LEAD_STEPS ahead,
//     sends them as Events 520-523 to everyone in CHEM_INTEREST_M, chunk
//     baselines (524) to newcomers and, for clients in the fallback mode,
//     2 Hz bitmaps (525). Burning cells set enemies alight; fire feeds the
//     movement step's updrafts; ice sheets and pillars are on the ground.

import (
	"encoding/binary"
	"math"
	"slices"
	"strconv"
	"strings"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/night"
)

// Event kinds 500-599 (contracts/events.md).
const (
	EventWorldClock     = 500
	EventDusk           = 501
	EventDawn           = 502
	EventDemonBurned    = 503
	EventDemonShrugged  = combat.EvDemonShrugged // 504
	EventDemonsRose     = 505
	EventLordRisen      = 506
	EventDefenseWarning = 510
	EventDefenseWave    = 511
	EventWardHealth     = 512
	EventDefenseEnded   = 513
	EventDefenseReward  = 514
	EventChemRefused    = 526
)

// Interact target kinds (contracts/events.md).
const (
	InteractChem  = 51
	InteractNight = 52
)

// Chem sync modes (Event 500, Interact 51 action 10).
const (
	ChemModeEvents = 1
	ChemModeBitmap = 2
)

// Defense results (Event 513 value).
const (
	DefenseHeld      = 1
	DefenseBroken    = 2
	DefenseAbandoned = 3
)

// NightSetup configures night and chemistry (main.go fills it; nil = none).
type NightSetup struct {
	World     *night.World
	Chem      *chem.Sim     // nil: no chemistry
	Overlay   *chem.Overlay // the ground overlay main.go wrapped the ground with
	WindDeg   int
	Dev       bool    // dev Interacts (ignite, set time, force a defense, spawn demons)
	ChemMode  uint8   // default client sync mode (ChemModeEvents)
	NoDemons  bool    // LODESTONE_ZONE_NO_DEMONS
	Force     int     // a town index to force a defense event at (-1 none)
	ForceAtS  float64 // ... this many seconds after the zone starts
	ForceWave bool    // (unused by the glue; reserved)
}

type demonGroup struct {
	g     *combat.Group
	owner uint32 // the player it rose for (0: a lord, a wave)
	rank  string
	lord  int // region of a lord (-1)
}

type defense struct {
	town     *night.Town
	night    int64
	phase    int // 0 warning, 1 wave, 2 break
	wave     int
	until    float64
	ward     float64
	sentWard int
	sentAt   float64
	groups   []*combat.Group
	part     map[uint32]bool
	lastNear float64
}

type chemClient struct {
	known  map[uint32]bool // chunks this client has a baseline for
	mode   uint8
	bitmap map[uint32]bool // chunks sent as bitmaps (fallback)
}

type nightState struct {
	on        bool
	cfg       NightSetup
	offset    float64
	wasNight  bool
	nightIdx  int64
	started   bool
	groups    []*demonGroup
	spawnN    map[uint32]int
	lords     map[int]bool
	defs      map[int]*defense
	broken    map[int]bool
	planned   map[int]float64
	forceAt   float64
	clients   map[*session]*chemClient
	dawnClean uint32
	opID      uint32
	hashes    []ChemHash
}

// ChemHash is the zone's state digest at a step (evidence: the fire comparison).
type ChemHash struct {
	Step    int64  `json:"step"`
	Hash    uint32 `json:"hash"`
	Burning int    `json:"burning"`
}

// worldTimeS is the world clock now (seconds).
func (s *Server) worldTimeS() float64 {
	return weather.Clock{Seed: s.cfg.Seed, OffsetS: s.clockOffset()}.WorldTime(s.serverTimeMs())
}

func (s *Server) clockOffset() float64 {
	if s.night.on {
		return s.night.offset
	}
	return s.cfg.TimeOffsetS
}

func (s *Server) nightInit() {
	n := &s.night
	if n.started {
		return
	}
	n.started = true
	n.offset = s.cfg.TimeOffsetS
	n.spawnN, n.lords, n.defs, n.broken, n.planned = map[uint32]int{}, map[int]bool{}, map[int]*defense{}, map[int]bool{}, map[int]float64{}
	n.clients = map[*session]*chemClient{}
	if s.cfg.Night == nil {
		return
	}
	n.on = true
	n.cfg = *s.cfg.Night
	if n.cfg.ChemMode == 0 {
		n.cfg.ChemMode = ChemModeEvents
	}
	n.forceAt = math.NaN()
	if n.cfg.Force >= 0 && n.cfg.World != nil && n.cfg.Force < len(n.cfg.World.Towns) {
		n.forceAt = s.worldTimeS() + n.cfg.ForceAtS
	}
	t := s.worldTimeS()
	n.wasNight, n.nightIdx = weather.IsNight(t), weather.NightIndex(t)
	if n.wasNight {
		s.planDefenses(n.nightIdx)
	}
	if c := n.cfg.Chem; c != nil {
		c.Step = weather.Step(t)
		if s.cfg.Rain != nil {
			r := *s.cfg.Rain
			c.Rain = &r
		}
	}
	w := s.cbt.w
	w.DemonHooks.Blocked = s.demonBlocked
	w.DemonHooks.Sheltered = s.demonSheltered
	w.DemonHooks.Wet = s.wetInRain
	s.log.Info("night ready", "night", n.wasNight, "nightIndex", n.nightIdx, "moon", weather.MoonPhase(s.cfg.Seed, n.nightIdx), "hour", math.Round(weather.Hour(t)*100)/100,
		"towns", len(n.cfg.World.Towns), "chem", n.cfg.Chem != nil, "offsetS", n.offset)
}

// ---- wards ----

func (s *Server) wardWeak(town int) bool {
	n := &s.night
	if n.broken[town] {
		return true
	}
	d := n.defs[town]
	return d != nil && d.phase >= 1
}

func (s *Server) demonBlocked(e *combat.Enemy, x, z float64) bool {
	w := s.night.cfg.World
	if t := w.WardAt(x, z); t >= 0 && !s.wardWeak(t) {
		return true
	}
	if e.Demon.Goal == nil && s.campSafeAt(x, z, 0) {
		return true // CR 025: never into a burning campfire's circle (camps.go)
	}
	return e.Demon.Rank == "lesser" && e.Demon.Goal == nil && w.NearLantern(x, z)
}

func (s *Server) demonSheltered(_ *combat.Enemy, p *combat.Player) bool {
	t := s.night.cfg.World.WardAt(p.Pos.X, p.Pos.Z)
	return (t >= 0 && !s.wardWeak(t)) || s.campSafeAt(p.Pos.X, p.Pos.Z, 0) // CR 025: by a burning campfire
}

func (s *Server) wetInRain(p movement.Vec3) bool {
	if !s.env.Raining && !(s.weatherOn() && s.rainingAt(p.X, p.Z, 0)) { // CR 030: rain where it lands
		return false
	}
	return movement.WaterAt(s.cfg.Ground, p.X, p.Z) > s.cfg.Ground.HeightAt(p.X, p.Z)
}

// ---- join, clock ----

// nightJoin sends the clock to a newly joined player (and active pillars).
func (s *Server) nightJoin(sess *session) {
	s.nightInit()
	s.sendClock(sess)
	n := &s.night
	if !n.on {
		return
	}
	n.clients[sess] = &chemClient{known: map[uint32]bool{}, bitmap: map[uint32]bool{}, mode: n.cfg.ChemMode}
	if c := n.cfg.Chem; c != nil {
		for _, p := range c.Pillars {
			ev := chem.OpEvent(chem.Op{Step: c.Step, Kind: chem.OpPillar, Pillar: p})
			s.sendEvent(sess, &ev)
		}
	}
	for _, d := range n.defs {
		s.sendEvent(sess, &proto.Event{Kind: EventDefenseWave, TargetID: uint32(d.town.Index), Value: int32(d.wave), X: cm(d.town.GardenX), Z: cm(d.town.GardenZ), Data: []byte{constants.DefenseWaves, byte(d.phase)}})
		s.sendEvent(sess, &proto.Event{Kind: EventWardHealth, TargetID: uint32(d.town.Index), Value: int32(d.ward), X: cm(d.town.GardenX), Z: cm(d.town.GardenZ)})
	}
}

func (s *Server) clockData() []byte {
	n := &s.night
	d := []byte{1}
	d = binary.LittleEndian.AppendUint64(d, math.Float64bits(s.clockOffset()))
	d = append(d, byte(weather.MoonOffset(s.cfg.Seed)))
	d = binary.LittleEndian.AppendUint16(d, uint16(n.cfg.WindDeg))
	d = append(d, n.cfg.ChemMode)
	inten := 0.5
	if n.cfg.World != nil {
		inten = n.cfg.World.Intensity
	}
	d = binary.LittleEndian.AppendUint32(d, math.Float32bits(float32(inten)))
	rain := byte(0)
	if s.cfg.Rain != nil {
		rain = 2
		if *s.cfg.Rain {
			rain = 1
		}
	}
	d = append(d, rain)
	// CR 030: d[18] = 1 seeded weather, 2 + s forced to state s everywhere
	// (dev); absent = no dynamic weather (WP10's global rain: atlas-less
	// worlds send the WP15 event unchanged, so the scale wire is too).
	if w := s.cfg.Weather; s.weatherOn() {
		wx := byte(1)
		if w.Override >= 0 {
			wx = byte(2 + w.Override)
		}
		d = append(d, wx)
	}
	return d
}

func (s *Server) sendClock(sess *session) {
	t := s.worldTimeS()
	idx := weather.NightIndex(t)
	data := s.clockData()
	if cc := s.night.clients[sess]; cc != nil {
		data[12] = cc.mode
	}
	s.sendEvent(sess, &proto.Event{Kind: EventWorldClock, EntityID: sess.ent.ID, TargetID: uint32(idx), Value: int32(weather.MoonPhase(s.cfg.Seed, idx)), Data: data})
}

// SetClockOffset changes the world clock offset (dev: Interact 52 action 2;
// tests) and tells every client.
func (s *Server) SetClockOffset(offsetS float64) {
	s.nightInit()
	s.night.offset = offsetS
	s.cfg.TimeOffsetS = offsetS
	if c := s.night.cfg.Chem; c != nil {
		c.Rebase(weather.Step(s.worldTimeS())) // fires keep their remaining time
		for _, cc := range s.night.clients {
			clear(cc.known) // clients rebuild their view: send fresh baselines
		}
	}
	for _, sess := range s.sessions {
		if sess.ent != nil {
			s.sendClock(sess)
		}
	}
	s.log.Info("world clock offset", "offsetS", offsetS, "hour", math.Round(weather.Hour(s.worldTimeS())*100)/100)
}

func (s *Server) broadcast(ev *proto.Event, at movement.Vec3, r float64) {
	b := proto.Encode(ev)
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil {
			continue
		}
		if r > 0 && math.Hypot(e.Move.Pos.X-at.X, e.Move.Pos.Z-at.Z) > r {
			continue
		}
		if err := sess.conn.SendReliable(b); err != nil {
			sess.closed.Store(true)
		}
	}
}

// ---- the tick ----

func (s *Server) nightTick(tick uint32) {
	s.nightInit()
	n := &s.night
	if !n.on {
		return
	}
	for sess := range n.clients {
		if sess.left {
			delete(n.clients, sess)
		}
	}
	t := s.worldTimeS()
	isNight, idx := weather.IsNight(t), weather.NightIndex(t)
	if isNight && !n.wasNight {
		s.dusk(idx)
	} else if !isNight && n.wasNight {
		s.dawn(tick)
	}
	n.wasNight, n.nightIdx = isNight, idx
	s.pruneDemonGroups(tick)
	if isNight && !n.cfg.NoDemons && tick%(constants.DemonSpawnEveryS*constants.TickRateHz) == 0 {
		s.huntTopUp(idx)
		if weather.IsLordNight(weather.MoonPhase(s.cfg.Seed, idx)) {
			s.lordTick(idx)
		}
	}
	s.defenseTick(t, idx)
	s.chemTick(tick, t)
}

func (s *Server) dusk(idx int64) {
	n := &s.night
	n.spawnN, n.lords, n.broken = map[uint32]int{}, map[int]bool{}, map[int]bool{}
	phase := weather.MoonPhase(s.cfg.Seed, idx)
	msg := "Night falls. Demons rise from the shadows."
	if weather.IsLordNight(phase) {
		msg = "A new moon. The demon lords walk tonight."
	}
	s.broadcast(&proto.Event{Kind: EventDusk, TargetID: uint32(idx), Value: int32(phase), Data: []byte(msg)}, movement.Vec3{}, 0)
	s.planDefenses(idx)
	s.log.Info("dusk", "night", idx, "moon", phase, "hunters/player", n.cfg.World.HuntersPerPlayer(idx), "defenses", len(n.planned))
}

func (s *Server) planDefenses(idx int64) {
	n := &s.night
	n.planned = map[int]float64{}
	for i := range n.cfg.World.Towns {
		if at, ok := n.cfg.World.DefensePlan(i, idx); ok {
			n.planned[i] = at
		}
	}
}

func (s *Server) dawn(tick uint32) {
	n := &s.night
	w := s.cbt.burnWorld()
	burned, fled := 0, 0
	for _, dg := range n.groups {
		for _, e := range dg.g.Members {
			if !e.Alive() {
				continue
			}
			if n.cfg.World.NearRefuge(e.Pos.X, e.Pos.Z, 25) || e.Pos.Y < s.cfg.Ground.HeightAt(e.Pos.X, e.Pos.Z)-3 {
				fled++
				s.broadcast(&proto.Event{Kind: EventDemonBurned, EntityID: e.ID, Value: 0, X: cm(e.Pos.X), Y: cm(e.Pos.Y), Z: cm(e.Pos.Z)}, e.Pos, 96)
				w.Despawn(e)
				continue
			}
			burned++
			s.broadcast(&proto.Event{Kind: EventDemonBurned, EntityID: e.ID, Value: 1, X: cm(e.Pos.X), Y: cm(e.Pos.Y), Z: cm(e.Pos.Z)}, e.Pos, 96)
			w.KillDemon(e)
		}
	}
	for town, d := range n.defs {
		s.endDefense(d, DefenseHeld, "Dawn breaks: the demons burn and the ward holds.")
		delete(n.defs, town)
	}
	n.dawnClean = tick + 2*constants.TickRateHz
	n.planned = map[int]float64{} // tonight's attacks that never found anyone
	s.broadcast(&proto.Event{Kind: EventDawn, Value: int32(burned), TargetID: uint32(fled), Data: []byte("Dawn breaks. The demons burn.")}, movement.Vec3{}, 0)
	s.log.Info("dawn", "burned", burned, "fled", fled)
}

// burnWorld is the combat world (a named accessor keeps night.go readable).
func (c *combatGlue) burnWorld() *combat.World { return c.w }

// pruneDemonGroups drops cleared or despawned night groups (they must
// never come back as camps) and, after dawn, every night group.
func (s *Server) pruneDemonGroups(tick uint32) {
	n := &s.night
	w := s.cbt.w
	keep := n.groups[:0]
	dawnDone := n.dawnClean != 0 && tick >= n.dawnClean
	for _, dg := range n.groups {
		present := false
		for _, e := range dg.g.Members {
			if w.Enemy(e.ID) != nil {
				present = true
			}
		}
		if !present || dawnDone {
			w.RemoveGroup(dg.g)
			continue
		}
		keep = append(keep, dg)
	}
	n.groups = keep
	if n.dawnClean != 0 && tick >= n.dawnClean {
		n.dawnClean = 0
	}
}

func (s *Server) trackDemons(g *combat.Group, owner uint32, rank string, lord int) *demonGroup {
	dg := &demonGroup{g: g, owner: owner, rank: rank, lord: lord}
	s.night.groups = append(s.night.groups, dg)
	r := map[string]int32{"lesser": 0, "greater": 1, "lord": 2}[rank]
	s.broadcast(&proto.Event{Kind: EventDemonsRose, TargetID: uint32(r), Value: int32(len(g.Members)), X: cm(g.Anchor.X), Y: cm(g.Anchor.Y), Z: cm(g.Anchor.Z)}, g.Anchor, 160)
	return dg
}

func (s *Server) demonsNear(p movement.Vec3, r float64, rank string) int {
	c := 0
	for _, dg := range s.night.groups {
		if rank != "" && dg.rank != rank {
			continue
		}
		for _, e := range dg.g.Members {
			if e.Alive() && math.Hypot(e.Pos.X-p.X, e.Pos.Z-p.Z) < r {
				c++
			}
		}
	}
	return c
}

// spawnSpot finds dry, walkable open ground for demons to rise on.
func (s *Server) spawnSpot(x, z float64) bool {
	g := s.cfg.Ground
	if x < 8 || z < 8 || x > constants.WorldSizeM-8 || z > constants.WorldSizeM-8 {
		return false
	}
	w := s.night.cfg.World
	if w.WardAt(x, z) >= 0 || w.NearLantern(x, z) || s.campSafeAt(x, z, campSafeMargin) { // CR 025: not near a burning campfire
		return false
	}
	y := g.HeightAt(x, z)
	if movement.WaterAt(g, x, z) > y-0.2 || movement.SlopeAt(g, x, z).T2 > constants.WalkableTanSq {
		return false
	}
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && math.Hypot(e.Move.Pos.X-x, e.Move.Pos.Z-z) < 24 {
			return false
		}
	}
	return true
}

// huntTopUp keeps HuntersPerPlayer lesser demons around each player in the
// open (spec 8: at dusk demons rise from shadowed ground).
func (s *Server) huntTopUp(idx int64) {
	n := &s.night
	w := n.cfg.World
	base := w.HuntersPerPlayer(idx)
	if base <= 0 {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || e.cbt == nil || e.cbt.Downed {
			continue
		}
		// caveSys is only maintained with a cave world (caves.go); without
		// one every entity reads 0 and nobody was ever hunted (playtest 1 fix).
		underground := e.caveSys >= 0 && s.caves() != nil
		if underground || w.WardAt(e.Move.Pos.X, e.Move.Pos.Z) >= 0 || s.campSafeAt(e.Move.Pos.X, e.Move.Pos.Z, 0) { // CR 025: safe by a burning campfire
			continue
		}
		// Playtest 1 (difficulty.go): the area's tier scales the hunt (none
		// in the Haven and quiet lands, a straggler in the wilds) and
		// low-level players are left alone near towns.
		want, greaterMult, ok := s.huntersFor(e, base, w.Scale(idx))
		if !ok {
			continue
		}
		p := e.Move.Pos
		have := s.demonsNear(p, 80, "lesser")
		if have < want {
			k := n.spawnN[e.ID]
			n.spawnN[e.ID]++
			count := min(3, want-have)
			if at, ok := s.findSpawn(idx, e.ID, k, p, true); ok {
				keys := make([]string, count)
				for i := range keys {
					keys[i] = combatdefs.D.Demons.Lesser[i%len(combatdefs.D.Demons.Lesser)]
				}
				g := s.cbt.w.SpawnDemons(at, keys, s.cbt.w.LevelAt(at.X, at.Z))
				s.paceDemons(g)
				s.trackDemons(g, e.ID, "lesser", -1)
			}
		}
		if w.Roll(idx, uint64(e.ID), uint64(n.spawnN[e.ID])) < w.GreaterChance(idx)*greaterMult && s.demonsNear(p, 140, "greater") == 0 {
			n.spawnN[e.ID]++
			if at, ok := s.findSpawn(idx, e.ID, n.spawnN[e.ID]+1000, p, true); ok {
				key := night.GreaterFor(s.cbt.w.ElementAt(at.X, at.Z))
				g := s.cbt.w.SpawnDemons(at, []string{key}, s.cbt.w.LevelAt(at.X, at.Z))
				s.paceDemons(g)
				s.trackDemons(g, e.ID, "greater", -1)
			}
		}
	}
}

// natural: a night spawn (playtest 1: never in an area whose tier has no
// demons); dev raises go anywhere.
func (s *Server) findSpawn(idx int64, player uint32, k int, p movement.Vec3, natural bool) (movement.Vec3, bool) {
	w := s.night.cfg.World
	a0 := w.SpawnAngle(idx, player, k)
	d := w.SpawnDistance(idx, player, k)
	for i := 0; i < 8; i++ {
		a := a0 + float64(i)*math.Pi/4
		x, z := p.X+d*math.Cos(a), p.Z+d*math.Sin(a)
		if s.spawnSpot(x, z) && (!natural || s.demonSpotOK(x, z)) {
			return movement.Vec3{X: x, Z: z}, true
		}
	}
	return movement.Vec3{}, false
}

// lordTick raises one lord per demon lair on a new-moon night when a player
// comes within 220 m of it (spec 8: demon lords roam on new moons).
func (s *Server) lordTick(idx int64) {
	n := &s.night
	for i, l := range n.cfg.World.Lairs {
		if n.lords[i] || !s.lordsAllowed(l.X, l.Z) { // playtest 1: lords walk only in dread lands and worse
			continue
		}
		near := false
		for _, sess := range s.sessions {
			if e := sess.ent; e != nil && math.Hypot(e.Move.Pos.X-l.X, e.Move.Pos.Z-l.Z) < 220 {
				near = true
			}
		}
		if !near {
			continue
		}
		at := movement.Vec3{X: l.X, Z: l.Z}
		for k := 0; k < 8 && !s.spawnSpot(at.X, at.Z); k++ {
			a := float64(k) * math.Pi / 4
			at = movement.Vec3{X: l.X + 30*math.Cos(a), Z: l.Z + 30*math.Sin(a)}
		}
		n.lords[i] = true
		g := s.cbt.w.SpawnDemons(at, []string{combatdefs.D.Demons.Lord}, s.cbt.w.LevelAt(at.X, at.Z)+2)
		dg := s.trackDemons(g, 0, "lord", i)
		name := g.Members[0].Def.Name
		s.broadcast(&proto.Event{Kind: EventLordRisen, EntityID: g.Members[0].ID, X: cm(at.X), Y: cm(g.Anchor.Y), Z: cm(at.Z), Data: []byte(name)}, movement.Vec3{}, 0)
		s.log.Info("demon lord risen", "lair", i, "x", math.Round(at.X), "z", math.Round(at.Z), "group", dg.g.ID)
	}
}

// ---- town defense events ----

// StartDefense begins a defense event at a town now (dev, tests).
func (s *Server) StartDefense(town int) bool {
	s.nightInit()
	n := &s.night
	if !n.on || town < 0 || town >= len(n.cfg.World.Towns) || n.defs[town] != nil {
		return false
	}
	t := s.worldTimeS()
	d := &defense{town: &n.cfg.World.Towns[town], night: weather.NightIndex(t), until: t + constants.DefenseWarningS, ward: constants.WardHealth, sentWard: -1, part: map[uint32]bool{}, lastNear: t}
	n.defs[town] = d
	at := movement.Vec3{X: d.town.X, Z: d.town.Z}
	s.broadcast(&proto.Event{Kind: EventDefenseWarning, TargetID: uint32(town), Value: int32(constants.DefenseWarningS), X: cm(d.town.GardenX), Z: cm(d.town.GardenZ), Data: []byte(d.town.Name)}, at, 400)
	s.log.Info("defense: the ward falters", "town", town, "name", d.town.Name)
	return true
}

func (s *Server) defenseTick(t float64, idx int64) {
	n := &s.night
	if !math.IsNaN(n.forceAt) && t >= n.forceAt {
		n.forceAt = math.NaN()
		s.StartDefense(n.cfg.Force)
	}
	for town, at := range n.planned {
		if t < at {
			continue
		}
		delete(n.planned, town)
		tw := &n.cfg.World.Towns[town]
		if !s.defenseAllowed(tw.X, tw.Z) { // playtest 1: gentle lands' wards hold
			s.log.Info("defense skipped: the area's tier keeps its ward", "town", town)
			continue
		}
		if len(s.playersNear(tw.X, tw.Z, tw.Radius+constants.DefenseJoinM)) > 0 {
			s.StartDefense(town)
		} else {
			s.log.Info("defense skipped: nobody near", "town", town)
		}
	}
	for town, d := range n.defs {
		if s.stepDefense(d, t, idx) {
			delete(n.defs, town)
		}
	}
}

func (s *Server) playersNear(x, z, r float64) []*Entity {
	var out []*Entity
	for _, sess := range s.sessions {
		if e := sess.ent; e != nil && math.Hypot(e.Move.Pos.X-x, e.Move.Pos.Z-z) <= r {
			out = append(out, e)
		}
	}
	return out
}

// stepDefense runs one defense event for a tick; true when it ended.
func (s *Server) stepDefense(d *defense, t float64, idx int64) bool {
	tw := d.town
	near := s.playersNear(tw.X, tw.Z, tw.Radius+constants.DefenseJoinM)
	for _, e := range near {
		d.part[e.ID] = true
	}
	if len(near) > 0 {
		d.lastNear = t
	} else if t-d.lastNear > 30 {
		s.endDefense(d, DefenseAbandoned, "The defenders left; the demons melt back into the night.")
		return true
	}
	at := movement.Vec3{X: tw.X, Z: tw.Z}
	switch d.phase {
	case 0, 2: // warning, break
		if t >= d.until {
			d.wave++
			d.phase = 1
			s.spawnWave(d, idx, len(near))
		}
	case 1:
		alive, atGarden := 0, 0
		for _, g := range d.groups {
			for _, e := range g.Members {
				if e.Alive() && s.cbt.w.Enemy(e.ID) != nil {
					alive++
					if e.Demon != nil && e.Demon.AtGoal {
						atGarden++
					}
				}
			}
		}
		d.ward -= float64(atGarden) * constants.WardDamagePerS / constants.TickRateHz
		if hp := int(math.Max(0, math.Ceil(d.ward))); hp != d.sentWard && (t-d.sentAt >= 0.5 || hp == 0) {
			d.sentWard, d.sentAt = hp, t
			s.broadcast(&proto.Event{Kind: EventWardHealth, TargetID: uint32(tw.Index), Value: int32(hp), X: cm(tw.GardenX), Z: cm(tw.GardenZ), Data: binary.LittleEndian.AppendUint16(nil, uint16(alive))}, at, 400)
		}
		if d.ward <= 0 {
			s.night.broken[tw.Index] = true
			for _, g := range d.groups {
				for _, e := range g.Members {
					if e.Demon != nil {
						e.Demon.Goal = nil // the ward is broken: they hunt the town
					}
				}
			}
			s.endDefense(d, DefenseBroken, "The ward garden is trampled. Demons roam the streets until dawn.")
			return true
		}
		if alive == 0 {
			if d.wave >= constants.DefenseWaves {
				s.endDefense(d, DefenseHeld, "The last wave falls. The ward blooms again.")
				return true
			}
			d.phase, d.until = 2, t+constants.DefenseBreakS
		}
	}
	return false
}

func (s *Server) spawnWave(d *defense, idx int64, defenders int) {
	tw := d.town
	keys := night.Wave(d.wave, max(1, defenders), tw.Element)
	gates := s.night.cfg.World.WaveGates(tw, idx, d.wave)
	goal := movement.Vec3{X: tw.GardenX, Y: s.cfg.Ground.HeightAt(tw.GardenX, tw.GardenZ), Z: tw.GardenZ}
	d.groups = d.groups[:0]
	per := (len(keys) + len(gates) - 1) / len(gates)
	for gi, gate := range gates {
		lo, hi := gi*per, min(len(keys), (gi+1)*per)
		if lo >= hi {
			continue
		}
		x, z := s.cbt.w.WalkableNear(gate[0], gate[1], 30, 4)
		g := s.cbt.w.SpawnDemons(movement.Vec3{X: x, Z: z}, keys[lo:hi], max(1, s.cbt.w.LevelAt(tw.X, tw.Z)))
		for _, e := range g.Members {
			gl := goal
			e.Demon.Goal, e.Demon.DefenseID = &gl, tw.Index+1
			e.Home = goal
			e.State = combat.Idle
		}
		s.trackDemons(g, 0, "lesser", -1)
		d.groups = append(d.groups, g)
	}
	data := []byte{constants.DefenseWaves, 1}
	data = binary.LittleEndian.AppendUint16(data, uint16(len(keys)))
	s.broadcast(&proto.Event{Kind: EventDefenseWave, TargetID: uint32(tw.Index), Value: int32(d.wave), X: cm(tw.GardenX), Z: cm(tw.GardenZ), Data: data}, movement.Vec3{X: tw.X, Z: tw.Z}, 400)
	s.log.Info("defense wave", "town", tw.Index, "wave", d.wave, "demons", len(keys), "gates", len(gates), "defenders", defenders)
}

func (s *Server) endDefense(d *defense, result int, msg string) {
	tw := d.town
	if result == DefenseAbandoned {
		for _, g := range d.groups {
			for _, e := range g.Members {
				if e.Alive() {
					s.cbt.w.Despawn(e)
				}
			}
		}
	}
	s.broadcast(&proto.Event{Kind: EventDefenseEnded, TargetID: uint32(tw.Index), Value: int32(result), X: cm(tw.GardenX), Z: cm(tw.GardenZ), Data: []byte(msg)}, movement.Vec3{X: tw.X, Z: tw.Z}, 400)
	ids := make([]uint32, 0, len(d.part))
	for id := range d.part {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	if result == DefenseHeld {
		xp := int64(100 * max(1, d.wave))
		for _, id := range ids {
			if ent := s.entityByID(id); ent != nil && ent.Kind == proto.EntityKindPlayer {
				s.grantCombatXP(combat.XPGrant{Player: id, XP: xp, Reason: "defense"})
				s.sendEventTo(ent, &proto.Event{Kind: EventDefenseReward, EntityID: id, TargetID: uint32(tw.Index), Value: int32(xp)})
			}
		}
	}
	s.log.Info("defense ended", "town", tw.Index, "result", result, "wave", d.wave, "ward", math.Round(d.ward), "participants", len(ids))
}

// DefenseInfo is a defense event for tests and /debug/night.
type DefenseInfo struct {
	Town         int     `json:"town"`
	Name         string  `json:"name"`
	Phase        int     `json:"phase"`
	Wave         int     `json:"wave"`
	Ward         float64 `json:"ward"`
	Participants int     `json:"participants"`
	Until        float64 `json:"until"`
}

// NightDebug is the /debug/night snapshot (call through Do).
type NightDebug struct {
	WorldTime float64        `json:"worldTime"`
	Hour      float64        `json:"hour"`
	Night     bool           `json:"night"`
	NightIdx  int64          `json:"nightIndex"`
	Moon      int            `json:"moon"`
	Demons    int            `json:"demons"`
	Groups    int            `json:"groups"`
	Defenses  []DefenseInfo  `json:"defenses"`
	Broken    []int          `json:"broken"`
	Planned   map[string]int `json:"planned"`
	ChemStep  int64          `json:"chemStep"`
	Burning   int            `json:"burning"`
	ChemHash  uint32         `json:"chemHash"`
	ChemLate  int            `json:"chemLate"`
	Hashes    []ChemHash     `json:"hashes,omitempty"`
	Towns     []TownDebug    `json:"towns,omitempty"`
	DemonList []DemonDebug   `json:"demonList,omitempty"`
}

// DemonDebug is one demon in /debug/night.
type DemonDebug struct {
	ID     uint32  `json:"id"`
	Key    string  `json:"key"`
	Rank   string  `json:"rank"`
	Level  int     `json:"level"`
	HP     float64 `json:"hp"`
	HPMax  float64 `json:"hpMax"`
	Seared float64 `json:"seared"`
	Wounds float64 `json:"wounds"`
	State  string  `json:"state"`
	X      float64 `json:"x"`
	Z      float64 `json:"z"`
	AtGoal bool    `json:"atGoal"`
}

// TownDebug is a ward in /debug/night (?towns=1).
type TownDebug struct {
	Index   int     `json:"index"`
	Name    string  `json:"name"`
	X       float64 `json:"x"`
	Z       float64 `json:"z"`
	WardR   float64 `json:"wardR"`
	GardenX float64 `json:"gardenX"`
	GardenZ float64 `json:"gardenZ"`
}

// NightTowns lists the wards (tick goroutine: call via Do).
func (s *Server) NightTowns() []TownDebug {
	s.nightInit()
	var out []TownDebug
	if s.night.cfg.World != nil {
		for _, t := range s.night.cfg.World.Towns {
			out = append(out, TownDebug{Index: t.Index, Name: t.Name, X: t.X, Z: t.Z, WardR: t.WardRadius(), GardenX: t.GardenX, GardenZ: t.GardenZ})
		}
	}
	return out
}

// NightDebugInfo reports night state (tick goroutine: call via Do).
func (s *Server) NightDebugInfo(withHashes bool) NightDebug {
	s.nightInit()
	n := &s.night
	t := s.worldTimeS()
	idx := weather.NightIndex(t)
	d := NightDebug{WorldTime: t, Hour: weather.Hour(t), Night: weather.IsNight(t), NightIdx: idx, Moon: weather.MoonPhase(s.cfg.Seed, idx), Groups: len(n.groups), Planned: map[string]int{}}
	for _, dg := range n.groups {
		for _, e := range dg.g.Members {
			if e.Alive() {
				d.Demons++
			}
			if e.Demon != nil {
				d.DemonList = append(d.DemonList, DemonDebug{ID: e.ID, Key: e.Def.Key, Rank: e.Demon.Rank, Level: e.Level, HP: e.HP, HPMax: e.HPMax, Seared: e.Demon.Seared, Wounds: e.Demon.Wounds, State: e.State.String(), X: e.Pos.X, Z: e.Pos.Z, AtGoal: e.Demon.AtGoal})
			}
		}
	}
	for _, df := range n.defs {
		d.Defenses = append(d.Defenses, DefenseInfo{Town: df.town.Index, Name: df.town.Name, Phase: df.phase, Wave: df.wave, Ward: df.ward, Participants: len(df.part), Until: df.until})
	}
	for t := range n.broken {
		d.Broken = append(d.Broken, t)
	}
	for town, at := range n.planned {
		d.Planned[strconv.Itoa(town)] = int(at)
	}
	if c := n.cfg.Chem; c != nil {
		d.ChemStep, d.Burning, d.ChemHash, d.ChemLate = c.Step, c.Burning(), c.Hash(), c.Late
		if withHashes {
			d.Hashes = slices.Clone(n.hashes)
		}
	}
	return d
}

// ---- chemistry ----

func (s *Server) chemTick(tick uint32, t float64) {
	n := &s.night
	c := n.cfg.Chem
	if c == nil {
		return
	}
	target := weather.Step(t)
	if target-c.Step > 50 { // a long stall or a clock jump: don't grind through hours of steps
		c.Step = target - 50
	}
	for c.Step < target {
		c.AdvanceTo(c.Step + 1)
		if c.Burning() > 0 || len(n.hashes) > 0 && n.hashes[len(n.hashes)-1].Burning > 0 {
			n.hashes = append(n.hashes, ChemHash{Step: c.Step, Hash: c.Hash(), Burning: c.Burning()})
			if len(n.hashes) > 3000 {
				n.hashes = n.hashes[len(n.hashes)-3000:]
			}
		}
	}
	if n.cfg.Overlay != nil {
		n.cfg.Overlay.Sync(c)
	}
	// Burning cells set enemies alight (the zone is authoritative for damage).
	if tick%15 == 0 && c.Burning() > 0 {
		for _, e := range s.cbt.w.Enemies() {
			ix, iz := chem.CellAt(e.Pos.X, e.Pos.Z)
			if chem.InWorld(ix, iz) {
				if st, _ := c.State(chem.CellID(ix, iz)); st == chem.StBurning {
					s.cbt.w.Burn(e)
				}
			}
		}
	}
	if tick%10 == 0 {
		s.chemInterest(c)
	}
	if tick%(constants.TickRateHz/constants.ChemBitmapHz) == 0 {
		s.chemBitmaps(c)
	}
}

func chunkCentre(ch uint32) (float64, float64) {
	half := float64(chem.ChunkCells * chem.CellM / 2)
	return float64(int(ch%chem.ChunksN)*chem.ChunkCells*chem.CellM) + half, float64(int(ch/chem.ChunksN)*chem.ChunkCells*chem.CellM) + half
}

// chemInterest sends chunk baselines to clients coming within range of
// fire, ice or scorched ground, and forgets chunks they left.
func (s *Server) chemInterest(c *chem.Sim) {
	active := c.ActiveChunks()
	for sess, cc := range s.night.clients {
		e := sess.ent
		if e == nil {
			continue
		}
		for ch := range cc.known {
			x, z := chunkCentre(ch)
			if math.Hypot(x-e.Move.Pos.X, z-e.Move.Pos.Z) > constants.ChemInterestM+96 {
				delete(cc.known, ch)
			}
		}
		if cc.mode == ChemModeBitmap {
			continue
		}
		for _, ch := range active {
			if cc.known[ch] {
				continue
			}
			x, z := chunkCentre(ch)
			if math.Hypot(x-e.Move.Pos.X, z-e.Move.Pos.Z) <= constants.ChemInterestM {
				cc.known[ch] = true
				s.sendEvent(sess, &proto.Event{Kind: chem.EvBaseline, TargetID: ch, Data: chem.EncodeBaseline(c, ch)})
			}
		}
	}
}

// chemBitmaps is the fallback path: 2 Hz burned-cell bitmaps per active chunk.
func (s *Server) chemBitmaps(c *chem.Sim) {
	var active []uint32
	for sess, cc := range s.night.clients {
		if cc.mode != ChemModeBitmap || sess.ent == nil {
			continue
		}
		if active == nil {
			active = c.ActiveChunks()
		}
		p := sess.ent.Move.Pos
		now := map[uint32]bool{}
		for _, ch := range active {
			x, z := chunkCentre(ch)
			if math.Hypot(x-p.X, z-p.Z) <= constants.ChemInterestM {
				now[ch] = true
				s.sendEvent(sess, &proto.Event{Kind: chem.EvBitmap, TargetID: ch, Data: chem.EncodeBitmap(c, ch)})
			}
		}
		for ch := range cc.bitmap {
			if !now[ch] {
				s.sendEvent(sess, &proto.Event{Kind: chem.EvBitmap, TargetID: ch, Data: chem.EncodeBitmap(c, ch)}) // now empty (or out of range)
			}
		}
		cc.bitmap = now
	}
}

// ChemSchedule queues an op CHEM_OP_LEAD_STEPS ahead and sends it to every
// client in range (sync events, not results). Returns the op as scheduled.
func (s *Server) ChemSchedule(op chem.Op) (chem.Op, bool) {
	s.nightInit()
	c := s.night.cfg.Chem
	if c == nil {
		return op, false
	}
	op.Step = c.Step + constants.ChemOpLeadSteps
	if op.Kind == chem.OpPillar {
		s.night.opID++
		op.Pillar.ID = s.night.opID
		op.Pillar = chem.QuantizePillar(op.Pillar)
	}
	c.Schedule(op)
	ev := chem.OpEvent(op)
	at := movement.Vec3{X: proto.CmToMeters(ev.X), Z: proto.CmToMeters(ev.Z)}
	s.broadcast(&ev, at, constants.ChemInterestM)
	return op, true
}

// chemAt schedules an effect of an element at a point (spell impacts).
func (s *Server) chemAt(kind uint8, p movement.Vec3, radius float64) {
	ix, iz := chem.CellAt(p.X, p.Z)
	if !chem.InWorld(ix, iz) {
		return
	}
	r := int32(math.Min(4, math.Ceil(radius/chem.CellM)))
	switch kind {
	case chem.OpPillar:
		y := s.cfg.Ground.HeightAt(p.X, p.Z)
		if movement.WaterAt(s.cfg.Ground, p.X, p.Z) > y {
			return
		}
		s.ChemSchedule(chem.Op{Kind: chem.OpPillar, Pillar: chem.Pillar{X: p.X, Z: p.Z, BaseY: y, Height: constants.PillarHeightM, Half: constants.PillarHalfM, Run: constants.PillarWallRunM}})
	case chem.OpFreeze:
		s.ChemSchedule(chem.Op{Kind: kind, Cell: chem.CellID(ix, iz), Radius: max(2, r+1)})
	default:
		s.ChemSchedule(chem.Op{Kind: kind, Cell: chem.CellID(ix, iz), Radius: r})
	}
}

// pillarSpells are the Earth spells that raise a pillar where they land.
var pillarSpells = map[string]bool{"bramble_burst": true, "crystal_spire": true}

// nightAction turns a legal attack/cast/form start into chemistry: Fire
// sets grass alight where it lands, Ice freezes water and puts fires out,
// some Earth spells raise a pillar (spec 8's interaction table).
func (s *Server) nightAction(sess *session, a *combat.Action) {
	if a == nil || !a.Legal || s.night.cfg.Chem == nil || sess.ent == nil {
		return
	}
	var element int
	var radius, rng, speed, gravity float64
	self := false
	key := ""
	switch {
	case a.Spell != nil:
		sp := a.Spell
		if sp.Type != "projectile" && sp.Type != "arc" && sp.Type != "aoe" && sp.Type != "hitscan" && sp.Type != "domain" {
			return
		}
		element, radius, rng, speed, gravity, self, key = sp.Element, sp.Radius, sp.Range, sp.Speed, sp.Gravity, sp.SelfCast || sp.Type == "domain", sp.Key
		if sp.Type == "domain" {
			radius = math.Min(radius, 6)
		}
	case a.Form != nil:
		f := a.Form
		element, radius, rng, self = f.Element, math.Max(f.Radius, 2), math.Max(f.Reach, 3), f.SelfCast
		if !self {
			rng = math.Max(2, rng*0.6) // cones and lines land in front of you
		}
	default:
		return
	}
	kind := uint8(0)
	switch {
	case element == combatdefs.Fire:
		kind = chem.OpIgnite
	case element == combatdefs.Ice:
		kind = chem.OpFreeze
	case element == combatdefs.Earth && pillarSpells[key]:
		kind = chem.OpPillar
	default:
		return
	}
	at := a.Pos
	if !self {
		at = s.impactPoint(a, rng, speed, gravity)
	}
	s.chemAt(kind, at, radius)
}

// impactPoint marches the aim ray (or a ballistic arc) from the eye until
// it meets the ground, else stops at the spell's range.
func (s *Server) impactPoint(a *combat.Action, rng, speed, gravity float64) movement.Vec3 {
	g := s.cfg.Ground
	cp, sp := math.Cos(a.Pitch), math.Sin(a.Pitch)
	fx, fz := -math.Sin(a.Yaw)*cp, -math.Cos(a.Yaw)*cp
	p := movement.Vec3{X: a.Pos.X, Y: a.Pos.Y + constants.PlayerHeight*0.9, Z: a.Pos.Z}
	if rng <= 0 {
		rng = 20
	}
	if gravity > 0 && speed > 0 {
		vx, vy, vz := fx*speed, sp*speed, fz*speed
		const dt = 0.03
		for t := 0.0; t < 4; t += dt {
			p.X, p.Y, p.Z = p.X+vx*dt, p.Y+vy*dt, p.Z+vz*dt
			vy -= gravity * dt
			if y := g.HeightAt(p.X, p.Z); p.Y <= y {
				p.Y = y
				return p
			}
		}
		return p
	}
	for d := 0.0; d < rng; d += 0.75 {
		q := movement.Vec3{X: p.X + fx*d, Y: p.Y + sp*d, Z: p.Z + fz*d}
		if y := g.HeightAt(q.X, q.Z); q.Y <= y {
			q.Y = y
			return q
		}
	}
	end := movement.Vec3{X: p.X + fx*rng, Z: p.Z + fz*rng}
	end.Y = g.HeightAt(end.X, end.Z)
	return end
}

// nightCombatEvent: a burn landing on an enemy sets the grass under it alight.
func (s *Server) nightCombatEvent(o combat.Out) {
	if o.Ev.Kind != combat.EvStatus || s.night.cfg.Chem == nil {
		return
	}
	if def := combatdefs.D.StatusByKey("burn"); def == nil || o.Ev.Value != int32(def.ID) {
		return
	}
	s.chemAt(chem.OpIgnite, movement.Vec3{X: proto.CmToMeters(o.Ev.X), Z: proto.CmToMeters(o.Ev.Z)}, 0)
}

// nightUpdraft is the movement env's updraft: burning cells plus WP10's
// debug columns.
func (s *Server) nightUpdraft() movement.UpdraftField {
	c := s.night.cfg.Chem
	if c == nil {
		return s.cfg.Updraft
	}
	if s.cfg.Updraft == nil {
		return c
	}
	return maxUpdraft{c, s.cfg.Updraft}
}

type maxUpdraft struct{ a, b movement.UpdraftField }

func (m maxUpdraft) LiftAt(x, y, z float64) float64 {
	return math.Max(m.a.LiftAt(x, y, z), m.b.LiftAt(x, y, z))
}

// ---- Interacts ----

func (s *Server) nightInteract(sess *session, m *proto.Interact) {
	s.nightInit()
	n := &s.night
	e := sess.ent
	if !n.on || e == nil {
		return
	}
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventChemRefused, EntityID: e.ID, TargetID: uint32(m.TargetKind)<<8 | uint32(m.Action), Value: r})
	}
	switch m.TargetKind {
	case InteractChem:
		if m.Action == 10 { // sync mode
			cc := n.clients[sess]
			if cc == nil || (m.Arg != ChemModeEvents && m.Arg != ChemModeBitmap) {
				refuse(2)
				return
			}
			cc.mode = uint8(m.Arg)
			clear(cc.known)
			s.sendClock(sess)
			return
		}
		if !n.cfg.Dev {
			refuse(1)
			return
		}
		x := proto.CmToMeters(int32(uint32(m.TargetID)))
		z := proto.CmToMeters(int32(uint32(m.TargetID >> 32)))
		p := movement.Vec3{X: x, Z: z}
		switch m.Action {
		case 1:
			s.chemAt(chem.OpIgnite, p, float64(m.Arg)*chem.CellM)
		case 2:
			s.chemAt(chem.OpFreeze, p, float64(m.Arg)*chem.CellM)
		case 3:
			ix, iz := chem.CellAt(x, z)
			s.ChemSchedule(chem.Op{Kind: chem.OpExtinguish, Cell: chem.CellID(ix, iz), Radius: int32(m.Arg)})
		case 4:
			s.chemAt(chem.OpPillar, p, 0)
		default:
			refuse(2)
		}
	case InteractNight:
		if !n.cfg.Dev {
			refuse(1)
			return
		}
		switch m.Action {
		case 1: // force a defense at the nearest town
			best, bd := -1, math.Inf(1)
			for i, t := range n.cfg.World.Towns {
				if d := math.Hypot(t.X-e.Move.Pos.X, t.Z-e.Move.Pos.Z); d < bd {
					best, bd = i, d
				}
			}
			if !s.StartDefense(best) {
				refuse(3)
			}
		case 2: // set the clock offset (arg = seconds, i32 bits)
			s.SetClockOffset(float64(int32(m.Arg)))
		case 3: // raise demons here: 0 lesser pack, 1 greater, 2 lord
			idx := weather.NightIndex(s.worldTimeS())
			p := e.Move.Pos
			n.spawnN[e.ID]++
			at, ok := s.findSpawn(idx, e.ID, n.spawnN[e.ID]+5000, p, false)
			if !ok {
				refuse(4)
				return
			}
			switch m.Arg {
			case 1:
				g := s.cbt.w.SpawnDemons(at, []string{night.GreaterFor(s.cbt.w.ElementAt(at.X, at.Z))}, s.cbt.w.LevelAt(at.X, at.Z))
				s.trackDemons(g, e.ID, "greater", -1)
			case 2:
				g := s.cbt.w.SpawnDemons(at, []string{combatdefs.D.Demons.Lord}, s.cbt.w.LevelAt(at.X, at.Z))
				s.trackDemons(g, 0, "lord", -1)
			default:
				g := s.cbt.w.SpawnDemons(at, []string{"gloamling", "gloamling", "gloamling"}, s.cbt.w.LevelAt(at.X, at.Z))
				s.trackDemons(g, e.ID, "lesser", -1)
			}
		default:
			refuse(2)
		}
	}
}

// ParseForceDefense reads LODESTONE_ZONE_DEBUG_DEFENSE="<town index>|spawn[,delay s]".
func ParseForceDefense(v string, spawnTown int) (town int, delayS float64) {
	town, delayS = -1, 10
	if v = strings.TrimSpace(v); v == "" {
		return
	}
	f := strings.Split(v, ",")
	if f[0] == "spawn" {
		town = spawnTown
	} else if i, err := strconv.Atoi(f[0]); err == nil {
		town = i
	}
	if len(f) > 1 {
		if d, err := strconv.ParseFloat(f[1], 64); err == nil {
			delayS = d
		}
	}
	return
}

// paceDemons applies the area's demon speed (playtest 1: slower demons in
// the wilds, so a player without sunsteel or Light can still walk away).
func (s *Server) paceDemons(g *combat.Group) {
	m := s.demonSpeed(g.Anchor.X, g.Anchor.Z)
	if m == 1 {
		return
	}
	for _, e := range g.Members {
		e.SpeedMult *= m
	}
}
