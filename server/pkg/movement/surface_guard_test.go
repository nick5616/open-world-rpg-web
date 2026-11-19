package movement

import (
	"math"
	"testing"

	"lodestone/server/pkg/proto"
)

// cliffCave is a level ground with a cliff (x >= 50 rises 6 m per metre)
// over open cave air: under the surface by more than 1 m there is no floor
// for 36 m (what the cave rules read in a cave cell with air at the feet).
// The TS twin is in client/src/sim/surfaceGuard.test.ts.
type cliffCave struct{}

func cliffH(x float64) float64 {
	if x < 50 {
		return 100
	}
	return 100 + (x-50)*6
}

func (cliffCave) HeightAt(x, z float64) float64 { return cliffH(x) }
func (cliffCave) AtLevel(y float64) Ground      { return cliffLevel{y} }

type cliffLevel struct{ y float64 }

func (l cliffLevel) HeightAt(x, z float64) float64 {
	if h := cliffH(x); l.y < h-1 {
		return l.y - 36
	}
	return cliffH(x)
}

// gallopAtCliff spurs a rider at the cliff for n steps.
func gallopAtCliff(n int) (State, float64) {
	g := cliffCave{}
	s := Mount(NewState(Vec3{X: 40, Y: 100, Z: 10}))
	worst := 0.0
	for i := 0; i < n; i++ {
		f := proto.InputFrame{Seq: uint32(i + 1), Flags: proto.InputFlagForward, Yaw: proto.YawToU16(3 * math.Pi / 2)}
		if i%40 == 0 {
			f.Flags |= proto.InputFlagSprint
		}
		s = StepFrame(s, f, g)
		worst = math.Max(worst, cliffH(s.Pos.X)-s.Pos.Y)
	}
	return s, worst
}

// Playtest 2 co-op polish: a gallop into a cliff stops at the face instead
// of going into the hill (and on through the world).
func TestSurfaceGuardStopsGallopAtCliff(t *testing.T) {
	s, worst := gallopAtCliff(240)
	t.Logf("end %v %v %v vel %v %v %v mode %d (TS twin asserts these)", s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z, s.Mode)
	if worst > SurfaceGuardM {
		t.Fatalf("went %.2f m into the cliff", worst)
	}
	if !Mounted(s) {
		t.Fatal("thrown off at the face")
	}
	// A plain heightfield never reaches the guard.
	flat := Flat{Y: 3}
	a := Mount(NewState(Vec3{X: 1, Y: 3, Z: 1}))
	b := surfaceGuard(flat, flat, a, a)
	if b != a {
		t.Fatal("guard touched a ground without levels")
	}
}
