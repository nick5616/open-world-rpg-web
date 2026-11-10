package game

// Playtest 2 dynamic weather (CR 030), the zone's half. The weather itself
// is server/pkg/weather (a pure function of the seed, the chemistry step
// and the weather cell; the client evaluates the same function), so nothing
// about it is sent per tick. The zone uses it for:
//
//   - the movement env (stepEnv, traversal.go): one weather.Field per
//     chemistry step: rain where you climb, snow under your feet, the gale
//     under your glider; read concurrently by the input workers (read-only);
//   - lightning: the seeded strikes of every thunderstorm cell, resolved
//     only where a player could see them: the bolt finds the tallest point
//     nearby, or a player in the open close enough (much farther for one
//     holding a metal weapon: a sword or a spear), deals LIGHTNING_DAMAGE
//     (splash: half), sets dry grass alight through the chemistry engine,
//     and is told to the players within LIGHTNING_EVENT_M (Event 1200).
//     A player in the open in a storm holding metal also draws bolts of
//     their own (LIGHTNING_METAL_PCT per slot), announced 2 s ahead
//     (Event 1201: the blade crackles; switch to the bow or a staff);
//   - cold: out in a cold-climate cell at night, or in a snowstorm, for
//     COLD_ONSET_S without warmth (a burning campfire or a town hearth
//     within COLD_WARMTH_M, a settlement, a cave, Rested, warm food) makes
//     you Chilled (no health regeneration, slower mana; Event 1202);
//   - fog banks, snowstorms and sandstorms cut enemies' aggro range
//     (combat World.AggroMult);
//   - fishing reads rain where the bobber lands.
//
// Worlds without an atlas (the flat test and scale worlds) get none of
// this (Config.Weather nil): WP10's global rain stub as before, so the
// wire digest of the scale scenario is unchanged.

import (
	"encoding/binary"
	"math"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/chem"
)

// Event kinds (contracts/events.md, 1200-1219).
const (
	EventLightning     = 1200
	EventLightningWarn = 1201
	EventWeatherStatus = 1202
)

// Lightning flags (Event 1200 data[0]).
const (
	BoltSeeded  = 1 // a storm cell's seeded strike (clients may have drawn it themselves)
	BoltDrawn   = 2 // drawn by a metal weapon
	BoltHit     = 4 // struck a player (entityId)
	BoltIgnited = 8 // set the ground alight
)

// Weather status bits (Event 1202 value).
const (
	WeatherChilled = 1
	WeatherWarm    = 2 // warm food active (targetId = seconds left)
	WeatherCold    = 4 // out in the cold and not warm (Chilled after COLD_ONSET_S)
)

// WeatherSetup turns dynamic weather on (main.go fills it from the atlas).
type WeatherSetup struct {
	Climate  *weather.Climate
	WindDeg  int // WorldSpec windDirection (degrees the wind blows from)
	Override int // >= 0: this state everywhere (LODESTONE_ZONE_DEBUG_WEATHER, _DEBUG_RAIN)
	NoBolts  bool
	NoCold   bool
}

// warmFoods keep you warm for COLD_FOOD_WARM_S when eaten.
var warmFoods = map[string]bool{
	"food:stew": true, "food:emberroot_skewer": true, "food:frostcap_broth": true, "food:fish_stew": true,
	"food:frostgill_chowder": true, "food:ember_curry": true, "food:seafarer_pie": true, "food:grilled_meat": true,
}

type drawnBolt struct {
	id    uint32
	ent   uint32
	step  int64
	x, z  float64
	angle float64
}

type sessWeather struct {
	coldS     float64
	chilled   bool
	warmUntil time.Time
	sent      int32
	sentWarm  int32
}

type weatherState struct {
	field   *weather.Field
	lastK   int64
	started bool
	drawn   []drawnBolt
	sess    map[*session]*sessWeather
	fires   []fireSpot // town hearths and campfires (props), built once
	built   bool
	Stats   WeatherStats
}

// WeatherStats counts what the weather did (GET /debug/night, tests).
type WeatherStats struct {
	Strikes, Hits, Drawn, Dodged, Ignited, Chilled int
}

func (s *Server) weatherOn() bool { return s.cfg.Weather != nil && s.cfg.Weather.Climate != nil }

// weatherFieldAt is the field of chemistry step k (one per step, shared).
// Only stepEnv (the tick's start) calls it: everything else in the tick,
// the input and AI workers included, reads curField.
func (s *Server) weatherFieldAt(k int64) *weather.Field {
	w := s.cfg.Weather
	if f := s.wx.field; f != nil && f.Step == k {
		return f
	}
	f := weather.NewField(s.cfg.Seed, w.Climate, w.WindDeg, k, w.Override)
	s.wx.field = f
	return f
}

// curField is this tick's weather (built by stepEnv).
func (s *Server) curField() *weather.Field {
	if s.wx.field == nil {
		return s.weatherFieldAt(weather.Step(s.worldTimeS()))
	}
	return s.wx.field
}

// weatherStateAt is the weather at (x, z) this tick (-1 without weather).
func (s *Server) weatherStateAt(x, z float64) int {
	if !s.weatherOn() {
		return -1
	}
	return s.curField().StateAt(x, z)
}

// rainingAt reports rain at (x, z) this tick: the weather there, or
// WP10's global stub (and its dev override) in worlds without weather.
func (s *Server) rainingAt(x, z, t float64) bool {
	if s.cfg.Rain != nil {
		return *s.cfg.Rain
	}
	if s.weatherOn() {
		return weather.IsWet(s.curField().StateAt(x, z))
	}
	return weather.IsRaining(s.cfg.Seed, t)
}

// weatherInit wires the combat hooks once.
func (s *Server) weatherInit() {
	if s.wx.started {
		return
	}
	s.wx.started = true
	s.wx.sess = map[*session]*sessWeather{}
	if !s.weatherOn() || s.cbt.w == nil {
		return
	}
	s.cbt.w.AggroMult = func(x, z float64) float64 {
		if f := s.wx.field; f != nil && weather.IsMurky(f.StateAt(x, z)) {
			return constants.FogAggroMult
		}
		return 1
	}
}

// weatherTick: lightning (every tick, by chemistry step) and cold (once a
// second per player, staggered).
func (s *Server) weatherTick(tick uint32) {
	if !s.weatherOn() {
		return
	}
	s.weatherInit()
	t := s.worldTimeS()
	k := s.curField().Step
	f := s.curField()
	if !s.wx.lastStep(k) {
		s.lightningSteps(k)
	}
	if s.cfg.Weather.NoCold {
		return
	}
	for i, sess := range s.sessions {
		if sess.ent == nil || (tick+uint32(i))%constants.TickRateHz != 0 {
			continue
		}
		s.coldCheck(sess, f, t)
	}
	if tick%(constants.TickRateHz*10) == 0 {
		alive := map[*session]bool{}
		for _, sess := range s.sessions {
			alive[sess] = true
		}
		for sess := range s.wx.sess {
			if !alive[sess] {
				delete(s.wx.sess, sess)
			}
		}
	}
}

// lastStep reports whether k was already handled (and starts the cursor).
func (w *weatherState) lastStep(k int64) bool {
	if !w.started || w.lastK == 0 || k < w.lastK || k-w.lastK > 50 {
		w.lastK = k // start, a clock jump (dev time) or a long stall: no backlog
		return true
	}
	return k == w.lastK
}

// lightningSteps resolves the strikes of steps (lastK, k].
func (s *Server) lightningSteps(k int64) {
	w := s.cfg.Weather
	k0 := s.wx.lastK + 1
	s.wx.lastK = k
	if w.NoBolts || len(s.sessions) == 0 {
		return
	}
	weather.StrikesBetween(s.cfg.Seed, w.Climate, k0, k+1, w.Override, func(st weather.Strike) {
		s.seededStrike(st)
	})
	// Metal draws bolts: a roll per slot for each player in the open in a storm.
	for slot := floorDivI(k0+weather.SlotSteps-1, weather.SlotSteps); slot*weather.SlotSteps <= k; slot++ {
		s.metalRolls(slot)
	}
	keep := s.wx.drawn[:0]
	for _, b := range s.wx.drawn {
		if b.step <= k {
			s.drawnStrike(b)
		} else {
			keep = append(keep, b)
		}
	}
	s.wx.drawn = keep
}

func floorDivI(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// surfaceY is the ground a bolt lands on (terrain, towers, roofs).
func (s *Server) surfaceY(x, z float64) float64 { return s.cfg.Ground.HeightAt(x, z) }

// sheltered reports a player lightning can't single out: underground, in a
// settlement (its roofs and towers take the bolts), down.
func (s *Server) sheltered(e *Entity) bool {
	if e.caveSys >= 0 || (e.cbt != nil && e.cbt.Downed) {
		return true
	}
	if nw := s.night.cfg.World; s.night.on && nw != nil && nw.WardAt(e.Move.Pos.X, e.Move.Pos.Z) >= 0 {
		return true
	}
	return false
}

// holdsMetal: a sword or a spear in the active loadout.
func holdsMetal(e *Entity) bool {
	if e.cbt == nil || e.cbt.Profile == nil {
		return false
	}
	switch e.cbt.Profile.Loadouts[e.cbt.Profile.Active].Weapon {
	case "sword", "spear":
		return true
	}
	return false
}

func (s *Server) seededStrike(st weather.Strike) {
	if len(s.playersNear(st.X, st.Z, constants.LightningEventM)) == 0 {
		return // nobody to see it: the clients far away draw it themselves
	}
	x, z := weather.TallSpot(s.surfaceY, st.X, st.Z)
	target := s.boltTarget(x, z)
	if target != nil {
		x, z = target.Move.Pos.X, target.Move.Pos.Z
	}
	s.strike(st.ID, x, z, target, BoltSeeded)
}

// boltTarget is the player a bolt at (x, z) jumps to: the one in the open
// closest relative to their reach (LIGHTNING_ATTRACT_M, or the metal reach
// for a sword or spear, plus half their height above the ground); ties go
// to the lower id. nil: it strikes (x, z).
func (s *Server) boltTarget(x, z float64) *Entity {
	var target *Entity
	best := math.Inf(1)
	for _, e := range s.playersNear(x, z, constants.LightningMetalAttractM+20) {
		if s.sheltered(e) {
			continue
		}
		p := e.Move.Pos
		r := constants.LightningAttractM
		if holdsMetal(e) {
			r = constants.LightningMetalAttractM
		}
		r += math.Min(20, math.Max(0, p.Y-s.surfaceY(p.X, p.Z))/2)
		d := math.Hypot(p.X-x, p.Z-z) / r
		if d <= 1 && (d < best || (d == best && target != nil && e.ID < target.ID)) {
			target, best = e, d
		}
	}
	return target
}

// metalRolls: each player in the open in a thunderstorm holding metal
// draws a bolt with LIGHTNING_METAL_PCT per slot, struck WARN steps later.
func (s *Server) metalRolls(slot int64) {
	f := s.wx.field
	if f == nil {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || !holdsMetal(e) || s.sheltered(e) || f.StateAt(e.Move.Pos.X, e.Move.Pos.Z) != weather.Thunderstorm {
			continue
		}
		h := weather.Hash(s.cfg.Seed^0x6d65746c^uint64(e.ID)<<32, slot)
		if h%100 >= constants.LightningMetalPct {
			continue
		}
		b := drawnBolt{id: 0x80000000 | (uint32(slot)<<10^e.ID)&0x7fffffff, ent: e.ID, step: slot*weather.SlotSteps + constants.LightningWarnSteps, x: e.Move.Pos.X, z: e.Move.Pos.Z, angle: float64(h>>8%360) * math.Pi / 180}
		s.wx.drawn = append(s.wx.drawn, b)
		s.wx.Stats.Drawn++
		ev := &proto.Event{Kind: EventLightningWarn, EntityID: e.ID, TargetID: b.id, Value: constants.LightningWarnSteps * 1000 / constants.ChemStepHz, X: cm(b.x), Y: cm(e.Move.Pos.Y), Z: cm(b.z)}
		for _, o := range s.playersNear(b.x, b.z, 64) {
			s.sendEventTo(o, ev)
		}
	}
}

// drawnStrike: the bolt a metal weapon drew. Still holding it in the open:
// it strikes you. Switched or sheltered: it finds the tall spot 30 m off.
func (s *Server) drawnStrike(b drawnBolt) {
	var e *Entity
	for _, sess := range s.sessions {
		if sess.ent != nil && sess.ent.ID == b.ent {
			e = sess.ent
		}
	}
	if e != nil && holdsMetal(e) && !s.sheltered(e) {
		s.strike(b.id, e.Move.Pos.X, e.Move.Pos.Z, e, BoltDrawn)
		return
	}
	s.wx.Stats.Dodged++
	x, z := weather.TallSpot(s.surfaceY, b.x+30*math.Sin(b.angle), b.z+30*math.Cos(b.angle))
	s.strike(b.id, x, z, nil, BoltDrawn)
}

// strike lands a bolt at (x, z): damage, fire, the event.
func (s *Server) strike(id uint32, x, z float64, target *Entity, flags uint8) {
	s.wx.Stats.Strikes++
	y := s.surfaceY(x, z)
	at := movement.Vec3{X: x, Y: y, Z: z}
	dealt := 0.0
	if target != nil {
		at.Y = target.Move.Pos.Y
		if target.cbt != nil && s.cbt.w != nil {
			dealt = s.cbt.w.HurtByWeather(target.cbt, constants.LightningDamage)
		}
		flags |= BoltHit
		s.wx.Stats.Hits++
	}
	if s.cbt.w != nil {
		for _, e := range s.playersNear(x, z, constants.LightningSplashM) {
			if e != target && e.cbt != nil && e.caveSys < 0 {
				s.cbt.w.HurtByWeather(e.cbt, constants.LightningDamage/2)
			}
		}
		for _, en := range s.cbt.w.EnemiesNear(x, z, constants.LightningSplashM) {
			s.cbt.w.StrikeEnemy(en, constants.LightningDamage/2, at)
		}
	}
	if s.night.on && s.night.cfg.Chem != nil {
		ix, iz := chem.CellAt(x, z)
		if chem.InWorld(ix, iz) && chem.Flammable(s.night.cfg.Chem.Src.Material(ix, iz)) {
			s.chemAt(chem.OpIgnite, at, 0)
			flags |= BoltIgnited
			s.wx.Stats.Ignited++
		}
	}
	var tid uint32
	if target != nil {
		tid = target.ID
	}
	ev := &proto.Event{Kind: EventLightning, EntityID: tid, TargetID: id, Value: int32(dealt), X: cm(x), Y: cm(at.Y), Z: cm(z), Data: []byte{flags}}
	for _, e := range s.playersNear(x, z, constants.LightningEventM) {
		s.sendEventTo(e, ev)
	}
}

// ---- cold ----

func (s *Server) sessWx(sess *session) *sessWeather {
	if s.wx.sess == nil {
		s.wx.sess = map[*session]*sessWeather{}
	}
	w := s.wx.sess[sess]
	if w == nil {
		w = &sessWeather{}
		s.wx.sess[sess] = w
	}
	return w
}

// townFires are the hearths and campfires of the towns (built once).
func (s *Server) townFires() []fireSpot {
	if !s.wx.built {
		s.wx.built = true
		if s.cfg.Towns != nil {
			for _, p := range s.cfg.Towns.T.Props {
				if p.Kind == propHearth || p.Kind == propCampfire {
					s.wx.fires = append(s.wx.fires, fireSpot{x: p.X, z: p.Z})
				}
			}
		}
	}
	return s.wx.fires
}

// warmAt reports warmth at a player: a burning campfire or a town fire
// close by, a settlement, a cave, Rested.
func (s *Server) warmAt(sess *session, now time.Time) bool {
	e := sess.ent
	p := e.Move.Pos
	if e.caveSys >= 0 {
		return true
	}
	if nw := s.night.cfg.World; s.night.on && nw != nil && nw.WardAt(p.X, p.Z) >= 0 {
		return true
	}
	if sw := s.wx.sess[sess]; sw != nil && now.Before(sw.warmUntil) {
		return true
	}
	if sess.camp != nil && sess.camp.restedOn {
		return true
	}
	const r2 = constants.ColdWarmthM * constants.ColdWarmthM
	nowW := s.worldTimeS()
	for _, f := range s.camp.fires {
		if f.until > nowW && (f.x-p.X)*(f.x-p.X)+(f.z-p.Z)*(f.z-p.Z) <= r2 {
			return true
		}
	}
	for _, f := range s.townFires() {
		if (f.x-p.X)*(f.x-p.X)+(f.z-p.Z)*(f.z-p.Z) <= r2 {
			return true
		}
	}
	return false
}

// coldCheck runs once a second per player.
func (s *Server) coldCheck(sess *session, f *weather.Field, t float64) {
	e := sess.ent
	if e.cbt == nil {
		return
	}
	sw := s.sessWx(sess)
	now := s.cfg.Now()
	p := e.Move.Pos
	cx, cz := weather.CellOf(p.X, p.Z)
	st := f.StateAt(p.X, p.Z)
	exposed := st == weather.Snowstorm || (s.cfg.Weather.Climate.At(cx, cz) == weather.ClimateCold && weather.IsNight(t))
	warm := s.warmAt(sess, now)
	if exposed && !warm && !e.cbt.Downed {
		sw.coldS++
	} else {
		sw.coldS = 0
	}
	chilled := sw.coldS >= constants.ColdOnsetS
	if chilled != sw.chilled {
		sw.chilled = chilled
		e.cbt.Chilled = chilled
		if chilled {
			s.wx.Stats.Chilled++
		}
	}
	s.sendWeatherStatus(sess, sw, exposed && !warm)
}

func (s *Server) sendWeatherStatus(sess *session, sw *sessWeather, cold bool) {
	bits := int32(0)
	if sw.chilled {
		bits |= WeatherChilled
	}
	warmLeft := int32(0)
	if now := s.cfg.Now(); now.Before(sw.warmUntil) {
		bits |= WeatherWarm
		warmLeft = int32(math.Ceil(sw.warmUntil.Sub(now).Seconds()))
	}
	if cold {
		bits |= WeatherCold
	}
	if bits == sw.sent && (bits&WeatherWarm == 0 || warmLeft <= sw.sentWarm) && sw.sent != -1 {
		return
	}
	sw.sent, sw.sentWarm = bits, warmLeft
	onset := uint16(math.Max(0, constants.ColdOnsetS-sw.coldS))
	s.sendEvent(sess, &proto.Event{Kind: EventWeatherStatus, EntityID: sess.ent.ID, TargetID: uint32(warmLeft), Value: bits, Data: binary.LittleEndian.AppendUint16(nil, onset)})
}

// weatherAte: warm food eaten (items.go drink).
func (s *Server) weatherAte(sess *session, item string) {
	if !s.weatherOn() || !warmFoods[item] || sess.ent == nil {
		return
	}
	sw := s.sessWx(sess)
	sw.warmUntil = s.cfg.Now().Add(time.Duration(constants.ColdFoodWarmS * float64(time.Second)))
	sw.coldS = 0
	sw.sent = -1
	if sw.chilled && sess.ent.cbt != nil {
		sw.chilled = false
		sess.ent.cbt.Chilled = false
	}
	s.sendWeatherStatus(sess, sw, false)
}
