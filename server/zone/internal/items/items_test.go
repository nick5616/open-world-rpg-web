package items

import (
	"math"
	"slices"
	"strings"
	"testing"
)

func TestOddsSumToOneAndBitchinIsFixed(t *testing.T) {
	for _, luck := range []float64{1, 1.5, 4, 24, 1e6} {
		p := Odds(luck)
		sum := 0.0
		for _, v := range p {
			if v < 0 {
				t.Fatalf("luck %v: negative odds %v", luck, p)
			}
			sum += v
		}
		if math.Abs(sum-1) > 1e-12 {
			t.Fatalf("luck %v: odds sum %v", luck, sum)
		}
		if p[7] != 0.000001 {
			t.Fatalf("luck %v: Bitchin' odds %v, want 1e-6 always", luck, p[7])
		}
		lucky := p[2] + p[3] + p[4] + p[5] + p[6]
		if lucky > D.LuckCap+1e-12 {
			t.Fatalf("luck %v: lucky tiers %v over the cap", luck, lucky)
		}
	}
	base := Odds(1)
	want := []float64{0.6, 0.25, 0.10, 0.04, 0.009, 0.0009, 0.00009, 0.000001}
	for i := 1; i < 8; i++ {
		if base[i] != want[i] {
			t.Fatalf("tier %d base odds %v, want spec 8's %v", i, base[i], want[i])
		}
	}
	if math.Abs(base[0]-(1-0.399991)) > 1e-12 {
		t.Fatalf("common %v", base[0])
	}
	// Luck shifts odds upward.
	if Odds(4)[3] <= base[3] || Odds(4)[0] >= base[0] {
		t.Fatal("luck must raise relic and lower common")
	}
}

// Spec 8 table: 2 M rolls land on the base odds (4.5 sigma bounds).
func TestRarityDistribution(t *testing.T) {
	const n = 2_000_000
	r := NewRNG(42)
	var got [8]int
	for i := 0; i < n; i++ {
		got[RollRarity(r, 1)]++
	}
	p := Odds(1)
	for i := 0; i < 5; i++ {
		exp := p[i] * n
		sd := math.Sqrt(n * p[i] * (1 - p[i]))
		if math.Abs(float64(got[i])-exp) > 4.5*sd {
			t.Fatalf("tier %s: %d rolls, expected %.0f +- %.0f", D.Rarities[i].Key, got[i], exp, 4.5*sd)
		}
	}
	t.Logf("2M rolls: %v (mythic expected %.0f, primordial %.0f, bitchin %.1f)", got, p[5]*n, p[6]*n, p[7]*n)
}

func findSeed(t *testing.T, tier int, luck float64) uint64 {
	t.Helper()
	for s := uint64(1); s < 60_000_000; s++ {
		if RollRarity(NewRNG(s), luck) == tier {
			return s
		}
	}
	t.Fatalf("no seed for tier %d", tier)
	return 0
}

func TestEveryTierRollsAsSpecified(t *testing.T) {
	for tier := 0; tier < 8; tier++ {
		seed := findSeed(t, tier, 1)
		// RollEquipment draws the base first, then the rarity: find a seed
		// whose rarity draw (second) is this tier.
		var it *Item
		for s := seed; ; s++ {
			it = RollEquipment(NewRNG(s), Rolled{Level: 10, Luck: 1, Element: 0, Theme: "infernal", Kind: "weapon"})
			if it.Rarity == tier {
				again := RollEquipment(NewRNG(s), Rolled{Level: 10, Luck: 1, Element: 0, Theme: "infernal", Kind: "weapon"})
				if again.Base != it.Base || len(again.Affixes) != len(it.Affixes) || again.Name != it.Name {
					t.Fatal("same seed, different item")
				}
				break
			}
			if s > seed+80_000_000 {
				t.Fatalf("tier %d not reached", tier)
			}
		}
		rd := D.Rarities[tier]
		if len(it.Affixes) != rd.Affixes || len(it.Uniques) != rd.Uniques || (it.Name != "") != rd.Named {
			t.Fatalf("%s: %d affixes %d uniques name %q", rd.Key, len(it.Affixes), len(it.Uniques), it.Name)
		}
		if len(rd.Bases) > 0 && !slices.Contains(rd.Bases, it.Def().Material) {
			t.Fatalf("%s on a %s base", rd.Key, it.Def().Material)
		}
		if len(it.Sockets) > 3 {
			t.Fatalf("%d sockets", len(it.Sockets))
		}
		if tier >= D.RarityByKey("relic") && len(it.Sockets) == 0 {
			t.Fatalf("%s rolled no socket", rd.Key)
		}
		if Announce(it) != (tier == 7) {
			t.Fatal("only Bitchin' is announced")
		}
		t.Logf("%-10s %-24s %q affixes %v uniques %v sockets %d", rd.Key, it.Base, it.Name, it.Affixes, it.Uniques, len(it.Sockets))
	}
}

func TestRandomLootNeverSunsteel(t *testing.T) {
	r := NewRNG(7)
	for i := 0; i < 20000; i++ {
		it := RollEquipment(r, Rolled{Level: 1 + i%20, Luck: 3, Element: -1})
		if it.Def().Material == "sunsteel" {
			t.Fatalf("random loot rolled %s: sunsteel is forge-only", it.Base)
		}
	}
}

func TestAffixesFollowElementAndTheme(t *testing.T) {
	r := NewRNG(3)
	fire, other := 0, 0
	for i := 0; i < 4000; i++ {
		for _, a := range rollAffixes(r, "weapon", 2, 5, 0, "infernal") {
			if a.Key == "of_embers" {
				fire++
			}
		}
		for _, a := range rollAffixes(r, "weapon", 2, 5, 1, "drowned") {
			if a.Key == "of_embers" {
				other++
			}
		}
	}
	if fire < 8*other {
		t.Fatalf("of_embers %d on fire/infernal rolls vs %d off-theme: tables must key on element and theme", fire, other)
	}
}

func inv() *Inventory {
	var h uint32
	return &Inventory{Alloc: func() uint32 { h++; return h }}
}

func TestStackingPouchesAndCapacity(t *testing.T) {
	v := inv()
	var d Delta
	if left := v.Add(Stack("ore:iron", 150), &d); left != 0 {
		t.Fatalf("left %d", left)
	}
	if v.Count("ore:iron") != 150 || len(v.Items) != 2 {
		t.Fatalf("iron %d in %d stacks", v.Count("ore:iron"), len(v.Items))
	}
	for _, it := range v.Items {
		if p, _ := SlotPouch(it.Slot); p != PouchOre {
			t.Fatalf("ore in %s", it.Slot)
		}
	}
	v.Add(Stack("currency:gold", 30), &d)
	v.Add(Stack("currency:gold", 12), &d)
	if v.Gold() != 42 || v.InSlot(PouchPurse) == nil {
		t.Fatal("purse")
	}
	v.Add(Stack("gem:ruby:rough", 2), &d)
	if p, _ := SlotPouch(v.Items[len(v.Items)-1].Slot); p != PouchGem {
		t.Fatal("gem pouch")
	}
	// 40 slots of swords.
	for i := 0; i < 40; i++ {
		if v.Add(Stack("weapon:iron_sword", 1), &d) != 0 {
			t.Fatalf("sword %d did not fit", i)
		}
	}
	if v.Add(Stack("weapon:iron_sword", 1), &d) != 1 || v.CanFit("food:bread", 1) {
		t.Fatal("41st item fit")
	}
	if !v.CanFit("ore:iron", 40) || !v.CanFit("currency:gold", 1e6) {
		t.Fatal("pouches are separate from the 40 slots")
	}
}

func TestDeltaCreateDeleteCancels(t *testing.T) {
	v := inv()
	var d Delta
	v.Add(Stack("food:bread", 2), &d)
	it := v.Items[0]
	if !v.Spend("food:bread", 2, &d) {
		t.Fatal("spend")
	}
	c, u, del := d.Rows()
	if len(c)+len(u)+len(del) != 0 {
		t.Fatalf("created+spent in one op must leave nothing: %d %d %v (%s)", len(c), len(u), del, it.ID)
	}
	var d2 Delta
	v.Add(Stack("food:bread", 3), &d2)
	var d3 Delta
	part := v.Take(v.Items[0], 1, &d3)
	if part.ID == v.Items[0].ID || part.Qty != 1 || v.Items[0].Qty != 2 {
		t.Fatal("partial take")
	}
	if _, u, _ := d3.Rows(); len(u) != 1 {
		t.Fatal("partial take updates the stack")
	}
}

func TestSmeltForgeSocketGear(t *testing.T) {
	v := inv()
	var d Delta
	v.Add(Stack("ore:sunsteel", 4), &d)
	v.Add(Stack("gem:topaz:cut", 1), &d)
	smelt := D.Recipe("smelt_sunsteel")
	for i := 0; i < 2; i++ {
		if _, err := v.Craft(smelt, 0, uint64(i+1), &d); err != nil {
			t.Fatal(err)
		}
	}
	if v.Count("ingot:sunsteel") != 2 || v.Count("ore:sunsteel") != 0 {
		t.Fatal("smelting")
	}
	forge := D.Recipe("forge_sunsteel_blade")
	if _, err := v.Craft(forge, 0, 9, &d); err != ErrBlueprint {
		t.Fatalf("forging without the blueprint: %v", err)
	}
	v.Add(Stack("blueprint:sunsteel_blade", 1), &d)
	blade, err := v.Craft(forge, 10, 9, &d)
	if err != nil {
		t.Fatal(err)
	}
	if blade.Base != "weapon:sunsteel_blade" || len(blade.Sockets) < 1 || v.Count("ingot:sunsteel") != 0 || v.Count("blueprint:sunsteel_blade") != 1 {
		t.Fatalf("blade %+v", blade)
	}
	if err := v.Equip(blade, EqMain0, &d); err != nil {
		t.Fatal(err)
	}
	gem := v.Items[slices.IndexFunc(v.Items, func(it *Item) bool { return it.Base == "gem:topaz:cut" })]
	if err := v.Socket(blade, gem, 0, &d); err != nil {
		t.Fatal(err)
	}
	g := v.Gear(0)
	if !g.KillsDemons || g.GemElement != 2 || g.FormMult != 1.25 || g.WeaponType != "sword" || g.WeaponMult < 1.2 {
		t.Fatalf("gear %+v", g)
	}
	// Unsocket away from a smith destroys the gem; at one it is kept.
	if _, err := v.Unsocket(blade, 0, false, &d); err != nil || v.Count("gem:topaz:cut") != 0 {
		t.Fatal("unsocket destroy")
	}
	v.Add(Stack("gem:topaz:cut", 1), &d)
	gem = v.Items[slices.IndexFunc(v.Items, func(it *Item) bool { return it.Base == "gem:topaz:cut" })]
	_ = v.Socket(blade, gem, 0, &d)
	if _, err := v.Unsocket(blade, 0, true, &d); err != nil || v.Count("gem:topaz:cut") != 1 {
		t.Fatal("unsocket keep")
	}
}

func TestCombineGems(t *testing.T) {
	v := inv()
	var d Delta
	v.Add(Stack("gem:ruby:rough", 7), &d)
	out, err := v.Combine("gem:ruby:rough", &d)
	if err != nil || out.Base != "gem:ruby:cut" || v.Count("gem:ruby:rough") != 4 {
		t.Fatalf("%v %v", out, err)
	}
	if _, err := v.Combine("gem:ruby:cut", &d); err != ErrMissing {
		t.Fatal("needs three")
	}
	v.Add(Stack("gem:ruby:brilliant", 3), &d)
	if _, err := v.Combine("gem:ruby:brilliant", &d); err == nil {
		t.Fatal("nothing above brilliant")
	}
}

func TestLootTables(t *testing.T) {
	r := NewRNG(11)
	boss := KillLoot(r, KillContext{Family: "boss", Level: 5, Boss: true, Element: 0, Luck: 1, Tomes: []string{"fireball"}})
	var eq, tomes, gold int
	for _, it := range boss {
		switch it.Def().Kind {
		case "weapon", "armor":
			eq++
		case "tome":
			tomes++
		case "currency":
			gold += it.Qty
		}
	}
	if eq != D.Loot.Boss.Items || tomes != 1 || gold < D.Loot.Coins.Boss[0] {
		t.Fatalf("boss loot: %d equipment, %d tomes, %d gold", eq, tomes, gold)
	}
	for k := 0; k < 4; k++ {
		for i := 0; i < 50; i++ {
			for _, it := range ContainerLoot(r, ContainerContext{Kind: k, Level: 3, Theme: "bandit", Element: -1}) {
				if it.Def() == nil || it.Qty <= 0 {
					t.Fatalf("bad container item %+v", it)
				}
			}
		}
	}
	for i := 0; i < 2000; i++ {
		for _, it := range KillLoot(r, KillContext{Family: []string{"beast", "bandit", "guardian", "elemental", "cave"}[i%5], Level: 1 + i%15, Element: i % 9, Luck: 1}) {
			if it.Def() == nil {
				t.Fatalf("unknown base %s", it.Base)
			}
		}
	}
}

func TestWireAndJSONRoundTrip(t *testing.T) {
	it := RollEquipment(NewRNG(findSeed(t, 5, 1)), Rolled{Level: 9, Luck: 1, Kind: "weapon"})
	it.Prov = []Prov{{Ev: "rolled", Char: "c"}}
	var back Item
	back.SetAffixesJSON(it.AffixesJSON())
	back.SetSocketsJSON(it.SocketsJSON())
	back.SetProvJSON(it.ProvJSON())
	if len(back.Affixes) != len(it.Affixes) || len(back.Uniques) != len(it.Uniques) || len(back.Sockets) != len(it.Sockets) || back.Prov[0].Ev != "rolled" {
		t.Fatal("round trip")
	}
	if !strings.Contains(string(it.AffixesJSON()), `"u":`) && len(it.Uniques) > 0 {
		t.Fatal("uniques in affixes json")
	}
}

func TestEveryRecipeAndStarterResolves(t *testing.T) {
	for _, rc := range D.Recipes {
		if D.Item(rc.Output) == nil {
			t.Fatal(rc.Key)
		}
		if rc.Blueprint != "" && D.Item(rc.Blueprint) == nil {
			t.Fatal(rc.Blueprint)
		}
	}
	if !D.KillsDemons("weapon:sunsteel_blade") || !D.KillsDemons("ammo:sunsteel_arrow") || D.KillsDemons("weapon:silver_sword") {
		t.Fatal("sunsteel rule data")
	}
}
