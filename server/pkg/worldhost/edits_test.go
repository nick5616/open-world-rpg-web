package worldhost

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"lodestone/server/pkg/worldedit"
)

// CR 040: the terrain edit overlay on the real world. Generated heights are
// untouched without edits; with edits the cached chunk path and the wasm
// path agree to the bit, and both equal the golden the TypeScript twin
// (client/src/world/edits) replays: contracts/golden/world_edits.json.
// LODESTONE_UPDATE_GOLDEN=1 rewrites the golden from this implementation.

type editGolden struct {
	Seed    string    `json:"seed"`
	Note    string    `json:"note"`
	Edits   []editG   `json:"edits"`
	Samples []sampleG `json:"samples"`
}
type editG struct {
	X, Z int32
	D    int8
}
type sampleG struct {
	X, Z float64
	H    string // f64 bits, hex
}

func goldenEdits() []worldedit.Change {
	// A patch straddling the chunk border x = 1728 (27 * 64) and z = 2048 (32 * 64).
	var out []worldedit.Change
	s := uint32(12345)
	next := func() uint32 { s = s*1664525 + 1013904223; return s >> 8 }
	for i := 0; i < 700; i++ {
		x := int32(1708 + next()%44)
		z := int32(2028 + next()%44)
		d := int8(int32(next()%49) - 24)
		out = append(out, worldedit.Change{X: x, Z: z, D: d})
	}
	// the border row and column, and a clear (a vertex set then reset)
	for i := int32(0); i < 12; i++ {
		out = append(out, worldedit.Change{X: 1728, Z: 2030 + i, D: int8(i - 5)}, worldedit.Change{X: 1710 + i, Z: 2048, D: int8(5 - i)})
	}
	return out
}

func goldenSamples() [][2]float64 {
	var out [][2]float64
	s := uint32(777)
	next := func() float64 { s = s*1664525 + 1013904223; return float64(s>>8) / float64(1<<24) }
	for i := 0; i < 500; i++ {
		out = append(out, [2]float64{1706 + next()*48, 2026 + next()*48})
	}
	for i := 0; i < 40; i++ { // lattice points and the cell diagonal
		x, z := math.Floor(1710+next()*40), math.Floor(2030+next()*40)
		out = append(out, [2]float64{x, z}, [2]float64{x + 0.25, z + 0.75}, [2]float64{x + 0.5, z + 0.5})
	}
	out = append(out, [2]float64{1727.999, 2047.999}, [2]float64{1728, 2048}, [2]float64{1728.0001, 2047.5})
	return out
}

func TestTerrainEditsBitwiseAndGolden(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 2, Capacity: 4096})
	defer tr.Close()
	pts := goldenSamples()
	for _, p := range pts {
		if err := tr.Ensure(p[0], p[1], 0); err != nil {
			t.Fatal(err)
		}
	}
	base := make([]float64, len(pts))
	for i, p := range pts {
		base[i] = tr.HeightAt(p[0], p[1])
	}
	// An empty overlay changes nothing.
	ov := worldedit.New()
	tr.SetEdits(ov)
	for i, p := range pts {
		if math.Float64bits(tr.HeightAt(p[0], p[1])) != math.Float64bits(base[i]) {
			t.Fatalf("empty overlay changed (%v, %v)", p[0], p[1])
		}
	}
	if _, err := ov.Apply(goldenEdits()); err != nil {
		t.Fatal(err)
	}
	changed := 0
	got := make([]float64, len(pts))
	for i, p := range pts {
		got[i] = tr.HeightAt(p[0], p[1])
		if got[i] != base[i] {
			changed++
		}
		// The reference: lift the four wasm lattice corners and interpolate.
		x0, z0 := math.Floor(p[0]), math.Floor(p[1])
		h := func(dx, dz float64) float32 { return float32(w.CollisionHeight(x0+dx, z0+dz)) }
		d := func(dx, dz int32) int8 { return ov.Delta(int32(x0)+dx, int32(z0)+dz) }
		want := worldedit.Surface(worldedit.Lift(h(0, 0), d(0, 0)), worldedit.Lift(h(1, 0), d(1, 0)), worldedit.Lift(h(0, 1), d(0, 1)), worldedit.Lift(h(1, 1), d(1, 1)), p[0]-x0, p[1]-z0)
		if math.Float64bits(got[i]) != math.Float64bits(want) {
			t.Fatalf("(%v, %v): overlay %v vs reference %v", p[0], p[1], got[i], want)
		}
	}
	if changed < len(pts)/3 {
		t.Fatalf("only %d of %d samples changed", changed, len(pts))
	}
	// The wasm path (no cached chunk) agrees: a fresh terrain with the same overlay and no chunks.
	cold := NewTerrain(w, TerrainOptions{Workers: 1, Capacity: 4096})
	defer cold.Close()
	cold.SetEdits(ov)
	for i, p := range pts[:80] {
		if math.Float64bits(cold.HeightAt(p[0], p[1])) != math.Float64bits(got[i]) {
			t.Fatalf("cold path differs at (%v, %v)", p[0], p[1])
		}
	}
	// BaseLattice ignores edits.
	if float64(tr.BaseLattice(1730, 2040)) != w.CollisionHeight(1730, 2040) {
		t.Fatal("BaseLattice is not the generated height")
	}

	path := filepath.Join("..", "..", "..", "contracts", "golden", "world_edits.json")
	g := editGolden{Seed: strconv.Itoa(officialSeed), Note: "CR 040: terrain edit overlay; heights are f64 bits (hex) of the zone's HeightAt with these edits applied over the generated world"}
	for _, c := range goldenEdits() {
		g.Edits = append(g.Edits, editG{c.X, c.Z, c.D})
	}
	for i, p := range pts {
		g.Samples = append(g.Samples, sampleG{p[0], p[1], strconv.FormatUint(math.Float64bits(got[i]), 16)})
	}
	if os.Getenv("LODESTONE_UPDATE_GOLDEN") == "1" {
		b, _ := json.MarshalIndent(g, "", " ")
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", path)
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("golden missing (run with LODESTONE_UPDATE_GOLDEN=1): %v", err)
	}
	var want editGolden
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Samples) != len(g.Samples) || len(want.Edits) != len(g.Edits) {
		t.Fatalf("golden has %d samples / %d edits, test builds %d / %d", len(want.Samples), len(want.Edits), len(g.Samples), len(g.Edits))
	}
	for i := range want.Samples {
		if want.Samples[i].H != g.Samples[i].H {
			t.Fatalf("sample %d (%v, %v): %s, golden %s", i, g.Samples[i].X, g.Samples[i].Z, g.Samples[i].H, want.Samples[i].H)
		}
	}
}
