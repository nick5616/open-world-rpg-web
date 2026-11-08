package voice

import (
	"fmt"
	"math"
	"math/rand"
	"slices"
	"testing"
)

func brute(players []Player) Neighbors {
	return func(i int, r float64, fn func(j int)) {
		for j := range players {
			fn(j)
		}
	}
}

func at(id string, x, z float64) Player { return Player{ID: id, X: x, Z: z} }

func TestJoinLeaveHysteresis(t *testing.T) {
	c := NewComputer()
	steps := []struct {
		d    float64
		want bool
	}{
		{50, false}, // beyond join
		{41, false}, // still beyond join (40)
		{40, true},  // joins at 40
		{45, true},  // stays inside the leave band
		{48, true},  // stays at exactly 48
		{48.5, false},
		{44, false}, // must come back inside 40 to rejoin
		{39.9, true},
	}
	for i, s := range steps {
		ps := []Player{at("a", 0, 0), at("b", s.d, 0)}
		c.Step(ps, brute(ps), false)
		got := slices.Contains(c.Current("a"), "b")
		if got != s.want {
			t.Fatalf("step %d d=%.1f: in set = %v, want %v", i, s.d, got, s.want)
		}
		if slices.Contains(c.Current("b"), "a") != s.want {
			t.Fatalf("step %d: not symmetric with two players", i)
		}
	}
}

func TestDistanceIs3D(t *testing.T) {
	c := NewComputer()
	ps := []Player{at("a", 0, 0), {ID: "b", X: 20, Y: 38, Z: 0}} // 42.9 m away diagonally
	c.Step(ps, brute(ps), false)
	if len(c.Current("a")) != 0 {
		t.Fatalf("a player 43 m away (mostly up) should not be in earshot")
	}
}

func TestCapNearestWithIncumbency(t *testing.T) {
	c := NewComputer()
	// 20 speakers on a line 1..20 m from the listener: the 12 nearest win.
	ps := []Player{at("L", 0, 0)}
	for i := 1; i <= 20; i++ {
		ps = append(ps, at(fmt.Sprintf("s%02d", i), float64(i), 0))
	}
	c.Step(ps, brute(ps), false)
	got := c.Current("L")
	if len(got) != 12 || got[0] != "s01" || got[11] != "s12" {
		t.Fatalf("want s01..s12, got %v", got)
	}
	// A newcomer slightly closer than member s12 does not displace it (8 m
	// head start); one much closer does, and the farthest member leaves.
	ps = append(ps, at("new1", 7, 1))
	c.Step(ps, brute(ps), false)
	if slices.Contains(c.Current("L"), "new1") {
		t.Fatalf("newcomer at 7.1 m displaced a member at 12 m: %v", c.Current("L"))
	}
	ps[len(ps)-1] = at("new1", 0.5, 0)
	ps = append(ps, at("new2", 0.6, 0))
	c.Step(ps, brute(ps), false)
	cur := c.Current("L")
	// new1 at 0.5 m scores 0.5 vs member s12 at 12 m scoring 4: it wins. Same for new2.
	if !slices.Contains(cur, "new1") || !slices.Contains(cur, "new2") || slices.Contains(cur, "s12") || slices.Contains(cur, "s11") {
		t.Fatalf("close newcomers should displace the two farthest members: %v", cur)
	}
	if len(cur) != 12 {
		t.Fatalf("cap broken: %d", len(cur))
	}
}

func TestCaveRule(t *testing.T) {
	c := NewComputer()
	ps := []Player{{ID: "a", Cave: 7}, {ID: "b", X: 31, Cave: 7}, {ID: "c", X: 5, Cave: 0}, {ID: "d", X: 5, Cave: 9}}
	c.Step(ps, brute(ps), false)
	if len(c.Current("a")) != 0 {
		t.Fatalf("31 m in a cave (join 30), open-air and other-system players: none audible, got %v", c.Current("a"))
	}
	ps[1].X = 29
	c.Step(ps, brute(ps), false)
	if got := c.Current("a"); len(got) != 1 || got[0] != "b" {
		t.Fatalf("same system within 30 m: got %v", got)
	}
	ps[1].X = 37.5 // inside the 38 m cave leave band
	c.Step(ps, brute(ps), false)
	if got := c.Current("a"); len(got) != 1 {
		t.Fatalf("cave hysteresis: got %v", got)
	}
}

func TestDeltasFullAndGone(t *testing.T) {
	c := NewComputer()
	ps := []Player{at("a", 0, 0), at("b", 10, 0), at("c", 500, 0)}
	sets, gone := c.Step(ps, brute(ps), false)
	if len(sets) != 3 || len(gone) != 0 {
		t.Fatalf("first step reports every new player (even with an empty set): %v %v", sets, gone)
	}
	if s, ok := sets["c"]; !ok || len(s) != 0 {
		t.Fatalf("c is alone but must be reported with an empty set: %v", sets)
	}
	sets, _ = c.Step(ps, brute(ps), false)
	if len(sets) != 0 {
		t.Fatalf("nothing changed, want no deltas: %v", sets)
	}
	sets, _ = c.Step(ps, brute(ps), true)
	if len(sets) != 3 {
		t.Fatalf("full step lists everyone: %v", sets)
	}
	ps = ps[:2]
	ps[1].X = 100
	sets, gone = c.Step(ps, brute(ps), false)
	if len(gone) != 1 || gone[0] != "c" {
		t.Fatalf("c left: gone = %v", gone)
	}
	if len(sets) != 2 || len(sets["a"]) != 0 || len(sets["b"]) != 0 {
		t.Fatalf("a and b drifted apart: %v", sets)
	}
}

// TestNoFlappingRandomWalk drives a crowd with jittery positions and checks
// that no pair toggles twice within a second (4 intervals): the property the
// voice soak measures end to end.
func TestNoFlappingRandomWalk(t *testing.T) {
	c := NewComputer()
	rng := rand.New(rand.NewSource(3))
	n := 60
	ps := make([]Player, n)
	vel := make([][2]float64, n)
	for i := range ps {
		a := rng.Float64() * 2 * math.Pi
		r := rng.Float64() * 20
		ps[i] = at(fmt.Sprintf("p%02d", i), r*math.Cos(a), r*math.Sin(a))
		vel[i] = [2]float64{math.Cos(a) * 4.9, math.Sin(a) * 4.9}
	}
	type pair struct{ l, s string }
	last := map[pair]int{}
	in := map[pair]bool{}
	flaps := 0
	for step := 0; step < 240; step++ { // 60 s at 4 Hz: disperse for 20 s, back for 20 s, hold
		for i := range ps {
			dir := 1.0
			if step >= 80 && step < 160 {
				dir = -1
			} else if step >= 160 {
				dir = 0
			}
			// 0.25 s of walking plus up to 30 cm of jitter per interval.
			ps[i].X += dir*vel[i][0]*0.25 + (rng.Float64()-0.5)*0.6
			ps[i].Z += dir*vel[i][1]*0.25 + (rng.Float64()-0.5)*0.6
		}
		c.Step(ps, brute(ps), false)
		for i := range ps {
			cur := map[string]bool{}
			for _, s := range c.Current(ps[i].ID) {
				cur[s] = true
			}
			for j := range ps {
				if i == j {
					continue
				}
				p := pair{ps[i].ID, ps[j].ID}
				if step == 0 {
					in[p] = cur[ps[j].ID] // the first sets are the baseline, not a change
					continue
				}
				if cur[ps[j].ID] != in[p] {
					if prev, ok := last[p]; ok && step-prev <= 4 {
						flaps++
						d := math.Hypot(ps[i].X-ps[j].X, ps[i].Z-ps[j].Z)
						t.Logf("flap step %d (prev %d) %s->%s now %v d=%.1f set=%d", step, prev, p.l, p.s, cur[ps[j].ID], d, len(cur))
					}
					last[p] = step
					in[p] = cur[ps[j].ID]
				}
			}
		}
	}
	if flaps > 0 {
		t.Fatalf("%d pairs toggled twice within 1 s", flaps)
	}
}

// Brute-force neighbours: every listener checks all 299 others, the worst
// case (the zone's grid query returns fewer).
func BenchmarkStep300Clustered(b *testing.B) {
	c := NewComputer()
	rng := rand.New(rand.NewSource(1))
	ps := make([]Player, 300)
	for i := range ps {
		ps[i] = at(fmt.Sprintf("%08x-0000-4000-8000-000000000000", i), rng.Float64()*120, rng.Float64()*120)
	}
	nb := brute(ps)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c.Step(ps, nb, i%8 == 0)
	}
}
