package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// CR 020 spell mechanics: streams (rate, mana, anti-cheat, per-shot claims),
// charges, homing re-flights, orbits, delayed charges and brand chains,
// summoned allies (lifecycle, caps, targets, PvP rules).

// caster is a hand player who knows every spell, with `key` in slot 0.
func caster(w *World, key string, at movement.Vec3) *handPlayer {
	h := newHand(w, 1, at, "staff")
	for _, s := range D.Spells {
		h.p.Profile.Known = append(h.p.Profile.Known, s.Key)
	}
	h.p.Profile.Loadouts[0].Spells[0] = key
	h.p.Mana, h.p.ManaMax = 1000, 1000
	return h
}

const castF = proto.InputFlagCast
const holdF = proto.InputFlagChannel

// eastYaw looks down +X.
var eastYaw = -math.Pi / 2

func TestStreamRateAndManaDrain(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "cinder_spray", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("cinder_spray")
	mana := h.p.Mana
	start := h.frame(castF, 0, eastYaw)
	for i := 0; i < 60; i++ {
		h.frame(holdF, 0, eastYaw)
	}
	a, _ := h.p.lookup(start, s.ID)
	if a == nil || !h.p.Streaming() {
		t.Fatal("no stream")
	}
	want := 60/s.Auto.IntervalSteps + 1 // shot 0 on the cast step, then one per interval
	if a.Shots() != want {
		t.Fatalf("shots %d, want %d (%.0f/s)", a.Shots(), want, s.Auto.RateHz)
	}
	if got := mana - h.p.Mana; math.Abs(got-float64(want)*s.Auto.ManaPerShot) > 1e-9 {
		t.Fatalf("mana spent %v, want %v", got, float64(want)*s.Auto.ManaPerShot)
	}
	// Letting go ends it: the zone tells everyone (Event 223 value 0).
	w.Drain()
	h.frame(0, 0, eastYaw)
	if h.p.Streaming() {
		t.Fatal("still streaming after release")
	}
	stops := 0
	for _, o := range w.Events {
		if o.Ev.Kind == EvChannel && o.Ev.Value == 0 {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("stop events %d", stops)
	}
}

func TestStreamEndsWhenManaRunsOut(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "arc_sparks", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("arc_sparks")
	h.p.Mana = s.Auto.ManaPerShot*5 + 0.1
	h.frame(castF, 0, eastYaw)
	for i := 0; i < 100; i++ {
		h.frame(holdF, 0, eastYaw)
	}
	if h.p.Streaming() {
		t.Fatal("stream outlived its mana")
	}
	if h.p.Mana < 0 || h.p.Mana >= s.Auto.ManaPerShot {
		t.Fatalf("mana left %v", h.p.Mana)
	}
}

// Anti-cheat: no input pattern fires faster than the stream's rate.
func TestStreamCannotBeatItsRate(t *testing.T) {
	s := D.SpellByKey("arc_sparks")
	for name, pattern := range map[string]func(i int) uint16{
		"tap every frame":       func(i int) uint16 { return castF },
		"tap and release":       func(i int) uint16 { return [2]uint16{castF, 0}[i%2] },
		"tap while holding":     func(i int) uint16 { return [3]uint16{castF, holdF, holdF}[i%3] },
		"hold with cast spam":   func(i int) uint16 { return holdF | [4]uint16{castF, 0, 0, 0}[i%4] },
		"release on shot steps": func(i int) uint16 { return [4]uint16{castF, holdF, holdF, 0}[i%4] },
	} {
		w, _ := newWorld()
		h := caster(w, "arc_sparks", movement.Vec3{X: 100, Z: 100})
		first := uint32(0)
		for i := 0; i < 120; i++ {
			seq := h.frame(pattern(i), 0, eastYaw)
			if first == 0 {
				first = seq
			}
		}
		shots := 0
		for i := 0; i < min(h.p.nAct, actionRing); i++ {
			if a := &h.p.actions[i]; a.Spell == s && a.Legal {
				shots += a.Shots()
			}
		}
		if max := 120/s.Auto.IntervalSteps + 1; shots > max || shots == 0 {
			t.Fatalf("%s: %d shots in 120 steps (rate allows %d)", name, shots, max)
		}
	}
}

func TestStreamShotClaims(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "cinder_spray", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("cinder_spray")
	e := spawnOne(w, "boar", movement.Vec3{X: 108, Z: 100})
	start := h.frame(castF, 0, eastYaw)
	for i := 0; i < 20; i++ {
		h.frame(holdF, 0, eastYaw)
	}
	hp := e.HP
	shot2 := start + uint32(2*s.Auto.IntervalSteps)
	if r := w.Claim(h.p, claim(shot2, s.ID, e.ID, w.tick, e.Pos)); !r.Accepted {
		t.Fatalf("shot 2 refused: %d", r.Reason)
	}
	if e.HP >= hp {
		t.Fatal("no damage")
	}
	if r := w.Claim(h.p, claim(shot2, s.ID, e.ID, w.tick, e.Pos)); r.Accepted || r.Reason != RefuseHits {
		t.Fatalf("the same shot twice: %+v", r)
	}
	if r := w.Claim(h.p, claim(shot2+1, s.ID, e.ID, w.tick, e.Pos)); r.Accepted {
		t.Fatal("a seq between shots was accepted")
	}
	if r := w.Claim(h.p, claim(start, s.ID, e.ID, w.tick, e.Pos)); !r.Accepted {
		t.Fatalf("shot 0 refused: %d", r.Reason)
	}
	// A shot fired the other way (aim turned west) cannot hit the boar.
	for i := 0; i < s.Auto.IntervalSteps; i++ {
		h.frame(holdF, 0, -eastYaw)
	}
	a, _ := h.p.lookup(start, s.ID)
	last := a.shotSeq(a.Shots() - 1)
	if r := w.Claim(h.p, claim(last, s.ID, e.ID, w.tick, e.Pos)); r.Accepted || r.Reason != RefuseRange {
		t.Fatalf("a westward shot hit an eastern boar: %+v", r)
	}
}

func TestChargeReleaseScalesAndInterruptCancels(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "boulder_heave", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("boulder_heave")
	h.frame(castF, 0, eastYaw)
	for i := 0; i < s.Charge.MaxSteps+20; i++ {
		h.frame(holdF, 0, eastYaw)
	}
	rel := h.frame(0, 0, eastYaw)
	a, _ := h.p.lookup(rel, s.ID)
	if a == nil || a.Charge != 1 {
		t.Fatalf("release action %+v", a)
	}
	if dm, rm, _ := chargeOf(a); dm != s.Charge.DamageMult || rm != s.Charge.RadiusMult {
		t.Fatalf("full charge mults %v %v", dm, rm)
	}
	// Half a charge.
	h.p.readyAt = map[int]uint32{}
	h.frame(castF, 0, eastYaw)
	for i := 1; i < s.Charge.MaxSteps/2; i++ {
		h.frame(holdF, 0, eastYaw)
	}
	rel = h.frame(0, 0, eastYaw)
	a, _ = h.p.lookup(rel, s.ID)
	if a == nil || math.Abs(a.Charge-0.5) > 1e-9 {
		t.Fatalf("half charge %v", a.Charge)
	}
	// A dodge while gathering cancels it: no action at the dodge step.
	h.p.readyAt = map[int]uint32{}
	h.frame(castF, 0, eastYaw)
	h.frame(holdF, 0, eastYaw)
	dodge := h.frame(proto.InputFlagDodge, 0, eastYaw)
	if a, _ := h.p.lookup(dodge, s.ID); a != nil || h.p.Streaming() {
		t.Fatal("an interrupted charge fired")
	}
}

func TestHomingReachesTargetsOffTheAim(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "guiding_motes", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("guiding_motes")
	// 52 degrees off the aim, 12 m away: outside the plain projectile cone,
	// inside the motes' acquire cone; the zone re-flies the path into it.
	off := movement.Vec3{X: 100 + 12*math.Cos(52*math.Pi/180), Z: 100 - 12*math.Sin(52*math.Pi/180)}
	e := spawnOne(w, "boar", off)
	seq := h.frame(castF, 0, eastYaw)
	a, _ := h.p.lookup(seq, s.ID)
	if r := w.geometryOK(h.p, a, e.Radius(), e.Height(), e.Pos, e.Pos); r {
		t.Fatal("test target is inside the plain aim cone")
	}
	for i := 0; i < 20; i++ {
		w.Step(w.tick + 1)
	}
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, e.Pos)); !r.Accepted {
		t.Fatalf("homing claim refused: %d", r.Reason)
	}
	// The mote fanned away from it cannot turn in (outside its cone), so a
	// second claim is refused; an orb that hit is spent for that target.
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, e.Pos)); r.Accepted {
		t.Fatal("the far mote (or the same one twice) reached it")
	}
	// Dead ahead, both motes converge: two hits, never three.
	e3 := spawnOne(w, "boar", movement.Vec3{X: 112, Z: 100})
	h.p.readyAt = map[int]uint32{}
	seq = h.frame(castF, 0, eastYaw)
	ok := 0
	for k := 0; k < 3; k++ {
		if w.Claim(h.p, claim(seq, s.ID, e3.ID, w.tick, e3.Pos)).Accepted {
			ok++
		}
	}
	if ok != 2 {
		t.Fatalf("a two-mote volley landed %d hits", ok)
	}
	// Straight behind the caster: no seeking path gets there.
	w2, _ := newWorld()
	h2 := caster(w2, "guiding_motes", movement.Vec3{X: 100, Z: 100})
	b := spawnOne(w2, "boar", movement.Vec3{X: 90, Z: 100})
	seq = h2.frame(castF, 0, eastYaw)
	if r := w2.Claim(h2.p, claim(seq, s.ID, b.ID, w2.tick, b.Pos)); r.Accepted {
		t.Fatal("a homing claim on a target behind the caster")
	}
}

func TestOrbitGeometryAndRate(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "whirling_blades", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("whirling_blades")
	e := spawnOne(w, "boar", movement.Vec3{X: 100 + s.Orbit.Radius, Z: 100})
	seq := h.frame(castF, 0, eastYaw)
	w.Step(w.tick + 1)
	orb := movement.Vec3{X: 100 + s.Orbit.Radius, Y: h.p.Pos.Y + 1, Z: 100}
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, orb)); !r.Accepted {
		t.Fatalf("orb touch refused: %d", r.Reason)
	}
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, orb)); r.Accepted {
		t.Fatal("a second touch inside hitEveryMs")
	}
	for i := 0; i < int(ticksOf(s.Orbit.HitEverySteps)); i++ {
		w.Step(w.tick + 1)
	}
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, orb)); !r.Accepted {
		t.Fatalf("a touch after hitEveryMs refused: %d", r.Reason)
	}
	// An "orb" 9 m out is not on the ring.
	far := movement.Vec3{X: 109, Y: h.p.Pos.Y + 1, Z: 100}
	e2 := spawnOne(w, "boar", far)
	if r := w.Claim(h.p, claim(seq, s.ID, e2.ID, w.tick, far)); r.Accepted {
		t.Fatal("an orb far off the ring")
	}
}

func TestDelayedChargeBursts(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "burrowing_seed", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("burrowing_seed")
	e := spawnOne(w, "boar", movement.Vec3{X: 106, Z: 100})
	n := spawnOne(w, "wolf", movement.Vec3{X: 107.5, Z: 100.5})
	e.HPMax, e.HP = 1e4, 1e4
	n.HPMax, n.HP = 1e4, 1e4
	hold := func() { // keep both where they are (petrified)
		e.applyStatus("petrify", 0, e.Pos, w.tick, 0)
		n.applyStatus("petrify", 0, n.Pos, w.tick, 0)
	}
	hold()
	seq := h.frame(castF, 0, eastYaw)
	if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, e.Pos)); !r.Accepted {
		t.Fatalf("seed refused: %d", r.Reason)
	}
	hpE, hpN := e.HP, n.HP
	bursts := 0
	for i := 0; i < int(ticksOf(s.Detonate.DelaySteps))+2; i++ {
		hold()
		w.Step(w.tick + 1)
		for _, o := range w.Events {
			if o.Ev.Kind == EvDetonate {
				bursts++
			}
		}
		w.Drain()
	}
	if bursts != 1 {
		t.Fatalf("bursts %d", bursts)
	}
	if e.HP >= hpE || n.HP >= hpN {
		t.Fatalf("burst missed: host %v -> %v, neighbour %v -> %v", hpE, e.HP, hpN, n.HP)
	}
}

func TestBrandChainReaction(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "pyre_brand", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("pyre_brand")
	var pack []*Enemy
	for i := 0; i < 3; i++ {
		e := spawnOne(w, "slime", movement.Vec3{X: 110 + 2.5*float64(i), Z: 100})
		pack = append(pack, e)
	}
	seq := h.frame(castF, 0, eastYaw)
	for _, e := range pack {
		if r := w.Claim(h.p, claim(seq, s.ID, e.ID, w.tick, e.Pos)); !r.Accepted {
			t.Fatalf("brand refused: %d", r.Reason)
		}
		if e.brand == nil {
			t.Fatal("no brand")
		}
		e.HP = 2 // one burst kills each
	}
	w.kill(pack[0], h.p.ID)
	for i := 0; i < 4*brandChainTick+4; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	for i, e := range pack {
		if e.Alive() {
			t.Fatalf("slime %d survived the chain", i)
		}
	}
}

func TestSummonLifecycleAndCaps(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "wraith_hound", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("wraith_hound")
	cast := func(key string) {
		h.p.Profile.Loadouts[0].Spells[0] = key
		h.p.readyAt = map[int]uint32{}
		h.frame(castF, 0, eastYaw)
	}
	cast("wraith_hound")
	if len(w.Summons()) != 1 {
		t.Fatalf("summons %d", len(w.Summons()))
	}
	ally := w.Summons()[0]
	if w.Enemy(ally.ID) != nil || w.Summon(ally.ID) != ally || ally.Owner() != h.p.ID {
		t.Fatal("an ally must be outside the enemy table")
	}
	if r := w.Claim(h.p, claim(1, D.SpellByKey("ember_flick").ID, ally.ID, w.tick, ally.Pos)); r.Accepted || r.Reason != RefuseNoTarget {
		t.Fatalf("a claim on an ally: %+v", r)
	}
	cast("wraith_hound")
	cast("wraith_hound") // max 2 of a kind: the oldest leaves
	if len(w.Summons()) != 2 || w.Summon(ally.ID) != nil {
		t.Fatalf("kind cap: %d live, first still here %v", len(w.Summons()), w.Summon(ally.ID) != nil)
	}
	cast("gale_phantom")
	cast("sunlit_sentinel") // SUMMONS_PER_PLAYER in all
	if len(w.Summons()) != constants.SummonsPerPlayer {
		t.Fatalf("total cap: %d", len(w.Summons()))
	}
	// Time up: all gone after the longest duration.
	for i := 0; i < int(ticksOf(s.DurationSteps))+5; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	if len(w.Summons()) != 0 {
		t.Fatalf("%d allies outlived their time", len(w.Summons()))
	}
	cast("wraith_hound")
	w.RemovePlayer(h.p.ID)
	if len(w.Summons()) != 0 {
		t.Fatal("an ally outlived its caster leaving")
	}
}

func TestSummonFightsEnemiesNotPlayers(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "wraith_hound", movement.Vec3{X: 100, Z: 100})
	other := newHand(w, 2, movement.Vec3{X: 103, Z: 100}, "sword")
	h.frame(castF, 0, eastYaw)
	hp := other.p.HP
	for i := 0; i < 90; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	if other.p.HP != hp {
		t.Fatal("an ally hurt a player without the PvP rules")
	}
	h.p.HPMax, h.p.HP = 1e6, 1e6 // the boar fights back; keep the caster up
	e := spawnOne(w, "boar", movement.Vec3{X: 108, Z: 100})
	e.HPMax, e.HP = 1e4, 1e4
	attacks, pvpHits := 0, 0
	run := func(n int) {
		for i := 0; i < n; i++ {
			w.Step(w.tick + 1)
			for _, o := range w.Events {
				switch o.Ev.Kind {
				case EvSummonAttack:
					attacks++
				case EvPvPHit:
					pvpHits++
				}
			}
			w.Drain()
		}
	}
	run(150)
	if attacks == 0 || e.HP >= 1e4 || e.DamageBy[h.p.ID] <= 0 {
		t.Fatalf("the hound did not fight: %d attacks, boar %v", attacks, e.HP)
	}
	if pvpHits != 0 {
		t.Fatal("an ally hit a player without the PvP rules")
	}
	// Under the PvP rules (both flagged: the game layer says yes) it does.
	e.HP = 0
	w.kill(e, h.p.ID)
	w.SummonPvP = func(owner, victim uint32) (PvPHit, bool) { return PvPHit{}, owner == h.p.ID && victim == other.p.ID }
	run(150)
	if pvpHits == 0 {
		t.Fatal("a flagged hostile player was never attacked")
	}
}
