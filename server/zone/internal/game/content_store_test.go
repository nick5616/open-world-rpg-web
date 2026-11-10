package game

// character_content on Postgres (migration 0025; scratch database from
// dbtest, skipped without the local infra unless LODESTONE_REQUIRE_INFRA=1):
// round trip, the epoch fence (an older owner's late save never wins), a
// missing character row.

import (
	"context"
	"errors"
	"testing"

	"lodestone/server/zone/internal/content"
)

func TestPGContentStoreRoundTripAndFence(t *testing.T) {
	_, store, _, char := itemsDB(t)
	ctx := context.Background()
	if _, found, err := store.LoadContent(ctx, char); err != nil || found {
		t.Fatalf("empty: found %v err %v", found, err)
	}
	st := content.NewState()
	st.AddRep(3, 40)
	st.Kill("slime", "slime", false)
	if err := store.SaveContent(ctx, char, st.JSON(), 5); err != nil {
		t.Fatal(err)
	}
	old := content.NewState() // a previous owner's late, older save
	if err := store.SaveContent(ctx, char, old.JSON(), 4); err != nil {
		t.Fatal(err)
	}
	b, found, err := store.LoadContent(ctx, char)
	if err != nil || !found {
		t.Fatal(err)
	}
	got := content.LoadState(b)
	if got.RepOf(3) != 40 || got.Kills["slime"] != 1 {
		t.Fatalf("fence lost the newer save: %s", b)
	}
	st.AddRep(3, 5)
	if err := store.SaveContent(ctx, char, st.JSON(), 0); err != nil { // unfenced single zone
		t.Fatal(err)
	}
	b, _, _ = store.LoadContent(ctx, char)
	if content.LoadState(b).RepOf(3) != 45 {
		t.Fatalf("epoch 0 save %s", b)
	}
	if err := store.SaveContent(ctx, "00000000-0000-0000-0000-000000000001", st.JSON(), 0); !errors.Is(err, ErrNoRow) {
		t.Fatalf("missing row: %v", err)
	}
}
