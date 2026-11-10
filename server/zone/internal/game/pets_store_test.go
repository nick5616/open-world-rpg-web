package game

// character_pets on Postgres (migration 0029; scratch database from dbtest,
// skipped without the local infra unless LODESTONE_REQUIRE_INFRA=1): round
// trip, the epoch fence (an older owner's late save never wins), a missing
// character row.

import (
	"context"
	"errors"
	"testing"

	"lodestone/server/zone/internal/content"
)

func TestPGPetStoreRoundTripAndFence(t *testing.T) {
	_, store, _, char := itemsDB(t)
	ctx := context.Background()
	if _, found, err := store.LoadPets(ctx, char); err != nil || found {
		t.Fatalf("empty: found %v err %v", found, err)
	}
	st := &content.PetState{V: 1}
	st.Add(content.PetRec{Species: "wolf", Name: "Fang", Level: 4, HP: 0.7, Element: -1})
	st.Rolls = 3
	if err := store.SavePets(ctx, char, st.JSON(), 5); err != nil {
		t.Fatal(err)
	}
	old := &content.PetState{V: 1} // a previous owner's late, older save
	if err := store.SavePets(ctx, char, old.JSON(), 4); err != nil {
		t.Fatal(err)
	}
	b, found, err := store.LoadPets(ctx, char)
	if err != nil || !found {
		t.Fatal(err)
	}
	got := content.LoadPets(b)
	if len(got.Pets) != 1 || got.Pets[0].Name != "Fang" || got.Pets[0].Level != 4 || got.Rolls != 3 || got.Active != 1 {
		t.Fatalf("fence lost the newer save: %s", b)
	}
	st.Pets[0].Name = "Fang II"
	if err := store.SavePets(ctx, char, st.JSON(), 0); err != nil { // unfenced single zone
		t.Fatal(err)
	}
	b, _, _ = store.LoadPets(ctx, char)
	if content.LoadPets(b).Pets[0].Name != "Fang II" {
		t.Fatalf("epoch 0 save %s", b)
	}
	if err := store.SavePets(ctx, "00000000-0000-0000-0000-000000000001", st.JSON(), 0); !errors.Is(err, ErrNoRow) {
		t.Fatalf("missing row: %v", err)
	}
}
