package vertical_test

// The Go host of the golden table's vertical vectors (genVersion 3, CR 038):
// heights, tiles and the descriptor come from worldgen.wasm through
// worldhost, the dispatch from this package, and every layer height, floor,
// layer, collide result and updraft lift must equal (bit for bit) what the
// TS core (worldgen/js/src/vertical.ts) produced when the table was made.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/vertical"
	"lodestone/server/pkg/worldhost"
)

type goldenFile struct {
	GenVersion int `json:"genVersion"`
	Worlds     []struct {
		Label    string          `json:"label"`
		Seed     string          `json:"seed"`
		Spec     json.RawMessage `json:"spec"`
		Vertical *struct {
			Heights []struct {
				Surf int     `json:"surf"`
				X    float64 `json:"x"`
				Z    float64 `json:"z"`
				H    string  `json:"h"`
			} `json:"heights"`
			Floors []struct {
				X, Y, Z float64
				H       string
				L       int
			} `json:"floors"`
			Collide []struct {
				X, Y, Z float64
				Out     string
			} `json:"collide"`
			Lifts []struct {
				X, Y, Z float64
				V       string
			} `json:"lifts"`
		} `json:"vertical"`
	} `json:"worlds"`
}

func bits(v float64) string { return fmt.Sprintf("%016x", math.Float64bits(v)) }

// terrainBase is the plain terrain (the golden base: no caves, structures or towns).
type terrainBase struct{ w *worldhost.World }

func (t terrainBase) HeightAt(x, z float64) float64 { return t.w.CollisionHeight(x, z) }
func (t terrainBase) WaterAt(x, z float64) float64  { return t.w.WaterHeight(x, z) }

type wasmSource struct{ w *worldhost.World }

func (s wasmSource) LayerHeight(surf int, x, z float64) float64 { return s.w.LayerHeight(surf, x, z) }

// tileSource answers from LOD 0 tiles it builds on first use (the cache path).
type tileSource struct {
	w     *worldhost.World
	tiles map[int]*vertical.Tile
}

func (s *tileSource) LayerHeight(surf int, x, z float64) float64 {
	layer := vertical.SurfLayer(surf)
	cx := int(math.Floor(math.Floor(x) / 64))
	cz := int(math.Floor(math.Floor(z) / 64))
	if cx < 0 || cz < 0 || cx > 63 || cz > 63 {
		return s.w.LayerHeight(surf, x, z)
	}
	k := layer*4096 + cz*64 + cx
	t := s.tiles[k]
	if t == nil {
		b, err := s.w.LayerTile(int32(layer), int32(cx), int32(cz), 0)
		if err != nil {
			panic(err)
		}
		if t, err = vertical.ParseTile(b); err != nil {
			panic(err)
		}
		s.tiles[k] = t
	}
	return vertical.TileValue(t, surf, x, z)
}

func TestGoldenVerticalQueries(t *testing.T) {
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatal(err)
		}
		t.Skipf("worldgen.wasm not built: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "worldgen", "golden", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if int(mod.GenVersion()) != g.GenVersion {
		t.Skipf("worldgen.wasm is genVersion %d, table %d", mod.GenVersion(), g.GenVersion)
	}
	var n, fails int
	for _, w := range g.Worlds {
		if w.Vertical == nil {
			continue
		}
		var seed uint64
		fmt.Sscan(w.Seed, &seed)
		world, err := mod.OpenWorld(w.Spec, seed, worldhost.WorldOptions{MaxInstances: 1})
		if err != nil {
			t.Fatal(err)
		}
		db, err := world.VerticalDesc()
		if err != nil {
			t.Fatal(err)
		}
		vw, err := vertical.Parse(db)
		if err != nil {
			t.Fatal(err)
		}
		ws := wasmSource{world}
		ts := &tileSource{w: world, tiles: map[int]*vertical.Tile{}}
		for _, p := range w.Vertical.Heights {
			for _, src := range []vertical.Source{ws, ts} {
				if got := bits(src.LayerHeight(p.Surf, p.X, p.Z)); got != p.H {
					t.Errorf("%s: layer_height(%d, %v, %v) %s != %s", w.Label, p.Surf, p.X, p.Z, got, p.H)
					fails++
				}
			}
			n++
		}
		gr := &vertical.Ground{Base: terrainBase{world}, W: vw, Src: ts}
		for _, f := range w.Vertical.Floors {
			got := bits(gr.FloorAt(f.X, f.Y, f.Z))
			l := gr.LayerAt(f.X, f.Y, f.Z)
			if got != f.H || l != f.L {
				t.Errorf("%s: floor (%v, %v, %v) %s/%d != %s/%d", w.Label, f.X, f.Y, f.Z, got, l, f.H, f.L)
				fails++
			}
			n++
		}
		for _, c := range w.Vertical.Collide {
			r := gr.Collide(c.X, c.Y, c.Z)
			ceil := 0
			if r.Ceiling {
				ceil = 1
			}
			if got := fmt.Sprintf("%s,%s,%s,%s,%s,%d", bits(r.X), bits(r.Y), bits(r.Z), bits(r.PushX), bits(r.PushZ), ceil); got != c.Out {
				t.Errorf("%s: collide (%v, %v, %v) %s != %s", w.Label, c.X, c.Y, c.Z, got, c.Out)
				fails++
			}
			n++
		}
		up := vertical.Updrafts(vw.Updrafts)
		for _, p := range w.Vertical.Lifts {
			if got := bits(up.LiftAt(p.X, p.Y, p.Z)); got != p.V {
				t.Errorf("%s: updraft (%v, %v, %v) %s != %s", w.Label, p.X, p.Y, p.Z, got, p.V)
				fails++
			}
			n++
		}
		world.Close()
		if fails > 40 {
			t.Fatalf("too many failures")
		}
	}
	t.Logf("%d vertical vectors, %d failures", n, fails)
	if n < 500 {
		t.Errorf("only %d vertical vectors checked", n)
	}
}
