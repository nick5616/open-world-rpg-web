package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// CR 033 (playtest 2 bow rework): the primary button draws (the alt_attack
// bit on the wire, counted per frame), letting go looses bow_charged with
// the draw it was held for; a tap still draws minChargeSteps; the zone
// refuses a bow shot with less draw, and the bow's old instant light shot.

// bowDraw holds the draw for n frames and lets go (the attack frame, no
// alt): the logged action of the release.
func bowDraw(h *handPlayer, n int) *Action {
	for i := 0; i < n; i++ {
		h.frame(proto.InputFlagAltAttack, 0, 0)
	}
	seq := h.frame(proto.InputFlagAttack, 0, 0)
	a := &h.p.actions[(h.p.nAct-1)%actionRing]
	if a.Seq != seq {
		return nil
	}
	return a
}

func TestBowHoldDrawReleaseFires(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "bow")
	h.idle(3)
	charged := D.MoveOf(D.WeaponByKey("bow"), "charged", 0)
	if charged.ChargeSteps != 60 || charged.MinChargeSteps != 9 {
		t.Fatalf("bow_charged draw %d steps, min %d: want 60 (1 s) and 9 (150 ms)", charged.ChargeSteps, charged.MinChargeSteps)
	}
	a := bowDraw(h, 30)
	if a == nil || a.Move != charged || !a.Legal || math.Abs(a.Charge-0.5) > 1e-9 {
		t.Fatalf("half draw: %+v", a)
	}
	// Full draw and beyond: capped at 1.
	h.idle(40)
	a = bowDraw(h, 90)
	if a == nil || !a.Legal || a.Charge != 1 {
		t.Fatalf("full draw: %+v", a)
	}
	// Recovery: a draw that starts at once still fires when held long enough
	// (the hold counts; the release waits for nothing on the zone).
	a = bowDraw(h, charged.StartupSteps+charged.ActiveSteps+charged.RecoverySteps+charged.MinChargeSteps)
	if a == nil || !a.Legal {
		t.Fatalf("draw right after a shot: %+v", a)
	}
}

func TestBowMinimumDrawAndNoInstantShot(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "bow")
	h.idle(3)
	charged := D.MoveOf(D.WeaponByKey("bow"), "charged", 0)
	// A press with no draw: the old instant quick shot is refused.
	h.frame(proto.InputFlagAttack, 0, 0)
	if a := h.p.actions[(h.p.nAct-1)%actionRing]; a.Legal || a.Refusal != RefuseIllegal || a.Move.Kind != "light" {
		t.Fatalf("undrawn bow shot: legal %v refusal %d %s", a.Legal, a.Refusal, a.Move.Key)
	}
	// Two steps of draw: refused (a modified client cannot spam weak shots faster than a tap).
	h.idle(30)
	if a := bowDraw(h, 2); a == nil || a.Legal || a.Refusal != RefuseIllegal {
		t.Fatalf("2-step draw: %+v", a)
	}
	// Exactly the minimum (the client's tap): a weak, legal shot.
	h.idle(30)
	a := bowDraw(h, charged.MinChargeSteps)
	want := float64(charged.MinChargeSteps) / float64(charged.ChargeSteps)
	if a == nil || !a.Legal || math.Abs(a.Charge-want) > 1e-9 {
		t.Fatalf("minimum draw: %+v (charge want %.3f)", a, want)
	}
	// An attack frame that still carries the draw bit is not a release.
	h.idle(30)
	for i := 0; i < 60; i++ {
		h.frame(proto.InputFlagAltAttack, 0, 0)
	}
	h.frame(proto.InputFlagAttack|proto.InputFlagAltAttack, 0, 0)
	if a := h.p.actions[(h.p.nAct-1)%actionRing]; a.Legal {
		t.Fatalf("attack while still drawing was legal: %s", a.Move.Key)
	}
	// The spear keeps its plain light attack (no minimum draw).
	s := newHand(w, 2, movement.Vec3{X: 140, Z: 100}, "spear")
	s.idle(3)
	s.frame(proto.InputFlagAttack, 0, 0)
	if a := s.p.actions[(s.p.nAct-1)%actionRing]; !a.Legal || a.Move.Kind != "light" {
		t.Fatalf("spear thrust: %+v", a)
	}
}

// Full draw: more damage, speed and reach than a tap; a tap's arrow is
// refused where only a full draw reaches.
func TestBowDrawScalesDamageSpeedAndReach(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "bow")
	h.idle(3)
	charged := D.MoveOf(D.WeaponByKey("bow"), "charged", 0)
	e := spawnOne(w, "brute", movement.Vec3{X: 300, Z: 300 - 70}) // 70 m straight ahead (yaw 0 faces -Z)
	minC := float64(charged.MinChargeSteps) / float64(charged.ChargeSteps)
	if ShotSpeed(charged, 1) != charged.ChargeSpeed || ShotSpeed(charged, 0) != charged.Speed || ShotRange(charged, 1) != charged.Reach {
		t.Fatalf("full draw: speed %v range %v", ShotSpeed(charged, 1), ShotRange(charged, 1))
	}
	if r := ShotRange(charged, minC); r > 60 || r < 50 {
		t.Fatalf("a tap reaches %.1f m, want 50..60", r)
	}
	weak := bowDraw(h, charged.MinChargeSteps)
	h.idle(30)
	full := bowDraw(h, charged.ChargeSteps)
	noCrit := func(d float64, _ int, fl uint8) float64 {
		if fl&FlagCrit != 0 {
			return d / 1.5
		}
		return d
	}
	dw := noCrit(w.damageOf(h.p, weak, e))
	df := noCrit(w.damageOf(h.p, full, e))
	if ratio := df / dw; math.Abs(ratio-charged.ChargeMult/(1+(charged.ChargeMult-1)*minC)) > 1e-6 || ratio < 1.9 {
		t.Fatalf("full/weak damage %.2f/%.2f", df, dw)
	}
	for i := 0; i < 10; i++ {
		w.Step(w.tick + 1)
	}
	if r := w.Claim(h.p, claim(weak.Seq, weak.ID, e.ID, w.tick, e.Pos)); r.Accepted || r.Reason != RefuseRange {
		t.Fatalf("a tap's arrow hit at 70 m: %+v", r)
	}
	if r := w.Claim(h.p, claim(full.Seq, full.ID, e.ID, w.tick, e.Pos)); !r.Accepted || r.Damage == 0 {
		t.Fatalf("a full draw's arrow at 70 m refused: %+v", r)
	}
}

// Observers see the draw: the guard is held while drawing, its Event 226
// carries the archer's aim as it turns (a parry or spear charge does not)
// and its progress is the steps drawn.
func TestBowDrawIsAimedForObservers(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "bow")
	newHand(w, 2, movement.Vec3{X: 110, Z: 100}, "sword") // an observer
	evs := heldRun(h, 40, func(i int) (uint16, int, float64, float64) {
		return proto.InputFlagAltAttack, 0, eastYaw + float64(i)*0.03, 0
	})
	if h.p.HeldVisual(w.tick) != CastFXGuard {
		t.Fatal("bow draw not held")
	}
	if len(evs) < 5 {
		t.Fatalf("a turning draw sent %d aim updates in 40 ticks", len(evs))
	}
	last := evs[len(evs)-1].Ev
	if last.TargetID != CastFXGuard || int(last.Value) != int(HeldAim(h.p.aimYaw, h.p.aimPitch)) {
		t.Fatalf("aim update %+v", last)
	}
	s := newHand(w, 3, movement.Vec3{X: 140, Z: 100}, "spear")
	evs = heldRun(s, 40, func(i int) (uint16, int, float64, float64) {
		return proto.InputFlagAltAttack, 0, eastYaw + float64(i)*0.03, 0
	})
	n := 0
	for _, o := range evs {
		if o.Ev.EntityID == 3 {
			n++
		}
	}
	if n > 2 {
		t.Fatalf("a turning spear charge sent %d Event 226s in 40 ticks (keepalives only)", n)
	}
}
