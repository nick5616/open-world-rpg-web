package combat

// CR 039 ("Hotbar slots"): a spell slot every ten levels, the third loadout
// at level 20, checked by the zone; v1 skill trees migrate.

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

func TestHotbarSlotsOpenEveryTenLevels(t *testing.T) {
	for _, c := range []struct{ level, slots, loadouts int }{
		{1, 4, 2}, {9, 4, 2}, {10, 5, 2}, {19, 5, 2}, {20, 6, 3}, {29, 6, 3}, {30, 7, 3}, {40, 8, 3}, {55, 8, 3}, {255, 8, 3},
	} {
		if s, l := D.SpellSlots(c.level), D.LoadoutsOpen(c.level); s != c.slots || l != c.loadouts {
			t.Errorf("level %d: %d slots %d loadouts, want %d / %d", c.level, s, l, c.slots, c.loadouts)
		}
	}
	for i, want := range []int{1, 1, 1, 1, 10, 20, 30, 40} {
		if got := D.SlotLevel(i); got != want {
			t.Errorf("slot %d opens at %d, want %d", i+1, got, want)
		}
		if D.SpellSlots(D.SlotLevel(i)) <= i || (want > 1 && D.SpellSlots(want-1) > i) {
			t.Errorf("slot %d: SlotLevel and SpellSlots disagree", i+1)
		}
	}
	if D.Leveling.Hotbar.MaxSlots != constants.MaxSpellSlots || len(D.Start.Loadouts) != constants.MaxLoadouts || D.Start.Loadouts[2].Weapon != "bow" {
		t.Fatalf("hotbar table: %+v, %d start loadouts", D.Leveling.Hotbar, len(D.Start.Loadouts))
	}
}

func TestCastSlotWireMapping(t *testing.T) {
	seen := map[uint8]bool{}
	for i := 0; i < constants.MaxSpellSlots; i++ {
		c := CastSlotOf(i)
		if c == FormSlot || c == TechniqueSlot || seen[c] {
			t.Fatalf("slot %d -> castSlot %d collides", i, c)
		}
		seen[c] = true
		if SpellSlotOf(c) != i {
			t.Fatalf("slot %d -> %d -> %d", i, c, SpellSlotOf(c))
		}
	}
	for _, c := range []uint8{FormSlot, TechniqueSlot, 10, 255} {
		if SpellSlotOf(c) != -1 {
			t.Fatalf("castSlot %d names a spell slot", c)
		}
	}
	if CastSlotOf(4) != 6 || CastSlotOf(7) != 9 {
		t.Fatal("slots 5-8 travel as 6-9")
	}
}

func TestHotbarEquipAndSwapNeedTheLevel(t *testing.T) {
	p := NewProfile()
	if p.EquipSpellAt(0, 4, "ember_flick", 9) {
		t.Fatal("slot 5 at level 9")
	}
	if !p.EquipSpellAt(0, 4, "ember_flick", 10) || p.Loadouts[0].Spells[4] != "ember_flick" || p.Loadouts[0].Spells[0] != "" {
		t.Fatalf("slot 5 at level 10 (moved from slot 1): %+v", p.Loadouts[0].Spells)
	}
	if p.EquipSpellAt(0, 5, "frost_bite", 19) || !p.EquipSpellAt(0, 5, "frost_bite", 20) {
		t.Fatal("slot 6 opens at 20")
	}
	if p.EquipSpellAt(0, 7, "magma_dash", 39) || !p.EquipSpellAt(0, 7, "magma_dash", 40) || p.EquipSpell(0, 8, "magma_dash") {
		t.Fatal("slot 8 opens at 40; there is no slot 9")
	}
	if p.SwapAt(2, 19) || p.EquipSpellAt(2, 0, "frost_bite", 19) {
		t.Fatal("loadout 3 before 20")
	}
	if !p.SwapAt(2, 20) || p.Active != 2 || !p.EquipSpellAt(2, 0, "frost_bite", 20) || p.Loadouts[2].Weapon != "bow" {
		t.Fatalf("loadout 3 at 20: active %d %+v", p.Active, p.Loadouts[2])
	}
	if p.SwapAt(3, 99) || p.EquipWeapon(3, "sword") {
		t.Fatal("there is no fourth loadout")
	}
}

// A cast from slot 5 is refused below level 10 and legal from it.
func TestCastFromSlotFiveNeedsLevelTen(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 100, Z: 100}, "sword")
	h.p.Profile.Loadouts[0].Spells[4] = "ember_flick"
	h.p.SetLevel(9)
	h.p.Mana = h.p.ManaMax
	h.idle(2)
	h.frame(proto.InputFlagCast, CastSlotOf(4), 0)
	refused := false
	for _, o := range drainEvents(w) {
		if o.Ev.Kind == EvRefused && o.Ev.Value == RefuseIllegal {
			refused = true
		}
	}
	if !refused {
		t.Fatal("slot 5 cast at level 9 was not refused")
	}
	h.p.SetLevel(10)
	h.idle(40)
	w.Drain()
	mana := h.p.Mana
	h.frame(proto.InputFlagCast, CastSlotOf(4), 0)
	for _, o := range drainEvents(w) {
		if o.Ev.Kind == EvRefused {
			t.Fatalf("slot 5 at level 10 refused: %+v", o.Ev)
		}
	}
	if h.p.Mana >= mana {
		t.Fatalf("slot 5 at level 10 did not cast (mana %v -> %v)", mana, h.p.Mana)
	}
}

// A skill_tree saved before CR 039 (v1: two loadouts of four) loads into
// the first slots, the third loadout gets the training bow, and the
// character has never been told about hotbar unlocks (HotbarSeen 0).
func TestHotbarSkillTreeV1Migrates(t *testing.T) {
	v1 := []byte(`{"v":1,"loadouts":[{"weapon":"spear","spells":["frost_bite","","ember_flick",""],"gem":2,"arrowGem":-1},{"weapon":"staff","spells":["","magma_dash","",""],"gem":-1,"arrowGem":-1}],"active":1,"weaponSkills":{"spear":900}}`)
	p := LoadProfile(v1, []string{"ember_flick", "frost_bite", "magma_dash"})
	if p.Loadouts[0].Weapon != "spear" || p.Loadouts[0].Spells[0] != "frost_bite" || p.Loadouts[0].Spells[2] != "ember_flick" || p.Loadouts[0].Gem != 2 {
		t.Fatalf("loadout 1: %+v", p.Loadouts[0])
	}
	if p.Loadouts[1].Spells[1] != "magma_dash" || p.Active != 1 || p.SkillXP["spear"] != 900 {
		t.Fatalf("loadout 2 / active / skills: %+v %d", p.Loadouts[1], p.Active)
	}
	if p.Loadouts[2].Weapon != "bow" || p.Loadouts[2].Gem != -1 || p.Loadouts[2].Spells != [constants.MaxSpellSlots]string{} {
		t.Fatalf("loadout 3 default: %+v", p.Loadouts[2])
	}
	if p.HotbarSeen != 0 {
		t.Fatalf("v1 HotbarSeen %d", p.HotbarSeen)
	}
	// Written back as v2 with everything, and read again unchanged.
	p.EquipSpell(0, 6, "magma_dash")
	p.SeeHotbar(31)
	b := p.MarshalSkillTree()
	var raw struct {
		V        int `json:"v"`
		Loadouts []struct {
			Spells []string `json:"spells"`
		} `json:"loadouts"`
		HotbarSeen int `json:"hotbarSeen"`
	}
	if err := json.Unmarshal(b, &raw); err != nil || raw.V != 2 || len(raw.Loadouts) != 3 || len(raw.Loadouts[0].Spells) != 8 || raw.HotbarSeen != 31 {
		t.Fatalf("v2 row: %s", b)
	}
	q := LoadProfile(b, p.Known)
	if q.Loadouts != p.Loadouts || q.HotbarSeen != 31 || q.Active != 1 {
		t.Fatalf("v2 round trip:\n%+v\n%+v", q.Loadouts, p.Loadouts)
	}
	if NewProfile().HotbarSeen != 1 || q.SeeHotbar(31) || !q.SeeHotbar(40) {
		t.Fatal("SeeHotbar")
	}
}

// combat_sync v2: three loadouts of eight slots and the open counts.
func TestCombatSyncV2(t *testing.T) {
	prof := NewProfile()
	prof.Loadouts[0].Spells[7] = "frost_bite"
	prof.Loadouts[0].Spells[1] = ""
	p := NewPlayer(1, "p", prof, 23)
	b := EncodeSync(p)
	if b[0] != 2 || b[2] != 3 || b[3] != 8 {
		t.Fatalf("header % x", b[:4])
	}
	o := 4
	per := 1 + 8*2 + 1
	if id := binary.LittleEndian.Uint16(b[o+1+7*2:]); int(id) != D.SpellByKey("frost_bite").ID {
		t.Fatalf("loadout 1 slot 8 = %d", id)
	}
	if w := D.WeaponByID(int(b[o+2*per])); w == nil || w.Key != "bow" {
		t.Fatalf("loadout 3 weapon %d", b[o+2*per])
	}
	if n := len(b); b[n-3] != 23 || b[n-2] != 6 || b[n-1] != 3 {
		t.Fatalf("tail level/slots/loadouts % x", b[n-3:])
	}
}

func drainEvents(w *World) []Out {
	ev, _, _, _, _, _ := w.Drain()
	return ev
}
