package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/tetratelabs/wazero"
)

type goldenFile struct {
	HashAlgo   string `json:"hashAlgo"`
	GenVersion uint32 `json:"genVersion"`
	Worlds     []struct {
		Label string          `json:"label"`
		Seed  string          `json:"seed"`
		Spec  json.RawMessage `json:"spec"`
		Atlas struct {
			Hash  string `json:"hash"`
			Bytes uint32 `json:"bytes"`
		} `json:"atlas"`
		Chunks []struct {
			Cx, Cz int32
			Lod    uint32
			Tag    string
			Hash   string
		} `json:"chunks"`
		Collision []struct {
			X, Z float64
			H    string
		} `json:"collision"`
		Caves *goldenCaves `json:"caves"` // WP09
		Towns *goldenTowns `json:"towns"` // WP20
	} `json:"worlds"`
}

func load(t *testing.T) ([]byte, *goldenFile) {
	t.Helper()
	wasm, err := os.ReadFile(filepath.Join("..", "..", "pkg", "worldgen.wasm"))
	if err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatalf("worldgen.wasm not built: %v", err)
		}
		t.Skipf("worldgen.wasm not built (npm run build:wasm): %v", err)
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "golden", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return wasm, &g
}

// check runs the table (or its first maxChunks chunks per world) and returns
// failures plus LOD-0 chunk times.
func check(t *testing.T, ctx context.Context, h *Host, g *goldenFile, maxChunks int) (fails []string, chunks, points int, ms []float64) {
	lastCaves = caveCounters{}
	lastTowns = townCounters{}
	if v := h.GenVersion(ctx); v != g.GenVersion {
		fails = append(fails, fmt.Sprintf("genVersion %d != %d", v, g.GenVersion))
	}
	for _, w := range g.Worlds {
		var seed uint64
		fmt.Sscan(w.Seed, &seed)
		// The spec is passed as the golden JSON bytes; the generator canonicalizes it.
		ap, an, err := h.AtlasBuild(ctx, w.Spec, seed)
		if err != nil {
			t.Fatalf("%s: atlas_build: %v", w.Label, err)
		}
		if got := fmt.Sprintf("%016x", h.HashRange(ctx, ap, an)); got != w.Atlas.Hash || an != w.Atlas.Bytes {
			fails = append(fails, fmt.Sprintf("%s: atlas %s (%d B) != %s (%d B)", w.Label, got, an, w.Atlas.Hash, w.Atlas.Bytes))
		}
		for i, c := range w.Chunks {
			if maxChunks > 0 && i >= maxChunks {
				break
			}
			t0 := time.Now()
			b, err := h.ChunkBuild(ctx, ap, c.Cx, c.Cz, c.Lod)
			if c.Lod == 0 {
				ms = append(ms, float64(time.Since(t0).Microseconds())/1000)
			}
			if err != nil {
				fails = append(fails, fmt.Sprintf("%s: chunk (%d,%d,%d): %v", w.Label, c.Cx, c.Cz, c.Lod, err))
				continue
			}
			got := h.Hash(ctx, b)
			if got != FNV1a64(b) {
				fails = append(fails, "hash_buffer disagrees with Go FNV-1a")
			}
			if s := fmt.Sprintf("%016x", got); s != c.Hash {
				fails = append(fails, fmt.Sprintf("%s: chunk (%d,%d,lod%d) %s != %s", w.Label, c.Cx, c.Cz, c.Lod, s, c.Hash))
			}
			chunks++
		}
		if w.Caves != nil {
			fails = append(fails, checkCaves(ctx, h, w.Label, ap, w.Caves, maxChunks, &lastCaves)...)
		}
		// WP20: the whole towns layer per world (compiler only: the
		// interpreter subset would spend tens of seconds per world here).
		if w.Towns != nil && maxChunks == 0 {
			fails = append(fails, checkTowns(ctx, h, w.Label, ap, w.Towns, &lastTowns)...)
		}
		for _, p := range w.Collision {
			v := h.CollisionHeight(ctx, ap, p.X, p.Z)
			if s := fmt.Sprintf("%016x", math.Float64bits(v)); s != p.H {
				fails = append(fails, fmt.Sprintf("%s: collision (%v,%v) %s != %s", w.Label, p.X, p.Z, s, p.H))
			}
			points++
		}
		h.Free(ctx, ap, an)
	}
	return
}

// TestGolden is host 3 of 3: Go via wazero's optimizing compiler (the engine
// zone servers use on amd64/arm64).
func TestGolden(t *testing.T) {
	wasm, g := load(t)
	ctx := context.Background()
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	h, err := New(ctx, rt, wasm)
	if err != nil {
		t.Fatal(err)
	}
	fails, chunks, points, ms := check(t, ctx, h, g, 0)
	sort.Float64s(ms)
	mean := 0.0
	for _, v := range ms {
		mean += v / float64(len(ms))
	}
	fmt.Printf("[golden:go] wazero compiler: %d worlds, %d chunks, %d collision points, %d failures; lod0 chunk mean %.2f ms p95 %.2f ms\n",
		len(g.Worlds), chunks, points, len(fails), mean, ms[len(ms)*95/100])
	fmt.Printf("[golden:go] caves: %d cells, %d masks, %d graphs match; cave_build max %.2f ms\n", lastCaves.cells, lastCaves.masks, lastCaves.graphs, lastCaves.maxMs)
	for _, f := range fails {
		t.Error(f)
	}
	if lastCaves.cells < 100 {
		t.Errorf("only %d cave cells checked", lastCaves.cells)
	}
	fmt.Printf("[golden:go] towns: %d worlds match; towns_build max %.0f ms\n", lastTowns.worlds, lastTowns.maxMs)
	if lastTowns.worlds < len(g.Worlds) {
		t.Errorf("only %d of %d town worlds matched", lastTowns.worlds, len(g.Worlds))
	}
	if chunks < 200 {
		t.Fatalf("only %d chunks checked", chunks)
	}
}

// TestGoldenInterpreter runs a subset under wazero's interpreter: a second,
// independent execution engine (and the one used on platforms without the
// compiler) must produce the same bits. ~30 s, so only under npm run
// test:golden (LODESTONE_REQUIRE_WASM=1), not in the default go test sweep.
func TestGoldenInterpreter(t *testing.T) {
	if testing.Short() || os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
		t.Skip("slow; runs under npm run test:golden")
	}
	wasm, g := load(t)
	ctx := context.Background()
	rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigInterpreter())
	defer rt.Close(ctx)
	h, err := New(ctx, rt, wasm)
	if err != nil {
		t.Fatal(err)
	}
	g.Worlds = g.Worlds[:1]
	fails, chunks, points, _ := check(t, ctx, h, g, 12)
	fmt.Printf("[golden:go] wazero interpreter: 1 world, %d chunks, %d collision points, %d failures\n", chunks, points, len(fails))
	for _, f := range fails {
		t.Error(f)
	}
}
