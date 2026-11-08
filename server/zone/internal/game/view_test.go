package game

import (
	"math"
	"testing"
	"time"

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

// Frames lost for good are filled with the previous input, so a walker
// keeps exactly the path their client predicted.
func TestLostFramesRepeatTheLastInput(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("?spawn=500,500")
	cl.join(h, "c1", "Lossy")
	var fs []proto.InputFrame
	for s := uint32(1); s <= 10; s++ {
		if s == 5 || s == 6 {
			continue
		}
		fs = append(fs, proto.InputFrame{Seq: s, Flags: proto.InputFlagForward})
	}
	cl.send(&proto.Input{Frames: fs})
	cl.drainFor(300 * time.Millisecond)
	sim := movement.State{Pos: movement.Vec3{X: 500, Z: 500}}
	for i := 0; i < 10; i++ {
		sim = movement.Step(sim, proto.InputFlagForward, 0, movement.Flat{})
	}
	if cl.snap.AckInputSeq != 10 || cl.frame.Self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("ack %d z %d, want 10 steps (z %d)", cl.snap.AckInputSeq, cl.frame.Self.Z, proto.MetersToCm(sim.Pos.Z))
	}
	if n := h.srv.m.framesSynthesized.Load(); n != 2 {
		t.Fatalf("synthesized %d frames, want 2", n)
	}
}

// Datagrams reorder: a packet carrying frames 5-8 that overtakes the one with
// 1-4 must not make the zone skip 1-4 (the player would be snapped back).
func TestReorderedInputWaitsForTheGap(t *testing.T) {
	h := newHarness(t, nil)
	cl := h.dial("?spawn=500,500")
	cl.join(h, "c1", "Reorder")
	mk := func(from, to uint32) []proto.InputFrame {
		var fs []proto.InputFrame
		for s := from; s <= to; s++ {
			fs = append(fs, proto.InputFrame{Seq: s, Flags: proto.InputFlagForward})
		}
		return fs
	}
	cl.send(&proto.Input{Frames: mk(1, 1)})
	time.Sleep(50 * time.Millisecond)
	cl.send(&proto.Input{Frames: mk(5, 8)})
	time.Sleep(15 * time.Millisecond)
	cl.send(&proto.Input{Frames: mk(2, 4)})
	cl.drainFor(300 * time.Millisecond)
	sim := movement.State{Pos: movement.Vec3{X: 500, Z: 500}}
	for i := 0; i < 8; i++ {
		sim = movement.Step(sim, proto.InputFlagForward, 0, movement.Flat{})
	}
	if cl.snap.AckInputSeq != 8 || cl.frame.Self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("ack %d z %d, want 8 frames applied (z %d)", cl.snap.AckInputSeq, cl.frame.Self.Z, proto.MetersToCm(sim.Pos.Z))
	}
	if h.srv.m.framesSkipped.Load() != 0 {
		t.Fatalf("skipped %d frames", h.srv.m.framesSkipped.Load())
	}
}
