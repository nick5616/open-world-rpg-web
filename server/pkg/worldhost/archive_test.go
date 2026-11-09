package worldhost

import (
	"context"
	"testing"
)

// TestArchiveOpensGenVersion1World: the official world as minted on
// genVersion 1 (WP07: seed 20261108, atlas 50ae4562cfd25265) still opens,
// bit for bit, through the archived generator after the default build moved
// to genVersion 2 (spec 5 rule 6, worldgen/archive/README.md).
func TestArchiveOpensGenVersion1World(t *testing.T) {
	cur := testModule(t) // skips without a built wasm
	ctx := context.Background()
	a, err := LoadArchive()
	if err != nil {
		t.Fatal(err)
	}
	e, ok := a.Entry(1)
	if !ok {
		t.Fatal("no genVersion 1 in worldgen/archive/manifest.json")
	}
	m, err := LoadForGenVersion(ctx, "1")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close(ctx)
	if m.GenVersionString() != "1" || m.SHA256() != e.SHA256 {
		t.Fatalf("loaded genVersion %s sha %s, want 1 / %s", m.GenVersionString(), m.SHA256(), e.SHA256)
	}
	spec, err := m.SpecFromSeed(20261108)
	if err != nil {
		t.Fatal(err)
	}
	mt, placeholder, err := m.OpenRow(WorldRow{Seed: 20261108, Spec: spec, GenVersion: "1", AtlasHash: "50ae4562cfd25265"}, WorldOptions{MaxInstances: 1})
	if err != nil || placeholder {
		t.Fatalf("genVersion 1 official world: %v (placeholder %v)", err, placeholder)
	}
	mt.World.Close()

	// The current build refuses that row (the pin), and a row on the current
	// version loads the current build, not the archive.
	if cur.GenVersionString() == "1" {
		t.Skip("current build is genVersion 1")
	}
	if _, _, err := cur.OpenRow(WorldRow{Seed: 20261108, Spec: spec, GenVersion: "1", AtlasHash: "50ae4562cfd25265"}, WorldOptions{MaxInstances: 1}); err == nil {
		t.Fatal("current build opened a genVersion 1 row")
	}
	same, err := LoadForGenVersion(ctx, cur.GenVersionString())
	if err != nil {
		t.Fatal(err)
	}
	defer same.Close(ctx)
	if same.SHA256() != cur.SHA256() {
		t.Fatalf("current genVersion loaded %s, want %s", same.SHA256(), cur.SHA256())
	}
	if v, ok := ParseGenVersion("v2"); !ok || v != 2 {
		t.Fatal("ParseGenVersion v2")
	}
	if _, ok := ParseGenVersion("placeholder"); ok {
		t.Fatal("placeholder parsed")
	}
}
