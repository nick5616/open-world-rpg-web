package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

// castSlot sends one cast frame for a spell slot.
func (cl *client) castSlot(slot uint8) {
	cl.seq++
	cl.send(&proto.Input{AckTick: cl.dec.Latest(), Frames: []proto.InputFrame{{Seq: cl.seq, Flags: proto.InputFlagCast, CastSlot: slot}}})
}

// lightEvent is the newest Event 1840 value the client holds (-1 none).
func lightValue(cl *client) int32 {
	evs := cl.eventsOf(EventLightState)
	if len(evs) == 0 {
		return -1
	}
	return evs[len(evs)-1].Value
}

func TestTorchLightsReplicatesAndGoesOutInWater(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Combat = &CombatSetup{Dev: true} })
	a := h.dial(spawnAt(700, 700))
	wa := a.join(h, "lt-a", "Bearer")
	b := h.dial(spawnAt(704, 700))
	b.join(h, "lt-b", "Watcher")
	a.pump(300 * time.Millisecond)
	b.seenAppearance(t, wa.EntityID, 0, "before: nothing lit")

	// The starter kit carries a torch: light it.
	h.do(func() {
		if n := h.srv.byChar["lt-a"].items.inv.Count("tool:torch"); n != 1 {
			t.Fatalf("starter torches %d, want 1", n)
		}
	})
	a.interact(InteractLight, 0, LightActTorch, 0)
	a.pump(200 * time.Millisecond)
	if v := lightValue(a); v != 1 {
		t.Fatalf("1840 after lighting: %d, want 1 (torch bit)", v)
	}
	want := uint64(1) << lightTorchBit
	b.seenAppearance(t, wa.EntityID, want, "observer sees the torch")

	// A late joiner gets it on first sight.
	c := h.dial(spawnAt(698, 700))
	c.join(h, "lt-c", "Late")
	c.seenAppearance(t, wa.EntityID, want, "late joiner sees the torch")

	// Douse it.
	a.interact(InteractLight, 0, LightActTorch, 0)
	a.pump(200 * time.Millisecond)
	if v := lightValue(a); v != 0 {
		t.Fatalf("1840 after dousing: %d", v)
	}
	b.seenAppearance(t, wa.EntityID, 0, "observer sees it out")

	// Light it, then put it in water: the once-a-second pass puts it out.
	a.interact(InteractLight, 0, LightActTorch, 0)
	a.pump(200 * time.Millisecond)
	h.do(func() {
		sess := h.srv.byChar["lt-a"]
		sess.ent.Move.Mode = 4 // swim
	})
	a.pump(1500 * time.Millisecond)
	if v := lightValue(a); v != 0 {
		t.Fatalf("a torch in the water: 1840 value %d, want out", v)
	}
	// And it cannot be lit while swimming.
	h.do(func() { h.srv.byChar["lt-a"].ent.Move.Mode = 4 })
	a.interact(InteractLight, 0, LightActTorch, 0)
	a.pump(200 * time.Millisecond)
	refs := a.eventsOf(EventLightRefused)
	if len(refs) == 0 || refs[len(refs)-1].Value != LightRefuseWater {
		t.Fatalf("lighting a torch while swimming: %+v", refs)
	}
}

func TestFamiliarLightToggleUpkeepAndReplication(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Combat = &CombatSetup{Dev: true} })
	a := h.dial(spawnAt(710, 710))
	wa := a.join(h, "fl-a", "Caster")
	b := h.dial(spawnAt(714, 710))
	b.join(h, "fl-b", "Watcher")
	a.pump(300 * time.Millisecond)

	var ice *combatdefs.Spell
	for i := range combatdefs.D.Spells {
		if s := &combatdefs.D.Spells[i]; s.Familiar != nil && s.Tree == "ice" {
			ice = s
		}
	}
	if ice == nil {
		t.Fatal("no ice familiar spell")
	}
	// Learn it (dev) and put it in slot 4.
	a.interact(combat.InteractCombat, 0, 7, uint32(ice.ID))
	a.interact(combat.InteractCombat, 0, 3, uint32(0|3<<4|ice.ID<<8))
	a.pump(300 * time.Millisecond)
	var mana0 float64
	h.do(func() { mana0 = h.srv.byChar["fl-a"].ent.cbt.Mana })

	a.castSlot(3)
	a.pump(300 * time.Millisecond)
	want := uint64(ice.Familiar.ID) << lightFamShift
	if v := lightValue(a); v != int32(ice.Familiar.ID)<<1 {
		t.Fatalf("1840 after the cast: %d, want %d", v, ice.Familiar.ID<<1)
	}
	b.seenAppearance(t, wa.EntityID, want, "observer sees the familiar")
	var mana1 float64
	h.do(func() { mana1 = h.srv.byChar["fl-a"].ent.cbt.Mana })
	if mana1 > mana0-ice.Mana+5 {
		t.Fatalf("mana %.1f -> %.1f: the cast cost %.1f", mana0, mana1, ice.Mana)
	}

	// A second of upkeep is taken (regen is 11/s, so only the dip proves it: check the zone's upkeep field instead).
	h.do(func() {
		l := h.srv.byChar["fl-a"].light
		if l == nil || l.fam != ice.Familiar.ID || l.famUp != ice.Familiar.UpkeepPerS {
			t.Fatalf("light state %+v", l)
		}
	})

	// Cast again (past the cooldown): dismissed, and free even with no mana.
	a.walk(ice.CooldownSteps+4, 0, 0, nil) // the cooldown counts input frames
	h.do(func() { c := h.srv.byChar["fl-a"].ent.cbt; c.Mana, c.ManaRegenMult = 0, 0.0001 })
	a.castSlot(3)
	a.pump(300 * time.Millisecond)
	if v := lightValue(a); v != 0 {
		t.Fatalf("1840 after dismissing with no mana: %d", v)
	}
	b.seenAppearance(t, wa.EntityID, 0, "observer sees it gone")

	// Called with mana, then the mana runs dry: it fades.
	h.do(func() { h.srv.byChar["fl-a"].ent.cbt.Mana = ice.Mana + 10 })
	a.walk(ice.CooldownSteps+4, 0, 0, nil) // the cooldown counts input frames
	a.castSlot(3)
	for i := 0; i < 20 && lightValue(a) == 0; i++ { // a loaded machine may be slow to deliver it
		a.pump(100 * time.Millisecond)
	}
	if v := lightValue(a); v == 0 {
		t.Fatal("the familiar was not called")
	}
	h.do(func() { c := h.srv.byChar["fl-a"].ent.cbt; c.Mana, c.ManaRegenMult = 0, 0.0001 })
	a.pump(1400 * time.Millisecond)
	evs := a.eventsOf(EventLightState)
	last := evs[len(evs)-1]
	if last.Value != 0 || len(last.Data) == 0 || last.Data[0] != LightWhyMana {
		t.Fatalf("out of mana: %+v", last)
	}
}
