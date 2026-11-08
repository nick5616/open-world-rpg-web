package movement

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

var update = flag.Bool("update", false, "rewrite testdata/vectors.json")

const (
	fwd    = proto.InputFlagForward
	back   = proto.InputFlagBack
	left   = proto.InputFlagLeft
	right  = proto.InputFlagRight
	jump   = proto.InputFlagJump
	edge   = proto.InputFlagJumpEdge
	sprint = proto.InputFlagSprint
)

func run(s State, n int, flags uint16, yaw float64) State {
	for i := 0; i < n; i++ {
		s = Step(s, flags, yaw, Flat{})
	}
	return s
}

// steady is the ground speed where friction and acceleration balance:
// accel*wish*dt == speed*friction*dt. With wizard-wars' tuned constants that is
// 5.5*8/9 = 4.89 m/s walking, not BASE_MOVE_SPEED: the feel was tuned with
// these numbers, so we keep them (and test them) as they are.
func steady(wish float64) float64 { return constants.GroundAccel * wish / constants.GroundFriction }

func TestWalkReachesSteadySpeedFacingMinusZ(t *testing.T) {
	s := run(NewState(Vec3{}), 120, fwd, 0)
	if math.Abs(s.Vel.Z+steady(constants.BaseMoveSpeed)) > 1e-6 || math.Abs(s.Vel.X) > 1e-9 {
		t.Fatalf("yaw 0 forward should be -Z at base speed, vel=%+v", s.Vel)
	}
	if s.Pos.Y != 0 || s.Vel.Y != 0 {
		t.Fatalf("walking on flat ground must stay at y=0: %+v", s)
	}
}

func TestSprintSpeedAndStrafeDirections(t *testing.T) {
	s := run(NewState(Vec3{}), 240, fwd|sprint, 0)
	want := steady(constants.BaseMoveSpeed * constants.SprintMultiplier)
	if math.Abs(HorizontalSpeed(s)-want) > 1e-6 {
		t.Fatalf("sprint speed %v want %v", HorizontalSpeed(s), want)
	}
	// Yaw 0: right is +X, left is -X, back is +Z.
	for _, c := range []struct {
		flags  uint16
		dx, dz float64
	}{{right, 1, 0}, {left, -1, 0}, {back, 0, 1}, {fwd | right, 1, -1}} {
		s := run(NewState(Vec3{}), 120, c.flags, 0)
		l := math.Hypot(c.dx, c.dz)
		w := steady(constants.BaseMoveSpeed)
		if math.Abs(s.Vel.X-c.dx/l*w) > 1e-6 || math.Abs(s.Vel.Z-c.dz/l*w) > 1e-6 {
			t.Fatalf("flags %b: vel %+v", c.flags, s.Vel)
		}
	}
	// Yaw pi/2 turns forward to -X.
	s = run(NewState(Vec3{}), 120, fwd, math.Pi/2)
	if math.Abs(s.Vel.X+steady(constants.BaseMoveSpeed)) > 1e-6 || math.Abs(s.Vel.Z) > 1e-6 {
		t.Fatalf("yaw pi/2 forward vel %+v", s.Vel)
	}
}

func TestFrictionStops(t *testing.T) {
	s := run(NewState(Vec3{}), 120, fwd, 0)
	s = run(s, 60, 0, 0)
	if s.Vel.X != 0 || s.Vel.Z != 0 {
		t.Fatalf("should have stopped within 1 s: %+v", s.Vel)
	}
}

func TestJumpArcAndLanding(t *testing.T) {
	s := Step(NewState(Vec3{}), jump, 0, Flat{})
	if s.Vel.Y != constants.JumpForce {
		t.Fatalf("jump vy %v", s.Vel.Y)
	}
	apex, steps := 0.0, 1
	for s.Pos.Y > 0 || s.Vel.Y != 0 {
		s = Step(s, 0, 0, Flat{})
		apex = math.Max(apex, s.Pos.Y)
		steps++
		if steps > 200 {
			t.Fatal("never landed")
		}
	}
	// v^2/2g = 1 m analytically; discrete Euler with the snap lands near it.
	if apex < 0.9 || apex > 1.1 {
		t.Fatalf("apex %v", apex)
	}
	if steps < 35 || steps > 42 {
		t.Fatalf("airtime %d steps", steps)
	}
	if s.AirJumps != 0 || s.Pos.Y != 0 {
		t.Fatalf("landed state %+v", s)
	}
}

func TestDoubleJumpNeedsEdgeAndIsLimited(t *testing.T) {
	s := Step(NewState(Vec3{}), jump, 0, Flat{})
	s = run(s, 10, 0, 0)
	vyBefore := s.Vel.Y
	s = Step(s, jump, 0, Flat{}) // held jump in the air does nothing
	if s.Vel.Y >= vyBefore || s.AirJumps != 0 {
		t.Fatalf("held jump must not double jump: %+v", s)
	}
	s = Step(s, edge, 0, Flat{})
	if s.Vel.Y != constants.JumpForce || s.AirJumps != 1 {
		t.Fatalf("edge should double jump: %+v", s)
	}
	s = run(s, 5, 0, 0)
	s = Step(s, edge, 0, Flat{})
	if s.Vel.Y == constants.JumpForce || s.AirJumps != 1 {
		t.Fatalf("only MAX_AIR_JUMPS allowed: %+v", s)
	}
}

func TestGroundSnapWhenHugging(t *testing.T) {
	// Just above the ground, descending: snaps instead of falling.
	s := Step(withVel(NewState(Vec3{Y: 0.2}), Vec3{Y: -0.1}), 0, 0, Flat{})
	if s.Pos.Y != 0 || s.Vel.Y != 0 {
		t.Fatalf("expected snap, got %+v", s)
	}
	// Rising: no snap even when close.
	s = Step(withVel(NewState(Vec3{Y: 0.2}), Vec3{Y: 3}), 0, 0, Flat{})
	if s.Pos.Y == 0 {
		t.Fatalf("rising player must not snap: %+v", s)
	}
}

func TestAirStrafeCanGainSpeed(t *testing.T) {
	// Classic strafe jump: in the air, hold right while turning right; speed
	// grows past base speed (this is the bunny-hop feel kept from wizard-wars).
	s := run(NewState(Vec3{}), 120, fwd, 0)
	s = Step(s, jump|fwd, 0, Flat{})
	start := HorizontalSpeed(s)
	yaw := 0.0
	for i := 0; i < 30; i++ {
		yaw -= 0.03
		s = Step(s, right, yaw, Flat{})
	}
	if HorizontalSpeed(s) <= start+0.5 {
		t.Fatalf("air strafe should gain speed: %v", HorizontalSpeed(s))
	}
	if HorizontalSpeed(s) > MaxLegitHorizontalSpeed {
		t.Fatal("legit play must stay under the validation bound")
	}
}

func TestStepFrameUsesQuantizedYaw(t *testing.T) {
	f := proto.InputFrame{Seq: 1, Flags: fwd, Yaw: proto.YawToU16(1.0)}
	a := StepFrame(NewState(Vec3{}), f, Flat{})
	b := Step(NewState(Vec3{}), fwd, proto.U16ToYaw(f.Yaw), Flat{})
	if a != b {
		t.Fatal("StepFrame must steer by the dequantized yaw")
	}
}

// vectors.json is a cross-language trajectory table: WP02's TypeScript port
// can replay the same scripted frames and compare (tolerance 1e-9, see the
// bitwise note in movement.go).
type vecFrame struct {
	Flags uint16 `json:"flags"`
	Yaw   uint16 `json:"yaw"`
}
type vecCase struct {
	Name   string       `json:"name"`
	Ground float64      `json:"ground"`
	Start  State        `json:"start"`
	Frames []vecFrame   `json:"frames"`
	States []vectorStep `json:"states"`
}
type vectorStep struct {
	Pos      [3]float64 `json:"pos"`
	Vel      [3]float64 `json:"vel"`
	AirJumps int        `json:"airJumps"`
}

func scripted() []vecCase {
	rep := func(n int, f vecFrame) []vecFrame {
		out := make([]vecFrame, n)
		for i := range out {
			out[i] = f
		}
		return out
	}
	cat := func(parts ...[]vecFrame) []vecFrame {
		var out []vecFrame
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}
	y := func(r float64) uint16 { return proto.YawToU16(r) }
	turning := make([]vecFrame, 90)
	for i := range turning {
		turning[i] = vecFrame{Flags: fwd | sprint, Yaw: y(float64(i) * 0.05)}
	}
	return []vecCase{
		{Name: "walk_then_stop", Frames: cat(rep(60, vecFrame{fwd, y(0.3)}), rep(30, vecFrame{0, y(0.3)}))},
		{Name: "sprint_turning", Frames: turning},
		{Name: "jump_double_jump", Frames: cat(rep(10, vecFrame{fwd, 0}), []vecFrame{{fwd | jump, 0}}, rep(12, vecFrame{fwd, 0}), []vecFrame{{fwd | edge, 0}}, rep(60, vecFrame{fwd, 0}))},
		{Name: "strafe_jump", Frames: cat(rep(30, vecFrame{fwd | left, y(-1)}), []vecFrame{{jump | left, y(-1)}}, rep(40, vecFrame{left, y(-1.2)}))},
		{Name: "raised_ground_fall", Ground: 2, Start: State{Pos: Vec3{10, 5, -3}}, Frames: rep(60, vecFrame{back | right, y(2.5)})},
	}
}

func simulate(c vecCase) []vectorStep {
	s := c.Start
	if s.StaminaMax == 0 {
		// The vector file predates WP10's stamina (its states carry only
		// pos/vel/airJumps): start with a full wheel, as the zone does.
		full := NewState(s.Pos)
		full.Vel, full.AirJumps = s.Vel, s.AirJumps
		s = full
	}
	g := Flat{Y: c.Ground}
	out := make([]vectorStep, 0, len(c.Frames))
	for i, f := range c.Frames {
		s = StepFrame(s, proto.InputFrame{Seq: uint32(i + 1), Flags: f.Flags, Yaw: f.Yaw}, g)
		out = append(out, vectorStep{[3]float64{s.Pos.X, s.Pos.Y, s.Pos.Z}, [3]float64{s.Vel.X, s.Vel.Y, s.Vel.Z}, s.AirJumps})
	}
	return out
}

func TestTrajectoryVectors(t *testing.T) {
	path := filepath.Join("testdata", "vectors.json")
	cases := scripted()
	for i := range cases {
		cases[i].States = simulate(cases[i])
	}
	if *update {
		b, _ := json.MarshalIndent(map[string]any{"doc": "Movement trajectories: replay frames from start on flat ground at `ground`; compare every state (tolerance 1e-9). Generated by server/pkg/movement tests (-update).", "dt": Dt, "cases": cases}, "", " ")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -run TestTrajectoryVectors -update)", err)
	}
	var file struct {
		Cases []vecCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) != len(cases) {
		t.Fatalf("vector file has %d cases, want %d", len(file.Cases), len(cases))
	}
	for i, c := range file.Cases {
		got := simulate(c)
		for j := range got {
			w := c.States[j]
			for k := 0; k < 3; k++ {
				if math.Abs(got[j].Pos[k]-w.Pos[k]) > 1e-9 || math.Abs(got[j].Vel[k]-w.Vel[k]) > 1e-9 || got[j].AirJumps != w.AirJumps {
					t.Fatalf("%s step %d: got %+v want %+v", cases[i].Name, j, got[j], w)
				}
			}
		}
	}
}

func withVel(s State, v Vec3) State {
	s.Vel = v
	return s
}
