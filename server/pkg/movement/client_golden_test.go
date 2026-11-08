package movement

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/proto"
)

// plane is WP02's tilted test ground: h = base + sx*x + sz*z.
type plane struct{ base, sx, sz float64 }

func (p plane) HeightAt(x, z float64) float64 { return p.base + p.sx*x + p.sz*z }

// TestReplaysClientGoldens replays the trajectories WP02 generated from its
// TypeScript port (client/src/sim/golden) through this Go step. Passing means
// client prediction and the zone agree, which is the whole point of sharing
// the algorithm. Skipped when the client tree is not present.
func TestReplaysClientGoldens(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "client", "src", "sim", "golden")
	for _, name := range []string{"movement_flat.json", "movement_plane.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Skipf("client goldens not available: %v", err)
		}
		var g struct {
			Dt     float64 `json:"dt"`
			Ground struct {
				Kind                 string
				Height, Base, Sx, Sz float64
			} `json:"ground"`
			Initial [7]float64   `json:"initial"` // x y z vx vy vz airJumps
			Frames  [][4]float64 `json:"frames"`  // seq flags yawU16 pitchI16
			States  [][7]float64 `json:"states"`
		}
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		if g.Dt != Dt {
			t.Fatalf("%s: dt %v != %v", name, g.Dt, Dt)
		}
		var ground Ground = Flat{Y: g.Ground.Height}
		if g.Ground.Kind == "plane" {
			ground = plane{g.Ground.Base, g.Ground.Sx, g.Ground.Sz}
		}
		s := State{Pos: Vec3{g.Initial[0], g.Initial[1], g.Initial[2]}, Vel: Vec3{g.Initial[3], g.Initial[4], g.Initial[5]}, AirJumps: int(g.Initial[6])}
		worst := 0.0
		for i, f := range g.Frames {
			s = StepFrame(s, proto.InputFrame{Seq: uint32(f[0]), Flags: uint16(f[1]), Yaw: uint16(f[2]), Pitch: int16(f[3])}, ground)
			w := g.States[i]
			got := [7]float64{s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z, float64(s.AirJumps)}
			for k := range got {
				d := math.Abs(got[k] - w[k])
				worst = math.Max(worst, d)
				if d > 1e-9 {
					t.Fatalf("%s frame %d field %d: go %v vs ts %v", name, i, k, got[k], w[k])
				}
			}
		}
		t.Logf("%s: %d frames, max |go - ts| = %g", name, len(g.Frames), worst)
	}
}
