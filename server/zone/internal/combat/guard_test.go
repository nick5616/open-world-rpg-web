package combat

import (
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// CR 016: pressing the secondary button on a sword, spear or bow tells the
// players nearby (EvCast, targetId CastFXGuard) once per press, so their
// view of you raises the parry, the spear charge or the bow draw. Staff and
// wand use the press as a heavy attack (an EvCast of its own), so no guard.
func TestGuardCastFXOncePerPress(t *testing.T) {
	for _, c := range []struct {
		weapon string
		guards int
	}{{"sword", 2}, {"spear", 2}, {"bow", 2}, {"staff", 0}, {"wand", 0}} {
		w, _ := newWorld()
		h := newHand(w, 1, movement.Vec3{X: 50, Z: 50}, c.weapon)
		h.idle(3)
		w.Events = nil
		for i := 0; i < 10; i++ { // held: one press
			h.frame(proto.InputFlagAltAttack, 0, 0)
		}
		h.idle(2)
		h.frame(proto.InputFlagAltAttack, 0, 0) // a second press
		n := 0
		for _, e := range w.Events {
			if e.Ev.Kind != EvCast || e.Ev.TargetID != CastFXGuard {
				continue
			}
			n++
			if e.Ev.EntityID != 1 || e.Aud.Except != 1 || e.Aud.Radius != 64 {
				t.Fatalf("%s: guard event %+v to %+v, want from 1 to everyone within 64 m but 1", c.weapon, e.Ev, e.Aud)
			}
		}
		if n != c.guards {
			t.Fatalf("%s: %d guard events, want %d", c.weapon, n, c.guards)
		}
	}
}
