package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// CR 035: the hooks the main story's finale and revives use.

func TestGuardDecidesHitsOnTheHush(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 500, Z: 500}, "sword")
	g := w.AddArena(Arena{Center: movement.Vec3{X: 500, Z: 510}, Radius: 30, Kind: "test"}, "the_hush", 14, combatdefs.Physical)
	w.SpawnNow(g)
	if len(g.Members) != 1 || !g.Members[0].IsBoss() {
		t.Fatalf("the Hush did not spawn: %+v", g.Members)
	}
	hush := g.Members[0]
	if hush.Element != 6 || len(hush.Boss.Def.Phases) != 3 {
		t.Fatalf("the Hush: element %d phases %d", hush.Element, len(hush.Boss.Def.Phases))
	}
	var calls []bool
	shroud := 100.0
	hush.Guard = func(e *Enemy, src uint32, dmg float64, killing bool) float64 {
		calls = append(calls, killing)
		if shroud > 0 {
			if killing {
				shroud -= dmg
			}
			return 0
		}
		return dmg * 2
	}
	hp := hush.HP
	w.applyDamage(hush, h.p.ID, 60, combatdefs.Physical, hush.Pos, 0, true, false)
	w.applyDamage(hush, h.p.ID, 60, combatdefs.Physical, hush.Pos, 0, true, true)
	if hush.HP != hp || math.Abs(shroud-40) > 1e-9 {
		t.Fatalf("shrouded: hp %v -> %v, shroud %v", hp, hush.HP, shroud)
	}
	w.applyDamage(hush, h.p.ID, 60, combatdefs.Physical, hush.Pos, 0, true, true)
	w.applyDamage(hush, h.p.ID, 50, combatdefs.Physical, hush.Pos, 0, true, false)
	if math.Abs(hp-hush.HP-100) > 1e-9 {
		t.Fatalf("staggered x2: hp %v -> %v", hp, hush.HP)
	}
	if len(calls) != 4 || calls[0] || !calls[1] {
		t.Fatalf("guard calls %v", calls)
	}
}

func TestHoldStopsActingAndStoryStrikeHits(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 500, Z: 500}, "sword")
	e := spawnOne(w, "brute", movement.Vec3{X: 500, Z: 503})
	w.Hold(e, 2)
	if !e.disabled(w.tick) || e.disabled(w.tick+secondsToTicks(2)+1) {
		t.Fatal("hold")
	}
	hp := h.p.HP
	if !w.StoryStrike(e, "hush_chorus", h.p.Pos, 3) || w.StoryStrike(e, "nope", h.p.Pos, 3) {
		t.Fatal("story strike")
	}
	telegraphs := 0
	for _, o := range w.Events {
		if o.Ev.Kind == EvTelegraph && o.Ev.EntityID == e.ID {
			telegraphs++
		}
	}
	if telegraphs != 1 {
		t.Fatalf("telegraphs %d", telegraphs)
	}
	for i := 0; i < 60; i++ {
		h.frame(0, 0, 0)
		h.frame(0, 0, 0)
		w.Step(w.tick + 1)
		w.SettleStoryStrikes()
		w.Drain()
	}
	if h.p.HP >= hp {
		t.Fatalf("standing in the chorus: hp %v -> %v", hp, h.p.HP)
	}
	if len(w.story) != 0 {
		t.Fatal("story strikes left")
	}
}

func TestHoldDownedReviveAndRespawnNow(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 500, Z: 500}, "sword")
	e := spawnOne(w, "brute", movement.Vec3{X: 520, Z: 520})
	if w.HoldDowned(h.p.ID, 20) || w.Revive(h.p.ID, 0.5) {
		t.Fatal("not down yet")
	}
	w.HurtPlayerBy(h.p.ID, e, "hush_night", 10000)
	if !h.p.Downed {
		t.Fatal("not downed")
	}
	if !w.HoldDowned(h.p.ID, 20) || w.DownedLeft(h.p.ID) < 19 {
		t.Fatalf("held %v", w.DownedLeft(h.p.ID))
	}
	for i := 0; i < 30*5; i++ { // past the plain 3 s respawn: still down
		w.Step(w.tick + 1)
	}
	w.Drain()
	if !h.p.Downed {
		t.Fatal("respawned during the revive window")
	}
	if !w.Revive(h.p.ID, 0.5) || h.p.Downed || h.p.HP != math.Round(h.p.HPMax*0.5) || !h.p.Graced(w.tick) {
		t.Fatalf("revive: downed %v hp %v", h.p.Downed, h.p.HP)
	}
	// Down again; respawn now.
	h.p.graceTick = 0
	w.HurtPlayerBy(h.p.ID, e, "hush_night", 10000)
	w.HoldDowned(h.p.ID, 20)
	if !w.RespawnNow(h.p.ID) {
		t.Fatal("respawn now")
	}
	w.Step(w.tick + 1)
	if h.p.Downed || h.p.HP != h.p.HPMax {
		t.Fatalf("respawn: downed %v hp %v", h.p.Downed, h.p.HP)
	}
}
