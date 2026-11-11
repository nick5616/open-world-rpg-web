package structures

import (
	"encoding/binary"
	"errors"
	"math"

	"lodestone/server/pkg/movement"
)

// The Go reader of the atlas SITES, REGIONS and NAMES sections
// (worldgen/README.md "Atlas buffer"; the TS reference reader is
// worldgen/js/src/format.ts parseAtlas). Here because towers are built from
// sites, and the zone's exploration logic reads the same table.

// Site categories and POI kinds (worldgen/README.md "Site record").
const (
	CategoryPOI        = 0
	CategorySettlement = 1
	CategoryStructure  = 2

	POITower     = 0
	POICaveMouth = 1
	POIWaypoint  = 2
	POILandmark  = 3
	POIEnemyCamp = 4
	// genVersion 3 (CR 038, the vertical world): appended after every base site.
	POITunnel      = 5
	POICavern      = 6
	POISkyLift     = 7
	POIDepths      = 8
	POIArchipelago = 9
	POIDepthsGate  = 10
	// Structure kinds 9 and 10 (layer 1).
	StructSkyPalace = 9
	StructSkyRuin   = 10
)

// Site is one atlas site record. Index is its dense, world-stable position
// in the table: per-character bitsets are indexed by it.
type Site struct {
	Index    int
	ID       uint64
	Category uint8
	Kind     uint8
	Region   uint8
	Size     uint8
	X, Y, Z  float64 // f32 in the atlas, widened exactly
	Radius   float64
	Name     string // "" when unnamed
	Yaw      float64
	Link     int // linked site index, -1 none
	// Layer (genVersion 3, byte 37): 0 surface, 1 sky, 2 Underground, 3 Depths.
	Layer uint8
}

// IsBase: a site that predates the vertical world (genVersion 3 appends its
// sites after these; story, content and quest picks read only these so they
// stay where they were).
func (s *Site) IsBase() bool {
	if s.Layer != 0 {
		return false
	}
	switch s.Category {
	case CategoryPOI:
		return s.Kind <= POIEnemyCamp
	case CategoryStructure:
		return s.Kind <= 8
	}
	return true
}

// IsTower reports whether the site is a tower POI.
func (s *Site) IsTower() bool { return s.Category == CategoryPOI && s.Kind == POITower }

// IsWaypoint reports whether the site is a waypoint POI.
func (s *Site) IsWaypoint() bool { return s.Category == CategoryPOI && s.Kind == POIWaypoint }

// Region is one atlas region record (the parts exploration uses).
type Region struct {
	Index int
	Name  string
	Tower int // site index of the region's tower, -1 none
}

// Atlas is the parsed site table.
type Atlas struct {
	WorldSize      float64
	RegionsPerEdge int
	SpawnX, SpawnZ float64
	Sites          []Site
	Regions        []Region
}

func section(b []byte, id int) []byte {
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

// ParseAtlas reads the sites, regions and names of an atlas buffer.
func ParseAtlas(b []byte) (*Atlas, error) {
	le := binary.LittleEndian
	if len(b) < 192 || string(b[:4]) != "LDAT" {
		return nil, errors.New("structures: not an atlas")
	}
	f32 := func(p []byte, o int) float64 { return float64(math.Float32frombits(le.Uint32(p[o:]))) }
	a := &Atlas{WorldSize: float64(le.Uint16(b[24:])), RegionsPerEdge: int(b[30]), SpawnX: f32(b, 36), SpawnZ: f32(b, 40)}

	var names []string
	if ns := section(b, 12); len(ns) >= 4 {
		n := int(le.Uint32(ns))
		o := 4
		for i := 0; i < n && o+2 <= len(ns); i++ {
			l := int(le.Uint16(ns[o:]))
			if o+2+l > len(ns) {
				return nil, errors.New("structures: names truncated")
			}
			names = append(names, string(ns[o+2:o+2+l]))
			o += 2 + l
		}
	}
	name := func(i uint16) string {
		if i == 0xffff || int(i) >= len(names) {
			return ""
		}
		return names[i]
	}

	ss := section(b, 11)
	if len(ss) < 8 {
		return nil, errors.New("structures: no site table")
	}
	n, rec := int(le.Uint32(ss)), int(le.Uint32(ss[4:]))
	if rec < 48 || 8+n*rec > len(ss) {
		return nil, errors.New("structures: site table truncated")
	}
	a.Sites = make([]Site, n)
	for i := range a.Sites {
		p := ss[8+i*rec:]
		link := int(le.Uint16(p[46:]))
		if link == 0xffff {
			link = -1
		}
		a.Sites[i] = Site{
			Index: i, ID: le.Uint64(p), Category: p[8], Kind: p[9], Region: p[10], Size: p[11],
			X: f32(p, 12), Y: f32(p, 16), Z: f32(p, 20), Radius: f32(p, 24),
			Name:  name(le.Uint16(p[32:])),
			Yaw:   float64(le.Uint16(p[44:])) / 65536 * 2 * math.Pi,
			Link:  link,
			Layer: p[37],
		}
	}

	rs := section(b, 10)
	for r := 0; r+32 <= len(rs); r += 32 {
		t := int(le.Uint16(rs[r+6:]))
		if t == 0xffff {
			t = -1
		}
		a.Regions = append(a.Regions, Region{Index: int(rs[r]), Name: name(le.Uint16(rs[r+4:])), Tower: t})
	}
	return a, nil
}

// RegionOf is the region index of a world position (index = rz * 4 + rx),
// clamped into the world.
func (a *Atlas) RegionOf(x, z float64) int {
	per := a.RegionsPerEdge
	size := a.WorldSize / float64(per)
	rx := min(per-1, max(0, int(math.Floor(x/size))))
	rz := min(per-1, max(0, int(math.Floor(z/size))))
	return rz*per + rx
}

// Towers builds one Radial per tower site on base and returns an overlay
// holding them plus, for each overlay index, the site index it came from.
// Overlay index order = site table order, identical in the TS twin.
func Towers(a *Atlas, base movement.Ground) (*Overlay, []int) {
	o := NewOverlay()
	var sites []int
	for i := range a.Sites {
		s := &a.Sites[i]
		if s.IsTower() {
			o.Add(NewTower(base, s.X, s.Z))
			sites = append(sites, i)
		}
	}
	return o, sites
}
