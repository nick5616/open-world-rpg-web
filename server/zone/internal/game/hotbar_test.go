package game

// CR 039 ("Hotbar slots") in process: a character past level 10 saved
// before the change hears about its new slots once after joining; the zone
// opens slots and the third loadout by level over Interact 50 and the
// inventory's equip.

import (
	"context"
	"encoding/binary"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
)

// syncSlots reads loadout l's spell ids and the open counts from a v2 combat_sync.
func syncSlots(t *testing.T, d []byte, l int) (ids []int, active, slots, loadouts int) {
	t.Helper()
	if len(d) < 4 || d[0] != 2 {
		t.Fatalf("combat_sync version %d", d[0])
	}
	nl, ns := int(d[2]), int(d[3])
	o := 4 + l*(2+2*ns)
	for k := 0; k < ns; k++ {
		ids = append(ids, int(binary.LittleEndian.Uint16(d[o+1+2*k:])))
	}
	_ = nl
	// the tail: ... u8 level | u8 slots | u8 loadouts | nl x u8 material (game layer)
	n := len(d) - nl
	return ids, int(d[1]), int(d[n-2]), int(d[n-1])
}

func TestHotbarSlotsOverTheWire(t *testing.T) {
	h, _ := diffHarness(t, nil)
	cl := h.dial("?spawn=3500,3500")
	cl.join(h, "hi", "Veteran") // level 15, no skill tree saved: never told
	s0 := cl.nextEvent(EventCharacterStats, 3*time.Second)
	if s0.Data[1] != StatsSync {
		t.Fatalf("first stats %+v", s0.ToJSON())
	}
	told := cl.nextEvent(EventCharacterStats, 2*time.Second)
	if told.Data[1] != StatsHotbar || told.Value != 15 || binary.LittleEndian.Uint16(told.Data[4:]) != 1 {
		t.Fatalf("hotbar news %+v", told.ToJSON())
	}
	ember := combatdefs.D.SpellByKey("ember_flick").ID
	frost := combatdefs.D.SpellByKey("frost_bite").ID
	cl.drainFor(200 * time.Millisecond)

	// Slot 5 is open at 15; slot 6 and loadout 3 are not.
	cl.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipSpell, Arg: uint32(0 | 4<<4 | ember<<8)})
	sy := cl.nextEvent(combat.EvCombatSync, 2*time.Second)
	ids, _, slots, louts := syncSlots(t, sy.Data, 0)
	if ids[4] != ember || slots != 5 || louts != 2 {
		t.Fatalf("slot 5 at 15: %v slots %d loadouts %d", ids, slots, louts)
	}
	cl.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipSpell, Arg: uint32(0 | 5<<4 | frost<<8)})
	if r := cl.nextEvent(combat.EvRefused, 2*time.Second); r.TargetID != combat.ActEquipSpell {
		t.Fatalf("slot 6 at 15: %+v", r.ToJSON())
	}
	cl.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSwapLoadout, Arg: 2})
	if r := cl.nextEvent(combat.EvRefused, 2*time.Second); r.TargetID != combat.ActSwapLoadout {
		t.Fatalf("loadout 3 at 15: %+v", r.ToJSON())
	}

	// Level 20: the fanfare (reason 1) carries the news, no second reason 3.
	_ = h.srv.Do(context.Background(), func() {
		h.srv.grantCombatXP(combat.XPGrant{Player: cl.welc.EntityID, XP: xpForLevel(20) - xpForLevel(15), Reason: "test"})
	})
	up := cl.nextEvent(EventCharacterStats, 2*time.Second)
	if up.Data[1] != StatsLevelUp || up.Value != 20 {
		t.Fatalf("level-up %+v", up.ToJSON())
	}
	cl.drainFor(200 * time.Millisecond)
	cl.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActSwapLoadout, Arg: 2})
	sy = cl.nextEvent(combat.EvCombatSync, 2*time.Second)
	ids, active, slots, louts := syncSlots(t, sy.Data, 2)
	if active != 2 || slots != 6 || louts != 3 || len(ids) != 8 {
		t.Fatalf("loadout 3 at 20: active %d slots %d loadouts %d", active, slots, louts)
	}
	cl.send(&proto.Interact{TargetKind: combat.InteractCombat, Action: combat.ActEquipSpell, Arg: uint32(2 | 5<<4 | frost<<8)})
	sy = cl.nextEvent(combat.EvCombatSync, 2*time.Second)
	if ids, _, _, _ := syncSlots(t, sy.Data, 2); ids[5] != frost {
		t.Fatalf("loadout 3 slot 6: %v", ids)
	}
	var seen int
	var weapon string
	_ = h.srv.Do(context.Background(), func() {
		pr := h.srv.entityByID(cl.welc.EntityID).cbt.Profile
		seen, weapon = pr.HotbarSeen, pr.Loadouts[2].Weapon
	})
	if seen != 20 || weapon != "bow" {
		t.Fatalf("seen %d, loadout 3 holds %q", seen, weapon)
	}
}
