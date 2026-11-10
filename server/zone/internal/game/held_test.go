package game

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

// TestHeldStreamReachesNearObserversOnly (CR 022, shared spell visuals): a
// player holding a stream and sweeping their aim sends Event 226 aim
// updates to a player 10 m away (who also sees the Activity casting bit on
// them in snapshots), never to themselves and never to a player 110 m away;
// when they let go the bit drops for the observer.
func TestHeldStreamReachesNearObserversOnly(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Combat = &CombatSetup{Dev: true} })
	a := h.dial("?spawn=1000,1000")
	wa := a.join(h, "ca", "Caster")
	b := h.dial("?spawn=1010,1000")
	b.join(h, "cb", "Near")
	c := h.dial("?spawn=1110,1000")
	c.join(h, "cc", "Far")
	_ = h.srv.Do(context.Background(), func() {
		p := h.srv.byChar["ca"].ent.cbt
		p.Profile.Grant("cinder_spray")
		if !p.Profile.EquipSpell(p.Profile.Active, 0, "cinder_spray") {
			t.Error("equip cinder_spray")
		}
		p.Mana, p.ManaMax = 1000, 1000
	})
	spell := combatdefs.D.SpellByKey("cinder_spray").ID

	activity := func() (uint8, bool) {
		if b.frame == nil {
			return 0, false
		}
		for _, e := range b.frame.Ents {
			if e.ID == wa.EntityID {
				return e.Activity, true
			}
		}
		return 0, false
	}
	// Cast, then hold the key for ~2 s sweeping the aim (2 frames a packet, 30 packets/s).
	yaw := 0.0
	send := func(flags uint16) {
		var frames []proto.InputFrame
		for k := 0; k < 2; k++ {
			a.seq++
			f := flags
			if k == 1 {
				f &^= proto.InputFlagCast
			}
			frames = append(frames, proto.InputFrame{Seq: a.seq, Flags: f | proto.InputFlagChannel, Yaw: proto.YawToU16(yaw), CastSlot: 0})
			yaw += 0.01
		}
		a.send(&proto.Input{AckTick: a.dec.Latest(), Frames: frames})
	}
	send(proto.InputFlagCast)
	var near []*proto.Event
	sawBit := false
	for i := 0; i < 60; i++ {
		send(0)
		a.pump(10 * time.Millisecond)
		c.pump(1 * time.Millisecond)
		b.pump(22 * time.Millisecond)
		if act, ok := activity(); ok && act&proto.ActivityCasting != 0 {
			sawBit = true
		}
	}
	c.pump(300 * time.Millisecond)
	for _, e := range b.evs {
		if e.Kind == combat.EvHeld {
			near = append(near, e)
		}
	}
	if len(near) == 0 || !sawBit {
		t.Fatalf("near observer: %d aim updates, casting bit seen %v", len(near), sawBit)
	}
	for _, e := range near {
		if e.EntityID != wa.EntityID || int(e.TargetID) != spell || len(e.Data) != 6 {
			t.Fatalf("Event 226 %+v", e)
		}
	}
	// ~2 s of sweeping at 10 Hz max: never more than one per 3 ticks.
	if len(near) > 22 {
		t.Fatalf("%d aim updates in ~2 s (rate limit is 10 Hz)", len(near))
	}
	for _, e := range a.evs {
		if e.Kind == combat.EvHeld {
			t.Fatal("the caster got its own aim update")
		}
	}
	for _, e := range c.evs {
		if e.Kind == combat.EvHeld {
			t.Fatal("a player 110 m away got an aim update")
		}
	}
	// Let go: the observer sees the bit drop.
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.seq++
		a.send(&proto.Input{AckTick: a.dec.Latest(), Frames: []proto.InputFrame{{Seq: a.seq, Yaw: proto.YawToU16(yaw)}}})
		b.pump(40 * time.Millisecond)
		if act, ok := activity(); ok && act&proto.ActivityCasting == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the casting bit stayed after the release")
		}
	}
}
