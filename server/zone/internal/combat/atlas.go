package combat

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/structures"
)

// AtlasInfo is the combat view of a world's atlas: sites with the biome and
// element fields structures.Site doesn't carry, region elements and danger,
// and the macro biome grid (worldgen/README.md "Atlas buffer").
type AtlasInfo struct {
	Sites     []SiteInfo
	Regions   []RegionInfo
	WorldSize float64
	PerEdge   int
	biome     []uint8
	biomeN    int
	SpawnX    float64
	SpawnZ    float64
}

// SiteInfo is one atlas site.
type SiteInfo struct {
	structures.Site
	Biome   int
	Element int // combatdefs element, Physical when none
}

// RegionInfo is the combat part of a region record.
type RegionInfo struct {
	Element, Element2 int
	Danger            float64
}

// Site categories and kinds (worldgen/README.md "Site record").
const (
	StructRuin        = 0
	StructWatchtower  = 1
	StructMineshaft   = 2
	StructShrine      = 3
	StructBanditCamp  = 4
	StructWizardTower = 5
	StructMeteor      = 6
	StructSunken      = 7
	StructDemonLair   = 8
)

func atlasSection(b []byte, id int) []byte {
	o := 64 + id*8
	if o+8 > len(b) {
		return nil
	}
	off, n := binary.LittleEndian.Uint32(b[o:]), binary.LittleEndian.Uint32(b[o+4:])
	if n == 0 || uint64(off)+uint64(n) > uint64(len(b)) {
		return nil
	}
	return b[off : off+n]
}

// ParseAtlas reads what combat needs from the raw atlas plus the parsed
// site table (structures.ParseAtlas).
func ParseAtlas(raw []byte, a *structures.Atlas) *AtlasInfo {
	le := binary.LittleEndian
	info := &AtlasInfo{WorldSize: a.WorldSize, PerEdge: a.RegionsPerEdge, SpawnX: a.SpawnX, SpawnZ: a.SpawnZ}
	ss := atlasSection(raw, 11)
	rec := 0
	if len(ss) >= 8 {
		rec = int(le.Uint32(ss[4:]))
	}
	for i, s := range a.Sites {
		si := SiteInfo{Site: s, Biome: 0, Element: 8}
		if rec >= 48 && 8+(i+1)*rec <= len(ss) {
			p := ss[8+i*rec:]
			si.Biome = int(p[34])
			if el := int(p[35]); el < 8 {
				si.Element = el
			}
		}
		info.Sites = append(info.Sites, si)
	}
	rs := atlasSection(raw, 10)
	for r := 0; r+32 <= len(rs); r += 32 {
		ri := RegionInfo{Element: int(rs[r+2]), Element2: int(rs[r+3]), Danger: float64(math.Float32frombits(le.Uint32(rs[r+8:])))}
		if ri.Element > 7 {
			ri.Element = 8
		}
		if ri.Element2 > 7 {
			ri.Element2 = 8
		}
		info.Regions = append(info.Regions, ri)
	}
	if bs := atlasSection(raw, 6); len(bs) > 0 {
		n := int(math.Round(math.Sqrt(float64(len(bs)))))
		if n*n == len(bs) {
			info.biome, info.biomeN = bs, n
		}
	}
	return info
}

// BiomeAt is the macro biome at a world position (0 meadow .. 5 wetland).
func (a *AtlasInfo) BiomeAt(x, z float64) int {
	if a.biomeN == 0 || a.WorldSize <= 0 {
		return 0
	}
	n := a.biomeN
	cx := min(n-1, max(0, int(x/a.WorldSize*float64(n))))
	cz := min(n-1, max(0, int(z/a.WorldSize*float64(n))))
	return min(5, int(a.biome[cz*n+cx]))
}

// RegionAt is the region index of a position.
func (a *AtlasInfo) RegionAt(x, z float64) int {
	per := max(1, a.PerEdge)
	size := a.WorldSize / float64(per)
	rx := min(per-1, max(0, int(math.Floor(x/size))))
	rz := min(per-1, max(0, int(math.Floor(z/size))))
	return rz*per + rx
}

// Region returns region info (zero value if out of range).
func (a *AtlasInfo) Region(i int) RegionInfo {
	if i < 0 || i >= len(a.Regions) {
		return RegionInfo{Element: 8, Element2: 8}
	}
	return a.Regions[i]
}
