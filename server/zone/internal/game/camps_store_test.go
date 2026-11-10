package game

// camp_pieces and chest items on Postgres (CR 025; scratch database from
// dbtest, skipped without the local infra unless LODESTONE_REQUIRE_INFRA=1):
// a piece round trip (40-bit ids, every field), owner_seen_at only moves
// forward, delete; an item stored in a chest is loaded with its piece, is
// never restored as a dropped pickup, and is taken out exactly once.

import (
	"context"
	"errors"
	"testing"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/zone/internal/items"
)

func TestPGCampStoreRoundTripAndChestItems(t *testing.T) {
	pool, st, world, char := itemsDB(t)
	ctx := context.Background()
	cs := &PGCampStore{Pool: pool}
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	chest := CampRow{ID: 1<<40 - 3, Owner: char, OwnerName: "Itemist", Kind: campdefs.Chest, XCm: 123456, YCm: -250, ZCm: 234567, Rot: 5, Lock: 1, Party: 0xfedcba98, PlacedAt: t0, SeenAt: t0}
	fire := CampRow{ID: 77, Owner: "not-a-character", Kind: campdefs.Campfire, XCm: 1, YCm: 2, ZCm: 3, BurnUntil: 1234567.25, Label: "", PlacedAt: t0, SeenAt: t0}
	for _, r := range []CampRow{chest, fire} {
		if err := cs.SaveCamp(ctx, world, "zone-a", r); err != nil {
			t.Fatal(err)
		}
	}
	// A later save with an older owner_seen_at does not move it back; the label and fuel change.
	upd := fire
	upd.Label, upd.BurnUntil, upd.SeenAt = "Hearth of Ash", 2000000, t0.Add(-time.Hour)
	if err := cs.SaveCamp(ctx, world, "zone-b", upd); err != nil {
		t.Fatal(err)
	}
	// An item stored in the chest: a world row naming the chest.
	it := items.Stack("wood:firewood", 7)
	it.ID = items.NewID()
	spot := &WorldSpot{WorldID: world, X: 1234.56, Y: 1, Z: 2345.67, Chest: chest.ID}
	if err := st.ApplyItemOp(ctx, &ItemOp{ID: items.NewID(), Char: char, Upsert: []ItemRow{{Item: it.Clone(), World: spot}}}); err != nil {
		t.Fatal(err)
	}
	rows, err := cs.LoadCamps(ctx, world)
	if err != nil || len(rows) != 2 {
		t.Fatalf("loaded %+v %v", rows, err)
	}
	byID := map[uint64]CampRow{}
	for _, r := range rows {
		byID[r.ID] = r
	}
	c, f := byID[chest.ID], byID[fire.ID]
	if c.Owner != char || c.Kind != campdefs.Chest || c.XCm != 123456 || c.YCm != -250 || c.Rot != 5 || c.Lock != 1 || c.Party != 0xfedcba98 || !c.SeenAt.Equal(t0) {
		t.Fatalf("chest row %+v", c)
	}
	if len(c.ChestItems) != 1 || c.ChestItems[0].ID != it.ID || c.ChestItems[0].Qty != 7 {
		t.Fatalf("chest items %+v", c.ChestItems)
	}
	if f.Label != "Hearth of Ash" || f.BurnUntil != 2000000 || !f.SeenAt.Equal(t0) {
		t.Fatalf("fire row %+v (owner_seen_at must never move back)", f)
	}
	// Never restored as a dropped pickup, never deleted as expired.
	if w, err := st.LoadWorldItems(ctx, world, time.Now()); err != nil || len(w) != 0 {
		t.Fatalf("chest item restored as a world item: %+v %v", w, err)
	}
	if n := countItems(t, pool, `id = $1::uuid AND camp_piece_id = $2`, it.ID, int64(chest.ID)); n != 1 {
		t.Fatal("chest item gone after LoadWorldItems")
	}
	// Taken out once: the row is the character's again (camp_piece_id cleared); a second take fails.
	took := it.Clone()
	took.Slot = "inv:4"
	take := &ItemOp{ID: items.NewID(), Char: char, Grant: &GrantMark{Key: "take:" + it.ID + ":1"}, Take: []string{it.ID}, Upsert: []ItemRow{{Item: took, Owner: char}}}
	if err := st.ApplyItemOp(ctx, take); err != nil {
		t.Fatal(err)
	}
	if n := countItems(t, pool, `id = $1::uuid AND owner_character_id = $2::uuid AND camp_piece_id IS NULL`, it.ID, char); n != 1 {
		t.Fatal("taken item not the character's")
	}
	again := &ItemOp{ID: items.NewID(), Char: char, Grant: &GrantMark{Key: "take:" + it.ID + ":1"}, Take: []string{it.ID}, Upsert: []ItemRow{{Item: took, Owner: char}}}
	if err := st.ApplyItemOp(ctx, again); !errors.Is(err, ErrDuplicateGrant) {
		t.Fatalf("second take: %v", err)
	}
	// Delete.
	if err := cs.DeleteCamp(ctx, world, fire.ID); err != nil {
		t.Fatal(err)
	}
	if rows, _ := cs.LoadCamps(ctx, world); len(rows) != 1 || rows[0].ID != chest.ID {
		t.Fatalf("after delete: %+v", rows)
	}
	// A dev (non-uuid) world is memory only.
	if r, err := cs.LoadCamps(ctx, "camps-dev"); err != nil || len(r) != 0 {
		t.Fatalf("dev world %v %v", r, err)
	}
}
