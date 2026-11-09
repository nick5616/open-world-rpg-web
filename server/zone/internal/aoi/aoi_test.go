package aoi

import (
	"math"
	"math/rand"
	"slices"
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

// G5: QueryMark finds exactly what Query finds (sparse and dense paths,
// world edges, empty and crowded cells).
func TestQueryMarkMatchesQuery(t *testing.T) {
	for _, n := range []int{20, 3000} {
		rng := rand.New(rand.NewSource(int64(n) + 1))
		g := NewWorld()
		for i := 0; i < n; i++ {
			x, z := rng.Float64()*4096, rng.Float64()*4096
			if i%7 == 0 {
				x, z = 1500+rng.NormFloat64()*40, 1500+rng.NormFloat64()*40
			}
			g.Insert(int32(i), x, z)
		}
		for q := 0; q < 100; q++ {
			x, z := rng.Float64()*4096, rng.Float64()*4096
			switch q % 4 {
			case 0:
				x, z = 1500, 1500
			case 1:
				x, z = rng.Float64()*20, 4090
			}
			for _, r := range []float64{QueryRadiusOthers, QueryRadius, 10} {
				want := make([]uint64, (n+63)/64)
				g.Query(x, z, r, func(i int32) { want[i>>6] |= 1 << (uint(i) & 63) })
				got := make([]uint64, (n+63)/64)
				g.QueryMark(x, z, r, got)
				if !slices.Equal(got, want) {
					t.Fatalf("n=%d query %d r=%v: QueryMark differs from Query", n, q, r)
				}
			}
		}
	}
}

// G5: DueAll(tick, id).Has(r) == Due(r, tick, id).
func TestDueMaskMatchesDue(t *testing.T) {
	for tick := uint32(0); tick < 200; tick++ {
		for id := uint32(0); id < 100; id++ {
			m := DueAll(tick+4_000_000_000, id*7919)
			for r := None; r <= Party; r++ {
				if m.Has(r) != Due(r, tick+4_000_000_000, id*7919) {
					t.Fatalf("tick %d id %d ring %v", tick, id, r)
				}
			}
		}
	}
}

// G5: Classify ignores known except where UsesKnown says so.
func TestClassifyUsesKnownOnlyWhereSaid(t *testing.T) {
	kinds := []proto.EntityKind{proto.EntityKindPlayer, proto.EntityKindEnemy, proto.EntityKindNpc, proto.EntityKindPickup, proto.EntityKindProjectile}
	for d := 0.0; d < 700; d += 0.125 {
		for _, k := range kinds {
			for _, party := range []bool{false, true} {
				if a, b := Classify(d, k, false, party), Classify(d, k, true, party); a != b && !UsesKnown(d, k) {
					t.Fatalf("d=%v kind=%v party=%v: known changes the ring (%v vs %v) but UsesKnown is false", d, k, party, a, b)
				}
			}
		}
	}
}

// G5: QueryMarkWithin marks a subset of QueryMark that still holds every
// entity closer than r (brute force, incl. positions clamped in from outside
// the world and entities exactly on cell edges), and skips something.
func TestQueryMarkWithinKeepsEverythingCloserThanR(t *testing.T) {
	rng := rand.New(rand.NewSource(9))
	const n = 4000
	g := NewWorld()
	xs, zs := make([]float64, n), make([]float64, n)
	for i := range xs {
		switch i % 5 {
		case 0: // on a cell edge
			xs[i], zs[i] = float64(rng.Intn(128))*32, float64(rng.Intn(128))*32
		case 1: // outside the world
			xs[i], zs[i] = -rng.Float64()*100, rng.Float64()*4096
		default:
			xs[i], zs[i] = 2000+rng.NormFloat64()*300, 2000+rng.NormFloat64()*300
		}
		g.Insert(int32(i), xs[i], zs[i])
	}
	skipped := 0
	for q := 0; q < 300; q++ {
		x, z := 2000+rng.NormFloat64()*300, 2000+rng.NormFloat64()*300
		switch q % 6 {
		case 0:
			x, z = float64(rng.Intn(128))*32, float64(rng.Intn(128))*32
		case 1:
			x = rng.Float64() * 150
		}
		for _, r := range []float64{QueryRadiusOthers, 64, 300} {
			sq := make([]uint64, (n+63)/64)
			g.QueryMark(x, z, r, sq)
			in := make([]uint64, (n+63)/64)
			g.QueryMarkWithin(x, z, r, in)
			for i := 0; i < n; i++ {
				has := func(m []uint64) bool { return m[i>>6]&(1<<(uint(i)&63)) != 0 }
				dx, dz := xs[i]-x, zs[i]-z
				if d := math.Sqrt(dx*dx + dz*dz); d < r && !has(in) {
					t.Fatalf("query %d r=%v: entity %d at %.2f m dropped", q, r, i, d)
				}
				if has(in) && !has(sq) {
					t.Fatalf("query %d: entity %d marked outside the square", q, i)
				}
				if has(sq) && !has(in) {
					skipped++
				}
			}
		}
	}
	if skipped == 0 {
		t.Fatal("QueryMarkWithin never skipped a cell")
	}
}
