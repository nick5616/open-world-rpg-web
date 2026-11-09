package items

import "math"

// Gear is what the equipped items add up to for one loadout: the numbers
// combat reads (internal/combat Player.Gear) plus WP15's sunsteel flags.
type Gear struct {
	Weapon      *Item   // the loadout's weapon item, nil = the training weapon (WP13 kit)
	WeaponType  string  // combat.yaml weapon key ("" = none)
	Material    string  // weapon material
	WeaponMult  float64 // material x item level: scales weapon moves and forms
	DamagePct   float64
	CritPct     float64
	SpellPower  float64 // spellPowerPct
	Health      float64
	ArmorPct    float64
	LootFindPct float64
	StaminaPct  float64 // data only in v1 (Moonstone; the shared movement step owns stamina)
	GemElement  int     // element of the first socketed elemental gem (WP13 forms), -1 none
	FormMult    float64 // that gem's cut
	KillsDemons bool    // WP15: sunsteel
	Stagger     bool    // WP15: silver
}

// armorCap keeps damage reduction from equipment below this percentage.
const armorCap = 60

// WeaponMult is a weapon item's damage multiplier: its material, +2 % per
// item level above the base's level.
func WeaponMult(it *Item) float64 {
	d := it.Def()
	if d == nil {
		return 1
	}
	m := 1.0
	if mat := D.Material(d.Material); mat != nil {
		m = mat.Mult
	}
	return m * (1 + 0.02*float64(max(0, it.Level-d.Level)))
}

func (g *Gear) add(stat string, v float64) {
	switch stat {
	case "damagePct":
		g.DamagePct += v
	case "critPct":
		g.CritPct += v
	case "spellPowerPct":
		g.SpellPower += v
	case "health":
		g.Health += v
	case "armorPct":
		g.ArmorPct += v
	case "lootFindPct":
		g.LootFindPct += v
	case "staminaPct":
		g.StaminaPct += v
	}
}

func (g *Gear) addItem(it *Item) {
	for _, a := range it.Affixes {
		g.add(a.Stat, a.Value)
	}
	for _, u := range it.Uniques {
		if ud := D.Unique(u); ud != nil {
			for k, v := range ud.Stats {
				g.add(k, v)
			}
		}
	}
}

// Gear computes a loadout's gear: its main-hand weapon and the armor.
func (inv *Inventory) Gear(loadout int) Gear {
	g := Gear{GemElement: -1, FormMult: 1, WeaponMult: 1}
	if w := inv.InSlot(MainSlot(loadout)); w != nil {
		d := w.Def()
		g.Weapon = w
		g.WeaponType = d.Weapon
		g.Material = d.Material
		g.WeaponMult = WeaponMult(w)
		if mat := D.Material(d.Material); mat != nil {
			g.KillsDemons, g.Stagger = mat.KillsDemons, mat.DemonStagger
		}
		g.addItem(w)
		for _, s := range w.Sockets {
			gd := D.Item(s)
			if gd == nil {
				continue
			}
			gem, cut := D.Gem(gd.Gem), D.Cut(gd.Cut)
			if gem == nil || cut == nil {
				continue
			}
			if gem.Element >= 0 && g.GemElement < 0 {
				g.GemElement, g.FormMult = gem.Element, cut.FormMult
			}
			if gem.Stat != "" {
				g.add(gem.Stat, cut.Utility)
			}
		}
	}
	for _, slot := range []string{EqHead, EqBody, EqLegs} {
		a := inv.InSlot(slot)
		if a == nil {
			continue
		}
		d := a.Def()
		m := 1.0
		if mat := D.Material(d.Material); mat != nil {
			m = mat.Mult
		}
		lv := 1 + 0.05*float64(max(0, a.Level-d.Level))
		g.Health += math.Round(d.Health * m * lv)
		g.ArmorPct += d.ArmorPct
		g.addItem(a)
	}
	g.ArmorPct = math.Min(armorCap, g.ArmorPct)
	return g
}

// LuckFrom is the rarity luck multiplier of loot find (spec 8: Opal gems
// shift odds upward): +1 % luck per point of lootFindPct.
func LuckFrom(g Gear) float64 { return 1 + g.LootFindPct/100 }
