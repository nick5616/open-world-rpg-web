package caves

import (
	"encoding/binary"
	"errors"
	"math"
)

// Chamber flags (README "Cave graph buffer").
const (
	ChamberEntrance = 1
	ChamberSunlit   = 2
	ChamberShaft    = 4
	ChamberDeepest  = 8
)

// System is one cave system (grown from one mouth).
type System struct {
	Index                  int
	ID                     uint64 // the mouth site's stable id
	SiteIndex              int
	Region, Biome          uint8
	Element, Element2      uint8
	DeepestBand            uint8
	MouthY                 float64
	FirstChamber, Chambers int
	FirstTunnel, Tunnels   int
	FirstOpening, Openings int
	FirstVein, VeinCount   int
	Deepest                int // local chamber index
	BBox                   [6]float64
	MaxDepth               float64
}

// Chamber is a graph node (the enemy nav graph uses it too).
type Chamber struct {
	X, Y, Z, RX, RY, Floor, Depth float64
	Flags, Band                   uint8
	Parent                        int // local, -1 for the entrance
	System                        int
}

// Tunnel is a graph edge: 3 capsule segments through 4 axis points.
type Tunnel struct {
	A, B              int // local chamber indices
	Kind              uint8
	R, Stretch, Floor float64
	Pts               [12]float64
	System            int
}

// Opening is where a system meets the sky (mouth or sinkhole).
type Opening struct {
	X, Y, Z, RMask, RZone float64
	System, Tunnel        int
	Sinkhole              bool
	Yaw                   uint16
}

// Graph is a parsed cave graph buffer.
type Graph struct {
	CaveMaxDepth, GemRarityCurve float64
	Systems                      []System
	Chambers                     []Chamber
	TunnelsList                  []Tunnel
	OpeningsList                 []Opening
	Veins                        []Vein
	Bytes                        []byte
	veinByID                     map[uint64]int
}

// ParseGraph decodes the cave graph buffer.
func ParseGraph(b []byte) (*Graph, error) {
	if len(b) < 64 || string(b[:4]) != "LDCG" {
		return nil, errors.New("not a cave graph (bad magic or short)")
	}
	le := binary.LittleEndian
	if le.Uint16(b[4:]) != graphFormat {
		return nil, errors.New("cave graph format mismatch")
	}
	u := func(o int) int { return int(le.Uint32(b[o:])) }
	u16 := func(o int) int { return int(le.Uint16(b[o:])) }
	f := func(o int) float64 { return float64(math.Float32frombits(le.Uint32(b[o:]))) }
	ns, nc, nt, no, nv := u(12), u(16), u(20), u(24), u(28)
	sysOff, chOff, tunOff, openOff, veinOff := u(32), u(36), u(40), u(44), u(48)
	if veinOff+nv*veinRec > len(b) {
		return nil, errors.New("cave graph truncated")
	}
	g := &Graph{CaveMaxDepth: f(52), GemRarityCurve: f(56), Bytes: b, veinByID: make(map[uint64]int, nv)}
	for s := 0; s < ns; s++ {
		o := sysOff + s*72
		sy := System{Index: s, ID: le.Uint64(b[o:]), SiteIndex: u16(o + 8), Region: b[o+10], Biome: b[o+11], Element: b[o+12], Element2: b[o+13],
			DeepestBand: b[o+15], MouthY: f(o + 16), FirstChamber: u(o + 20), Chambers: u16(o + 24), Tunnels: u16(o + 26), FirstTunnel: u(o + 28),
			FirstOpening: u16(o + 32), Openings: u16(o + 34), FirstVein: u(o + 36), VeinCount: u16(o + 40), Deepest: u16(o + 42), MaxDepth: f(o + 68)}
		for k := 0; k < 6; k++ {
			sy.BBox[k] = f(o + 44 + k*4)
		}
		g.Systems = append(g.Systems, sy)
	}
	sysOf := func(i int, first func(*System) (int, int)) int {
		for k := range g.Systems {
			a, n := first(&g.Systems[k])
			if i >= a && i < a+n {
				return k
			}
		}
		return -1
	}
	for k := 0; k < nc; k++ {
		o := chOff + k*32
		p := u16(o + 30)
		if p == 0xFFFF {
			p = -1
		}
		g.Chambers = append(g.Chambers, Chamber{X: f(o), Y: f(o + 4), Z: f(o + 8), RX: f(o + 12), RY: f(o + 16), Floor: f(o + 20), Depth: f(o + 24),
			Flags: b[o+28], Band: b[o+29], Parent: p, System: sysOf(k, func(s *System) (int, int) { return s.FirstChamber, s.Chambers })})
	}
	for k := 0; k < nt; k++ {
		o := tunOff + k*72
		t := Tunnel{A: u16(o), B: u16(o + 2), Kind: b[o+4], R: f(o + 8), Stretch: f(o + 12), Floor: f(o + 16),
			System: sysOf(k, func(s *System) (int, int) { return s.FirstTunnel, s.Tunnels })}
		for i := 0; i < 12; i++ {
			t.Pts[i] = f(o + 20 + i*4)
		}
		g.TunnelsList = append(g.TunnelsList, t)
	}
	for k := 0; k < no; k++ {
		o := openOff + k*32
		g.OpeningsList = append(g.OpeningsList, Opening{X: f(o), Y: f(o + 4), Z: f(o + 8), RMask: f(o + 12), RZone: f(o + 16),
			System: u16(o + 20), Tunnel: u16(o + 22), Sinkhole: b[o+24] == 1, Yaw: le.Uint16(b[o+26:])})
	}
	for k := 0; k < nv; k++ {
		v := readVein(b, veinOff+k*veinRec)
		g.veinByID[v.ID] = k
		g.Veins = append(g.Veins, v)
	}
	return g, nil
}

// Vein returns the generated vein with this id.
func (g *Graph) Vein(id uint64) (Vein, bool) {
	k, ok := g.veinByID[id]
	if !ok {
		return Vein{}, false
	}
	return g.Veins[k], true
}

// VeinSystem returns the system a vein (by graph index) belongs to.
func (g *Graph) VeinSystem(k int) int {
	for i := range g.Systems {
		s := &g.Systems[i]
		if k >= s.FirstVein && k < s.FirstVein+s.VeinCount {
			return i
		}
	}
	return -1
}

// TriMasked reports whether heightfield triangle tri (0 below the cell
// diagonal, 1 above) of the 1 m cell (x0, z0) is dropped by a mouth mask
// (README "Mouth masks").
func TriMasked(openings []Opening, x0, z0 float64, tri int) bool {
	var cx, cz float64
	if tri == 0 {
		cx, cz = x0+1.0/3.0, z0+1.0/3.0
	} else {
		cx, cz = x0+2.0/3.0, z0+2.0/3.0
	}
	for i := range openings {
		o := &openings[i]
		dx := cx - o.X
		dz := cz - o.Z
		if float64(dx*dx)+float64(dz*dz) < float64(o.RMask*o.RMask) {
			return true
		}
	}
	return false
}

// Masked reports whether the heightfield triangle under (x, z) is dropped.
func Masked(openings []Opening, x, z float64) bool {
	x0 := math.Floor(x)
	z0 := math.Floor(z)
	tri := 1
	if (x-x0)+(z-z0) <= 1 {
		tri = 0
	}
	return TriMasked(openings, x0, z0, tri)
}

// SystemAt is the cave-system index containing (x, y, z) (within 2 m of the
// planned air of a chamber or tunnel), or -1. Same as the wasm export and
// caveSystemAt in TS. AOI clipping and voice earshot ("same cave system",
// WP11) use it.
func (g *Graph) SystemAt(x, y, z float64) int {
	const pad = 2.0
	for si := range g.Systems {
		s := &g.Systems[si]
		b := &s.BBox
		if x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5] {
			continue
		}
		for k := 0; k < s.Chambers; k++ {
			c := &g.Chambers[s.FirstChamber+k]
			if y < c.Floor-pad {
				continue
			}
			dx := (x - c.X) / (c.RX + pad)
			dy := (y - c.Y) / (c.RY + pad)
			dz := (z - c.Z) / (c.RX + pad)
			if float64(float64(dx*dx)+float64(dy*dy))+float64(dz*dz) <= 1 {
				return si
			}
		}
		for k := 0; k < s.Tunnels; k++ {
			t := &g.TunnelsList[s.FirstTunnel+k]
			for sg := 0; sg < 3; sg++ {
				p := &t.Pts
				ax, ay, az := p[sg*3], p[sg*3+1]/t.Stretch, p[sg*3+2]
				bx, by, bz := p[sg*3+3], p[sg*3+4]/t.Stretch, p[sg*3+5]
				py := y / t.Stretch
				ex, ey, ez := bx-ax, by-ay, bz-az
				l2 := float64(float64(ex*ex)+float64(ey*ey)) + float64(ez*ez)
				tt := 0.0
				if l2 > 0 {
					tt = (float64(float64((x-ax)*ex)+float64((py-ay)*ey)) + float64((z-az)*ez)) / l2
				}
				tt = math.Max(0, math.Min(1, tt))
				qx := ax + float64(ex*tt) - x
				qy := ay + float64(ey*tt) - py
				qz := az + float64(ez*tt) - z
				rr := t.R + pad
				if float64(float64(qx*qx)+float64(qy*qy))+float64(qz*qz) <= float64(rr*rr) {
					return si
				}
			}
		}
	}
	return -1
}

// SystemOpenings returns the openings of system si.
func (g *Graph) SystemOpenings(si int) []Opening {
	s := &g.Systems[si]
	return g.OpeningsList[s.FirstOpening : s.FirstOpening+s.Openings]
}
