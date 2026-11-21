package game

import (
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/itemdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/zone/internal/combat"
)

func TestWeaponLookPacking(t *testing.T) {
	// The layout contracts/events.md documents (client weapons/look.ts tests the same numbers).
	if got := WeaponLook(1, LookMaterialCode("sunsteel"), 5); got != 1|6<<4|6<<8 {
		t.Fatalf("sword/sunsteel/light = %#x", got)
	}
	if got := WeaponLook(3, 0, -1); got != 3 {
		t.Fatalf("plain bow = %#x", got)
	}
	for _, w := range combatdefs.D.Weapons {
		for m := 0; m <= len(itemdefs.D.Materials); m++ {
			for g := -1; g < 8; g++ {
				id, mat, gem := UnpackWeaponLook(WeaponLook(w.ID, uint8(m), g))
				if id != w.ID || int(mat) != m || gem != g {
					t.Fatalf("round trip %d/%d/%d -> %d/%d/%d", w.ID, m, g, id, mat, gem)
				}
			}
		}
	}
	if LookMaterialCode("") != 0 || LookMaterialCode("nope") != 0 {
		t.Fatal("ordinary and unknown materials are code 0")
	}
	// combat.yaml's weapon materials are items.yaml materials too.
	for _, m := range combatdefs.D.Materials {
		if LookMaterialCode(m.Key) == 0 {
			t.Fatalf("combat material %q has no look code", m.Key)
		}
	}
	if len(itemdefs.D.Materials) > 15 {
		t.Fatal("material codes are 4 bits")
	}
}

// TestRemoteObserverSeesTheWeaponChange: another player's loadout weapon,
// material and gem reach an observer through the player entity's snapshot
// typeId, and the owner's combat_sync ends with the per-loadout material codes.
func TestRemoteObserverSeesTheWeaponChange(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Combat = &CombatSetup{Dev: true, Config: combat.Config{Seed: 42, NoWildPacks: true}}
	})
	a := h.dial("?spawn=100,100")
	a.join(h, "wl-a", "Watcher")
	b := h.dial("?spawn=104,100")
	wb := b.join(h, "wl-b", "Wielder")

	see := func(want uint16) *snapshot.EntState {
		t.Helper()
		var got *snapshot.EntState
		for i := 0; i < 60; i++ {
			a.walk(2, 0, 0, nil)
			b.drainFor(5 * time.Millisecond)
			if a.frame != nil {
				if got = a.frame.Find(wb.EntityID); got != nil && got.TypeID == want {
					return got
				}
			}
		}
		t.Fatalf("observer never saw typeId %#x (last %+v)", want, got)
		return nil
	}
	start := combatdefs.D.WeaponByKey(combatdefs.D.Start.Loadouts[0].Weapon)
	see(WeaponLook(start.ID, 0, -1))

	bow := combatdefs.D.WeaponByKey("bow")
	b.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipWeapon, Arg: 0 | uint32(bow.ID)<<8})
	b.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSetGem, Arg: 0 | (1+1)<<8})
	b.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSetMaterial, Arg: 0 | uint32(combatdefs.D.MaterialByKey("sunsteel").ID)<<8})
	got := see(WeaponLook(bow.ID, LookMaterialCode("sunsteel"), 1))
	if got.Kind != proto.EntityKindPlayer {
		t.Fatalf("kind %v", got.Kind)
	}

	// The owner's combat_sync carries the material codes (CR 039: 3 trailing bytes);
	// a no-op swap to the active loadout asks for a fresh one.
	b.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSwapLoadout, Arg: 0})
	last := b.event(combat.EvCombatSync, 3*time.Second)
	if n := len(last.Data); last.Data[n-3] != LookMaterialCode("sunsteel") || last.Data[n-2] != 0 || last.Data[n-1] != 0 {
		t.Fatalf("combat_sync material codes % x", last.Data[n-3:])
	}

	// Swapping to loadout 1 shows its weapon instead.
	b.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSwapLoadout, Arg: 1})
	other := combatdefs.D.WeaponByKey(combatdefs.D.Start.Loadouts[1].Weapon)
	see(WeaponLook(other.ID, 0, -1))
}
