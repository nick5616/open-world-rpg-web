package combat

import (
	"fmt"
	"hash/fnv"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
)

// Pathfinding (playtest 2): enemies go round what blocks the straight line
// (a wall, a house, a fence with a gate, a cliff with a ramp), never
// through a closed door, within the per-tick budget, the same way every
// run; pets follow their owner round a wall instead of warping.

// navBox is an axis-aligned solid box (a wall, a fence post, a door).
type navBox struct {
	x0, z0, x1, z1 float64
	open           *bool // a door: solid while *open is false
}

type navBoxes []navBox

func (b navBoxes) blocked(x, y, z, r, h float64) bool {
	for _, k := range b {
		if k.open != nil && *k.open {
			continue
		}
		cx, cz := math.Min(math.Max(x, k.x0), k.x1), math.Min(math.Max(z, k.z0), k.z1)
		if (x-cx)*(x-cx)+(z-cz)*(z-cz) < r*r {
			return true
		}
	}
	return false
}

// house: four 0.3 m walls round [x0, x1] x [z0, z1] with a 1.8 m doorway in
// the south wall (z0) centred at x; door (if not nil) fills the doorway.
func house(x0, z0, x1, z1, doorX float64, door *bool) navBoxes {
	const t = 0.15
	b := navBoxes{
		{x0 - t, z1 - t, x1 + t, z1 + t, nil},      // north
		{x0 - t, z0 - t, x0 + t, z1 + t, nil},      // west
		{x1 - t, z0 - t, x1 + t, z1 + t, nil},      // east
		{x0 - t, z0 - t, doorX - 0.9, z0 + t, nil}, // south, left of the door
		{doorX + 0.9, z0 - t, x1 + t, z0 + t, nil}, // south, right of the door
	}
	if door != nil {
		b = append(b, navBox{doorX - 0.9, z0 - t, doorX + 0.9, z0 + t, door})
	}
	return b
}

// chaseRun: one enemy chases a player standing still at `at`; returns the
// closest it came and whether it ever overlapped an obstacle.
type chaseOut struct {
	closest    float64
	overlapped bool
	reachedAt  int
	gaveUp     bool // it went home (Return) at some point
	e          *Enemy
	w          *World
}

func chaseRun(t *testing.T, ground movement.Ground, obst func(x, y, z, r, h float64) bool, key string, from, at movement.Vec3, ticks int, retarget bool) chaseOut {
	t.Helper()
	id := uint32(100)
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, ground, func() uint32 { id++; return id })
	w.Obstacles = obst
	h := newHand(w, 1, at, "sword")
	h.p.HPMax, h.p.HP = 1e7, 1e7
	e := spawnOne(w, key, from)
	e.Pos = w.place(from.X, from.Z, e.Def)
	e.Target, e.State = h.p.ID, Chase
	out := chaseOut{closest: math.Inf(1), reachedAt: -1, e: e, w: w}
	for i := 0; i < ticks; i++ {
		h.idle(2)
		w.Step(w.tick + 1)
		w.Drain()
		if retarget && e.Target == 0 {
			e.Target, e.State = h.p.ID, Chase
		}
		d := hdist(e.Pos, h.p.Pos)
		if d < out.closest {
			out.closest = d
		}
		if e.State == Return {
			out.gaveUp = true
		}
		if d < 3 && out.reachedAt < 0 {
			out.reachedAt = i
		}
		if obst != nil && obst(e.Pos.X, e.Pos.Y, e.Pos.Z, e.Radius()-0.05, 1) {
			out.overlapped = true
		}
	}
	return out
}

func TestEnemyPathsRoundAWall(t *testing.T) {
	out := chaseRun(t, movement.Flat{Y: 5}, wallAt510, "wolf", movement.Vec3{X: 503, Z: 500}, movement.Vec3{X: 525, Z: 500}, 30*16, true)
	if out.overlapped {
		t.Fatal("the wolf overlapped the wall")
	}
	if out.reachedAt < 0 {
		t.Fatalf("the wolf never got round the 60 m wall (closest %.1f m; nav %+v)", out.closest, out.w.NavStats())
	}
	st := out.w.NavStats()
	if st.Paths == 0 {
		t.Fatalf("no path was found: %+v", st)
	}
	t.Logf("reached after %.1f s; nav %+v", float64(out.reachedAt)/30, st)
}

func TestEnemyFollowsPlayerRoundAHouse(t *testing.T) {
	// A closed 12 x 9 m house between the wolf (south) and the player (north).
	shut := false
	b := house(494, 494, 506, 503, 500, &shut)
	out := chaseRun(t, movement.Flat{Y: 5}, b.blocked, "wolf", movement.Vec3{X: 500, Z: 488}, movement.Vec3{X: 500, Z: 510}, 30*10, true)
	if out.overlapped {
		t.Fatal("the wolf overlapped a wall or the closed door")
	}
	if out.reachedAt < 0 {
		t.Fatalf("the wolf never came round the house (closest %.1f m; nav %+v)", out.closest, out.w.NavStats())
	}
	t.Logf("round the house in %.1f s", float64(out.reachedAt)/30)
}

func TestEnemyGoesThroughAGate(t *testing.T) {
	// A 200 m fence along x = 510 with a 2.2 m gate at z 518..520.2: the
	// only way through within the search window.
	fence := navBoxes{{509.9, 380, 510.1, 518, nil}, {509.9, 520.2, 510.1, 620, nil}}
	out := chaseRun(t, movement.Flat{Y: 5}, fence.blocked, "wolf", movement.Vec3{X: 503, Z: 500}, movement.Vec3{X: 518, Z: 500}, 30*10, true)
	if out.overlapped {
		t.Fatal("the wolf overlapped the fence")
	}
	if out.reachedAt < 0 {
		t.Fatalf("the wolf never came through the gate (closest %.1f m; nav %+v)", out.closest, out.w.NavStats())
	}
	t.Logf("through the gate in %.1f s", float64(out.reachedAt)/30)
}

// plateau is flat ground at 5 m with a 6 m high plateau [520, 540] x [490,
// 510] (sheer sides) reached by one ramp up its south side (x 526..534,
// z 470..490).
type plateau struct{}

func (plateau) HeightAt(x, z float64) float64 {
	if x >= 520 && x <= 540 && z >= 490 && z <= 510 {
		return 11
	}
	if x >= 526 && x <= 534 && z >= 470 && z < 490 {
		return 5 + (z-470)/20*6
	}
	return 5
}

func TestEnemyClimbsARamp(t *testing.T) {
	out := chaseRun(t, plateau{}, nil, "wolf", movement.Vec3{X: 505, Z: 500}, movement.Vec3{X: 532, Z: 502}, 30*18, true)
	if out.reachedAt < 0 {
		t.Fatalf("the wolf never came up the ramp (closest %.1f m, at %+v; nav %+v)", out.closest, out.e.Pos, out.w.NavStats())
	}
	if out.e.Pos.Y < 10 {
		t.Fatalf("the wolf is not on the plateau: %+v", out.e.Pos)
	}
	t.Logf("up the ramp in %.1f s", float64(out.reachedAt)/30)
}

func TestEnemyNeverPathsThroughAClosedDoor(t *testing.T) {
	// The player hides in a house whose only door is shut: the wolf comes up
	// to the house, never gets in, and gives up (home) instead of waiting
	// at the wall for ever. With the door open it walks in.
	shut := false
	b := house(494, 494, 506, 503, 500, &shut)
	inside := func(p movement.Vec3) bool { return p.X > 494.2 && p.X < 505.8 && p.Z > 494.2 && p.Z < 502.8 }
	out := chaseRun(t, movement.Flat{Y: 5}, b.blocked, "wolf", movement.Vec3{X: 500, Z: 515}, movement.Vec3{X: 500, Z: 499}, 30*12, false)
	if out.overlapped || inside(out.e.Pos) {
		t.Fatalf("the wolf got into the closed house (overlap %v, at %+v)", out.overlapped, out.e.Pos)
	}
	if !out.gaveUp {
		t.Fatalf("the wolf did not give up on an unreachable target: state %v, nav %+v", out.e.State, out.w.NavStats())
	}
	open := true
	b = house(494, 494, 506, 503, 500, &open)
	out = chaseRun(t, movement.Flat{Y: 5}, b.blocked, "wolf", movement.Vec3{X: 500, Z: 515}, movement.Vec3{X: 500, Z: 499}, 30*12, true)
	if out.reachedAt < 0 {
		t.Fatalf("door open: the wolf never came in (closest %.1f; nav %+v)", out.closest, out.w.NavStats())
	}
	if out.overlapped {
		t.Fatal("door open: the wolf overlapped a wall")
	}
}

func TestNavInvalidateOnDoorChange(t *testing.T) {
	// A path is planned with the door open; the door shuts and the zone
	// invalidates the grid there: the next search goes round (no path in).
	open := true
	b := house(494, 494, 506, 503, 500, &open)
	id := uint32(100)
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, movement.Flat{Y: 5}, func() uint32 { id++; return id })
	w.Obstacles = b.blocked
	e := spawnOne(w, "wolf", movement.Vec3{X: 500, Z: 515})
	w.aiList = []*Enemy{e} // the nav pass takes asks in thinkAll's order
	run := func() []movement.Vec3 {
		e.nav = nil
		w.navWant(e, movement.Vec3{X: 500, Z: 499})
		for i := 0; i < 30 && (e.nav.queued || e.nav.want || w.navWanted); i++ {
			w.navTick()
			w.tick++
		}
		return e.NavPath()
	}
	if p := run(); len(p) == 0 || hdist(p[len(p)-1], movement.Vec3{X: 500, Z: 499}) > 0.5 {
		t.Fatalf("door open: no path in: %v", p)
	}
	open = false
	w.NavInvalidate(499, 494, 501, 494)
	if p := run(); len(p) > 0 && hdist(p[len(p)-1], movement.Vec3{X: 500, Z: 499}) < 1 {
		t.Fatalf("door shut: still a path in: %v", p)
	}
	if w.NavStats().Invalidated == 0 {
		t.Fatal("nothing was invalidated")
	}
}

func TestFlyersNeverPath(t *testing.T) {
	out := chaseRun(t, movement.Flat{Y: 5}, wallAt510, "wisp", movement.Vec3{X: 503, Z: 500}, movement.Vec3{X: 525, Z: 500}, 30*4, true)
	if out.e.nav != nil || out.w.NavStats().Requests != 0 {
		t.Fatalf("a flyer asked for a path: %+v", out.w.NavStats())
	}
}

// navCrowd: n wolves and boars in groups of 5 west of a 100 m wall (z 885..985),
// ten players east of its middle: every one of them has to path round an end.
func navCrowd(n int, par Parallel, workers int) (*World, []*handPlayer) {
	id := uint32(1000)
	w := NewWorld(Config{Seed: 7, NoWildPacks: true}, movement.Flat{Y: 5}, func() uint32 { id++; return id })
	wall := navBoxes{{1009.8, 885, 1010.2, 985, nil}}
	w.Obstacles = wall.blocked
	w.SetParallel(par, workers)
	var hs []*handPlayer
	for k := 0; k < 10; k++ {
		h := newHand(w, uint32(k+1), movement.Vec3{X: 1022, Z: 921 + float64(k)*3}, "sword")
		h.p.HPMax, h.p.HP = 1e9, 1e9
		hs = append(hs, h)
	}
	for g := 0; g < n/5; g++ {
		at := movement.Vec3{X: 990 - float64(g%10)*2, Z: 920 + float64(g/10)*3}
		grp := w.TestGroup(at, []string{"wolf", "wolf", "boar", "wolf", "boar"}, 1, "")
		w.spawnGroup(grp)
		for i, e := range grp.Members {
			e.Pos = w.place(at.X+float64(i)*0.4, at.Z, e.Def)
			e.State, e.Target = Chase, hs[g%len(hs)].p.ID // a pack hunts one player
		}
	}
	w.Drain()
	return w, hs
}

func TestNavBudgetUnder500Requests(t *testing.T) {
	w, hs := navCrowd(500, nil, 1)
	var worst time.Duration
	for tick := 0; tick < 30*20; tick++ {
		for _, h := range hs {
			h.idle(2)
		}
		before := w.nav
		var exp0 int64
		if before != nil {
			exp0 = before.Stats.Expanded
		}
		t0 := time.Now()
		w.Step(w.tick + 1)
		if d := time.Since(t0); d > worst {
			worst = d
		}
		w.Drain()
		if w.nav != nil && w.nav.Stats.Expanded-exp0 > navTickBudget {
			t.Fatalf("tick %d expanded %d nodes (budget %d)", tick, w.nav.Stats.Expanded-exp0, navTickBudget)
		}
	}
	st := w.NavStats()
	t.Logf("nav %+v; slowest tick %v", st, worst)
	if st.Requests < 300 {
		t.Fatalf("expected hundreds of asks, got %d", st.Requests)
	}
	// overrun past the budget: the last expansion's neighbour chunks (a
	// search's smoothing and a new search's flood wait for a fresh tick)
	if st.MaxTickUnits > navTickBudget+3*navChunkCost {
		t.Fatalf("a tick spent %d units (budget %d)", st.MaxTickUnits, navTickBudget)
	}
	if st.Paths+st.Partial < st.Requests/2 {
		t.Fatalf("most asks went unanswered: %+v", st)
	}
	if len(w.nav.queue) > 0 && st.MaxQueue < 100 {
		t.Fatalf("queue %d left with max %d", len(w.nav.queue), st.MaxQueue)
	}
	// and they get round: most wolves are east of the wall by now
	east := 0
	for _, e := range w.Enemies() {
		if e.Pos.X > 1010 {
			east++
		}
	}
	if east < 250 {
		t.Fatalf("only %d of 500 got round the wall", east)
	}
}

func navDigest(w *World) string {
	h := fnv.New64a()
	for _, id := range w.order {
		e := w.enemies[id]
		fmt.Fprintf(h, "%d:%.6f,%.6f,%d;", id, e.Pos.X, e.Pos.Z, e.State)
	}
	return fmt.Sprintf("%x", h.Sum64())
}

func TestNavDeterministic(t *testing.T) {
	// Same seed, same inputs: same paths, with or without workers.
	a, ha := navCrowd(200, nil, 1)
	b, hb := navCrowd(200, goParallel, 4)
	for tick := 0; tick < 30*8; tick++ {
		for i := range ha {
			ha[i].idle(2)
			hb[i].idle(2)
		}
		a.Step(a.tick + 1)
		b.Step(b.tick + 1)
		a.Drain()
		b.Drain()
		if da, db := navDigest(a), navDigest(b); da != db {
			t.Fatalf("tick %d: runs differ (%s vs %s)", tick, da, db)
		}
	}
	if a.NavStats() != b.NavStats() {
		t.Fatalf("stats differ: %+v vs %+v", a.NavStats(), b.NavStats())
	}
}

func TestPetPathsRoundAWallToItsOwner(t *testing.T) {
	w, _ := newWorld()
	w.Obstacles = navBoxes{{109.8, 70, 110.2, 130, nil}}.blocked
	h := newHand(w, 1, movement.Vec3{X: 104, Z: 100}, "sword")
	pet := w.SpawnPet(testPetSpec(h.p.ID, movement.Vec3{X: 102, Z: 100}))
	stepN(w, 30)
	h.p.Pos.X = 118 // over the wall (well within warp range)
	prev := pet.Pos
	for i := 0; i < 30*10; i++ {
		stepN(w, 1)
		if hdist(prev, pet.Pos) > 1 {
			t.Fatalf("the pet jumped %.1f m at tick %d (a warp)", hdist(prev, pet.Pos), i)
		}
		prev = pet.Pos
		if math.Abs(pet.Pos.X-110) < 0.2+pet.Radius()-0.05 && pet.Pos.Z > 70 && pet.Pos.Z < 130 {
			t.Fatalf("the pet walked into the wall at %+v", pet.Pos)
		}
	}
	if d := hdist(pet.Pos, h.p.Pos); d > 4.5 {
		t.Fatalf("the pet is %.1f m from its owner after 10 s (nav %+v)", d, w.NavStats())
	}
}
