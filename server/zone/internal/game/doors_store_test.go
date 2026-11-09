package game

// door_state on Postgres (scratch database from dbtest; skipped without
// the local infra unless LODESTONE_REQUIRE_INFRA=1).

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/writebehind"
)

func TestPGDoorStoreRoundTripNewestWins(t *testing.T) {
	pool, url := dbtest.Postgres(t)
	pool2, err := pgxpool.New(context.Background(), url) // a second zone's own pool
	if err != nil {
		t.Fatal(err)
	}
	defer pool2.Close()
	ctx := context.Background()
	const world = "11111111-2222-3333-4444-555555555555"
	a, b := &PGDoorStore{Pool: pool}, &PGDoorStore{Pool: pool2}
	t0 := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	big := uint64(math.MaxUint64 - 7) // prop ids are u64: the top bit must survive
	if err := a.SaveDoors(ctx, world, "zone-a", []DoorRow{{ID: 42, Open: false, At: t0}, {ID: big, Open: false, At: t0}, {ID: 7, Open: true, At: t0}}); err != nil {
		t.Fatal(err)
	}
	// Zone B decides door 42 later (it took the region over); a delayed
	// write from zone A (older) arrives after it and must not undo it.
	if err := b.SaveDoors(ctx, world, "zone-b", []DoorRow{{ID: 42, Open: true, At: t0.Add(time.Minute)}}); err != nil {
		t.Fatal(err)
	}
	if err := a.SaveDoors(ctx, world, "zone-a", []DoorRow{{ID: 42, Open: false, At: t0.Add(time.Second)}}); err != nil {
		t.Fatal(err)
	}
	rows, err := b.LoadDoors(ctx, world)
	if err != nil {
		t.Fatal(err)
	}
	got := map[uint64]bool{}
	for _, r := range rows {
		got[r.ID] = r.Open
	}
	if len(got) != 3 || !got[42] || got[big] || !got[7] {
		t.Fatalf("loaded %+v", rows)
	}
	var zone string
	if err := pool.QueryRow(ctx, `SELECT zone_id FROM door_state WHERE world_id = $1::uuid AND door_id = 42`, world).Scan(&zone); err != nil || zone != "zone-b" {
		t.Fatalf("door 42 written by %q (%v), want zone-b", zone, err)
	}
	// Another world is separate; a dev (non-uuid) world is memory only.
	if o, _ := a.LoadDoors(ctx, "99999999-2222-3333-4444-555555555555"); len(o) != 0 {
		t.Fatalf("other world sees %d doors", len(o))
	}
	if err := a.SaveDoors(ctx, "dev-world", "zone-a", []DoorRow{{ID: 1, At: t0}}); !errors.Is(err, writebehind.ErrSkip) {
		t.Fatalf("dev world save: %v, want ErrSkip", err)
	}
	if o, err := a.LoadDoors(ctx, "dev-world"); err != nil || len(o) != 0 {
		t.Fatalf("dev world load: %v %d", err, len(o))
	}
}
