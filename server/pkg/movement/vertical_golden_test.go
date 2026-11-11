package movement_test

// CR 038: replays the TypeScript vertical-world goldens
// (client/src/sim/golden/movement_pt2_vertical_*.json: off a sky island to
// terminal speed, up a sky lift and onto an island, down a tunnel to a
// cavern floor, a cavern lake swim, a cenote dive) through this Go step on
// the Go twin of the vertical ground (server/pkg/vertical over the wasm
// terrain and layer_height) with vertical.Wind as the updraft field. Within
// 1e-9 m, every discrete field exact. A golden made by another generator
// (the table is regenerated after a generator change) is skipped.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/vertical"
	"lodestone/server/pkg/worldhost"
)

type layerWasm struct{ w *worldhost.World }

func (s layerWasm) LayerHeight(surf int, x, z float64) float64 { return s.w.LayerHeight(surf, x, z) }

func TestReplaysClientVerticalGoldens(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join("..", "..", "..", "client", "src", "sim", "golden", "movement_pt2_vertical_*.json"))
	if len(files) == 0 {
		t.Skip("client vertical goldens not available")
	}
	var w *worldhost.World
	var g *vertical.Ground
	var env movement.Env
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var gd wp10Golden
		if err := json.Unmarshal(raw, &gd); err != nil {
			t.Fatal(err)
		}
		if gd.Ground.Kind != "worldgen-vertical" || gd.Dt != movement.Dt {
			t.Fatalf("%s: ground %q dt %v", f, gd.Ground.Kind, gd.Dt)
		}
		if w == nil {
			seed, _ := strconv.ParseUint(gd.Ground.Seed, 10, 64)
			w = openOfficial(t, seed)
			defer w.Close()
			if w.Module().GenVersion() != gd.Ground.GenVersion {
				t.Skipf("golden genVersion %d, wasm %d", gd.Ground.GenVersion, w.Module().GenVersion())
			}
			b, err := w.VerticalDesc()
			if err != nil {
				t.Fatal(err)
			}
			vw, err := vertical.Parse(b)
			if err != nil {
				t.Fatal(err)
			}
			g = &vertical.Ground{Base: wasmGround{w}, W: vw, Src: layerWasm{w}}
			env = movement.Env{Updraft: vertical.Wind{W: vw}}
		}
		s := rowState(gd.Initial, gd.StaminaMax)
		worst := 0.0
		modes := map[int]int{}
		for i, fr := range gd.Frames {
			s = movement.StepFrameEnv(s, proto.InputFrame{Seq: uint32(fr[0]), Flags: uint16(fr[1]), Yaw: uint16(fr[2]), Pitch: int16(fr[3])}, g, env)
			want := rowState(gd.States[i], gd.StaminaMax)
			got := [6]float64{s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z}
			exp := [6]float64{want.Pos.X, want.Pos.Y, want.Pos.Z, want.Vel.X, want.Vel.Y, want.Vel.Z}
			for k := range got {
				d := math.Abs(got[k] - exp[k])
				worst = math.Max(worst, d)
				if d > 1e-9 {
					t.Fatalf("%s frame %d field %d: go %v vs ts %v (go %+v, ts %+v)", gd.Scenario, i, k, got[k], exp[k], s, want)
				}
			}
			if s.AirJumps != want.AirJumps || s.Mode != want.Mode || s.Stamina != want.Stamina || s.Timer != want.Timer || s.Lunge != want.Lunge || s.Flags != want.Flags {
				t.Fatalf("%s frame %d: discrete state differs: go %+v vs ts %+v", gd.Scenario, i, s, want)
			}
			modes[s.Mode]++
		}
		t.Logf("%s: %d frames, modes %v, max |go - ts| = %g", gd.Scenario, len(gd.Frames), modes, worst)
	}
}
