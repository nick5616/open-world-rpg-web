package difficulty

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/accountapi/dbtest"
)

// Two zones (two pools on one scratch database) claim the same areas at
// the same moment with different player levels: exactly one stamp per area
// stands and both read it back (WP16: every zone of a world agrees).
func TestPGStoreFirstWriterWinsAcrossPools(t *testing.T) {
	pool, url := dbtest.Postgres(t)
	pool2, err := pgxpool.New(context.Background(), url) // a second zone's own pool
	if err != nil {
		t.Fatal(err)
	}
	defer pool2.Close()
	m := testMap()
	g := m.Geometry("11111111-2222-3333-4444-555555555555")
	a, b := &PGStore{Pool: pool}, &PGStore{Pool: pool2}
	ctx := context.Background()
	cells := []int{m.Cell(3500, 3500), m.Cell(3500, 3700), m.Cell(300, 3800)}
	for _, c := range cells {
		var wg sync.WaitGroup
		var sa, sb Stamp
		var ea, eb error
		wg.Add(2)
		go func() {
			defer wg.Done()
			sa, ea = a.Claim(ctx, g, Claim{Cell: c, PlayerLevel: 3, CharID: "zone-a-char", Name: "Ana"})
		}()
		go func() {
			defer wg.Done()
			sb, eb = b.Claim(ctx, g, Claim{Cell: c, PlayerLevel: 18, CharID: "zone-b-char", Name: "Bo"})
		}()
		wg.Wait()
		if ea != nil || eb != nil {
			t.Fatal(ea, eb)
		}
		if sa.Level != sb.Level || sa.By != sb.By {
			t.Fatalf("area %d: zones disagree: %+v vs %+v", c, sa, sb)
		}
		if sa.Won == sb.Won {
			t.Fatalf("area %d: exactly one winner (a %v, b %v)", c, sa.Won, sb.Won)
		}
	}
	all, err := a.LoadAll(ctx, g)
	if err != nil || len(all) != len(cells) {
		t.Fatalf("load: %v %d", err, len(all))
	}
	// Another world's map is separate.
	other := m.Geometry("99999999-2222-3333-4444-555555555555")
	if o, _ := a.LoadAll(ctx, other); len(o) != 0 {
		t.Fatalf("other world sees %d stamps", len(o))
	}
	// A neighbour stamped later is smoothed against the stored stamps.
	st, err := a.Claim(ctx, g, Claim{Cell: cells[0] + 1, PlayerLevel: 30, CharID: "x"})
	if err != nil {
		t.Fatal(err)
	}
	lo := 99
	for _, x := range all {
		if x.Cell == cells[0] || x.Cell == cells[1] {
			lo = min(lo, x.Level)
		}
	}
	if st.Level > lo+def().MaxStep {
		t.Fatalf("level %d next to stamps as low as %d", st.Level, lo)
	}
}
