package game

import (
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/chem"
)

// A walk predicted with the shared weather field lands where the zone puts
// it (snow slows both), with no speed violations; the calm prediction does not.
func TestSnowWalkPredictedEqualsZone(t *testing.T) {
	r := weatherRig(t, weather.Snowstorm, 12)
	x, z := r.flatSpot(t)
	a := r.join(t, "wx-w", "Walker", x, z)
	a.ride(10, 0, 0, nil, nil)
	sim := movement.FromSelf(a.ackedState(t))
	sim.Pos.Y = movement.GroundAt(r.srv.cfg.Ground, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)
	calm := sim
	var before int64
	var f *weather.Field
	r.do(func() {
		before = r.srv.m.speedViolations.Load()
		f = r.srv.curField()
	})
	env := movement.Env{Weather: f}
	g := r.srv.cfg.Ground
	east := -math.Pi / 2
	var prev *proto.InputFrame
	for i := 0; i < 180; i += 2 {
		var frames []proto.InputFrame
		if prev != nil {
			frames = append(frames, *prev)
		}
		for k := 0; k < 2; k++ {
			a.seq++
			fr := proto.InputFrame{Seq: a.seq, Flags: proto.InputFlagForward | proto.InputFlagSprint, Yaw: proto.YawToU16(east)}
			frames = append(frames, fr)
			sim = movement.StepFrameEnv(sim, fr, g, env)
			calm = movement.StepFrame(calm, fr, g)
			prev = &frames[len(frames)-1]
		}
		a.send(&proto.Input{AckTick: a.dec.Latest(), Frames: frames})
		a.pump(33 * time.Millisecond)
	}
	got := movement.FromSelf(a.ackedState(t))
	if d := math.Hypot(got.Pos.X-sim.Pos.X, got.Pos.Z-sim.Pos.Z); d > 0.02 {
		t.Fatalf("zone %+v vs predicted %+v (%.3f m)", got.Pos, sim.Pos, d)
	}
	if d := math.Hypot(got.Pos.X-calm.Pos.X, got.Pos.Z-calm.Pos.Z); d < 1 {
		t.Fatalf("the snowstorm did not slow the zone's walk (%.2f m from the calm path)", d)
	}
	var after int64
	r.do(func() { after = r.srv.m.speedViolations.Load() })
	if after != before {
		t.Fatalf("%d speed violations", after-before)
	}
}

// CR 030: the zone's half of the weather on the official world (towns,
// terrain), with the weather forced so the rules are what is tested.

func weatherRig(t *testing.T, override int, hour float64) *mountRig {
	t.Helper()
	r := mountHarness(t, nil, hour)
	r.do(func() {
		// Seeded bolts off: the tests call the resolution directly.
		r.srv.cfg.Weather = &WeatherSetup{Climate: weather.UniformClimate(weather.ClimateTemperate), Override: override, NoBolts: true}
	})
	return r
}

func (r *mountRig) arm(char, weapon string) {
	r.do(func() {
		p := r.srv.byChar[char].ent.cbt
		p.Profile.Loadouts[p.Profile.Active].Weapon = weapon
	})
}

func TestLightningPrefersMetalThenStrikesAndHurts(t *testing.T) {
	r := weatherRig(t, weather.Thunderstorm, 12)
	x, z := r.flatSpot(t)
	a := r.join(t, "wx-a", "Ana", x, z)
	b := r.join(t, "wx-b", "Bo", x+12, z)
	r.arm("wx-a", "sword")
	r.arm("wx-b", "bow")
	var target string
	r.do(func() {
		// A bolt at x+20: Ana (sword) is 20 m off with a 30 m reach (0.67),
		// Bo (bow) 8 m off with 10 m (0.8): the metal draws it.
		if e := r.srv.boltTarget(x+20, z); e != nil {
			target = e.CharacterID
		}
	})
	if target != "wx-a" {
		t.Fatalf("bolt went to %q, want the sword", target)
	}
	r.arm("wx-a", "staff")
	r.do(func() {
		target = ""
		if e := r.srv.boltTarget(x+20, z); e != nil {
			target = e.CharacterID
		}
	})
	if target != "wx-b" {
		t.Fatalf("without metal the bolt went to %q, want the nearer player", target)
	}
	// Nobody within reach: the bolt strikes the ground.
	r.do(func() {
		target = ""
		if e := r.srv.boltTarget(x+80, z); e != nil {
			target = e.CharacterID
		}
	})
	if target != "" {
		t.Fatalf("a bolt 68 m away jumped to %q", target)
	}
	// A cave shelters.
	r.do(func() {
		r.srv.byChar["wx-b"].ent.caveSys = 0
		target = ""
		if e := r.srv.boltTarget(x+20, z); e != nil {
			target = e.CharacterID
		}
		r.srv.byChar["wx-b"].ent.caveSys = -1
	})
	if target != "" {
		t.Fatalf("a bolt found %q in a cave", target)
	}
	// The strike: damage to Ana (no armor), nobody else in the splash, both told.
	var before, after float64
	r.do(func() {
		e := r.srv.byChar["wx-a"].ent
		before = e.cbt.HP
		r.srv.strike(77, e.Move.Pos.X, e.Move.Pos.Z, e, BoltSeeded)
		after = e.cbt.HP
	})
	if before-after != constants.LightningDamage {
		t.Fatalf("bolt took %v health, want %v", before-after, constants.LightningDamage)
	}
	ev := b.nextEvent(EventLightning, 2*time.Second)
	if ev.TargetID != 77 || ev.Data[0]&BoltHit == 0 || ev.Value != int32(constants.LightningDamage) {
		t.Fatalf("bystander got %+v", ev)
	}
	if ev := a.nextEvent(EventLightning, 2*time.Second); ev.TargetID != 77 {
		t.Fatalf("victim got %+v", ev)
	}
	r.do(func() {
		if r.srv.byChar["wx-b"].ent.cbt.HP != r.srv.byChar["wx-b"].ent.cbt.HPMax {
			t.Fatal("Bo, 12 m away, was hurt")
		}
	})
}

func TestMetalDrawsBoltsAndSwitchingDodges(t *testing.T) {
	r := weatherRig(t, weather.Thunderstorm, 12)
	x, z := r.flatSpot(t)
	a := r.join(t, "wx-m", "Mira", x, z)
	r.arm("wx-m", "spear")
	var drawn []drawnBolt
	r.do(func() {
		r.srv.weatherInit()
		r.srv.curField()
		for slot := int64(1000); slot < 1400 && len(r.srv.wx.drawn) == 0; slot++ {
			r.srv.metalRolls(slot)
		}
		drawn = append(drawn, r.srv.wx.drawn...)
	})
	if len(drawn) != 1 {
		t.Fatalf("%d bolts drawn in 400 slots with a spear (%d%% each)", len(drawn), constants.LightningMetalPct)
	}
	w := a.nextEvent(EventLightningWarn, 2*time.Second)
	if w.Value != constants.LightningWarnSteps*1000/constants.ChemStepHz || w.TargetID != drawn[0].id {
		t.Fatalf("warning %+v", w)
	}
	// She switches to the bow before it falls: it finds something else.
	r.arm("wx-m", "bow")
	var hp, max float64
	r.do(func() {
		r.srv.drawnStrike(drawn[0])
		p := r.srv.byChar["wx-m"].ent.cbt
		hp, max = p.HP, p.HPMax
	})
	if hp != max {
		t.Fatalf("switched to the bow and still struck: %v / %v", hp, max)
	}
	ev := a.nextEvent(EventLightning, 2*time.Second)
	if ev.EntityID != 0 || ev.Data[0]&BoltDrawn == 0 {
		t.Fatalf("dodged bolt %+v", ev)
	}
	if d := math.Hypot(float64(ev.X)/100-x, float64(ev.Z)/100-z); d < constants.LightningSplashM {
		t.Fatalf("dodged bolt landed %.1f m away", d)
	}
	// Holding the spear when it falls: struck.
	r.arm("wx-m", "spear")
	r.do(func() {
		r.srv.drawnStrike(drawn[0])
		hp = r.srv.byChar["wx-m"].ent.cbt.HP
	})
	if max-hp != constants.LightningDamage {
		t.Fatalf("drawn bolt took %v", max-hp)
	}
}

func TestColdChillsAndWarmFoodAndFiresWarm(t *testing.T) {
	r := weatherRig(t, weather.Snowstorm, 12)
	x, z := r.flatSpot(t)
	a := r.join(t, "wx-c", "Cold", x, z)
	chilled := func() bool {
		var c bool
		r.do(func() { c = r.srv.byChar["wx-c"].ent.cbt.Chilled })
		return c
	}
	tick := func(n int) {
		r.do(func() {
			sess := r.srv.byChar["wx-c"]
			for i := 0; i < n; i++ {
				r.srv.coldCheck(sess, r.srv.curField(), r.srv.worldTimeS())
			}
		})
	}
	tick(int(constants.ColdOnsetS) - 1)
	if chilled() {
		t.Fatal("chilled before the onset")
	}
	tick(2)
	if !chilled() {
		t.Fatal("not chilled after the onset in a snowstorm")
	}
	var ev = a.nextEvent(EventWeatherStatus, 2*time.Second)
	for ev.Value&WeatherChilled == 0 {
		ev = a.nextEvent(EventWeatherStatus, 2*time.Second)
	}
	// Chilled: no health regeneration.
	r.do(func() {
		p := r.srv.byChar["wx-c"].ent.cbt
		p.HP = p.HPMax - 30
	})
	time.Sleep(time.Duration(constants.PlayerRegenDelayS*1000+600) * time.Millisecond)
	r.do(func() {
		p := r.srv.byChar["wx-c"].ent.cbt
		if p.HP != p.HPMax-30 {
			t.Fatalf("regenerated while chilled: %v", p.HP)
		}
	})
	// A hearty stew warms you at once and for COLD_FOOD_WARM_S.
	r.do(func() { r.srv.weatherAte(r.srv.byChar["wx-c"], "food:stew") })
	if chilled() {
		t.Fatal("still chilled after a stew")
	}
	tick(int(constants.ColdOnsetS) + 5)
	if chilled() {
		t.Fatal("chilled while warm food lasts")
	}
	ev = a.nextEvent(EventWeatherStatus, 2*time.Second)
	for ev.Value&WeatherWarm == 0 {
		ev = a.nextEvent(EventWeatherStatus, 2*time.Second)
	}
	if ev.TargetID < uint32(constants.ColdFoodWarmS)-5 {
		t.Fatalf("warm for %d s", ev.TargetID)
	}
	// Bread does nothing for the cold.
	r.do(func() {
		sw := r.srv.sessWx(r.srv.byChar["wx-c"])
		sw.warmUntil = time.Time{}
		r.srv.weatherAte(r.srv.byChar["wx-c"], "food:bread")
	})
	tick(int(constants.ColdOnsetS) + 1)
	if !chilled() {
		t.Fatal("bread kept the cold off")
	}
	// A burning campfire close by warms.
	r.do(func() {
		r.srv.camp.fires = append(r.srv.camp.fires, fireSpot{x: x + 3, z: z, until: r.srv.worldTimeS() + 600})
	})
	tick(1)
	if chilled() {
		t.Fatal("still chilled by a campfire")
	}
}

func TestClearDayIsNotCold(t *testing.T) {
	r := weatherRig(t, weather.Clear, 12)
	x, z := r.flatSpot(t)
	r.join(t, "wx-d", "Day", x, z)
	r.do(func() {
		sess := r.srv.byChar["wx-d"]
		for i := 0; i < 60; i++ {
			r.srv.coldCheck(sess, r.srv.curField(), r.srv.worldTimeS())
		}
		if sess.ent.cbt.Chilled {
			t.Fatal("chilled on a clear temperate day")
		}
	})
}

func TestFogShortensAggroAndFieldDrivesMovement(t *testing.T) {
	r := weatherRig(t, weather.Fog, 12)
	r.do(func() {
		r.srv.weatherInit()
		r.srv.env = r.srv.stepEnv()
		if m := r.srv.cbt.w.AggroMult(100, 100); m != constants.FogAggroMult {
			t.Fatalf("fog aggro %v", m)
		}
		if r.srv.env.Weather == nil {
			t.Fatal("no weather field in the movement env")
		}
		r.srv.cfg.Weather.Override = weather.Snowstorm
		r.srv.env = r.srv.stepEnv()
		// The field is per chemistry step: a new override shows from the next step.
		r.srv.wx.field = nil
		r.srv.env = r.srv.stepEnv()
		if mw := r.srv.env.Weather.MoveWeatherAt(100, 100); mw.SpeedMult != constants.SnowstormMoveMult {
			t.Fatalf("snowstorm move weather %+v", mw)
		}
		r.srv.cfg.Weather.Override = weather.Clear
		r.srv.wx.field = nil
		r.srv.env = r.srv.stepEnv()
		if m := r.srv.cbt.w.AggroMult(100, 100); m != 1 {
			t.Fatalf("clear aggro %v", m)
		}
	})
}

// The official world's climate: every cell voted, several climates, and
// chemistry reads rain per weather cell.
func TestOfficialWorldClimate(t *testing.T) {
	tr := testTerrain(t)
	m := chem.NewTerrainMaterial(tr, 20261108, tr.World().Atlas)
	cl := weather.NewClimate(m.GridN, m.MacroRes, m.Biome)
	seen := map[uint8]int{}
	for _, c := range cl.Cells {
		seen[c]++
	}
	if len(seen) < 3 {
		t.Fatalf("climates %v", seen)
	}
	t.Logf("official world climates (0 temperate, 1 wet, 2 highland, 3 cold, 4 arid): %v", seen)
}
