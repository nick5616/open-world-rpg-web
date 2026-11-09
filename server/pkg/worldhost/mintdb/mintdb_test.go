package mintdb

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/worldhost"
)

func loader(t *testing.T) (func() (*worldhost.Module, error), *int) {
	calls := 0
	return func() (*worldhost.Module, error) {
		calls++
		m, err := worldhost.LoadFromEnv(context.Background())
		if errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", err)
		}
		if err == nil {
			t.Cleanup(func() { _ = m.Close(context.Background()) })
		}
		return m, err
	}, &calls
}

// TestUpgradesPlaceholderThenLeavesItAlone: WP04's placeholder official row
// is minted in place (seed kept, spec/gen_version/atlas_hash real), a second
// start is a no-op that never loads the wasm, and a minted row can't be
// changed.
func TestUpgradesPlaceholderThenLeavesItAlone(t *testing.T) {
	pool, _ := dbtest.Postgres(t)
	db := accountapi.DB{Pool: pool}
	ctx := context.Background()
	ph, _, err := db.EnsureOfficialWorld(ctx, accountapi.World{Name: "Lodestone", Seed: "20261108", Spec: json.RawMessage(`{"placeholder":true}`), GenVersion: "placeholder", AtlasHash: "placeholder"})
	if err != nil {
		t.Fatal(err)
	}
	load, calls := loader(t)
	w, action, err := EnsureOfficial(ctx, db, load, accountapi.World{Name: "Ignored", Seed: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if action != Upgraded || w.ID != ph.ID || w.Seed != "20261108" || w.GenVersion != "2" || len(w.AtlasHash) != 16 || w.Name != "Lodestone" {
		t.Fatalf("upgrade: %s %+v", action, w)
	}
	var spec struct {
		Seed string `json:"seed"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(w.Spec, &spec); err != nil || spec.Seed != "20261108" || spec.Name == "" {
		t.Fatalf("spec %s (%v)", w.Spec, err)
	}

	// The stored (jsonb) spec reopens to the same atlas: the zone's pin holds.
	m, _ := load()
	mt, placeholder, err := m.OpenRow(worldhost.WorldRow{Seed: 20261108, Spec: w.Spec, GenVersion: w.GenVersion, AtlasHash: w.AtlasHash}, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil || placeholder {
		t.Fatalf("reopen minted row: %v %v", err, placeholder)
	}
	mt.World.Close()

	before := *calls
	again, action, err := EnsureOfficial(ctx, db, load, accountapi.World{Seed: "1"})
	if err != nil || action != AlreadyMinted || again.AtlasHash != w.AtlasHash || *calls != before {
		t.Fatalf("second start: %v %s %+v (loads %d -> %d)", err, action, again, before, *calls)
	}

	other, err := m.Mint(5, nil, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	other.World.Close()
	if _, err := SetMint(ctx, db, w.ID, other); !errors.Is(err, ErrMinted) {
		t.Fatalf("re-minting a minted world: %v", err)
	}
	same, err := m.Mint(20261108, nil, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	same.World.Close()
	if _, err := SetMint(ctx, db, w.ID, same); err != nil {
		t.Fatalf("idempotent re-mint: %v", err)
	}
}

func TestCreatesWhenMissing(t *testing.T) {
	pool, _ := dbtest.Postgres(t)
	db := accountapi.DB{Pool: pool}
	load, _ := loader(t)
	w, action, err := EnsureOfficial(context.Background(), db, load, accountapi.World{Name: "Lodestone", Seed: "7"})
	if err != nil || action != Created || w.Seed != "7" || w.GenVersion != "2" || !w.Official {
		t.Fatalf("%v %s %+v", err, action, w)
	}
	// Golden table: seed-7's spec_from_seed atlas.
	if w.AtlasHash != "e0e3c0c797584a62" {
		t.Fatalf("atlas hash %s, golden e0e3c0c797584a62", w.AtlasHash)
	}
}
