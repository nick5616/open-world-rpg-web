package movement

import (
	"math"
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// island is the golden's CR 021 lake: an island of radius r (top height)
// in water (surface water, bottom bottom) everywhere else.
type island struct{ height, bottom, water, cx, cz, r float64 }

func (i island) on(x, z float64) bool {
	return (x-i.cx)*(x-i.cx)+(z-i.cz)*(z-i.cz) < i.r*i.r
}

func (i island) HeightAt(x, z float64) float64 {
	if i.on(x, z) {
		return i.height
	}
	return i.bottom
}

func (i island) WaterAt(x, z float64) float64 {
	if i.on(x, z) {
		return math.Inf(-1)
	}
	return i.water
}

func dashByKey(t *testing.T, k string) *combatdefs.Dash {
	for i := range combatdefs.D.Dashes {
		if combatdefs.D.Dashes[i].Key == k {
			return &combatdefs.D.Dashes[i]
		}
	}
	t.Fatalf("no dash %s", k)
	return nil
}

func frame(flags uint16, slot int, yaw, pitch float64) proto.InputFrame {
	return proto.InputFrame{Flags: flags, CastSlot: uint8(slot), Yaw: proto.YawToU16(yaw), Pitch: proto.PitchToI16(pitch)}
}

// TestJetFliesWhereYouLook (CR 021): magma dash held looking straight up
// climbs, levelled off it holds its height at full thrust, and the zone's
// validation bounds accept every step of it.
func TestJetFliesWhereYouLook(t *testing.T) {
	jet := dashByKey(t, "magma_dash")
	g := Flat{}
	s := NewState(Vec3{100, 0, 100})
	check := func(prev, next State) {
		t.Helper()
		if HorizontalSpeed(next) > MaxHorizontalSpeed(prev, next) {
			t.Fatalf("horizontal %v over the bound %v", HorizontalSpeed(next), MaxHorizontalSpeed(prev, next))
		}
		if next.Dash > 0 && next.Vel.Y > MaxDashLift+1e-9 {
			t.Fatalf("vertical %v over MaxDashLift %v", next.Vel.Y, MaxDashLift)
		}
	}
	n := StepFrame(s, frame(proto.InputFlagDodge, jet.ID, 0, math.Pi/2), g)
	check(s, n)
	s = n
	for i := 0; i < 60; i++ {
		n = StepFrame(s, frame(proto.InputFlagChannel, jet.ID, 0, math.Pi/2), g)
		check(s, n)
		s = n
	}
	if s.Pos.Y < 25 {
		t.Fatalf("held jet straight up reached only %.1f m", s.Pos.Y)
	}
	for i := 0; i < 150; i++ {
		n = StepFrame(s, frame(proto.InputFlagChannel, jet.ID, 1, 0), g)
		check(s, n)
		s = n
	}
	y0 := s.Pos.Y
	for i := 0; i < 60; i++ {
		s = StepFrame(s, frame(proto.InputFlagChannel, jet.ID, 1, 0), g)
	}
	if math.Abs(s.Pos.Y-y0) > 2 || HorizontalSpeed(s) < jet.Sustain.Speed*0.95 {
		t.Fatalf("level flight drifted %.2f m at %.1f m/s", s.Pos.Y-y0, HorizontalSpeed(s))
	}
}

// TestHoldNeedsARunningDashAndItsVariant: the sustain is the step's only for
// a dash in progress, the channel bit, castSlot = a sustainable variant and
// no attack/dodge/cast; anything else counts the dash down and the exit
// clamp ends it (the zone zeroes castSlot when it will not pay).
func TestHoldNeedsARunningDashAndItsVariant(t *testing.T) {
	d := dashByKey(t, "sunstep")
	g := Flat{}
	fresh := NewState(Vec3{100, 0, 100})
	if s := StepFrame(fresh, frame(proto.InputFlagChannel, d.ID, 0, 0), g); s.Dash != 0 || HorizontalSpeed(s) != 0 {
		t.Fatal("holding started a dash")
	}
	s := StepFrame(fresh, frame(proto.InputFlagDodge, d.ID, 0, 0), g)
	for _, f := range []proto.InputFrame{frame(proto.InputFlagChannel, 0, 0, 0), frame(proto.InputFlagChannel|proto.InputFlagCast, d.ID, 0, 0), frame(proto.InputFlagChannel|proto.InputFlagAttack, d.ID, 0, 0), frame(0, d.ID, 0, 0)} {
		if Holding(s, f.Flags, f.CastSlot) {
			t.Fatalf("frame %+v holds", f)
		}
		if n := StepFrame(s, f, g); n.Dash != d.Steps-1 {
			t.Fatalf("frame %+v: dash %d, want the countdown %d", f, n.Dash, d.Steps-1)
		}
	}
	for i := 0; i < 120; i++ {
		s = StepFrame(s, frame(proto.InputFlagChannel, d.ID, 0, 0), g)
	}
	if s.Dash != d.Sustain.CarrySteps || math.Abs(HorizontalSpeed(s)-d.Sustain.Speed) > 1e-9 {
		t.Fatalf("held: dash %d speed %v", s.Dash, HorizontalSpeed(s))
	}
	// Stripped (castSlot 0): the carry runs out and the plain exit clamp applies.
	for i := 0; i < d.Sustain.CarrySteps+1; i++ {
		s = StepFrame(s, frame(0, 0, 0, 0), g)
	}
	if s.Dash != 0 || HorizontalSpeed(s) > constants.DashExitSpeed+1e-9 {
		t.Fatalf("stripped hold: dash %d speed %v", s.Dash, HorizontalSpeed(s))
	}
}

// TestDashSpeedBounds: the validation bounds take jet and blink speeds only
// while a dash runs; the same speed without one is a violation, and every
// exit speed is inside the walk bound.
func TestDashSpeedBounds(t *testing.T) {
	jet := dashByKey(t, "magma_dash")
	fast := State{Vel: Vec3{X: jet.Sustain.Speed}}
	if HorizontalSpeed(fast) > MaxHorizontalSpeed(State{Dash: 3}, State{Vel: fast.Vel, Dash: 2}) {
		t.Fatal("a running jet's speed is refused")
	}
	if HorizontalSpeed(fast) <= MaxHorizontalSpeed(State{}, fast) {
		t.Fatal("jet speed without a dash passes the bound")
	}
	for _, d := range combatdefs.D.Dashes {
		if d.ExitSpeed > MaxLegitHorizontalSpeed {
			t.Fatalf("%s exit %v above the walk bound", d.Key, d.ExitSpeed)
		}
		if s := d.Sustain; s != nil && (s.Speed > MaxDashSpeed || s.BlinkSpeed > MaxDashSpeed) {
			t.Fatalf("%s sustain above MaxDashSpeed", d.Key)
		}
	}
}

// TestSkateOverWater: glacier step held over a lake stays on the surface
// in ground mode; let go, it swims.
func TestSkateOverWater(t *testing.T) {
	ice := dashByKey(t, "glacier_step")
	g := island{0, 0, 2, 0, 0, 0}
	s := NewState(Vec3{100, 2, 100})
	s = StepFrame(s, frame(proto.InputFlagDodge|proto.InputFlagForward, ice.ID, 0, 0), g)
	for i := 0; i < 60; i++ {
		s = StepFrame(s, frame(proto.InputFlagChannel|proto.InputFlagForward, ice.ID, 0, 0), g)
	}
	if s.Pos.Y != 2 || s.Mode != ModeGround {
		t.Fatalf("skate: y %v mode %d", s.Pos.Y, s.Mode)
	}
	for i := 0; i < 40; i++ {
		s = StepFrame(s, frame(proto.InputFlagForward, 0, 0, 0), g)
	}
	if s.Mode != ModeSwim {
		t.Fatalf("after the skate: mode %d, want swim", s.Mode)
	}
}
