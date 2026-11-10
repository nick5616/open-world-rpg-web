package combat

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/movement"
)

// TestReplaysSpellsimGoldens replays the client's CR 020 spell simulation
// vectors (client/src/combat/golden/spellsim.golden.ts) through the zone's
// twin: homing flights within 1e-6 m and the same lock state every step,
// the stream jitter / rain patterns, orbit offsets and charge fractions.
// Passing means a homing shot the client claims is the path the zone
// re-flies, and a stream's bullets lean the same way on both sides.
func TestReplaysSpellsimGoldens(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "client", "src", "combat", "golden", "spellsim_golden.json"))
	if err != nil {
		t.Skipf("client goldens not available: %v", err)
	}
	var g struct {
		Homing []struct {
			Name   string
			Spell  string
			Eye    movement.Vec3
			Yaw    float64
			Pitch  float64
			Target struct{ X, Y, Z, Ax, Az, Rx, Rz float64 }
			Steps  int
			States [][7]float64
		}
		Hashes []struct{ A, B, H uint32 }
		Jitter []struct {
			Seed         uint32
			K            int
			Deg          float64
			Dyaw, Dpitch float64
		}
		Rain []struct {
			Seed   uint32
			K      int
			Radius float64
			Dx, Dz float64
		}
		Orbit []struct {
			I, Count, Steps, Period int
			Radius, X, Y, Z         float64
		}
		Charge []struct {
			Held, Max int
			F         float64
		}
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Homing) == 0 || len(g.Jitter) == 0 {
		t.Fatal("empty golden")
	}
	near := func(what string, a, b, tol float64) {
		t.Helper()
		if math.Abs(a-b) > tol {
			t.Fatalf("%s: go %v vs ts %v", what, a, b)
		}
	}
	for _, c := range g.Homing {
		sp := D.SpellByKey(c.Spell)
		p := homingParamsOf(sp)
		s := launchShot(c.Eye, c.Yaw, c.Pitch, sp.Speed)
		locked := false
		for i := 0; i < c.Steps; i++ {
			tg := movement.Vec3{X: c.Target.X + c.Target.Ax*math.Sin(c.Target.Rx*float64(i)), Y: c.Target.Y, Z: c.Target.Z + c.Target.Az*math.Sin(c.Target.Rz*float64(i))}
			if s.canAcquire(tg, p) {
				s.state = 1
			}
			var tp *movement.Vec3
			if s.state == 1 {
				tp = &tg
			}
			s.step(tp, p)
			w := c.States[i]
			got := [7]float64{s.pos.X, s.pos.Y, s.pos.Z, s.vel.X, s.vel.Y, s.vel.Z, float64(s.state)}
			for k := range got {
				tol := 1e-6
				if k == 6 {
					tol = 0
				}
				if math.Abs(got[k]-w[k]) > tol {
					t.Fatalf("%s step %d field %d: go %v vs ts %v", c.Name, i, k, got[k], w[k])
				}
			}
			locked = locked || s.state == 1
		}
		if c.Name != "motes_no_target" && !locked {
			t.Fatalf("%s never locked", c.Name)
		}
	}
	for _, h := range g.Hashes {
		if got := hash32(h.A, h.B); got != h.H {
			t.Fatalf("hash32(%d,%d) = %d, ts %d", h.A, h.B, got, h.H)
		}
	}
	for _, j := range g.Jitter {
		dy, dp := shotJitter(j.Seed, j.K, j.Deg)
		near("jitter yaw", dy, j.Dyaw, 1e-12)
		near("jitter pitch", dp, j.Dpitch, 1e-12)
	}
	for _, r := range g.Rain {
		dx, dz := rainOffset(r.Seed, r.K, r.Radius)
		near("rain x", dx, r.Dx, 1e-9)
		near("rain z", dz, r.Dz, 1e-9)
	}
	for _, o := range g.Orbit {
		v := orbOffset(o.I, o.Count, o.Steps, o.Period, o.Radius)
		near("orbit x", v.X, o.X, 1e-9)
		near("orbit z", v.Z, o.Z, 1e-9)
		near("orbit y", v.Y, o.Y, 0)
	}
	for _, c := range g.Charge {
		near("charge", chargeFrac(c.Held, c.Max), c.F, 0)
	}
}
