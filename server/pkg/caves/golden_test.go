package caves_test

// The Go host of the golden table's cave collision vectors (WP09): cells
// come from worldgen.wasm through worldhost, the queries from this package,
// and every floor height, collide result and system id must equal (bit for
// bit) what the TS queries produced when the table was generated.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/worldhost"
)

type goldenFile struct {
	Worlds []struct {
		Label string          `json:"label"`
		Seed  string          `json:"seed"`
		Spec  json.RawMessage `json:"spec"`
		Caves *struct {
			Floors []struct {
				X, Y, Z float64
				H       string
			} `json:"floors"`
			Collide []struct {
				X, Y, Z float64
				Out     string
			} `json:"collide"`
			SystemAt []struct {
				X, Y, Z float64
				S       int
			} `json:"systemAt"`
			Rays []struct {
				O, D [3]float64
				Max  float64
				T    string
			} `json:"rays"`
		} `json:"caves"`
	} `json:"worlds"`
}

type lazyCells struct {
	w     *worldhost.World
	cells map[uint32]*caves.Cell
}

func (l *lazyCells) Cell(cx, cy, cz int32) *caves.Cell {
	if !caves.ValidCell(cx, cy, cz) {
		return nil
	}
	k := caves.Key(cx, cy, cz)
	if c, ok := l.cells[k]; ok {
		return c
	}
	b, err := l.w.CaveCell(cx, cy, cz, nil)
	if err != nil {
		panic(err)
	}
	c, err := caves.ParseCell(b)
	if err != nil {
		panic(err)
	}
	l.cells[k] = c
	return c
}

func bits(v float64) string { return fmt.Sprintf("%016x", math.Float64bits(v)) }

func loadModule(t *testing.T) *worldhost.Module {
	t.Helper()
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if os.Getenv("LODESTONE_REQUIRE_WASM") == "1" {
			t.Fatal(err)
		}
		t.Skipf("worldgen.wasm not built: %v", err)
	}
	return mod
}

func TestGoldenCaveQueries(t *testing.T) {
	mod := loadModule(t)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "worldgen", "golden", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	var floors, collides, systems, rays, fails int
	for _, w := range g.Worlds {
		if w.Caves == nil {
			continue
		}
		var seed uint64
		fmt.Sscan(w.Seed, &seed)
		world, err := mod.OpenWorld(w.Spec, seed, worldhost.WorldOptions{MaxInstances: 1})
		if err != nil {
			t.Fatal(err)
		}
		gb, err := world.CaveGraph()
		if err != nil {
			t.Fatal(err)
		}
		graph, err := caves.ParseGraph(gb)
		if err != nil {
			t.Fatal(err)
		}
		src := &lazyCells{w: world, cells: map[uint32]*caves.Cell{}}
		ground := &caves.Ground{Height: world.CollisionHeight, Openings: graph.OpeningsList, Cells: src}
		for _, f := range w.Caves.Floors {
			if got := bits(ground.FloorAt(f.X, f.Y, f.Z)); got != f.H {
				t.Errorf("%s: floor (%v, %v, %v) %s != %s", w.Label, f.X, f.Y, f.Z, got, f.H)
				fails++
			}
			floors++
		}
		for _, c := range w.Caves.Collide {
			r := ground.Collide(c.X, c.Y, c.Z)
			ceil := 0
			if r.Ceiling {
				ceil = 1
			}
			if got := fmt.Sprintf("%s,%s,%s,%d", bits(r.X), bits(r.Y), bits(r.Z), ceil); got != c.Out {
				t.Errorf("%s: collide (%v, %v, %v) %s != %s", w.Label, c.X, c.Y, c.Z, got, c.Out)
				fails++
			}
			collides++
		}
		for _, s := range w.Caves.SystemAt {
			if got := graph.SystemAt(s.X, s.Y, s.Z); got != s.S {
				t.Errorf("%s: system at (%v, %v, %v) %d != %d", w.Label, s.X, s.Y, s.Z, got, s.S)
				fails++
			}
			systems++
		}
		for _, r := range w.Caves.Rays {
			if got := bits(caves.Raycast(src, r.O[0], r.O[1], r.O[2], r.D[0], r.D[1], r.D[2], r.Max)); got != r.T {
				t.Errorf("%s: ray %v -> %v %s != %s", w.Label, r.O, r.D, got, r.T)
				fails++
			}
			rays++
		}
		world.Close()
	}
	fmt.Printf("[golden:go] cave queries (server/pkg/caves): %d floors, %d collides, %d system ids, %d rays, %d failures\n", floors, collides, systems, rays, fails)
	if floors < 100 || collides < 100 {
		t.Fatalf("too few cave vectors: %d floors, %d collides", floors, collides)
	}
}
