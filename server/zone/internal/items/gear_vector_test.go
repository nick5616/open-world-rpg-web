package items

import (
	"math"
	"testing"
)

// TestGearClientVector pins Gear for the inventory UI's sample equipment
// (client/src/ui/inventory/dev.ts mockItems): the client's build overview
// (client/src/ui/skills/build.ts gearFor) must add it up to exactly these
// numbers, and client/src/ui/skills/skills.test.ts asserts the same ones.
func TestGearClientVector(t *testing.T) {
	v := &Inventory{}
	v.Items = []*Item{
		{Base: "weapon:sunsteel_blade", Slot: EqMain0, Qty: 1, Level: 11, Rarity: 2, Affixes: []Affix{{"brutal", "damagePct", 8.4}, {"keen", "critPct", 3.1}}, Sockets: []string{"gem:topaz:cut"}},
		{Base: "weapon:oak_staff", Slot: EqMain1, Qty: 1, Level: 3},
		{Base: "armor:iron_helm", Slot: EqHead, Qty: 1, Level: 6, Rarity: 1, Affixes: []Affix{{"sturdy", "health", 9}}},
		{Base: "armor:silver_cuirass", Slot: EqBody, Qty: 1, Level: 9, Rarity: 3, Affixes: []Affix{{"hale", "health", 17}, {"warding", "armorPct", 4.2}, {"lucky", "lootFindPct", 3.5}}},
		{Base: "armor:leather_leggings", Slot: EqLegs, Qty: 1, Level: 2},
	}
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
	g := v.Gear(0)
	if g.WeaponType != "sword" || g.Material != "sunsteel" || !near(g.WeaponMult, 1.2*1.02) || !near(g.DamagePct, 8.4) || !near(g.CritPct, 3.1) ||
		!near(g.Health, 77) || !near(g.ArmorPct, 17.2) || !near(g.LootFindPct, 3.5) || g.GemElement != 2 || g.FormMult != 1.25 || !g.KillsDemons || g.Stagger {
		t.Fatalf("loadout 1 gear %+v", g)
	}
	g1 := v.Gear(1)
	if g1.WeaponType != "staff" || !near(g1.WeaponMult, 1.04) || !near(g1.DamagePct, 0) || !near(g1.Health, 77) || g1.GemElement != -1 || g1.KillsDemons {
		t.Fatalf("loadout 2 gear %+v", g1)
	}
}
