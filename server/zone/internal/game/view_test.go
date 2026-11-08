package game

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// A walker whose input stalls for 8 ticks (TCP retransmit) and then arrives
// in one burst: observers must see steady motion through the stall, and the
// view must equal the confirmed state once the burst lands.
func TestViewExtrapolatesThroughInputStall(t *testing.T) {
	g := movement.Flat{}
	e := &Entity{}
	e.Move.Pos = movement.Vec3{X: 1000, Z: 1000}
	e.view = e.Move
	seq := uint32(0)
	frame := func() proto.InputFrame {
		seq++
		return proto.InputFrame{Seq: seq, Flags: proto.InputFlagForward}
	}
	var viewZ []float64
	tick := func(frames int) {
		for i := 0; i < frames; i++ {
			e.applyFrame(frame(), g)
		}
		e.updateView(g)
		viewZ = append(viewZ, e.view.Pos.Z)
	}
	for i := 0; i < 30; i++ { // reach top speed
		tick(2)
	}
	for i := 0; i < 8; i++ { // stall
		tick(0)
	}
	tick(18) // the 16 late frames + this tick's 2
	if e.guess != 0 || e.view != e.Move {
		t.Fatalf("after the burst the view must be the confirmed state (guess %d)", e.guess)
	}
	for i := 0; i < 10; i++ {
		tick(2)
	}
	// Per-tick view motion stays at walking speed (4.89 m/s = 16.3 cm/tick)
	// through the stall and the catch-up: no stop, no lurch.
	for i := 31; i < len(viewZ); i++ {
		step := viewZ[i-1] - viewZ[i] // forward is -Z
		if math.Abs(step-0.163) > 0.01 {
			t.Fatalf("tick %d: view moved %.3f m (want ~0.163)", i, step)
		}
	}
}

func TestViewGuessIsBoundedAndDecays(t *testing.T) {
	g := movement.Flat{}
	e := &Entity{}
	e.Move.Pos = movement.Vec3{X: 1000, Z: 1000}
	e.applyFrame(proto.InputFrame{Seq: 1, Flags: proto.InputFlagForward}, g)
	e.updateView(g)
	for i := 0; i < 40; i++ { // client went silent (closed tab)
		e.updateView(g)
	}
	if e.guess != maxGuessSteps {
		t.Fatalf("guess %d, want capped at %d", e.guess, maxGuessSteps)
	}
	// Frames resume at the normal rate without a catch-up burst (a paused
	// client): the lead decays by one step per tick.
	for i := 0; i < maxGuessSteps; i++ {
		e.applyFrame(proto.InputFrame{Seq: uint32(2 + 2*i), Flags: 0}, g)
		e.applyFrame(proto.InputFrame{Seq: uint32(3 + 2*i), Flags: 0}, g)
		e.updateView(g)
	}
	if e.guess != 0 {
		t.Fatalf("guess %d after %d steady ticks, want 0", e.guess, maxGuessSteps)
	}
	// A player who never sent input is never extrapolated.
	idle := &Entity{}
	idle.updateView(g)
	idle.updateView(g)
	if idle.view != idle.Move {
		t.Fatal("no input yet: nothing to extrapolate")
	}
}
