package difficulty

import (
	"context"
	"math"
	"sync"
	"testing"

	"lodestone/server/pkg/combatdefs"
)

func def() *combatdefs.Difficulty { return &combatdefs.D.Difficulty }

func TestProposeFollowsThePlayerWithoutNeighbours(t *testing.T) {
	for _, lvl := range []int{1, 4, 15, 29} {
		if got := Propose(def(), lvl, nil, 0); got != lvl {
			t.Errorf("level %d alone: got %d", lvl, got)
		}
	}
	if got := Propose(def(), 15, nil, 1); got != 15+int(def().DangerBonus) {
		t.Errorf("danger bonus: got %d", got)
	}
	if got := Propose(def(), 99, nil, 1); got != def().MaxLevel {
		t.Errorf("cap: got %d", got)
	}
}

func TestProposeIsSmoothedAgainstNeighbours(t *testing.T) {
	// A level-15 explorer next to the Haven (level 1) stamps at most 1+maxStep.
	if got := Propose(def(), 15, []int{1}, 0); got != 1+def().MaxStep {
		t.Errorf("next to the Haven: got %d", got)
	}
	// Next to a level-10 area: pulled to the middle, clamped to 10+maxStep.
	got := Propose(def(), 15, []int{10}, 0)
	if got < 10 || got > 10+def().MaxStep {
		t.Errorf("next to level 10: got %d", got)
	}
	// A level-1 explorer next to level-12 areas is pulled up (no cliffs).
	if got := Propose(def(), 1, []int{12, 12}, 0); got < 12-def().MaxStep {
		t.Errorf("low explorer next to 12: got %d", got)
	}
	// Neighbours far apart: within maxStep of the lowest.
	if got := Propose(def(), 20, []int{1, 20}, 0); got != 1+def().MaxStep {
		t.Errorf("spread neighbours: got %d", got)
	}
}

func testMap() *Map {
	return New(def(), 4096, 1000, 1000, func(x, z float64) float64 { return 0 })
}

func TestHavenAroundTheSpawn(t *testing.T) {
	m := testMap()
	c := m.Cell(1000, 1000)
	if !m.Haven(c) {
		t.Fatal("the spawn area must be the Haven")
	}
	if l, ok := m.Level(c); !ok || l != 1 {
		t.Fatalf("Haven level %d %v", l, ok)
	}
	tier, idx, ok := m.Tier(c)
	if !ok || idx != 0 || tier.Key != "haven" || tier.Demons != 0 {
		t.Fatalf("Haven tier %+v %d", tier, idx)
	}
	far := m.Cell(3500, 3500)
	if m.Haven(far) {
		t.Fatal("far away is not the Haven")
	}
	if _, ok := m.Level(far); ok {
		t.Fatal("an undiscovered area is unknown")
	}
	n := 0
	for i := 0; i < m.Cells(); i++ {
		if m.Haven(i) {
			n++
		}
	}
	if n < 4 || n > 16 {
		t.Fatalf("Haven areas %d", n)
	}
	// The Haven never changes.
	m.Set(Stamp{Cell: c, Level: 20}, 0)
	if l, _ := m.Level(c); l != 1 {
		t.Fatal("the Haven was stamped over")
	}
}

func TestStampsAreImmutableExceptProvisional(t *testing.T) {
	m := testMap()
	c := m.Cell(3500, 3500)
	m.Set(Stamp{Cell: c, Level: 7, Provisional: true}, 10)
	if l, ok := m.Level(c); !ok || l != 7 || m.Stamped(c) {
		t.Fatal("provisional level")
	}
	if m.NeedsClaim(c, 11) {
		t.Fatal("provisional retries after 30 s, not at once")
	}
	if !m.NeedsClaim(c, 10+30*30) {
		t.Fatal("provisional retry")
	}
	m.Set(Stamp{Cell: c, Level: 9}, 20)
	if l, _ := m.Level(c); l != 9 || !m.Stamped(c) {
		t.Fatal("the real stamp replaces a provisional one")
	}
	m.Set(Stamp{Cell: c, Level: 2}, 30)
	if l, _ := m.Level(c); l != 9 {
		t.Fatal("a stamp changed")
	}
	tier, _, _ := m.Tier(c)
	if tier.Key != "perilous" {
		t.Fatalf("level 9 tier %s", tier.Key)
	}
}

func TestNearCoversTheSpawnRadius(t *testing.T) {
	m := testMap()
	x, z := 2000.0, 2000.0
	near := m.Near(x, z, def().StampReachM, nil)
	if near[0] != m.Cell(x, z) {
		t.Fatal("own area first")
	}
	// Every point within ENEMY_SPAWN_M of the player is in one of them.
	in := map[int]bool{}
	for _, c := range near {
		in[c] = true
	}
	for a := 0.0; a < 6.28; a += 0.1 {
		for _, r := range []float64{50, 120, 160} {
			px, pz := x+r*cos(a), z+r*sin(a)
			if !in[m.Cell(px, pz)] {
				t.Fatalf("(%.0f, %.0f) not covered", px, pz)
			}
		}
	}
}

func TestMemStoreFirstWriterWins(t *testing.T) {
	m := testMap()
	g := m.Geometry("w1")
	st := NewMemStore()
	c := m.Cell(3500, 3500)
	var wg sync.WaitGroup
	res := make([]Stamp, 8)
	for i := range res {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, err := st.Claim(context.Background(), g, Claim{Cell: c, PlayerLevel: 2 + 3*i, CharID: "c" + string(rune('a'+i))})
			if err != nil {
				t.Error(err)
			}
			res[i] = s
		}(i)
	}
	wg.Wait()
	won := 0
	for _, s := range res {
		if s.Won {
			won++
		}
		if s.Level != res[0].Level || s.By != res[0].By {
			t.Fatalf("claims disagree: %+v vs %+v", s, res[0])
		}
	}
	if won != 1 {
		t.Fatalf("%d winners", won)
	}
	all, _ := st.LoadAll(context.Background(), g)
	if len(all) != 1 || all[0].Level != res[0].Level {
		t.Fatalf("load: %+v", all)
	}
	// A neighbour claimed later is smoothed against it.
	n := c - 1
	s2, _ := st.Claim(context.Background(), g, Claim{Cell: n, PlayerLevel: 30})
	if s2.Level > res[0].Level+def().MaxStep {
		t.Fatalf("neighbour %d next to %d", s2.Level, res[0].Level)
	}
}

func cos(a float64) float64 { return math.Cos(a) }
func sin(a float64) float64 { return math.Sin(a) }
