package worldgen

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// WasmPath finds worldgen/pkg/worldgen.wasm from the test's directory.
func wasmPath(t *testing.T) string {
	p := filepath.Join("..", "..", "..", "..", "..", "worldgen", "pkg", "worldgen.wasm")
	if _, err := os.Stat(p); err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatalf("worldgen.wasm missing: %v", err)
		}
		t.Skip("worldgen.wasm not built (npm run build:wasm)")
	}
	return p
}

type golden struct {
	Worlds []struct {
		Seed  string          `json:"seed"`
		Spec  json.RawMessage `json:"spec"`
		Atlas struct {
			Hash  string `json:"hash"`
			Bytes int    `json:"bytes"`
		} `json:"atlas"`
	} `json:"worlds"`
}

// The creator's mint must produce the golden atlas hash for the golden
// worlds: same wasm, same spec, same bytes in every host (spec 5 rule 5).
func TestAtlasHashMatchesGolden(t *testing.T) {
	ctx := context.Background()
	m, err := Load(ctx, wasmPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close(ctx)
	if m.GenVersionString() != "1" {
		t.Fatalf("genVersion %s", m.GenVersionString())
	}
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "worldgen", "golden", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	for _, w := range g.Worlds[:2] {
		var seed uint64
		for _, c := range w.Seed {
			seed = seed*10 + uint64(c-'0')
		}
		fromSeed, err := m.SpecFromSeed(ctx, seed)
		if err != nil {
			t.Fatal(err)
		}
		a, err := m.BuildAtlas(ctx, fromSeed, seed)
		if err != nil {
			t.Fatal(err)
		}
		if a.AtlasHash != w.Atlas.Hash || a.Bytes != w.Atlas.Bytes {
			t.Fatalf("seed %s: atlas %s (%d bytes), golden %s (%d)", w.Seed, a.AtlasHash, a.Bytes, w.Atlas.Hash, w.Atlas.Bytes)
		}
		var got, want map[string]any
		_ = json.Unmarshal(a.SpecJSON, &got)
		_ = json.Unmarshal(w.Spec, &want)
		if got["name"] != want["name"] || got["seed"] != w.Seed || a.Sites == 0 {
			t.Fatalf("seed %s: SPEC section %s", w.Seed, a.SpecJSON)
		}
	}
}

func TestBuildAtlasRejectsBadSpec(t *testing.T) {
	ctx := context.Background()
	m, err := Load(ctx, wasmPath(t))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close(ctx)
	if _, err := m.BuildAtlas(ctx, []byte(`{"specVersion":1}`), 7); err == nil {
		t.Fatal("want error for an incomplete spec")
	}
	// The module stays usable after an error (instance per call).
	if _, err := m.SpecFromSeed(ctx, 7); err != nil {
		t.Fatal(err)
	}
}
