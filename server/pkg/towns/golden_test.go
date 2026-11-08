package towns_test

// The Go host of the golden table's town collision vectors (WP20): the
// towns buffer comes from worldgen.wasm through worldhost, the queries from
// this package, and every floor height and collide result must equal (bit
// for bit) what the TS queries produced when the table was generated.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
)

type goldenFile struct {
	Worlds []struct {
		Label string          `json:"label"`
		Seed  string          `json:"seed"`
		Spec  json.RawMessage `json:"spec"`
		Towns *struct {
			Hash   string         `json:"hash"`
			Counts map[string]int `json:"counts"`
			Floors []struct {
				X, Y, Z float64
				H       string
			} `json:"floors"`
			Collide []struct {
				X, Y, Z float64
				Out     string
			} `json:"collide"`
		} `json:"towns"`
	} `json:"worlds"`
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

func TestGoldenTownQueries(t *testing.T) {
	mod := loadModule(t)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "worldgen", "golden", "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	var floors, collides, fails, worlds int
	for _, w := range g.Worlds {
		if w.Towns == nil {
			continue
		}
		var seed uint64
		fmt.Sscan(w.Seed, &seed)
		world, err := mod.OpenWorld(w.Spec, seed, worldhost.WorldOptions{MaxInstances: 1})
		if err != nil {
			t.Fatal(err)
		}
		b, err := world.TownsBytes()
		if err != nil {
			t.Fatal(err)
		}
		tw, err := towns.Parse(b)
		if err != nil {
			t.Fatal(err)
		}
		if got := len(tw.Settlements); got != w.Towns.Counts["settlements"] {
			t.Errorf("%s: %d settlements, golden %d", w.Label, got, w.Towns.Counts["settlements"])
		}
		if got := tw.Boxes.Len(); got != w.Towns.Counts["boxes"] {
			t.Errorf("%s: %d boxes, golden %d", w.Label, got, w.Towns.Counts["boxes"])
		}
		if got := len(tw.NPCs); got != w.Towns.Counts["npcs"] {
			t.Errorf("%s: %d npcs, golden %d", w.Label, got, w.Towns.Counts["npcs"])
		}
		regions := map[uint8]bool{}
		for _, s := range tw.Settlements {
			regions[s.Region] = true
		}
		if len(regions) != 16 {
			t.Errorf("%s: settlements in %d of 16 regions", w.Label, len(regions))
		}
		c := towns.NewCollision(&tw.Boxes)
		for _, p := range w.Towns.Floors {
			if v := bits(c.FloorAt(p.X, p.Y, p.Z)); v != p.H {
				fails++
				if fails < 20 {
					t.Errorf("%s: floor (%v, %v, %v) %s != %s", w.Label, p.X, p.Y, p.Z, v, p.H)
				}
			}
			floors++
		}
		for _, p := range w.Towns.Collide {
			r := c.Collide(p.X, p.Y, p.Z)
			ceil := 0
			if r.Ceiling {
				ceil = 1
			}
			v := fmt.Sprintf("%s,%s,%s,%s,%s,%d", bits(r.X), bits(r.Y), bits(r.Z), bits(r.PushX), bits(r.PushZ), ceil)
			if v != p.Out {
				fails++
				if fails < 20 {
					t.Errorf("%s: collide (%v, %v, %v) %s != %s", w.Label, p.X, p.Y, p.Z, v, p.Out)
				}
			}
			collides++
		}
		world.Close()
		worlds++
	}
	t.Logf("towns golden: %d worlds, %d floors, %d collides, %d failures", worlds, floors, collides, fails)
	if floors < 1000 || collides < 1000 {
		t.Fatalf("only %d floors / %d collides checked", floors, collides)
	}
}
