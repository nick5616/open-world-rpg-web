// Package worldedit is the rules of breaking and reshaping the generated
// world (playtest 3, CR 040): which scatter objects can be chopped or
// broken and what they drop, and the terrain edit overlay (per-vertex height
// deltas on the 1 m lattice) with the dig/fill planner. Pure Go with no
// dependency on the zone, so the rules are unit-testable; the TS twin of the
// overlay height math lives in client/src/world/edits/.
package worldedit

import "time"

// Scatter layers (worldgen/README.md "Record"): the first byte of a scatter
// id's unmixed tuple.
const (
	LayerTree = 1
	LayerRock = 2
	LayerBush = 3
	LayerTuft = 4
)

// unmix64 inverts SplitMix64's finalizer (worldgen rng.rs unmix64).
func unmix64(z uint64) uint64 {
	z ^= (z >> 31) ^ (z >> 62)
	z *= 0x319642b2d24d8ec3
	z ^= (z >> 27) ^ (z >> 54)
	z *= 0x96de1b173f119089
	z ^= (z >> 30) ^ (z >> 60)
	return z
}

// ScatterID unpacks a scatter record id into its layer and the chunk that
// holds it (id = mix64(layer << 56 | (u16)cx << 40 | (u16)cz << 24 | index)).
func ScatterID(id uint64) (layer uint8, cx, cz int32, index uint32) {
	t := unmix64(id)
	return uint8(t >> 56), int32(int16(t >> 40)), int32(int16(t >> 24)), uint32(t & 0xffffff)
}

// Tools: what a swing is made with.
const (
	ToolAxe     = "tool:axe"
	ToolPickaxe = "tool:pickaxe"
	ToolShovel  = "tool:shovel"
)

// Drop is one possible yield of a broken object.
type Drop struct {
	Item     string
	Min, Max int
	// Chance of this drop at all (0 = always).
	Chance float64
	// PerScale adds up to this many extra at the largest scale byte.
	PerScale float64
}

// Def says how an object is broken.
type Def struct {
	// Tool needed: "" = any tool; otherwise the item key (an axe for trees).
	Tool string
	// HP before scale; a swing with the right tool does Damage.
	HP     float64
	Damage float64
	// Regrow window after it is gone (0 = never regrows).
	RegrowMin, RegrowMax time.Duration
	// Height and Radius (m, at scale byte 128) for reach and the fall.
	Height, Radius float64
	Drops          []Drop
}

var (
	treeDrops      = []Drop{{Item: "wood:log", Min: 2, Max: 3, PerScale: 1.5}, {Item: "wood:stick", Min: 1, Max: 2, Chance: 0.7}, {Item: "wood:resin", Min: 1, Max: 1, Chance: 0.2}}
	coniferDrops   = []Drop{{Item: "wood:log", Min: 2, Max: 4, PerScale: 1.5}, {Item: "wood:stick", Min: 1, Max: 2, Chance: 0.6}, {Item: "wood:resin", Min: 1, Max: 2, Chance: 0.5}}
	deadTreeDrops  = []Drop{{Item: "wood:log", Min: 1, Max: 2, PerScale: 1}, {Item: "wood:firewood", Min: 2, Max: 4}}
	rockDrops      = []Drop{{Item: "stone:block", Min: 2, Max: 4, PerScale: 2}, {Item: "stone:flint", Min: 1, Max: 1, Chance: 0.18}}
	spireDrops     = []Drop{{Item: "stone:block", Min: 3, Max: 5, PerScale: 2}, {Item: "stone:flint", Min: 1, Max: 2, Chance: 0.3}}
	bushDrops      = []Drop{{Item: "plant:fiber", Min: 1, Max: 2}, {Item: "wood:stick", Min: 0, Max: 1, Chance: 0.5}}
	berryBushDrops = []Drop{{Item: "plant:berries", Min: 2, Max: 4}, {Item: "plant:fiber", Min: 1, Max: 1}}
	treeRegrow     = [2]time.Duration{3 * time.Hour, 6 * time.Hour}
	rockRegrow     = [2]time.Duration{8 * time.Hour, 16 * time.Hour}
	bushRegrow     = [2]time.Duration{time.Hour, 2 * time.Hour}
)

// treeH follows worldgen's TREE_KINDS (oak, birch, broadleaf, pine, snow
// fir, dead tree, acacia, willow, cypress); heights match the client's
// TREE_STYLE (scatterManager.ts) at scale byte 128. rockH likewise.
var treeH = [...]float64{7.5, 8.5, 9, 11, 9.5, 6.5, 5.5, 8, 10}
var rockH = [...]float64{1.6, 0.9, 4.5, 1.4, 1.5}

// DefFor returns the rules of a scatter object, or false when it cannot be
// broken (grass tufts, unknown kinds).
func DefFor(layer, kind uint8) (Def, bool) {
	switch layer {
	case LayerTree:
		if int(kind) >= len(treeH) {
			return Def{}, false
		}
		d := Def{Tool: ToolAxe, HP: 100, Damage: 25, RegrowMin: treeRegrow[0], RegrowMax: treeRegrow[1], Height: treeH[kind], Radius: 0.45, Drops: treeDrops}
		switch kind {
		case 3, 4, 8:
			d.Drops = coniferDrops
		case 5:
			d.Drops = deadTreeDrops
			d.HP = 70
		}
		return d, true
	case LayerRock:
		if int(kind) >= len(rockH) {
			return Def{}, false
		}
		d := Def{Tool: ToolPickaxe, HP: 100, Damage: 25, RegrowMin: rockRegrow[0], RegrowMax: rockRegrow[1], Height: rockH[kind], Radius: 1.0, Drops: rockDrops}
		if kind == 2 {
			d.Drops = spireDrops
			d.HP = 140
			d.Radius = 0.7
		}
		if kind == 1 {
			d.HP = 80
		}
		return d, true
	case LayerBush:
		if kind > 5 {
			return Def{}, false
		}
		d := Def{HP: 40, Damage: 25, RegrowMin: bushRegrow[0], RegrowMax: bushRegrow[1], Height: 1.2, Radius: 0.8, Drops: bushDrops}
		if kind == 1 {
			d.Drops = berryBushDrops
		}
		return d, true
	}
	return Def{}, false
}

// ScaleFactor maps a record's scale byte to the renderer's 0.7..1.3 size
// multiplier (scatterManager.ts put()).
func ScaleFactor(scaleByte uint8) float64 { return 0.7 + float64(scaleByte)/255*0.6 }

// MaxHP is the object's hit points: bigger ones take more swings.
func (d Def) MaxHP(scaleByte uint8) float64 { return d.HP * (0.6 + 0.8*float64(scaleByte)/255) }

// Yield is one rolled drop.
type Yield struct {
	Item string
	Qty  int
}

// Roll rolls the drops of one broken object from a seed (deterministic, so
// a logged roll can be replayed).
func (d Def) Roll(scaleByte uint8, seed uint64) []Yield {
	var out []Yield
	for i, dr := range d.Drops {
		u := unit(mix64(seed ^ uint64(i+1)*0x9E3779B97F4A7C15))
		if dr.Chance > 0 && u >= dr.Chance {
			continue
		}
		v := unit(mix64(seed ^ uint64(i+101)*0xD1B54A32D192ED03))
		span := dr.Max - dr.Min + 1
		q := dr.Min + int(v*float64(span))
		if dr.PerScale > 0 {
			q += int(dr.PerScale * float64(scaleByte) / 255 * (0.5 + unit(mix64(seed^uint64(i+201)))))
		}
		if q > 0 {
			out = append(out, Yield{dr.Item, q})
		}
	}
	return out
}

// Regrow returns how long the object stays gone, seeded; 0 = never.
func (d Def) Regrow(seed uint64) time.Duration {
	if d.RegrowMax <= 0 {
		return 0
	}
	lo, hi := d.RegrowMin, max(d.RegrowMin, d.RegrowMax)
	return lo + time.Duration(float64(hi-lo)*unit(mix64(seed^0x51ED2701)))
}

func mix64(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

func unit(h uint64) float64 { return float64(h>>11) / float64(uint64(1)<<53) }

// Mix64 is SplitMix64's finalizer, exported for the zone's seeding.
func Mix64(z uint64) uint64 { return mix64(z) }
