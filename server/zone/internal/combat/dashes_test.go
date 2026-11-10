package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// CR 021 (dash overhaul): the zone pays for held dash steps, strips holds it
// did not allow or cannot charge, and applies dash trails, heals and slams.

func dashVariantOf(key string) int { return D.DashByID(D.SpellByKey(key).Dash).ID }

// dashHand equips a mobility spell in slot 3 of the active loadout.
func dashHand(t *testing.T, w *World, id uint32, at movement.Vec3, spell string) *handPlayer {
	t.Helper()
	h := newHand(w, id, at, "staff")
	h.p.Profile.Grant(spell)
	if !h.p.Profile.EquipSpell(0, 3, spell) {
		t.Fatalf("equip %s", spell)
	}
	return h
}

// step runs one frame like the zone (Frame before the step, RecordFrame after) and returns what the step got.
func (h *handPlayer) step(flags uint16, slot int, yaw, pitch float64) FrameResult {
	h.seq++
	f := proto.InputFrame{Seq: h.seq, Flags: flags, CastSlot: uint8(slot), Yaw: proto.YawToU16(yaw), Pitch: proto.PitchToI16(pitch)}
	r := h.w.Frame(h.p, f, h.state)
	h.state = movement.StepFrame(h.state, r.Frame, h.g)
	h.p.RecordFrame(h.seq, h.state)
	return r
}

func TestHeldDashDrainsManaAndEndsWhenDry(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "magma_dash")
	v := dashVariantOf("magma_dash")
	sp := D.SpellByKey("magma_dash")
	su := D.DashByID(v).Sustain
	m0 := h.p.Mana
	h.step(proto.InputFlagDodge, v, 0, 0.4)
	if h.state.Dash == 0 || math.Abs(h.p.Mana-(m0-sp.Mana)) > 1e-9 {
		t.Fatalf("start: dash %d mana %v", h.state.Dash, h.p.Mana)
	}
	for i := 0; i < 60; i++ {
		r := h.step(proto.InputFlagChannel, v, 0, 0.4)
		if int(r.Frame.CastSlot) != v {
			t.Fatalf("held step %d stripped with mana %v", i, h.p.Mana)
		}
	}
	if want := m0 - sp.Mana - su.ManaPerS; math.Abs(h.p.Mana-want) > 1e-6 {
		t.Fatalf("a second of jet: mana %v, want %v", h.p.Mana, want)
	}
	if h.state.Pos.Y < 8 {
		t.Fatalf("held jet climbed only to %.1f", h.state.Pos.Y)
	}
	h.p.Mana = su.ManaPerS / 60 / 2 // not enough for one more step
	r := h.step(proto.InputFlagChannel, v, 0, 0.4)
	if r.Frame.CastSlot != 0 {
		t.Fatal("a hold the player cannot pay for kept its variant")
	}
	for i := 0; i < su.CarrySteps+2; i++ {
		h.step(proto.InputFlagChannel, v, 0, 0.4)
	}
	if h.state.Dash != 0 || movement.HorizontalSpeed(h.state) > 6+1e-9 {
		t.Fatalf("dry: dash %d speed %v (the step must end it)", h.state.Dash, movement.HorizontalSpeed(h.state))
	}
}

func TestHoldStrippedWithoutTheSpellOrForAnotherDash(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "sunstep")
	v := dashVariantOf("sunstep")
	if r := h.step(proto.InputFlagChannel, v, 0, 0); r.Frame.CastSlot != 0 {
		t.Fatal("a hold with no dash running kept its variant")
	}
	h.step(proto.InputFlagDodge, v, 0, 0)
	if r := h.step(proto.InputFlagChannel, dashVariantOf("magma_dash"), 0, 0); r.Frame.CastSlot != 0 {
		t.Fatal("holding another variant than the running dash was not stripped")
	}
	if r := h.step(proto.InputFlagChannel, v, 0, 0); int(r.Frame.CastSlot) != v {
		t.Fatal("a legit hold was stripped")
	}
	h.p.Profile.EquipSpell(0, 3, "")
	if r := h.step(proto.InputFlagChannel, v, 0, 0); r.Frame.CastSlot != 0 {
		t.Fatal("a hold after unequipping the spell kept its variant")
	}
	// A cast step's castSlot is a spell slot: left alone.
	if r := h.step(proto.InputFlagCast, 0, 0, 0); r.Frame.Flags&proto.InputFlagCast == 0 {
		t.Fatal("cast frame touched")
	}
}

func TestBloodDashCostsHealthNeverBelowOne(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "phase_slip")
	v := dashVariantOf("phase_slip")
	su := D.DashByID(v).Sustain
	hp0 := h.p.HP
	h.step(proto.InputFlagDodge, v, 0, 0)
	for i := 0; i < 60; i++ {
		h.step(proto.InputFlagChannel, v, 0, 0)
	}
	if math.Abs(h.p.HP-(hp0-su.HealthPerS)) > 1e-6 {
		t.Fatalf("a second of blood dash: hp %v, want %v", h.p.HP, hp0-su.HealthPerS)
	}
	h.p.HP = 1.1
	if r := h.step(proto.InputFlagChannel, v, 0, 0); r.Frame.CastSlot != 0 || h.p.HP < 1 {
		t.Fatalf("blood dash at 1 hp: slot %d hp %v", r.Frame.CastSlot, h.p.HP)
	}
}

func TestDashTrailHitsEnemiesOnceAndSlams(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "magma_dash")
	v := dashVariantOf("magma_dash")
	e := spawnOne(w, "boar", movement.Vec3{X: 100, Z: 92}) // 8 m ahead (yaw 0 faces -Z)
	hp0 := e.HP
	tick := uint32(1)
	h.step(proto.InputFlagDodge, v, 0, 0)
	for i := 0; i < 30; i++ {
		h.step(proto.InputFlagChannel, v, 0, 0)
		if i%2 == 1 {
			tick++
			w.Step(tick)
		}
	}
	if e.HP >= hp0 {
		t.Fatal("the jet flew through a boar without burning it")
	}
	once := e.HP
	for i := 0; i < 10; i++ {
		tick++
		w.Step(tick)
	}
	if e.HP < once-1e-9 && !e.has("burn", w.tick) {
		t.Fatal("trail hit twice")
	}
	// Climb, then dive into the ground next to a second boar: the slam.
	w.Drain()
	for i := 0; i < 50; i++ {
		h.step(proto.InputFlagChannel, v, 0, 1.0)
	}
	at := h.state.Pos
	e2 := spawnOne(w, "boar", movement.Vec3{X: at.X, Z: at.Z - 6})
	hp2 := e2.HP
	slammed := false
	for i := 0; i < 200 && !slammed; i++ {
		h.step(proto.InputFlagChannel, v, 0, -1.3)
		tick++
		w.Step(tick)
		for _, o := range w.Events {
			if o.Ev.Kind == EvDashSlam && o.Ev.EntityID == 1 {
				slammed = true
			}
		}
	}
	if !slammed {
		t.Fatalf("no slam diving in (y %.1f, mode %d)", h.state.Pos.Y, h.state.Mode)
	}
	if e2.HP >= hp2 {
		t.Fatal("the slam missed a boar 6 m from where it landed")
	}
}

func TestSunstepTrailHealsTheParty(t *testing.T) {
	w, _ := newWorld()
	h := dashHand(t, w, 1, movement.Vec3{X: 100, Z: 100}, "sunstep")
	mate := newHand(w, 2, movement.Vec3{X: 103, Z: 100}, "sword")
	h.p.PartyID, mate.p.PartyID = 7, 7
	mate.p.HP = 50
	v := dashVariantOf("sunstep")
	h.step(proto.InputFlagDodge, v, 0, 0)
	w.Step(1)
	if mate.p.HP <= 50 {
		t.Fatal("the radiant trail did not heal a party member nearby")
	}
}
