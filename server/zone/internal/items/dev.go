package items

// Playtest 2 dev console (docs/cr/032-dev-console.md): a weapon or armor
// piece of an exact rarity and level, with a chosen affix and socketed gem,
// for testing gear. Only the game package's dev console calls these, on
// zones started with LODESTONE_ZONE_DEV=1.

import (
	"math"
	"slices"
)

// DevGear describes a dev roll. Rarity is the tier (0 common .. 7
// Bitchin'); Level 0 = the base's; Affix and Gem are keys ("" none; the gem
// goes in the first socket of a weapon).
type DevGear struct {
	Base   string
	Level  int
	Rarity int
	Affix  string
	Gem    string
}

// DevRoll rolls gear like RollEquipment with the rarity and level forced and
// the named affix first (the rest of the rarity's affix count is rolled as
// loot is; uniques and names as the tier gives them). Nil for an unknown or
// non-gear base.
func DevRoll(r *RNG, g DevGear) *Item {
	base := D.Item(g.Base)
	if base == nil || (base.Kind != "weapon" && base.Kind != "armor") {
		return nil
	}
	level := g.Level
	if level <= 0 {
		level = max(1, base.Level)
	}
	rar := min(max(0, g.Rarity), len(D.Rarities)-1)
	rd := D.Rarities[rar]
	it := &Item{Base: base.Key, Qty: 1, Level: level, Rarity: rar, Tradeable: true, Verified: true}
	slot := base.Kind
	if a := D.Affix(g.Affix); a != nil && slices.Contains(a.Slots, slot) && rd.Affixes > 0 {
		v := (a.Min + (a.Max-a.Min)*r.Float()) * (1 + 0.03*float64(level-1))
		it.Affixes = append(it.Affixes, Affix{Key: a.Key, Stat: a.Stat, Value: math.Round(v*10) / 10})
	}
	for _, a := range rollAffixes(r, slot, rd.Affixes, level, -1, "") {
		if len(it.Affixes) >= rd.Affixes {
			break
		}
		if !slices.ContainsFunc(it.Affixes, func(x Affix) bool { return x.Key == a.Key }) {
			it.Affixes = append(it.Affixes, a)
		}
	}
	for len(it.Uniques) < rd.Uniques && len(it.Uniques) < len(D.Uniques) {
		u := D.Uniques[r.Intn(len(D.Uniques))].Key
		if !slices.Contains(it.Uniques, u) {
			it.Uniques = append(it.Uniques, u)
		}
	}
	if rd.Named {
		it.Name = D.Names.First[r.Intn(len(D.Names.First))] + D.Names.Second[r.Intn(len(D.Names.Second))]
	}
	if base.Sockets > 0 {
		it.Sockets = make([]string, base.Sockets) // dev gear: every socket the base can have
		if gd := D.Item(g.Gem); gd != nil && gd.Kind == "gem" && base.Kind == "weapon" {
			it.Sockets[0] = g.Gem
		}
	}
	return it
}

// DevItemKeys is every item key the dev console can give: the base items
// (families expanded: gems by cut, ores, ingots, blueprints) and a tome for
// every spell key passed.
func DevItemKeys(spells []string) []string {
	out := make([]string, 0, len(D.Items)+len(spells))
	for i := range D.Items {
		out = append(out, D.Items[i].Key)
	}
	for _, s := range spells {
		out = append(out, "tome:"+s)
	}
	return out
}
