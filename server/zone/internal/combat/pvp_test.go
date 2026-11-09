package combat

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Playtest 2 (CR 017): ClaimPlayer validates like Claim and scales damage;
// duel hits stop at 1 health; open-PvP hits can down.

func pvpPair(t *testing.T) (*World, *handPlayer, *handPlayer) {
	t.Helper()
	w, _ := newWorld()
	a := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	b := newHand(w, 2, movement.Vec3{X: 100, Z: 98.5}, "sword") // 1.5 m ahead of A (yaw 0 faces -Z)
	for i := 0; i < 3; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	return w, a, b
}

func TestClaimPlayerValidatesAndScales(t *testing.T) {
	w, a, b := pvpPair(t)
	sword := D.MoveOf(D.WeaponByKey("sword"), "light", 0)
	seq := a.frame(proto.InputFlagAttack, 0, 0)
	hp := b.p.HP
	res := w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{})
	if !res.Accepted || res.Dealt <= 0 {
		t.Fatalf("claim in reach: %+v", res)
	}
	want := math.Round(sword.Damage * D.DamageMult(1) * D.PvP.DamageMult)
	if res.Dealt != want && res.Dealt != math.Round(sword.Damage*D.DamageMult(1)*1.5*D.PvP.DamageMult) {
		t.Fatalf("dealt %v, want %v (x %v of PvE)", res.Dealt, want, D.PvP.DamageMult)
	}
	if b.p.HP != hp-res.Dealt {
		t.Fatalf("victim health %v -> %v, dealt %v", hp, b.p.HP, res.Dealt)
	}
	// The same claim again: one hit per swing.
	if r2 := w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{}); r2.Accepted || r2.Reason != RefuseHits {
		t.Fatalf("second claim on one swing: %+v", r2)
	}
	// Out of reach (B 8 m away for the whole history window).
	a.idle(60)
	b.p.Pos = movement.Vec3{X: 100, Y: b.p.Pos.Y, Z: 92}
	for i := 0; i < 30; i++ {
		w.Step(w.tick + 1)
		w.Drain()
	}
	seq = a.frame(proto.InputFlagAttack, 0, 0)
	if r3 := w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{}); r3.Accepted || r3.Reason != RefuseRange {
		t.Fatalf("claim out of reach: %+v", r3)
	}
	// A swing that never happened.
	if r4 := w.ClaimPlayer(a.p, claim(seq-5, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{}); r4.Accepted {
		t.Fatalf("claim without a logged attack: %+v", r4)
	}
}

func TestClaimPlayerDuelFloorAndOpenDown(t *testing.T) {
	w, a, b := pvpPair(t)
	sword := D.MoveOf(D.WeaponByKey("sword"), "light", 0)
	b.p.HP = 3
	seq := a.frame(proto.InputFlagAttack, 0, 0)
	res := w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{Duel: true})
	if !res.Accepted || !res.DuelFloor || b.p.HP != 1 || b.p.Downed {
		t.Fatalf("duel hit: %+v hp %v downed %v", res, b.p.HP, b.p.Downed)
	}
	b.p.RestoreAfterDuel(b.p.HPMax, 0)
	if b.p.HP != b.p.HPMax {
		t.Fatalf("restore: %v", b.p.HP)
	}
	b.p.HP = 3
	a.idle(60)
	seq = a.frame(proto.InputFlagAttack, 0, 0)
	res = w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{})
	if !res.Accepted || !res.Downed || !b.p.Downed || res.Flags&FlagKilled == 0 {
		t.Fatalf("open PvP killing hit: %+v downed %v", res, b.p.Downed)
	}
	// A downed player cannot be hit.
	a.idle(60)
	seq = a.frame(proto.InputFlagAttack, 0, 0)
	if r := w.ClaimPlayer(a.p, claim(seq, sword.ID, b.p.ID, w.tick, a.p.Pos), b.p, PvPHit{}); r.Accepted || r.Reason != RefuseDead {
		t.Fatalf("hit on a downed player: %+v", r)
	}
	events, _, _, _, _, _ := w.Drain()
	var hit, downed bool
	for _, o := range events {
		hit = hit || (o.Ev.Kind == EvPvPHit && o.Aud.To == b.p.ID && o.Ev.EntityID == a.p.ID)
		downed = downed || (o.Ev.Kind == EvPlayerDowned && o.Ev.TargetID == a.p.ID)
	}
	if !hit || !downed {
		t.Fatalf("events: pvp hit %v, downed by the player %v", hit, downed)
	}
}

// Heals and other zero-damage spells never hurt a player.
func TestClaimPlayerRefusesZeroDamageSpells(t *testing.T) {
	w, a, b := pvpPair(t)
	n := 0
	for _, s := range D.Spells {
		if s.Damage != 0 || s.Type == "passive" || s.Type == "mobility" {
			continue
		}
		a.p.Profile.Known = append(a.p.Profile.Known, s.Key)
		a.p.Profile.Loadouts[0].Spells[0] = s.Key
		a.p.readyAt = map[int]uint32{}
		a.p.Mana = a.p.ManaMax
		a.idle(4)
		seq := a.frame(proto.InputFlagCast, 0, 0)
		for k := 0; k < 30; k++ {
			w.Step(w.tick + 1)
			w.Drain()
		}
		hp := b.p.HP
		if r := w.ClaimPlayer(a.p, claim(seq, s.ID, b.p.ID, w.tick, b.p.Pos), b.p, PvPHit{}); r.Accepted || b.p.HP < hp {
			t.Fatalf("%s hurt a player: %+v", s.Key, r)
		}
		n++
	}
	t.Logf("%d zero-damage spells refused against a player", n)
}
