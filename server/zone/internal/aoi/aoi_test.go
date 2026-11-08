package aoi

import (
	"math"
	"math/rand"
	"sort"
	"testing"

	"lodestone/server/pkg/proto"
)

func TestQueryMatchesBruteForce(t *testing.T) {
	for _, n := range []int{20, 3000} { // sparse path and dense path
		rng := rand.New(rand.NewSource(int64(n)))
		g := NewWorld()
		xs, zs := make([]float64, n), make([]float64, n)
		for i := range xs {
			xs[i], zs[i] = rng.Float64()*4096, rng.Float64()*4096
			g.Insert(int32(i), xs[i], zs[i])
		}
		for q := 0; q < 50; q++ {
			x, z := rng.Float64()*4096, rng.Float64()*4096
			var got []int
			g.Query(x, z, QueryRadius, func(i int32) {
				if math.Hypot(xs[i]-x, zs[i]-z) < QueryRadius {
					got = append(got, int(i))
				}
			})
			var want []int
			for i := range xs {
				if math.Hypot(xs[i]-x, zs[i]-z) < QueryRadius {
					want = append(want, i)
				}
			}
			sort.Ints(got)
			if len(got) != len(want) {
				t.Fatalf("n=%d: got %d want %d", n, len(got), len(want))
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("n=%d mismatch", n)
				}
			}
		}
		g.Reset()
		cnt := 0
		g.Query(2048, 2048, 5000, func(int32) { cnt++ })
		if cnt != 0 {
			t.Fatal("reset left entities behind")
		}
	}
}

func TestOutOfWorldIsClamped(t *testing.T) {
	g := NewWorld()
	g.Insert(1, -50, 5000)
	found := false
	g.Query(0, 4095, 10, func(i int32) { found = found || i == 1 })
	if !found {
		t.Fatal("out-of-world entity must land in an edge cell")
	}
}

func TestClassifyRings(t *testing.T) {
	P, E, K := proto.EntityKindPlayer, proto.EntityKindEnemy, proto.EntityKindPickup
	cases := []struct {
		d           float64
		kind        proto.EntityKind
		known, prty bool
		want        Ring
	}{
		{10, P, false, false, Near},
		{63.9, K, false, false, Near},
		{100, K, false, false, None}, // pickups only up close
		{100, E, false, false, Mid},
		{199, P, false, false, Mid},
		{300, E, false, false, None}, // far ring is players only
		{300, P, false, false, Far},
		{605, P, false, false, None},
		{605, P, true, false, Far}, // hysteresis
		{2000, P, false, true, Party},
		{2000, P, false, false, None},
	}
	for _, c := range cases {
		if got := Classify(c.d, c.kind, c.known, c.prty); got != c.want {
			t.Errorf("d=%v kind=%d known=%v party=%v: got %v want %v", c.d, c.kind, c.known, c.prty, got, c.want)
		}
	}
}

func TestDueRates(t *testing.T) {
	for _, c := range []struct {
		r    Ring
		want int
	}{{Near, 30}, {Mid, 10}, {Far, 2}, {Party, 2}, {None, 0}} {
		n := 0
		for tick := uint32(1); tick <= 30; tick++ {
			if Due(c.r, tick, 12345) {
				n++
			}
		}
		if n != c.want {
			t.Errorf("%v: %d updates per second, want %d", c.r, n, c.want)
		}
	}
}
