package combat

import (
	"encoding/binary"
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// CR 022 (shared spell visuals): what a player holds reaches other clients
// as the Activity casting bit and Event 226 (aim updates while an aimed
// action is held, at most every heldMinTicks and only on real change, a
// keepalive every heldKeepTicks), never to the caster, only within 64 m,
// and nothing at all for a player who holds nothing.

// heldRun steps the world n ticks with the hand player sending frames per
// tick (two 60 Hz frames a tick, like the zone; one-step flags on the first
// only) and returns the Event 226s.
func heldRun(h *handPlayer, ticks int, frame func(i int) (flags uint16, slot int, yaw, pitch float64)) []Out {
	var out []Out
	for i := 0; i < ticks; i++ {
		for k := 0; k < 2; k++ {
			fl, sl, y, p := frame(i)
			if k == 1 && fl&(castF|proto.InputFlagDodge|proto.InputFlagAttack) != 0 {
				fl &^= castF | proto.InputFlagDodge | proto.InputFlagAttack
				fl |= holdF // the key stays down
			}
			h.step(fl, sl, y, p)
		}
		h.p.Pos = h.state.Pos
		h.w.Step(h.w.tick + 1)
		evs, _, _, _, _, _ := h.w.Drain()
		for _, o := range evs {
			if o.Ev.Kind == EvHeld {
				out = append(out, o)
			}
		}
	}
	return out
}

func TestHeldNothingSendsNothing(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	evs := heldRun(h, 120, func(i int) (uint16, int, float64, float64) {
		return proto.InputFlagForward, 0, float64(i) * 0.05, 0 // walking and turning: not held
	})
	if len(evs) != 0 || h.p.HeldActivity(w.tick) != 0 || w.Stats.HeldEvents != 0 {
		t.Fatalf("idle player: %d events, activity %d", len(evs), h.p.HeldActivity(w.tick))
	}
}

func TestHeldStreamAimUpdatesRateLimitedAndAudience(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "cinder_spray", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("cinder_spray")
	// Cast, then hold for 4 s sweeping the aim 1 degree per tick (a real turn).
	evs := heldRun(h, 120, func(i int) (uint16, int, float64, float64) {
		if i == 0 {
			return castF, 0, eastYaw, 0
		}
		return holdF, 0, eastYaw + float64(i)*0.0175, 0.1
	})
	if h.p.HeldActivity(w.tick) != proto.ActivityCasting {
		t.Fatal("a running stream has no casting bit")
	}
	if len(evs) == 0 {
		t.Fatal("no aim updates while sweeping a stream")
	}
	// At most one per heldMinTicks: 120 ticks -> <= 40.
	if len(evs) > 120/heldMinTicks {
		t.Fatalf("%d updates in 120 ticks (cap %d)", len(evs), 120/heldMinTicks)
	}
	t.Logf("sweeping a stream 4 s: %d Event 226 per observer, %.2f kbps per observer (encoded frames)", len(evs), wireKbps(evs, 4))
	for _, o := range evs {
		e := o.Ev
		if o.Aud.To != 0 || o.Aud.Radius != heldRadius || o.Aud.Except != h.p.ID {
			t.Fatalf("audience %+v: want everyone within %d m but the caster", o.Aud, heldRadius)
		}
		if e.EntityID != h.p.ID || int(e.TargetID) != s.ID || len(e.Data) != 6 {
			t.Fatalf("event %+v", e)
		}
		if start := binary.LittleEndian.Uint32(e.Data); start != 1 {
			t.Fatalf("start seq %d, want the cast step 1 (the stream's seed)", start)
		}
	}
	// The newest update carries the aim of its frame exactly (u16 yaw, i16 pitch).
	last := evs[len(evs)-1].Ev
	if uint16(uint32(last.Value)) != h.p.aimYaw && int16(uint32(last.Value)>>16) != proto.PitchToI16(0.1) {
		t.Fatalf("aim %x vs frame yaw %x", last.Value, h.p.aimYaw)
	}
	shots := binary.LittleEndian.Uint16(last.Data[4:])
	if shots == 0 {
		t.Fatal("the update does not say how many shots were fired (late observers)")
	}
	// Letting go: no more updates, the bit drops.
	n := len(heldRun(h, 60, func(int) (uint16, int, float64, float64) { return 0, 0, eastYaw, 0 }))
	if n != 0 || h.p.HeldActivity(w.tick) != 0 {
		t.Fatalf("after release: %d updates, activity %d", n, h.p.HeldActivity(w.tick))
	}
}

func TestHeldStillAimSendsOnlyKeepalives(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "arc_sparks", movement.Vec3{X: 100, Z: 100})
	evs := heldRun(h, 150, func(i int) (uint16, int, float64, float64) {
		if i == 0 {
			return castF, 0, eastYaw, 0
		}
		return holdF, 0, eastYaw, 0
	})
	// 5 s held at a fixed aim: one keepalive a second (late observers), nothing else.
	if len(evs) < 4 || len(evs) > 5 {
		t.Fatalf("still aim, 150 ticks: %d events, want 4-5 keepalives", len(evs))
	}
	t.Logf("holding a stream still 5 s: %d Event 226 per observer, %.3f kbps per observer", len(evs), wireKbps(evs, 5))
}

// wireKbps is what a list of Events costs one observer over secs (encoded
// message bytes, before transport framing).
func wireKbps(evs []Out, secs float64) float64 {
	n := 0
	for _, o := range evs {
		e := o.Ev
		n += len(proto.Encode(&e))
	}
	return float64(n) * 8 / 1000 / secs
}

func TestHeldAimSettlesOnTheExactAim(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "cinder_spray", movement.Vec3{X: 100, Z: 100})
	heldRun(h, 10, func(i int) (uint16, int, float64, float64) {
		if i == 0 {
			return castF, 0, eastYaw, 0
		}
		return holdF, 0, eastYaw, 0
	})
	// a nudge smaller than an update step (10 of 64 units), then still: one update with the exact aim
	nudge := eastYaw + 10*2*math.Pi/65536
	evs := heldRun(h, 12, func(int) (uint16, int, float64, float64) { return holdF, 0, nudge, 0 })
	if len(evs) != 1 || uint16(uint32(evs[0].Ev.Value)) != proto.YawToU16(nudge) {
		t.Fatalf("settle: %d events (want 1 with the exact aim)", len(evs))
	}
}

func TestHeldDashSetsTheBitOnlyWhileThrusting(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "magma_dash")
	v := dashVariantOf("magma_dash")
	h.p.Mana, h.p.ManaMax = 1000, 1000
	bits := map[string]bool{}
	var evs []Out
	h.step(proto.InputFlagDodge, v, 0, 0.3) // the start step itself is not a hold
	bits["start"] = h.p.HeldActivity(w.tick) != 0
	evs = append(evs, heldRun(h, 70, func(int) (uint16, int, float64, float64) { return holdF, v, 0, 0.3 })...)
	bits["held"] = h.p.HeldActivity(w.tick) != 0
	if id := h.p.HeldVisual(w.tick); id != v|CastFXDash {
		t.Fatalf("held visual %x, want variant %d | CastFXDash", id, v)
	}
	heldRun(h, 1, func(int) (uint16, int, float64, float64) { return 0, v, 0, 0.3 }) // let go: the carry
	bits["carry"] = h.p.HeldActivity(w.tick) != 0
	if bits["start"] || !bits["held"] || bits["carry"] {
		t.Fatalf("casting bit %v: want only while held", bits)
	}
	// A dash's look is its velocity: keepalives only (70 ticks: two), whatever the aim did.
	if len(evs) != 2 {
		t.Fatalf("held dash: %d events, want 2 keepalives", len(evs))
	}
	for _, o := range evs {
		if int(o.Ev.TargetID) != v|CastFXDash || binary.LittleEndian.Uint16(o.Ev.Data[4:]) == 0 {
			t.Fatalf("dash keepalive %+v", o.Ev)
		}
	}
}

func TestHeldBeamForItsDurationAndGuard(t *testing.T) {
	w, _ := newWorld()
	h := caster(w, "cauterize", movement.Vec3{X: 100, Z: 100})
	s := D.SpellByKey("cauterize")
	heldRun(h, 1, func(int) (uint16, int, float64, float64) { return castF, 0, eastYaw, 0 })
	if h.p.HeldVisual(w.tick) != s.ID {
		t.Fatalf("a channelled beam is not held: %d", h.p.HeldVisual(w.tick))
	}
	evs := heldRun(h, int(ticksOf(s.WindupSteps+s.DurationSteps))+2, func(i int) (uint16, int, float64, float64) {
		return 0, 0, eastYaw + float64(i)*0.02, 0
	})
	if h.p.HeldVisual(w.tick) != 0 || len(evs) == 0 {
		t.Fatalf("beam: held %d after its duration, %d aim updates while it ran", h.p.HeldVisual(w.tick), len(evs))
	}
	// The bow draw: held while the secondary is down, gone when released.
	g := newHand(w, 2, movement.Vec3{X: 140, Z: 100}, "bow")
	heldRun(g, 10, func(int) (uint16, int, float64, float64) { return proto.InputFlagAltAttack, 0, 0, 0 })
	if g.p.HeldVisual(w.tick) != CastFXGuard {
		t.Fatal("bow draw not held")
	}
	heldRun(g, 1, func(int) (uint16, int, float64, float64) { return 0, 0, 0, 0 })
	if g.p.HeldVisual(w.tick) != 0 {
		t.Fatal("released draw still held")
	}
	// Staff and wand use the secondary as a heavy attack: not a guard.
	st := newHand(w, 3, movement.Vec3{X: 180, Z: 100}, "staff")
	heldRun(st, 5, func(int) (uint16, int, float64, float64) { return proto.InputFlagAltAttack, 0, 0, 0 })
	if st.p.HeldVisual(w.tick) != 0 {
		t.Fatal("a staff's secondary counted as a guard")
	}
}

func TestShieldBreakReachesObservers(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	h.p.shield, h.p.shieldEnd = 10, 1000
	w.mitigate(h.p, 4) // absorbed, still up: only the caster hears
	n := 0
	for _, o := range w.Events {
		if o.Ev.Kind == EvShield && o.Aud.To == 0 {
			n++
		}
	}
	if n != 0 {
		t.Fatal("observers told of a shield that held")
	}
	w.mitigate(h.p, 40) // broken
	var obs *Out
	for i := range w.Events {
		if o := &w.Events[i]; o.Ev.Kind == EvShield && o.Aud.To == 0 {
			obs = o
		}
	}
	if obs == nil || obs.Ev.EntityID != h.p.ID || obs.Ev.Value != 0 || obs.Aud.Except != h.p.ID || obs.Aud.Radius != 64 {
		t.Fatalf("break event to observers: %+v", obs)
	}
}
