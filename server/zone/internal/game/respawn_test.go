package game

// Playtest 2 (new player onboarding, CR 024): dying to enemies. The downed
// event names the enemy, the respawn comes after PLAYER_RESPAWN_S at the
// respawn point with full health and everything kept, and for
// PLAYER_RESPAWN_GRACE_S enemies leave the player alone (no target, no
// damage) unless the player lands a hit first. Exact ticks (pvpRig).

import (
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

func TestDeathRespawnAndGrace(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Fallen", 1000, 1000)
	r.ticks(5)
	w := r.srv.cbt.w
	g := w.TestGroup(movement.Vec3{X: 1000, Z: 997}, []string{"brute", "brute"}, 12, "")
	charges := a.ent().cbt.Charges
	for i := 0; i < 30*90 && !a.ent().cbt.Downed; i++ {
		r.tick()
	}
	if !a.ent().cbt.Downed {
		t.Fatalf("two level-12 brutes did not down a new character (hp %v)", a.hp())
	}
	ev, _ := a.last(combat.EvPlayerDowned)
	killer := false
	for _, m := range g.Members {
		killer = killer || ev != nil && ev.TargetID == m.ID
	}
	if ev == nil || ev.EntityID != a.ent().ID || !killer || ev.Value != int32(constants.PlayerRespawnS*1000) {
		t.Fatalf("downed event should name the brute and the wait: %+v", ev)
	}
	downAt := a.ent().Move.Pos
	r.seconds(constants.PlayerRespawnS + 0.3)
	p := a.ent().cbt
	if p.Downed || p.HP != p.HPMax || p.Mana != p.ManaMax {
		t.Fatalf("respawn: downed %v hp %v/%v mana %v/%v", p.Downed, p.HP, p.HPMax, p.Mana, p.ManaMax)
	}
	if rv, _ := a.last(combat.EvRespawned); rv == nil {
		t.Fatal("no respawned event")
	}
	at := a.ent().Move.Pos
	want := r.srv.RespawnPoint(a.ent())
	if dx, dz := at.X-want.X, at.Z-want.Z; dx*dx+dz*dz > 4 {
		t.Fatalf("respawned at %+v, the respawn point is %+v (downed at %+v)", at, want, downAt)
	}
	if p.Charges < charges {
		t.Fatalf("draught charges lost: %d -> %d", charges, p.Charges)
	}
	if !p.Graced(w.Tick()) {
		t.Fatal("no grace after the respawn")
	}

	// The same brutes right at the respawn point: they leave the player
	// alone for the grace, then fight.
	g2 := w.TestGroup(movement.Vec3{X: at.X, Z: at.Z - 2.5}, []string{"brute", "brute"}, 12, "")
	hp := a.hp()
	r.seconds(constants.PlayerRespawnGraceS - 0.6)
	if a.hp() != hp {
		t.Fatalf("hurt during the grace: %v -> %v", hp, a.hp())
	}
	if len(g2.Members) == 0 {
		t.Fatal("the second group never spawned")
	}
	for _, m := range g2.Members {
		if m.Target == a.ent().ID {
			t.Fatal("an enemy targets a player in grace")
		}
	}
	// a stand-in strike (the PvE path) is ignored too
	w.TestHurtPlayer(p, 10)
	if a.hp() != hp {
		t.Fatal("TestHurtPlayer landed during the grace")
	}
	_, hurt0 := a.last(combat.EvPlayerHurt)
	r.seconds(8)
	if _, hurt := a.last(combat.EvPlayerHurt); hurt == hurt0 {
		t.Fatalf("the grace never ended (hp %v)", a.hp())
	}
}

// Landing a hit ends the grace at once.
func TestGraceEndsOnAHit(t *testing.T) {
	r := newPvPRig(t)
	a := r.add("Eager", 1000, 1000)
	r.ticks(5)
	w := r.srv.cbt.w
	g := w.TestGroup(movement.Vec3{X: 1000, Z: 998.4}, []string{"slime"}, 1, "")
	r.seconds(1.5)
	if len(g.Members) == 0 {
		t.Fatal("no slime")
	}
	p := a.ent().cbt
	p.Downed, p.HP = true, 0
	r.seconds(constants.PlayerRespawnS + 0.3)
	if p.Downed || !p.Graced(w.Tick()) {
		t.Fatalf("respawn: downed %v graced %v", p.Downed, p.Graced(w.Tick()))
	}
	// Back next to the slime (the rig has no terrain: the respawn point is elsewhere).
	r.srv.Teleport(a.ent(), movement.Vec3{X: 1000, Z: 1000})
	g.Members[0].Pos = movement.Vec3{X: 1000, Z: 998.4}
	r.ticks(3)
	a.flags = proto.InputFlagAttack
	r.ticks(2)
	a.push(&proto.HitClaim{AttackSeq: a.lastAt, AttackID: uint16(swordLight()), TargetID: g.Members[0].ID, Tick: r.srv.tick, X: proto.MetersToCm(1000), Z: proto.MetersToCm(998.4)})
	r.ticks(3)
	if len(a.hits) == 0 || !a.hits[len(a.hits)-1].Accepted {
		t.Fatalf("hit on the slime: %+v", a.hits)
	}
	if p.Graced(w.Tick()) {
		t.Fatal("landing a hit should end the grace")
	}
}

func swordLight() int { return combatdefs.D.MoveOf(combatdefs.D.WeaponByKey("sword"), "light", 0).ID }
