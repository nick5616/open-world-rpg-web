package caves_test

// Golden cave trajectory, Go side (WP09): replay the frames the TS walker
// produced (client/src/world/caves/golden/cave_path.json) through the Go
// movement step on the Go cave ground and require every sampled state to
// match the TS states bit for bit. This is "client prediction == server
// simulation" on a path from a mouth to the deepest chamber.

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/worldhost"
)

type cavePath struct {
	Seed       string     `json:"seed"`
	System     int        `json:"system"`
	Start      [3]float64 `json:"start"`
	Frames     string     `json:"frames"`
	FrameCount int        `json:"frameCount"`
	Samples    []struct {
		Frame int    `json:"frame"`
		S     string `json:"s"`
	} `json:"samples"`
}

func stateKey(s movement.State) string {
	v := []float64{s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z}
	parts := make([]string, 0, 7)
	for _, f := range v {
		parts = append(parts, fmt.Sprintf("%016x", math.Float64bits(f)))
	}
	return strings.Join(parts, ",") + fmt.Sprintf(",%d", s.AirJumps)
}

// LoadCavePath reads the golden walk (exported for the zone test via a copy).
func loadCavePath(t *testing.T) *cavePath {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "client", "src", "world", "caves", "golden", "cave_path.json"))
	if err != nil {
		t.Fatal(err)
	}
	var p cavePath
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func TestGoldenCavePath(t *testing.T) {
	mod := loadModule(t)
	p := loadCavePath(t)
	var seed uint64
	fmt.Sscan(p.Seed, &seed)
	spec, err := mod.SpecFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	world, err := mod.OpenWorld(spec, seed, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer world.Close()
	gb, err := world.CaveGraph()
	if err != nil {
		t.Fatal(err)
	}
	graph, err := caves.ParseGraph(gb)
	if err != nil {
		t.Fatal(err)
	}
	ground := &caves.Ground{Height: world.CollisionHeight, Openings: graph.OpeningsList, Cells: &lazyCells{w: world, cells: map[uint32]*caves.Cell{}}}
	raw, err := base64.StdEncoding.DecodeString(p.Frames)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int]string{}
	for _, s := range p.Samples {
		want[s.Frame] = s.S
	}
	st := movement.State{Pos: movement.Vec3{X: p.Start[0], Y: p.Start[1], Z: p.Start[2]}}
	// Go math.Sin/Cos and V8 Math.sin/cos may differ in the last ulp for some
	// yaws (server/pkg/movement README), so states are compared within 1e-9
	// (WP03's replay tolerance) and bit-exact samples are counted separately.
	checked, mismatches, exact := 0, 0, 0
	maxDiff := 0.0
	for n := 0; n < p.FrameCount; n++ {
		flags := binary.LittleEndian.Uint16(raw[n*4:])
		yaw := binary.LittleEndian.Uint16(raw[n*4+2:])
		st = movement.Step(st, flags, float64(yaw)/65536*2*math.Pi, ground)
		if w, ok := want[n+1]; ok {
			checked++
			got := stateKey(st)
			if got == w {
				exact++
			}
			parts := strings.Split(w, ",")
			mine := []float64{st.Pos.X, st.Pos.Y, st.Pos.Z, st.Vel.X, st.Vel.Y, st.Vel.Z}
			diff := 0.0
			for i, m := range mine {
				var b uint64
				fmt.Sscanf(parts[i], "%x", &b)
				diff = math.Max(diff, math.Abs(m-math.Float64frombits(b)))
			}
			maxDiff = math.Max(maxDiff, diff)
			if diff > 1e-9 {
				if mismatches < 3 {
					t.Errorf("frame %d: Go %s\n           TS %s", n+1, got, w)
				}
				mismatches++
			}
		}
	}
	s := graph.Systems[p.System]
	deep := graph.Chambers[s.FirstChamber+s.Deepest]
	fmt.Printf("[cave-path:go] %d frames replayed, %d sampled states (%d bit-exact), max |Go - TS| %.3g, %d over 1e-9; end (%.2f, %.2f, %.2f), deepest chamber floor %.2f, system %d\n",
		p.FrameCount, checked, exact, maxDiff, mismatches, st.Pos.X, st.Pos.Y, st.Pos.Z, deep.Floor, graph.SystemAt(st.Pos.X, st.Pos.Y+1, st.Pos.Z))
	if checked < 10 {
		t.Fatalf("only %d samples", checked)
	}
	if graph.SystemAt(st.Pos.X, st.Pos.Y+1, st.Pos.Z) != p.System || math.Abs(st.Pos.Y-deep.Floor) > 2.5 {
		t.Fatalf("walk did not end in the deepest chamber")
	}
}
