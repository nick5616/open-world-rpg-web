package movement_test

// WP10: replays the TypeScript terrain goldens (client/src/sim/golden/
// movement_wp10_*.json: climb, rain climb, kick-off, glide, updraft, swim +
// drowning, slopes, stamina on the official world) through this Go step on
// worldhost's wasm terrain. Passing means the zone and client prediction
// agree on every traversal rule on real generated terrain, not just on flat
// test ground. Skipped without the built wasm unless LODESTONE_REQUIRE_WASM=1.
// An external test package because worldhost imports movement.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/worldhost"
)

// wasmGround queries the wasm directly (collision_height, water_height).
type wasmGround struct{ w *worldhost.World }

func (g wasmGround) HeightAt(x, z float64) float64 { return g.w.CollisionHeight(x, z) }
func (g wasmGround) WaterAt(x, z float64) float64  { return g.w.WaterHeight(x, z) }

type wp10Golden struct {
	Scenario string  `json:"scenario"`
	Dt       float64 `json:"dt"`
	Ground   struct {
		Kind       string `json:"kind"`
		Seed       string `json:"seed"`
		Structures string `json:"structures"` // "towers": terrain + WP12's tower overlay
		GenVersion uint32 `json:"genVersion"`
	} `json:"ground"`
	Env struct {
		Raining  bool         `json:"raining"`
		Updrafts [][5]float64 `json:"updrafts"`
	} `json:"env"`
	StaminaMax int           `json:"staminaMax"`
	Initial    [12]float64   `json:"initial"`
	Frames     [][4]float64  `json:"frames"`
	States     [][12]float64 `json:"states"`
}

func rowState(r [12]float64, staminaMax int) movement.State {
	return movement.State{
		Pos: movement.Vec3{X: r[0], Y: r[1], Z: r[2]}, Vel: movement.Vec3{X: r[3], Y: r[4], Z: r[5]},
		AirJumps: int(r[6]), Mode: int(r[7]), Stamina: int(r[8]), StaminaMax: staminaMax,
		Timer: int(r[9]), Lunge: int(r[10]), Flags: uint8(r[11]),
	}
}

func openOfficial(t *testing.T, seed uint64) *worldhost.World {
	t.Helper()
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", err)
		}
		t.Fatal(err)
	}
	spec, err := mod.SpecFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	w, err := mod.OpenWorld(spec, seed, worldhost.WorldOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestReplaysClientTerrainGoldens(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "client", "src", "sim", "golden", "movement_wp10_*.json"))
	if len(files) == 0 {
		t.Skip("client WP10 goldens not available")
	}
	var w *worldhost.World
	var tr *worldhost.Terrain
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var g wp10Golden
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		if g.Dt != movement.Dt || g.Ground.Kind != "worldgen" {
			t.Fatalf("%s: unexpected dt %v / ground %q", f, g.Dt, g.Ground.Kind)
		}
		if w == nil {
			seed, _ := strconv.ParseUint(g.Ground.Seed, 10, 64)
			w = openOfficial(t, seed)
			if w.Module().GenVersion() != g.Ground.GenVersion {
				t.Fatalf("golden genVersion %d, wasm %d", g.Ground.GenVersion, w.Module().GenVersion())
			}
			tr = worldhost.NewTerrain(w, worldhost.TerrainOptions{Workers: 2})
			defer tr.Close()
		}
		env := movement.Env{Raining: g.Env.Raining}
		if len(g.Env.Updrafts) > 0 {
			var cs movement.Columns
			for _, u := range g.Env.Updrafts {
				cs = append(cs, movement.Column{X: u[0], Z: u[1], Radius: u[2], Top: u[3], Lift: u[4]})
			}
			env.Updraft = cs
		}
		// Replay twice: on the wasm itself and on the zone's cached-chunk fast
		// path (what the zone really runs; bitwise equal by WP07's proof).
		grounds := []struct {
			name string
			g    movement.Ground
		}{{"wasm", wasmGround{w}}, {"terrain", tr}}
		if g.Ground.Structures == "towers" {
			// The ground the zone runs since WP12: towers over the terrain
			// (structures.Towers samples the plain terrain; same bits either way).
			a, err := structures.ParseAtlas(w.Atlas)
			if err != nil {
				t.Fatal(err)
			}
			for i := range grounds {
				o, _ := structures.Towers(a, grounds[i].g)
				grounds[i].g = structures.Wrap(grounds[i].g, o)
				grounds[i].name += "+towers"
			}
		}
		for _, ground := range grounds {
			if ground.name != "wasm" && ground.name != "wasm+towers" {
				for _, r := range g.States {
					tr.Want(r[0], r[2], 4)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				if err := tr.WaitIdle(ctx); err != nil {
					t.Fatal(err)
				}
				cancel()
			}
			s := rowState(g.Initial, g.StaminaMax)
			worst := 0.0
			modes := map[int]int{}
			for i, fr := range g.Frames {
				s = movement.StepFrameEnv(s, proto.InputFrame{Seq: uint32(fr[0]), Flags: uint16(fr[1]), Yaw: uint16(fr[2]), Pitch: int16(fr[3])}, ground.g, env)
				want := rowState(g.States[i], g.StaminaMax)
				got := [6]float64{s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z}
				exp := [6]float64{want.Pos.X, want.Pos.Y, want.Pos.Z, want.Vel.X, want.Vel.Y, want.Vel.Z}
				for k := range got {
					d := math.Abs(got[k] - exp[k])
					worst = math.Max(worst, d)
					if d > 1e-9 {
						t.Fatalf("%s/%s frame %d field %d: go %v vs ts %v (go %+v, ts %+v)", g.Scenario, ground.name, i, k, got[k], exp[k], s, want)
					}
				}
				if s.AirJumps != want.AirJumps || s.Mode != want.Mode || s.Stamina != want.Stamina || s.Timer != want.Timer || s.Lunge != want.Lunge || s.Flags != want.Flags {
					t.Fatalf("%s/%s frame %d: discrete state differs: go %+v vs ts %+v", g.Scenario, ground.name, i, s, want)
				}
				modes[s.Mode]++
			}
			t.Logf("%s/%s: %d frames, modes %v, max |go - ts| = %g", g.Scenario, ground.name, len(g.Frames), modes, worst)
		}
	}
}
