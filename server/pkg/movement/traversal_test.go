package movement

import (
	"math"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// WP10 unit tests on synthetic ground. Parity with the TS step is proven by
// terrain_golden_test.go (8 scenarios on real terrain); these pin the rules
// themselves on the Go side, mirroring client/src/sim/traversal.test.ts.

// wall: flat at 0 for x >= 10, rising westward at grade for x < 10, capped.
type wall struct{ grade, top float64 }

func (w wall) HeightAt(x, _ float64) float64 {
	if x >= 10 {
		return 0
	}
	return math.Min(w.top, (10-x)*w.grade)
}

type lake struct{}

func (lake) HeightAt(x, _ float64) float64 {
	switch {
	case x < 10:
		return -3
	case x < 14:
		return -1
	}
	return 0.5
}
func (lake) WaterAt(_, _ float64) float64 { return 0 }

var west = proto.YawToU16(math.Pi / 2) // forward = -x

func runN(s State, n int, flags uint16, g Ground, env Env) State {
	for i := 0; i < n; i++ {
		s = StepFrameEnv(s, proto.InputFrame{Flags: flags, Yaw: west}, g, env)
	}
	return s
}

func TestSlopeLiteralsMatchDegrees(t *testing.T) {
	tw := math.Tan(constants.WalkableSlopeDeg * math.Pi / 180)
	if math.Abs(tw*tw-constants.WalkableTanSq) > 1e-12 {
		t.Fatalf("WALKABLE_TAN_SQ %v vs tan^2 %v", constants.WalkableTanSq, tw*tw)
	}
	tc := math.Tan(constants.ClimbMaxSlopeDeg * math.Pi / 180)
	if math.Abs(tc*tc/constants.ClimbMaxTanSq-1) > 1e-12 {
		t.Fatalf("CLIMB_MAX_TAN_SQ %v vs tan^2 %v", constants.ClimbMaxTanSq, tc*tc)
	}
	if DrainSprint != 12 || DrainClimb != 10 || DrainGlide != 6 || DrainSwim != 8 || RegenPerStep != 40 || ClimbJumpCost != 1200 || RegenDelaySteps != 60 || LungeSteps != 15 || SlipPeriodSteps != 180 || SlipSteps != 30 || DrownSteps != 90 {
		t.Fatal("derived step constants changed: update the TS twin and the goldens together")
	}
}

func TestBlockedByWallWhenExhaustedThenClimbsWhenFull(t *testing.T) {
	g := wall{3, 6}
	s := NewState(Vec3{X: 11})
	s.Stamina, s.Flags = 0, FlagExhausted
	s = runN(s, 120, proto.InputFlagForward, g, Env{})
	if s.Mode == ModeClimb || s.Pos.Y > 0.5 {
		t.Fatalf("exhausted player got up the wall: %+v", s)
	}
	f := NewState(Vec3{X: 10.3})
	f = runN(f, 30, proto.InputFlagForward, g, Env{})
	if f.Mode != ModeClimb {
		t.Fatalf("no grab: %+v", f)
	}
	f = runN(f, 600, proto.InputFlagForward, g, Env{})
	if f.Mode != ModeGround || f.Pos.Y != 6 {
		t.Fatalf("no mantle onto the top: %+v", f)
	}
}

func TestGlideOpensSinksAndDrains(t *testing.T) {
	s := NewState(Vec3{Y: 50})
	s.Mode, s.Vel.Y, s.AirJumps = ModeAir, -3, 1
	s = StepFrameEnv(s, proto.InputFrame{Flags: proto.InputFlagJumpEdge, Yaw: west}, Flat{}, Env{})
	if s.Mode != ModeGlide {
		t.Fatalf("glider did not open: %+v", s)
	}
	s = runN(s, 120, proto.InputFlagForward, Flat{}, Env{})
	if s.Vel.Y != -constants.GlideSinkSpeed || math.Abs(HorizontalSpeed(s)-constants.GlideSpeed) > 1e-9 || s.Stamina != s.StaminaMax-120*DrainGlide {
		t.Fatalf("glide state %+v", s)
	}
	up := runN(s, 600, 0, Flat{}, Env{Updraft: Columns{{X: s.Pos.X, Z: s.Pos.Z, Radius: 50, Top: 80, Lift: 6}}})
	if up.Pos.Y < 79 || up.Pos.Y > 81 {
		t.Fatalf("updraft did not carry to the column top: %+v", up)
	}
}

func TestSwimDrownRespawn(t *testing.T) {
	s := runN(NewState(Vec3{X: 5, Y: -3}), 1, 0, lake{}, Env{})
	if s.Mode != ModeSwim || s.Pos.Y != -constants.SwimFloatDepthM {
		t.Fatalf("not floating: %+v", s)
	}
	s.Stamina = 16
	s = runN(s, 2, 0, lake{}, Env{})
	if s.Flags&FlagDrowned == 0 {
		t.Fatalf("not drowned: %+v", s)
	}
	s = runN(s, DrownSteps, 0, lake{}, Env{})
	if s.Mode != ModeGround || s.Pos != (Vec3{15, 0.5, 0}) || s.Stamina != s.StaminaMax || s.Flags != 0 {
		t.Fatalf("respawn %+v", s)
	}
}

func TestRainSlipsOncePerPeriod(t *testing.T) {
	g := wall{3, 100}
	s := runN(NewState(Vec3{X: 10.3}), 60, proto.InputFlagForward, g, Env{})
	down := 0
	for i := 0; i < SlipPeriodSteps; i++ {
		n := StepFrameEnv(s, proto.InputFrame{Flags: proto.InputFlagForward, Yaw: west}, g, Env{Raining: true})
		if n.Pos.Y < s.Pos.Y {
			down++
		}
		s = n
	}
	if down != SlipSteps {
		t.Fatalf("%d slipping steps per period, want %d", down, SlipSteps)
	}
}

func TestWireRoundTrip(t *testing.T) {
	s := NewState(Vec3{12.34, 5.67, -8.9})
	s.Mode, s.Stamina, s.Timer, s.Lunge, s.Flags = ModeClimb, 4321, 177, 9, FlagSliding
	var st proto.SelfState
	SelfFields(&st, s)
	if st.Activity != proto.ActivityClimbing || st.Stamina != 720 || st.StaminaMax != 1000 {
		t.Fatalf("self fields %+v", st)
	}
	if got := FromSelf(st); got != s {
		t.Fatalf("round trip %+v != %+v", got, s)
	}
}

func TestParseColumnsAndSpeedBounds(t *testing.T) {
	cs := ParseColumns("10,20,5,100,6; bad; 1,2,3,4")
	if len(cs) != 1 || cs.LiftAt(12, 50, 21) != 6 || cs.LiftAt(12, 101, 21) != 0 {
		t.Fatalf("columns %+v", cs)
	}
	walk := NewState(Vec3{})
	walk.Vel.X = 4.9
	swim := walk
	swim.Mode = ModeSwim
	if MaxHorizontalSpeed(walk, swim) < MaxLegitHorizontalSpeed {
		t.Fatal("walking into water must keep the walk bound for that step")
	}
	climb := NewState(Vec3{})
	climb.Mode = ModeClimb
	if b := MaxHorizontalSpeed(climb, climb); b > constants.ClimbJumpSpeed+1e-5 {
		t.Fatalf("climb bound %v", b)
	}
}
