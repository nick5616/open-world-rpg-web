package game

import (
	"context"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
)

// CR 033 (playtest 2 bow rework) over the real session path: bows have
// infinite ammo. Using a stack of arrows only picks the arrowheads (the
// stack is kept), and drawn shots that land never spend an arrow; a shot
// fires with no arrows in the bag at all.
func TestBowInfiniteAmmo(t *testing.T) {
	t.Setenv("LODESTONE_ZONE_DEBUG_CAMP", "1000,998,1,brute")
	h := newHarness(t, func(c *Config) { c.Combat = &CombatSetup{Dev: true} })
	a := h.dial("?spawn=1000,1000")
	const char = "bow-a"
	a.join(h, char, "Archer")
	inv0 := a.inventory(t)
	do := func(fn func()) {
		if err := h.srv.Do(context.Background(), fn); err != nil {
			t.Fatal(err)
		}
	}
	do(func() {
		p := h.srv.byChar[char].ent.cbt
		p.Profile.Loadouts[p.Profile.Active].Weapon = "bow"
	})
	var enemy uint32
	deadline := time.Now().Add(5 * time.Second)
	for enemy == 0 && time.Now().Before(deadline) {
		a.sendFrames(0, 0)
		a.drainFor(50 * time.Millisecond)
		if a.frame != nil {
			for _, e := range a.frame.Ents {
				if e.Kind == proto.EntityKindEnemy {
					enemy = e.ID
				}
			}
		}
	}
	if enemy == 0 {
		t.Fatal("no enemy in snapshots")
	}
	charged := combatdefs.D.MoveOf(combatdefs.D.WeaponByKey("bow"), "charged", 0)
	shoot := func(what string) {
		t.Helper()
		for i := 0; i < 15; i++ { // a half-second draw, two frames a packet like the client
			a.sendFrames(proto.InputFlagAltAttack, proto.InputFlagAltAttack)
			time.Sleep(34 * time.Millisecond) // 60 Hz: the zone keeps only a short input queue
		}
		a.sendFrames(proto.InputFlagAttack, 0)
		a.send(&proto.HitClaim{AttackSeq: a.seq - 1, AttackID: uint16(charged.ID), TargetID: enemy, Tick: a.dec.Latest(), X: 100000, Z: 99800})
		if r := a.hitResult(3 * time.Second); !r.Accepted || r.Damage == 0 {
			do(func() {
				p := h.srv.byChar[char].ent.cbt
				t.Logf("weapon %s lastSeq %d", p.Weapon().Key, p.LastSeq)
			})
			t.Fatalf("%s: drawn shot on the brute: %+v", what, r)
		}
	}

	// No arrows at all: the bow still shoots.
	count := func() (n int) {
		do(func() { n = h.srv.byChar[char].items.inv.Count("ammo:iron_arrow") })
		return n
	}
	if findItem(inv0, "ammo:iron_arrow") != nil || count() != 0 {
		t.Fatal("the starter kit has iron arrows")
	}
	shoot("no arrows in the bag")

	// Iron arrows: using the stack loads iron arrowheads and keeps the stack.
	addItems(t, h, char, "ammo:iron_arrow", 20)
	arrows := findItem(a.inventory(t), "ammo:iron_arrow")
	if arrows == nil || arrows.Qty != 20 {
		t.Fatalf("added arrows: %+v", arrows)
	}
	a.interact(InteractItem, uint64(arrows.H), ItemActUse, 0)
	var ore string
	deadline = time.Now().Add(3 * time.Second)
	for ore != "iron" && time.Now().Before(deadline) {
		a.drainFor(50 * time.Millisecond)
		do(func() {
			p := h.srv.byChar[char].ent.cbt
			ore = p.Profile.Loadouts[p.Profile.Active].ArrowOre
		})
	}
	if ore != "iron" {
		t.Fatalf("arrowheads %q after using iron arrows", ore)
	}
	do(func() { // the item commit put the starter sword (the equipped main-hand item) back in the loadout
		p := h.srv.byChar[char].ent.cbt
		p.Profile.Loadouts[p.Profile.Active].Weapon = "bow"
	})
	for i := 0; i < 3; i++ {
		shoot("iron arrowheads")
	}
	if n := count(); n != 20 {
		t.Fatalf("%d arrows after loading and three shots (want all 20 kept)", n)
	}
}
