package combat

import (
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
)

// CR 056: monsters do not see, hit or shoot through walls. Every rule is
// tried against four geometries: a town building wall and a base wall (both
// reach the enemy world as World.Obstacles boxes: server/zone obstacles.go),
// cave rock (the ground's Sight, a stand-in here for CaveTerrain.Sight) and
// open field (still hits). The real geometry (the wasm world's houses, base
// pieces, cave cells) is exercised in internal/game/sight_test.go.

// rockSlab is a ground whose Sight reports solid rock in a slab, as caves do.
type rockGround struct {
	movement.Flat
	x0, x1 float64
}

func (g rockGround) Sight(x, y, z float64) int8 {
	if x > g.x0 && x < g.x1 {
		return 1
	}
	return 0
}

type sightCase struct {
	name string
	wall bool // a wall stands between x = 503 and x = 515
	mk   func() *World
}

func sightCases() []sightCase {
	box := func(thick float64) func() *World {
		return func() *World {
			w, _ := newWorld()
			w.Obstacles = func(x, y, z, r, h float64) bool { return math.Abs(x-510) < thick/2+r && z > 400-r && z < 600+r }
			return w
		}
	}
	return []sightCase{
		{"town building wall", true, box(0.5)},
		{"base wall", true, box(0.3)},
		{"cave rock", true, func() *World {
			id := uint32(100)
			return NewWorld(Config{Seed: 1, NoWildPacks: true}, rockGround{movement.Flat{Y: 5}, 507, 513}, func() uint32 { id++; return id })
		}},
		{"open field", false, func() *World { w, _ := newWorld(); return w }},
	}
}

func at(x, z float64) movement.Vec3 { return movement.Vec3{X: x, Y: 5, Z: z} }

// The query itself.
func TestLineClearGeometries(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		got := w.LineClear(movement.Vec3{X: 503, Y: 6, Z: 500}, movement.Vec3{X: 518, Y: 6, Z: 500})
		if got == c.wall {
			t.Errorf("%s: clear = %v, wall = %v", c.name, got, c.wall)
		}
		// along the wall, never through it
		if !w.LineClear(movement.Vec3{X: 503, Y: 6, Z: 500}, movement.Vec3{X: 503, Y: 6, Z: 520}) {
			t.Errorf("%s: a segment on one side is blocked", c.name)
		}
	}
}

// A ridge of terrain between two points blocks; the same segment over flat
// ground does not; a thin 10 cm wall is not stepped over by the sampling.
func TestLineClearTerrainAndThinWall(t *testing.T) {
	id := uint32(100)
	ridge := ridgeGround{}
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, ridge, func() uint32 { id++; return id })
	if w.LineClear(movement.Vec3{X: 503, Y: 6, Z: 500}, movement.Vec3{X: 518, Y: 6, Z: 500}) {
		t.Error("a 12 m ridge does not block the line")
	}
	if !w.LineClear(movement.Vec3{X: 503, Y: 30, Z: 500}, movement.Vec3{X: 518, Y: 30, Z: 500}) {
		t.Error("a line well above the ridge is blocked")
	}
	w2, _ := newWorld()
	w2.Obstacles = func(x, y, z, r, h float64) bool { return math.Abs(x-510.03) < 0.05+r }
	for dz := 0.0; dz < 1; dz += 0.07 {
		if w2.LineClear(movement.Vec3{X: 503, Y: 6, Z: 500 + dz}, movement.Vec3{X: 518, Y: 6, Z: 500 + dz*2}) {
			t.Fatalf("a 10 cm wall let a line through (dz %.2f)", dz)
		}
	}
}

type ridgeGround struct{}

func (ridgeGround) HeightAt(x, z float64) float64 {
	if x > 508 && x < 512 {
		return 17
	}
	return 5
}

// Perception: an enemy 12 m from a player, a wall between, does not notice
// them; in the open it does; close enough to hear it does.
func TestEnemyDoesNotNoticeThroughWall(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		newHand(w, 1, at(515, 500), "sword")
		e := spawnOne(w, "wolf", at(503, 500))
		for i := 0; i < 60; i++ {
			w.Step(w.tick + 1)
			w.Drain()
		}
		noticed := e.State != Idle
		if noticed == c.wall {
			t.Errorf("%s: noticed = %v (state %v) with wall = %v", c.name, noticed, e.State, c.wall)
		}
	}
}

// Hearing: right beside the wall (5 m) a wolf still notices.
func TestEnemyHearsThroughWallWhenNear(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		newHand(w, 1, at(512.5, 500), "sword")
		e := spawnOne(w, "wolf", at(507.5, 500))
		for i := 0; i < 30; i++ {
			w.Step(w.tick + 1)
			w.Drain()
		}
		if e.State == Idle {
			t.Errorf("%s: a wolf 5 m away did not hear the player", c.name)
		}
	}
}

// Keeping the chase: a chasing wolf whose target stands behind a wall with no
// way round (a 600 m wall) gives up within the memory time and never hurts.
func TestChaserLosesTargetBehindWall(t *testing.T) {
	w, _ := newWorld()
	w.Obstacles = func(x, y, z, r, h float64) bool { return math.Abs(x-510) < 0.5+r && z > 200-r && z < 800+r }
	h := newHand(w, 1, at(525, 500), "sword")
	hp := h.p.HP
	e := spawnOne(w, "wolf", at(503, 500))
	e.Target, e.State = h.p.ID, Chase
	for i := 0; i < 30*40; i++ {
		h.idle(2)
		w.Step(w.tick + 1)
		w.Drain()
	}
	if e.Target != 0 || e.State == Chase {
		t.Fatalf("the wolf still chases a player it cannot see (target %d, state %v)", e.Target, e.State)
	}
	if h.p.HP != hp {
		t.Fatalf("the player was hurt through the wall: %v -> %v", hp, h.p.HP)
	}
}

// Melee: the wolf's bite does not land through a wall, in any geometry; in
// the open it does.
func TestMeleeDoesNotHitThroughWall(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		// the wall is thin and the player 2.5 m off: well inside the bite's reach
		h := newHand(w, 1, at(511.4, 500), "sword")
		h.p.HPMax, h.p.HP = 1e9, 1e9
		hp := h.p.HP
		e := spawnOne(w, "wolf", at(508.8, 500))
		e.Target, e.State = h.p.ID, Chase
		if !c.wall {
			e.Pos = at(508.8, 500)
		}
		for i := 0; i < 30*6; i++ {
			h.idle(2)
			w.Step(w.tick + 1)
			w.Drain()
			if c.wall { // the wolf may not walk through the wall to get round it
				e.Pos.X = math.Min(e.Pos.X, 509.2)
			}
		}
		hit := h.p.HP < hp
		if hit == c.wall {
			t.Errorf("%s: player hit = %v with wall = %v", c.name, hit, c.wall)
		}
	}
}

// The strike itself: an area that contains a player a wall hides from its
// centre queues nothing; in the open it queues.
func TestStrikeAreaStopsAtWall(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		h := newHand(w, 1, at(513, 500), "sword")
		e := spawnOne(w, "wolf", at(505, 500))
		a := w.closestAttack(e)
		area := attackArea{shape: "circle", center: e.Pos, radius: 12}
		w.strikes = nil
		w.strikeArea(e, a, area, nil)
		_ = h
		queued := len(w.strikes) > 0
		if queued == c.wall {
			t.Errorf("%s: strike queued = %v with wall = %v", c.name, queued, c.wall)
		}
	}
}

// A ground blast whose centre is on the far side of a wall hurts nobody on
// this side.
func TestGroundBlastStopsAtWall(t *testing.T) {
	w := sightCases()[0].mk()
	newHand(w, 1, at(506, 500), "sword")
	e := spawnOne(w, "wolf", at(500, 500))
	a := w.closestAttack(e)
	w.strikes = nil
	w.strikeArea(e, a, attackArea{shape: "circle", center: at(513, 500), radius: 8}, nil)
	if len(w.strikes) != 0 {
		t.Fatal("a blast behind the wall hit a player in front of it")
	}
}

// Projectiles: an enemy shot flying at a player through a wall ends at it
// (Event 1990 at the wall); in the open it reaches the player.
func TestEnemyProjectileStopsAtWall(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		h := newHand(w, 1, at(518, 500), "sword")
		e := spawnOne(w, "archer", at(503, 500))
		att := w.closestAttack(e)
		from := movement.Vec3{X: 503, Y: 6.5, Z: 500}
		w.shots = append(w.shots, &shot{enemy: e, att: att, pos: from, vel: movement.Vec3{X: att.Speed}, left: 30, radius: 0.35, hit: map[uint32]bool{}})
		w.Drain()
		var walled *Out
		reached := false
		for i := 0; i < 60 && len(w.shots) > 0; i++ {
			w.stepShots()
			if len(w.strikes) > 0 {
				reached = true
			}
			for _, o := range w.Events {
				if o.Ev.Kind == EvShotWall {
					o := o
					walled = &o
				}
			}
			w.Events = w.Events[:0]
		}
		_ = h
		if reached == c.wall {
			t.Errorf("%s: the shot reached the player = %v with wall = %v", c.name, reached, c.wall)
		}
		if c.wall {
			if walled == nil {
				t.Errorf("%s: no wall impact event", c.name)
			} else if x := float64(walled.Ev.X) / 100; x < 502 || x > 511 {
				t.Errorf("%s: impact at x %.2f, not at the wall", c.name, x)
			}
		} else if walled != nil {
			t.Errorf("%s: a wall impact in the open", c.name)
		}
	}
}

// A shot that starts in a cave and leaves the ground: terrain still ends it.
func TestEnemyProjectileStopsAtTerrain(t *testing.T) {
	id := uint32(100)
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, ridgeGround{}, func() uint32 { id++; return id })
	newHand(w, 1, at(518, 500), "sword")
	e := spawnOne(w, "archer", at(503, 500))
	att := w.closestAttack(e)
	w.shots = append(w.shots, &shot{enemy: e, att: att, pos: movement.Vec3{X: 503, Y: 6.5, Z: 500}, vel: movement.Vec3{X: att.Speed}, left: 30, radius: 0.35, hit: map[uint32]bool{}})
	for i := 0; i < 60; i++ {
		w.stepShots()
	}
	if len(w.strikes) != 0 || len(w.shots) != 0 {
		t.Fatalf("the shot went through a ridge (strikes %d, shots %d)", len(w.strikes), len(w.shots))
	}
}

// The players' own ranged claims use the same wall rule (validate.go clear);
// a melee reach check is not touched.
func TestPlayerClaimLineOfSight(t *testing.T) {
	for _, c := range sightCases() {
		w := c.mk()
		shooter, target := at(503, 500), at(518, 500)
		if got := w.lineOfSight(shooter, shooter, target, 0.9); got == c.wall {
			t.Errorf("%s: player line of sight = %v with wall = %v", c.name, got, c.wall)
		}
	}
}

// The memo: an enemy asks the ground about one player once per
// sightEveryTicks, not every tick.
func TestSightIsThrottled(t *testing.T) {
	w := sightCases()[0].mk()
	calls := 0
	obst := w.Obstacles
	w.Obstacles = func(x, y, z, r, h float64) bool { calls++; return obst(x, y, z, r, h) }
	h := newHand(w, 1, at(515, 500), "sword")
	e := spawnOne(w, "wolf", at(503, 500))
	w.tick = 1000
	w.sees(e, h.p)
	first := calls
	for i := 0; i < sightEveryTicks-1; i++ {
		w.tick++
		w.sees(e, h.p)
	}
	if calls != first {
		t.Fatalf("a memoised look asked the ground again (%d -> %d calls)", first, calls)
	}
	w.tick += 2
	w.sees(e, h.p)
	if calls == first {
		t.Fatal("the memo never expired")
	}
}

// BenchmarkSight measures the line-of-sight query: a 20 m ray over open
// ground (no blocker), through a wall, and 500 enemies each looking at one
// player once per memo window (the per-tick cost at scale).
func BenchmarkSight(b *testing.B) {
	for _, c := range sightCases() {
		b.Run(c.name+"/20m", func(b *testing.B) {
			w := c.mk()
			a, p := movement.Vec3{X: 500, Y: 6, Z: 500}, movement.Vec3{X: 520, Y: 6, Z: 500}
			for i := 0; i < b.N; i++ {
				w.LineClear(a, p)
			}
		})
	}
	b.Run("500 enemies per tick", func(b *testing.B) {
		w, _ := newWorld()
		h := newHand(w, 1, at(520, 500), "sword")
		var es []*Enemy
		for i := 0; i < 500; i++ {
			es = append(es, spawnOne(w, "wolf", at(500+float64(i%20), 480+float64(i/20))))
		}
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			w.tick++
			for _, e := range es {
				w.sees(e, h.p)
			}
		}
	})
}

// BenchmarkSightTick is a tick of 500 chasing wolves in an open field, with
// line of sight on and off (World.NoSight): the cost of the feature.
func BenchmarkSightTick(b *testing.B) {
	for _, off := range []bool{true, false} {
		name := "sight"
		if off {
			name = "off"
		}
		b.Run(name, func(b *testing.B) {
			w, _ := newWorld()
			w.NoSight = off
			h := newHand(w, 1, at(520, 500), "sword")
			h.p.HPMax, h.p.HP = 1e9, 1e9
			for i := 0; i < 500; i++ {
				e := spawnOne(w, "wolf", at(480+float64(i%25)*1.5, 470+float64(i/25)*1.5))
				e.Target, e.State = h.p.ID, Chase
			}
			b.ResetTimer()
			start := time.Now()
			for i := 0; i < b.N; i++ {
				h.idle(2)
				w.Step(w.tick + 1)
				w.Drain()
			}
			b.ReportMetric(float64(time.Since(start).Microseconds())/float64(b.N), "us/tick")
		})
	}
}
