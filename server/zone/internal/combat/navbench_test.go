package combat

import (
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
)

// The town crowd (playtest 2 pathfinding, G5 budget): 200 enemies (40
// packs of 5) chase 20 players who run laps round the blocks of a 6 x 6
// town of closed 10 x 8 m houses on 8 m streets. Every chase is round a
// building, so the nav pass works all the time (re-plans as the players
// move). "off" is the same town with pathfinding disabled (the old
// straight steering): the difference is the nav cost.
//
//	go test ./internal/combat -run '^$' -bench TownCrowd -benchtime 600x -cpu 4

type townCrowd struct {
	w     *World
	hs    []*handPlayer
	laps  []townLap
	ticks int
}

type townLap struct {
	x0, z0, x1, z1 float64
	at             float64 // metres along the lap
}

func (l *townLap) pos() (float64, float64) {
	wd, ht := l.x1-l.x0, l.z1-l.z0
	p := math.Mod(l.at, 2*(wd+ht))
	switch {
	case p < wd:
		return l.x0 + p, l.z0
	case p < wd+ht:
		return l.x1, l.z0 + p - wd
	case p < 2*wd+ht:
		return l.x1 - (p - wd - ht), l.z1
	default:
		return l.x0, l.z1 - (p - 2*wd - ht)
	}
}

func newTownCrowd(nav bool, par Parallel, workers int) *townCrowd {
	id := uint32(1000)
	w := NewWorld(Config{Seed: 11, NoWildPacks: true}, movement.Flat{Y: 5}, func() uint32 { id++; return id })
	w.SetParallel(par, workers)
	w.navOff = !nav
	w.NoSight = true // the crowd is told where its player is: this tests the pathing
	shut := false
	var town navBoxes
	const bx, bz = 18.0, 16.0 // block pitch (house + street)
	for i := 0; i < 6; i++ {
		for j := 0; j < 6; j++ {
			x0, z0 := 2000+float64(i)*bx, 2000+float64(j)*bz
			town = append(town, house(x0, z0, x0+10, z0+8, x0+5, &shut)...)
		}
	}
	// broadphase like towns.Blocker: only boxes near (x, z)
	cells := map[[2]int][]navBox{}
	for _, b := range town {
		for cx := int((b.x0 - 2) / 8); cx <= int((b.x1+2)/8); cx++ {
			for cz := int((b.z0 - 2) / 8); cz <= int((b.z1+2)/8); cz++ {
				cells[[2]int{cx, cz}] = append(cells[[2]int{cx, cz}], b)
			}
		}
	}
	w.Obstacles = func(x, y, z, r, h float64) bool {
		if r > 2 {
			return town.blocked(x, y, z, r, h)
		}
		return navBoxes(cells[[2]int{int(x / 8), int(z / 8)}]).blocked(x, y, z, r, h)
	}
	tc := &townCrowd{w: w}
	for k := 0; k < 20; k++ {
		i, j := k%5, k/5%4
		x0, z0 := 2000+float64(i)*bx-4, 2000+float64(j)*bz-4
		l := townLap{x0: x0, z0: z0, x1: x0 + 18, z1: z0 + 16, at: float64(k) * 7}
		x, z := l.pos()
		h := newHand(w, uint32(k+1), movement.Vec3{X: x, Z: z}, "sword")
		h.p.HPMax, h.p.HP = 1e12, 1e12
		tc.hs = append(tc.hs, h)
		tc.laps = append(tc.laps, l)
	}
	keys := []string{"wolf", "boar", "cutthroat", "wolf", "brute"}
	for g := 0; g < 40; g++ {
		i, j := g%7, g/7%6
		at := movement.Vec3{X: 2000 + float64(i)*bx - 4, Z: 2000 + float64(j)*bz - 4 + float64(g/42)*2}
		grp := w.TestGroup(at, keys, 1, "")
		w.spawnGroup(grp)
		for m, e := range grp.Members {
			e.Pos = w.place(at.X+float64(m%3)*0.9, at.Z+float64(m/3)*0.9, e.Def)
			e.State, e.Target = Chase, tc.hs[(g*5+m)%len(tc.hs)].p.ID
		}
	}
	w.Drain()
	return tc
}

// step moves the players 5 m/s round their laps and steps the world.
func (tc *townCrowd) step() time.Duration {
	for k, h := range tc.hs {
		l := &tc.laps[k]
		l.at += 5.0 / 30
		x, z := l.pos()
		h.p.Pos = movement.Vec3{X: x, Y: 5, Z: z}
	}
	t0 := time.Now()
	tc.w.Step(tc.w.tick + 1)
	d := time.Since(t0)
	tc.w.Drain()
	// keep the fight on: a pack that gave up (home) picks its player again
	for _, e := range tc.w.Enemies() {
		if e.State == Idle {
			e.State, e.Target = Chase, tc.hs[int(e.ID)%len(tc.hs)].p.ID
		}
	}
	return d
}

func BenchmarkTownCrowd(b *testing.B) {
	for _, nav := range []bool{true, false} {
		name := "nav"
		if !nav {
			name = "off"
		}
		b.Run(name, func(b *testing.B) {
			tc := newTownCrowd(nav, goParallel, 4)
			for i := 0; i < 150; i++ {
				tc.step()
			}
			st0 := tc.w.NavStats()
			durs := make([]time.Duration, 0, b.N)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				durs = append(durs, tc.step())
			}
			b.StopTimer()
			st := tc.w.NavStats()
			// (per-tick quantiles are not reported: a tick here is ~0.1 ms,
			// below the Windows clock's resolution; ns/op is the cost)
			_ = durs
			n := float64(b.N)
			b.ReportMetric(float64(st.Requests-st0.Requests)/n, "asks/tick")
			b.ReportMetric(float64(st.Expanded-st0.Expanded)/n, "expanded/tick")
			if asks := st.Requests - st0.Requests; asks > 0 {
				b.ReportMetric(100*float64(st.Shared-st0.Shared)/float64(asks), "shared-%")
			}
			b.ReportMetric(float64(st.MaxTickUnits), "max-units")
			following := 0
			for _, e := range tc.w.Enemies() {
				if e.nav.following() {
					following++
				}
			}
			b.ReportMetric(float64(following), "following")
		})
	}
}

// BenchmarkNavSaturated is the worst case of the budget: 500 enemies west
// of a 100 m wall all ask for paths round it at once (nav_test.go
// navCrowd), so for the first seconds every tick spends the whole budget.
// ns/op against "off" is the nav pass at full budget.
func BenchmarkNavSaturated(b *testing.B) {
	for _, nav := range []bool{true, false} {
		name := "nav"
		if !nav {
			name = "off"
		}
		b.Run(name, func(b *testing.B) {
			var w *World
			var hs []*handPlayer
			busy, ticks := 0, 0
			b.StopTimer()
			for i := 0; i < b.N; i++ {
				if i%90 == 0 { // a fresh crowd, walked up to the wall (3 s, untimed), then 3 s timed: the queue stays full
					w, hs = navCrowd(500, goParallel, 4)
					w.navOff = !nav
					for k := 0; k < 90; k++ {
						for _, h := range hs {
							h.idle(2)
						}
						w.Step(w.tick + 1)
						w.Drain()
					}
				}
				for _, h := range hs {
					h.idle(2)
				}
				b.StartTimer()
				w.Step(w.tick + 1)
				b.StopTimer()
				w.Drain()
				ticks++
				if w.nav != nil && (len(w.nav.queue) > 0 || w.nav.cur != nil) {
					busy++
				}
			}
			b.ReportMetric(100*float64(busy)/float64(ticks), "busy-%")
			b.ReportMetric(float64(w.NavStats().MaxTickUnits), "max-units")
		})
	}
}

// TestTownCrowdChasesRoundHouses keeps the benchmark honest: without
// pathfinding many chasers stand at a wall between them and their player;
// with it they keep moving round the houses.
func TestTownCrowdChasesRoundHouses(t *testing.T) {
	if testing.Short() {
		t.Skip("town crowd")
	}
	stuck := func(nav bool) (int, NavStats) {
		tc := newTownCrowd(nav, nil, 1)
		was := map[uint32]movement.Vec3{}
		n := 0
		for i := 0; i < 30*20; i++ {
			tc.step()
			if i%30 != 0 {
				continue
			}
			for _, e := range tc.w.Enemies() {
				p := tc.w.players[e.Target]
				if prev, ok := was[e.ID]; ok && p != nil && e.State == Chase && hdist(p.Pos, e.Pos) > 6 && hdist(prev, e.Pos) < 1 {
					n++ // a chaser a second without getting anywhere
				}
				was[e.ID] = e.Pos
			}
		}
		return n, tc.w.NavStats()
	}
	on, st := stuck(true)
	off, _ := stuck(false)
	t.Logf("stuck chaser-seconds: nav %d, off %d; nav %+v", on, off, st)
	if on*4 > off {
		t.Fatalf("pathfinding should leave far fewer chasers standing at walls (nav %d, off %d)", on, off)
	}
}
