package items

// Seeded rolls (spec 8: "All rolls happen on the zone server with a
// per-roll seed logged for audit"). A roll is a pure function of its seed
// and inputs, so a logged seed reproduces the exact items (RollAgain in the
// tests does this for every tier).

import (
	"math"
	"slices"

	"lodestone/server/pkg/itemdefs"
)

// RNG is SplitMix64: tiny, fast, and identical everywhere.
type RNG struct{ s uint64 }

// NewRNG seeds a generator.
func NewRNG(seed uint64) *RNG { return &RNG{s: seed ^ 0x9E3779B97F4A7C15} }

// Mix64 is the SplitMix64 finalizer (seed derivation).
func Mix64(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// U64 is the next 64 random bits.
func (r *RNG) U64() uint64 {
	r.s += 0x9E3779B97F4A7C15
	return Mix64(r.s)
}

// Float is uniform in [0, 1).
func (r *RNG) Float() float64 { return float64(r.U64()>>11) / float64(uint64(1)<<53) }

// Intn is uniform in [0, n).
func (r *RNG) Intn(n int) int {
	if n <= 1 {
		return 0
	}
	return int(r.U64() % uint64(n))
}

// Range is uniform in [lo, hi] (integers).
func (r *RNG) Range(lo, hi int) int {
	if hi <= lo {
		return lo
	}
	return lo + r.Intn(hi-lo+1)
}

// Chance is true with probability p.
func (r *RNG) Chance(p float64) bool { return r.Float() < p }

// Odds returns the per-roll probability of every tier for a luck
// multiplier (1 = base odds). Lucky tiers (rare and up, minus Bitchin')
// scale by luck, capped at LuckCap of all rolls in total; common absorbs
// the rest so the eight always sum to 1.
func Odds(luck float64) [8]float64 {
	var p [8]float64
	luck = math.Max(1, luck)
	luckySum := 0.0
	for i, r := range D.Rarities {
		p[i] = r.Odds
		if r.Lucky {
			p[i] *= luck
			luckySum += p[i]
		}
	}
	if luckySum > D.LuckCap {
		k := D.LuckCap / luckySum
		for i, r := range D.Rarities {
			if r.Lucky {
				p[i] *= k
			}
		}
	}
	rest := 0.0
	for i := 1; i < len(p); i++ {
		rest += p[i]
	}
	p[0] = math.Max(0, 1-rest)
	return p
}

// RollRarity picks a tier, walking from the rarest down.
func RollRarity(r *RNG, luck float64) int {
	p := Odds(luck)
	u := r.Float()
	acc := 0.0
	for i := len(p) - 1; i > 0; i-- {
		acc += p[i]
		if u < acc {
			return i
		}
	}
	return 0
}

// Rolled is the context of an equipment roll.
type Rolled struct {
	Level   int     // item level
	Element int     // roll element (region/enemy element), -1 none
	Theme   string  // loot theme (worldspec lootThemes value), "" none
	Luck    float64 // rarity luck multiplier
	Kind    string  // "weapon", "armor" or "" (either)
	Base    string  // forced base (forging), "" = pick
	Forged  bool    // a forge roll (guaranteed sockets from the recipe)
	MinSock int
	Deep    bool // deep-cave / void source: primordial bases prefer voidglass
}

// randomBases are the bases loot can roll: everything except sunsteel
// (spec 7/8: sunsteel weapons come from sunsteel ore at a forge; a random
// sunsteel drop would bypass the night's main rule) and the primordial
// materials (only primordial rolls and high levels reach them).
func randomBases(kind string, level int) []*itemdefs.Item {
	var out []*itemdefs.Item
	for i := range D.Items {
		it := &D.Items[i]
		if (kind == "weapon" && it.Kind != "weapon") || (kind == "armor" && it.Kind != "armor") || (it.Kind != "weapon" && it.Kind != "armor") {
			continue
		}
		if it.Material == "sunsteel" {
			continue
		}
		if it.Level > level+1 || it.Level < level-9 {
			continue
		}
		out = append(out, it)
	}
	if len(out) == 0 { // very low or very high levels: the nearest tier
		best := math.MaxInt
		for i := range D.Items {
			it := &D.Items[i]
			if (it.Kind != kind && kind != "") || (it.Kind != "weapon" && it.Kind != "armor") || it.Material == "sunsteel" {
				continue
			}
			d := absInt(it.Level - level)
			if d < best {
				best, out = d, []*itemdefs.Item{it}
			} else if d == best {
				out = append(out, it)
			}
		}
	}
	return out
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// counterpart finds the same weapon type / armor slot in another material.
func counterpart(base *itemdefs.Item, material string) *itemdefs.Item {
	for i := range D.Items {
		it := &D.Items[i]
		if it.Material == material && it.Kind == base.Kind && it.Weapon == base.Weapon && it.Armor == base.Armor {
			return it
		}
	}
	return nil
}

// RollEquipment rolls one weapon or armor piece.
func RollEquipment(r *RNG, ctx Rolled) *Item {
	level := max(1, ctx.Level)
	var base *itemdefs.Item
	if ctx.Base != "" {
		base = D.Item(ctx.Base)
	} else {
		kind := ctx.Kind
		if kind == "" {
			kind = "armor"
			if r.Chance(0.6) {
				kind = "weapon"
			}
		}
		cands := randomBases(kind, level)
		// Prefer bases near the item level: weight 1 + (base level).
		tot := 0.0
		for _, c := range cands {
			tot += 1 + float64(c.Level)
		}
		u := r.Float() * tot
		for _, c := range cands {
			u -= 1 + float64(c.Level)
			if u < 0 {
				base = c
				break
			}
		}
		if base == nil {
			base = cands[len(cands)-1]
		}
	}
	rar := RollRarity(r, ctx.Luck)
	rd := D.Rarities[rar]
	// Primordial: "5 plus a unique, on a starmetal or voidglass base".
	if len(rd.Bases) > 0 && !slices.Contains(rd.Bases, base.Material) {
		want := rd.Bases[0]
		if ctx.Deep && len(rd.Bases) > 1 {
			want = rd.Bases[1]
		}
		if c := counterpart(base, want); c != nil {
			base = c
		}
	}
	it := &Item{Base: base.Key, Qty: 1, Level: level, Rarity: rar, Tradeable: true, Verified: true}
	slot := base.Kind
	it.Affixes = rollAffixes(r, slot, rd.Affixes, level, ctx.Element, ctx.Theme)
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
		n := len(D.Loot.Sockets) - 1
		u := r.Float()
		for i, w := range D.Loot.Sockets {
			if u < w {
				n = i
				break
			}
			u -= w
		}
		if rar >= D.RarityByKey("relic") {
			n++ // relic and up: one step more
		}
		n = max(n, ctx.MinSock)
		n = min(n, base.Sockets)
		it.Sockets = make([]string, n)
	}
	return it
}

// rollAffixes picks n distinct affixes for a slot (weapon/armor), weighted
// by element and theme (x4 matching, x0.25 off), values scaled by level.
func rollAffixes(r *RNG, slot string, n, level, element int, theme string) []Affix {
	type cand struct {
		a *itemdefs.Affix
		w float64
	}
	var cs []cand
	for i := range D.Affixes {
		a := &D.Affixes[i]
		if !slices.Contains(a.Slots, slot) {
			continue
		}
		w := a.Weight
		if len(a.Elements) > 0 {
			if slices.Contains(a.Elements, element) {
				w *= 4
			} else {
				w *= 0.25
			}
		}
		if len(a.Themes) > 0 {
			if slices.Contains(a.Themes, theme) {
				w *= 4
			} else {
				w *= 0.25
			}
		}
		cs = append(cs, cand{a, w})
	}
	var out []Affix
	for len(out) < n && len(cs) > 0 {
		tot := 0.0
		for _, c := range cs {
			tot += c.w
		}
		u := r.Float() * tot
		k := len(cs) - 1
		for i, c := range cs {
			u -= c.w
			if u < 0 {
				k = i
				break
			}
		}
		a := cs[k].a
		cs = slices.Delete(cs, k, k+1)
		v := (a.Min + (a.Max-a.Min)*r.Float()) * (1 + 0.03*float64(level-1))
		out = append(out, Affix{Key: a.Key, Stat: a.Stat, Value: math.Round(v*10) / 10})
	}
	return out
}

// Stack makes a plain stack of a base item (materials, coins, gems).
func Stack(base string, qty int) *Item {
	d := D.Item(base)
	lvl := 1
	if d != nil {
		lvl = d.Level
	}
	return &Item{Base: base, Qty: qty, Level: lvl, Tradeable: true, Verified: true}
}

// ---- loot tables ----

// KillContext describes a kill for the loot tables.
type KillContext struct {
	Family  string // combat.yaml enemy family
	Level   int
	Elite   bool
	Boss    bool
	Element int    // enemy element (combat index; 8 physical)
	Theme   string // region loot theme ("" none)
	Luck    float64
	Deep    bool
	Tomes   []string // candidate spell keys for a boss tome (not known yet)
}

func coins(r *RNG, rng [2]int, level int) int {
	n := float64(r.Range(rng[0], rng[1])) * (1 + D.Loot.Coins.PerLevel*float64(max(1, level)-1))
	return int(math.Round(n))
}

func gemElementKey(r *RNG, element int) string {
	if element >= 0 && element < 8 {
		for _, g := range D.Gems {
			if g.Element == element {
				return g.Key
			}
		}
	}
	return D.Gems[r.Intn(len(D.Gems))].Key
}

// RollGem is one gem: mostly rough, deeper and luckier is better cut.
func RollGem(r *RNG, element int, luck float64) *Item {
	cut := "rough"
	u := r.Float() / math.Max(1, luck)
	switch {
	case u < 0.02:
		cut = "brilliant"
	case u < 0.15:
		cut = "cut"
	}
	return Stack("gem:"+gemElementKey(r, element)+":"+cut, 1)
}

func randomBlueprint(r *RNG, level int) *Item {
	var bps []string
	for _, rc := range D.Recipes {
		if rc.Blueprint == "" {
			continue
		}
		if out := D.Item(rc.Output); out != nil && out.Level <= level+4 {
			bps = append(bps, rc.Blueprint)
		}
	}
	if len(bps) == 0 {
		return nil
	}
	return Stack(bps[r.Intn(len(bps))], 1)
}

var foodPool = []string{"food:bread", "food:cheese", "food:apple"}

var consumablePool = []string{"potion:health", "food:bread", "food:cheese", "food:apple", "potion:health", "food:grilled_meat"}

func randomConsumable(r *RNG, level int) *Item {
	b := consumablePool[r.Intn(len(consumablePool))]
	if level >= 8 && r.Chance(0.3) {
		b = "potion:greater_health"
	}
	return Stack(b, 1+r.Intn(2))
}

// KillLoot is one eligible player's personal loot for a kill (spec 8).
func KillLoot(r *RNG, k KillContext) []*Item {
	var out []*Item
	cr := D.Loot.Coins.Common
	switch {
	case k.Boss:
		cr = D.Loot.Coins.Boss
	case k.Elite:
		cr = D.Loot.Coins.Elite
	}
	if n := coins(r, cr, k.Level); n > 0 {
		out = append(out, Stack("currency:gold", n))
	}
	fam := k.Family
	if k.Boss {
		fam = "boss"
	}
	fd := D.Loot.Families[fam]
	luck := math.Max(1, k.Luck)
	el := k.Element
	ctx := Rolled{Level: k.Level, Element: el, Theme: k.Theme, Luck: luck, Deep: k.Deep}
	nItems := 0
	if r.Chance(fd.Item) {
		nItems++
	}
	if k.Elite && !k.Boss {
		nItems = max(nItems, D.Loot.Elite.Items)
		ctx.Luck *= D.Loot.Elite.Luck
	}
	if k.Boss {
		nItems = D.Loot.Boss.Items
		ctx.Luck *= D.Loot.Boss.Luck
	}
	for i := 0; i < nItems; i++ {
		out = append(out, RollEquipment(r, ctx))
	}
	if r.Chance(fd.Meat) {
		out = append(out, Stack("meat:raw", 1+r.Intn(2)))
	}
	if r.Chance(fd.Hide) {
		out = append(out, Stack("hide:wolf", 1))
	}
	if r.Chance(fd.Gem) {
		out = append(out, RollGem(r, el, luck))
	}
	if r.Chance(fd.Ore) {
		ores := []string{"copper", "iron", "iron", "silver"}
		out = append(out, Stack("ore:"+ores[r.Intn(len(ores))], 1+r.Intn(2)))
	}
	if r.Chance(fd.Blueprint) {
		if b := randomBlueprint(r, k.Level); b != nil {
			out = append(out, b)
		}
	}
	if r.Chance(fd.Consumable) {
		out = append(out, randomConsumable(r, k.Level))
	}
	if r.Chance(fd.Food) {
		out = append(out, Stack(foodPool[r.Intn(len(foodPool))], 1))
	}
	if k.Boss {
		for i := 0; i < D.Loot.Boss.Tomes && len(k.Tomes) > 0; i++ {
			out = append(out, Stack("tome:"+k.Tomes[r.Intn(len(k.Tomes))], 1))
		}
	}
	return out
}

// ContainerKinds are the worldgen container kinds (chunk records).
var ContainerKinds = []string{"chest", "buried_cache", "urn", "crate"}

// ContainerContext describes a container for its loot table.
type ContainerContext struct {
	Kind    int     // 0 chest, 1 buried cache, 2 urn, 3 crate
	Theme   string  // loot theme (container variant)
	Level   int     // item level (the zone: the area's discovery-stamped level)
	Element int     // region element, -1 none
	Luck    float64 // extra luck (Opal)
}

// ContainerLoot is one character's roll for a container.
func ContainerLoot(r *RNG, c ContainerContext) []*Item {
	kind := "chest"
	if c.Kind >= 0 && c.Kind < len(ContainerKinds) {
		kind = ContainerKinds[c.Kind]
	}
	t := D.Loot.Containers[kind]
	var out []*Item
	if n := coins(r, t.Coins, c.Level); n > 0 {
		out = append(out, Stack("currency:gold", n))
	}
	luck := math.Max(1, c.Luck) * t.Luck
	for i, n := 0, r.Range(t.Items[0], t.Items[1]); i < n; i++ {
		out = append(out, RollEquipment(r, Rolled{Level: c.Level, Element: c.Element, Theme: c.Theme, Luck: luck}))
	}
	if r.Chance(t.Gem) {
		out = append(out, RollGem(r, c.Element, luck))
	}
	if r.Chance(t.Blueprint) {
		if b := randomBlueprint(r, c.Level); b != nil {
			out = append(out, b)
		}
	}
	if r.Chance(t.Consumable) {
		out = append(out, randomConsumable(r, c.Level))
	}
	return out
}

// Announce reports whether an item's tier is announced to the whole world
// (spec 8: Bitchin' in global chat).
func Announce(it *Item) bool {
	return it.Rarity >= 0 && it.Rarity < len(D.Rarities) && D.Rarities[it.Rarity].Announce
}
