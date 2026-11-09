package game

// WP14 Postgres tests (scratch database from dbtest; skipped without the
// shared infra): the item transaction's exactly-once rules, the WP16 epoch
// fence, world items, and a zone reload.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/zone/internal/items"
)

func itemsDB(t *testing.T) (*pgxpool.Pool, *PGStore, string, string) {
	t.Helper()
	pool, _ := dbtest.Postgres(t)
	ctx := context.Background()
	var acct, world, char string
	if err := pool.QueryRow(ctx, `INSERT INTO accounts (auth_provider, auth_subject) VALUES ('dev', 'wp14-'||gen_random_uuid()) RETURNING id::text`).Scan(&acct); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO worlds (name, seed, spec, gen_version, atlas_hash) VALUES ('w', 42, '{}', 'g1', 'h') RETURNING id::text`).Scan(&world); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name) VALUES ($1::uuid, $2::uuid, 'Itemist') RETURNING id::text`, acct, world).Scan(&char); err != nil {
		t.Fatal(err)
	}
	return pool, &PGStore{Pool: pool}, world, char
}

func countItems(t *testing.T, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM items WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestItemOpExactlyOnceAndFence(t *testing.T) {
	pool, st, world, char := itemsDB(t)
	ctx := context.Background()
	it := items.Stack("gem:ruby:cut", 2)
	it.ID, it.Slot = items.NewID(), "gem:0"
	op := &ItemOp{ID: items.NewID(), Char: char, Epoch: 100, Grant: &GrantMark{Key: "container:42", Seed: 9}, Upsert: []ItemRow{{Item: it, Owner: char}}}
	if err := st.ApplyItemOp(ctx, op); err != nil {
		t.Fatal(err)
	}
	// A retry of the same op (lost COMMIT reply) is a success, not a second item.
	if err := st.ApplyItemOp(ctx, op); err != nil {
		t.Fatalf("retry: %v", err)
	}
	// A genuine second grant of the same roll is refused.
	it2 := items.Stack("gem:ruby:cut", 2)
	it2.ID, it2.Slot = items.NewID(), "gem:1"
	dup := &ItemOp{ID: items.NewID(), Char: char, Epoch: 100, Grant: &GrantMark{Key: "container:42"}, Upsert: []ItemRow{{Item: it2, Owner: char}}}
	if err := st.ApplyItemOp(ctx, dup); !errors.Is(err, ErrDuplicateGrant) {
		t.Fatalf("duplicate grant: %v", err)
	}
	if n := countItems(t, pool, `owner_character_id = $1::uuid`, char); n != 1 {
		t.Fatalf("%d rows after grant + retry + duplicate, want 1", n)
	}
	// WP16: a newer owner writes (sync at epoch 200); the old owner's late
	// op (epoch 100) is fenced and changes nothing.
	keep := items.Stack("potion:health", 3)
	keep.ID, keep.Slot = items.NewID(), "inv:0"
	sync := &ItemOp{ID: items.NewID(), Char: char, Epoch: 200, Sync: true, Upsert: []ItemRow{{Item: keep, Owner: char}}, Markers: []string{"container:42", "starter"}}
	if err := st.ApplyItemOp(ctx, sync); err != nil {
		t.Fatal(err)
	}
	stale := it.Clone()
	stale.Qty = 99
	late := &ItemOp{ID: items.NewID(), Char: char, Epoch: 100, Upsert: []ItemRow{{Item: stale, Owner: char}}}
	if err := st.ApplyItemOp(ctx, late); !errors.Is(err, errItemsFenced) {
		t.Fatalf("stale op: %v", err)
	}
	inv, markers, found, err := st.LoadItems(ctx, char)
	if err != nil || !found || len(inv) != 1 || inv[0].Base != "potion:health" || inv[0].Qty != 3 || len(markers) != 2 {
		t.Fatalf("after sync + fenced op: %+v markers %v found %v err %v", inv, markers, found, err)
	}

	// TransferItem's world rows: drop (owner NULL, world spot), restore, take
	// with a marker; a second take of the same row is refused.
	spot := &WorldSpot{WorldID: world, X: 1, Y: 2, Z: 3, DespawnAt: time.Now().Add(10 * time.Minute)}
	drop := &ItemOp{ID: items.NewID(), Char: char, Epoch: 200, Update: []ItemRow{{Item: keep.Clone(), World: spot}}}
	if err := st.ApplyItemOp(ctx, drop); err != nil {
		t.Fatal(err)
	}
	rows, err := st.LoadWorldItems(ctx, world, time.Now())
	if err != nil || len(rows) != 1 || rows[0].World.Y != 2 {
		t.Fatalf("world items %+v %v", rows, err)
	}
	took := keep.Clone()
	took.Slot = "inv:3"
	take := &ItemOp{ID: items.NewID(), Char: char, Epoch: 200, Grant: &GrantMark{Key: "take:" + keep.ID}, Take: []string{keep.ID}, Upsert: []ItemRow{{Item: took, Owner: char}}}
	if err := st.ApplyItemOp(ctx, take); err != nil {
		t.Fatal(err)
	}
	again := &ItemOp{ID: items.NewID(), Char: char, Epoch: 200, Grant: &GrantMark{Key: "take:" + keep.ID}, Take: []string{keep.ID}, Upsert: []ItemRow{{Item: took, Owner: char}}}
	if err := st.ApplyItemOp(ctx, again); !errors.Is(err, ErrDuplicateGrant) {
		t.Fatalf("second take: %v", err)
	}
	// Expired world rows are deleted on load.
	gone := items.Stack("food:bread", 1)
	gone.ID = items.NewID()
	_ = st.ApplyItemOp(ctx, &ItemOp{ID: items.NewID(), Upsert: []ItemRow{{Item: gone, World: &WorldSpot{WorldID: world, DespawnAt: time.Now().Add(-time.Second)}}}})
	if rows, _ := st.LoadWorldItems(ctx, world, time.Now()); len(rows) != 0 {
		t.Fatalf("expired world item restored: %+v", rows)
	}
	if n := countItems(t, pool, `id = $1::uuid`, gone.ID); n != 0 {
		t.Fatal("expired world item not deleted")
	}
}
