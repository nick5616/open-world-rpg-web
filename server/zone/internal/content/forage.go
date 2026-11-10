package content

import (
	"math"

	"lodestone/server/pkg/contentdefs"
)

// Herb patches (CR 022 foraging): one chance per forage.cellM cell, a herb
// that grows in the cell's biome, placed by the world seed. Each character
// picks a patch once per forage.regrowS. The glue checks the ground (not
// water, not too steep, not in a town) with `ok`.

// AreaM is the size of the areas patches are listed by (the combat grid).
const AreaM = 256.0

// Patch is one herb patch.
type Patch struct {
	ID   uint32
	Herb int // contentdefs herb id (1-based)
	X, Z float64
}

// PatchID packs a cell (never 0).
func PatchID(cx, cz int) uint32 { return uint32(cz)<<12 | uint32(cx) + 1 }

// PatchCell unpacks PatchID.
func PatchCell(id uint32) (cx, cz int) { id--; return int(id & 0xfff), int(id >> 12) }

// PatchAt is the patch of cell (cx, cz), if any.
func PatchAt(seed uint64, cx, cz int, biomeAt func(x, z float64) int, ok func(x, z float64) bool) (Patch, bool) {
	fg := &contentdefs.D.Forage
	h := mix(seed ^ 0xf0a6e ^ uint64(cz)*0x9e3779b97f4a7c15 ^ uint64(cx)*0xc2b2ae3d27d4eb4f)
	if unit(h) >= fg.Chance {
		return Patch{}, false
	}
	x := (float64(cx) + 0.2 + 0.6*unit(mix(h+1))) * fg.CellM
	z := (float64(cz) + 0.2 + 0.6*unit(mix(h+2))) * fg.CellM
	b := biomeAt(x, z)
	tot := 0.0
	for i := range fg.Herbs {
		for _, hb := range fg.Herbs[i].Biomes {
			if hb == b {
				tot += fg.Herbs[i].Weight
				break
			}
		}
	}
	if tot <= 0 {
		return Patch{}, false
	}
	u := unit(mix(h+3)) * tot
	herb := 0
	for i := range fg.Herbs {
		in := false
		for _, hb := range fg.Herbs[i].Biomes {
			in = in || hb == b
		}
		if !in {
			continue
		}
		herb = fg.Herbs[i].ID
		if u -= fg.Herbs[i].Weight; u < 0 {
			break
		}
	}
	if ok != nil && !ok(x, z) {
		return Patch{}, false
	}
	return Patch{ID: PatchID(cx, cz), Herb: herb, X: x, Z: z}, true
}

// PatchesIn lists the patches whose cells start inside area (ax, az).
func PatchesIn(seed uint64, ax, az int, biomeAt func(x, z float64) int, ok func(x, z float64) bool) []Patch {
	c := contentdefs.D.Forage.CellM
	x0, x1 := int(math.Ceil(float64(ax)*AreaM/c)), int(math.Ceil(float64(ax+1)*AreaM/c))
	z0, z1 := int(math.Ceil(float64(az)*AreaM/c)), int(math.Ceil(float64(az+1)*AreaM/c))
	var out []Patch
	for cz := z0; cz < z1; cz++ {
		for cx := x0; cx < x1; cx++ {
			if p, has := PatchAt(seed, cx, cz, biomeAt, ok); has {
				out = append(out, p)
			}
		}
	}
	return out
}

// HerbByID is herb id's definition (nil if none).
func HerbByID(id int) *contentdefs.Herb {
	if id < 1 || id > len(contentdefs.D.Forage.Herbs) {
		return nil
	}
	return &contentdefs.D.Forage.Herbs[id-1]
}
