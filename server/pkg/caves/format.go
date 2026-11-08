// Package caves reads worldgen's cave buffers (cave graph, cave cells) and
// answers the cave queries movement and the zone need: the floor under a
// point, wall/ceiling push-out, mouth masks and the cave-system id (WP09,
// spec 7). Pure Go, no wasm: server/pkg/worldhost builds the buffers.
//
// The queries are a line-for-line port of worldgen/js/src/cave.ts (the
// browser's prediction runs that) and must agree with it to the bit: f64
// arithmetic in the same order, f32 buffer values widened exactly, and every
// product that Go could fuse into an FMA (arm64, ppc64, s390x; amd64 does
// not) wrapped in an explicit float64() so it rounds separately, as core
// wasm and JavaScript always do. The golden table's cave floor/collide
// vectors are replayed here (TestGoldenCaveQueries).
package caves

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Buffer geometry (worldgen/README.md "Caves").
const (
	CellW       = 64.0
	CellH       = 32.0
	SamplesXZ   = 33
	SamplesY    = 17
	Bins        = 34
	CYMin       = -8
	CYMax       = 23
	EditRecord  = 32
	veinRec     = 32
	decoRec     = 16
	cellFormat  = 1
	graphFormat = 1
)

// Vein kinds and flags (README "Vein record").
const (
	KindOre    = 0
	KindGem    = 1
	VeinSunlit = 1
	VeinMined  = 2
)

// OreNames and GemNames index Vein.Material by kind.
var (
	OreNames = [...]string{"copper", "iron", "silver", "sunsteel", "starmetal", "voidglass"}
	GemNames = [...]string{"ruby", "sapphire", "topaz", "emerald", "aquamarine", "sunstone", "onyx", "amethyst", "opal", "moonstone"}
)

// Vein is one ore vein or gem cluster on a chamber wall.
type Vein struct {
	ID         uint64
	X, Y, Z    float64
	NX, NY, NZ float64 // out of the wall, i8/127
	Kind       uint8
	Material   uint8
	Element    uint8
	HP         uint16
	Size       uint8
	Flags      uint8
	Band       uint8
	Chamber    uint8
}

// MaterialName is "iron", "ruby", ...
func (v Vein) MaterialName() string {
	if v.Kind == KindGem {
		if int(v.Material) < len(GemNames) {
			return GemNames[v.Material]
		}
		return "gem"
	}
	if int(v.Material) < len(OreNames) {
		return OreNames[v.Material]
	}
	return "ore"
}

// Deco is a glowing fungus, crystal or stalagmite (render only).
type Deco struct {
	X, Y, Z                   float64
	Kind, Variant, Scale, Yaw uint8
}

// Cell is a parsed cave cell. Positions are widened from f32 exactly.
type Cell struct {
	CX, CY, CZ    int32
	OX, OY, OZ    float64
	Flags         uint32
	Pos           []float64 // 3 per vertex
	Idx           []uint16  // 3 per triangle
	ColOff        []uint32  // Bins*Bins+1
	ColTris       []uint32
	Veins         []Vein
	Decos         []Deco
	System        int // -1 none
	Band          uint8
	MinY, MaxY    float64
	TriangleCount int
	Bytes         []byte
}

func readVein(b []byte, o int) Vein {
	le := binary.LittleEndian
	f := func(k int) float64 { return float64(math.Float32frombits(le.Uint32(b[o+k:]))) }
	return Vein{
		ID: le.Uint64(b[o:]), X: f(8), Y: f(12), Z: f(16),
		NX: float64(int8(b[o+20])) / 127, NY: float64(int8(b[o+21])) / 127, NZ: float64(int8(b[o+22])) / 127,
		Kind: b[o+23], Material: b[o+24], Element: b[o+25], HP: le.Uint16(b[o+26:]),
		Size: b[o+28], Flags: b[o+29], Band: b[o+30], Chamber: b[o+31],
	}
}

// ParseCell decodes a cave cell buffer (it keeps a reference to b).
func ParseCell(b []byte) (*Cell, error) {
	if len(b) < 96 || string(b[:4]) != "LDCV" {
		return nil, errors.New("not a cave cell (bad magic or short)")
	}
	le := binary.LittleEndian
	if v := le.Uint16(b[4:]); v != cellFormat {
		return nil, fmt.Errorf("cave cell format %d", v)
	}
	c := &Cell{CX: int32(le.Uint32(b[12:])), CY: int32(le.Uint32(b[16:])), CZ: int32(le.Uint32(b[20:])), Flags: le.Uint32(b[24:]), Bytes: b}
	c.OX, c.OY, c.OZ = float64(c.CX)*CellW, float64(c.CY)*CellH, float64(c.CZ)*CellW
	nv := int(le.Uint32(b[28:]))
	nt := int(le.Uint32(b[32:]))
	posOff, idxOff := int(le.Uint32(b[40:])), int(le.Uint32(b[48:]))
	colOff, colLen := int(le.Uint32(b[52:])), int(le.Uint32(b[56:]))
	veinOff, nVein := int(le.Uint32(b[60:])), int(le.Uint16(b[64:]))
	nDeco, decoOff := int(le.Uint16(b[66:])), int(le.Uint32(b[68:]))
	if posOff+nv*12 > len(b) || idxOff+nt*6 > len(b) || colOff+colLen > len(b) || veinOff+nVein*veinRec > len(b) || decoOff+nDeco*decoRec > len(b) {
		return nil, errors.New("cave cell section out of range")
	}
	c.Pos = make([]float64, nv*3)
	for i := range c.Pos {
		c.Pos[i] = float64(math.Float32frombits(le.Uint32(b[posOff+i*4:])))
	}
	c.Idx = make([]uint16, nt*3)
	for i := range c.Idx {
		c.Idx[i] = le.Uint16(b[idxOff+i*2:])
	}
	nOff := Bins*Bins + 1
	c.ColOff = make([]uint32, nOff)
	for i := range c.ColOff {
		c.ColOff[i] = le.Uint32(b[colOff+i*4:])
	}
	c.ColTris = make([]uint32, (colLen-nOff*4)/4)
	for i := range c.ColTris {
		c.ColTris[i] = le.Uint32(b[colOff+nOff*4+i*4:])
	}
	for k := 0; k < nVein; k++ {
		c.Veins = append(c.Veins, readVein(b, veinOff+k*veinRec))
	}
	for k := 0; k < nDeco; k++ {
		o := decoOff + k*decoRec
		f := func(q int) float64 { return float64(math.Float32frombits(le.Uint32(b[o+q:]))) }
		c.Decos = append(c.Decos, Deco{X: f(0), Y: f(4), Z: f(8), Kind: b[o+12], Variant: b[o+13], Scale: b[o+14], Yaw: b[o+15]})
	}
	c.System = int(le.Uint16(b[72:]))
	if c.System == 0xFFFF {
		c.System = -1
	}
	c.Band = b[74]
	c.MinY = float64(math.Float32frombits(le.Uint32(b[76:])))
	c.MaxY = float64(math.Float32frombits(le.Uint32(b[80:])))
	c.TriangleCount = nt
	return c, nil
}

// Key packs a cell id for maps.
func Key(cx, cy, cz int32) uint32 {
	return (uint32(cy-CYMin)*64+uint32(cz))*64 + uint32(cx)
}

// Unkey inverts Key.
func Unkey(k uint32) (cx, cy, cz int32) {
	return int32(k % 64), int32(k/4096) + CYMin, int32((k / 64) % 64)
}

// ValidCell reports whether (cx, cy, cz) is inside the cave volume.
func ValidCell(cx, cy, cz int32) bool {
	return cx >= 0 && cx < 64 && cz >= 0 && cz < 64 && cy >= CYMin && cy <= CYMax
}

// CellOf returns the cell containing a point.
func CellOf(x, y, z float64) (int32, int32, int32) {
	return int32(math.Floor(x / CellW)), int32(math.Floor(y / CellH)), int32(math.Floor(z / CellW))
}

// Edit is a carve + mined vein, as cave_build_edited takes it.
type Edit struct {
	VeinID     uint64
	X, Y, Z, R float32
}

// EncodeEdits packs edits into 32-byte records.
func EncodeEdits(edits []Edit) []byte {
	b := make([]byte, len(edits)*EditRecord)
	le := binary.LittleEndian
	for i, e := range edits {
		o := i * EditRecord
		le.PutUint64(b[o:], e.VeinID)
		le.PutUint32(b[o+8:], math.Float32bits(e.X))
		le.PutUint32(b[o+12:], math.Float32bits(e.Y))
		le.PutUint32(b[o+16:], math.Float32bits(e.Z))
		le.PutUint32(b[o+20:], math.Float32bits(e.R))
	}
	return b
}

// Touches reports whether the edit's carve sphere reaches cell (cx, cy, cz)
// including the 2 m padding layer the cell samples on its low sides.
func (e Edit) Touches(cx, cy, cz int32) bool {
	ox, oy, oz := float64(cx)*CellW, float64(cy)*CellH, float64(cz)*CellW
	x, y, z, r := float64(e.X), float64(e.Y), float64(e.Z), float64(e.R)
	return x+r >= ox-2 && x-r <= ox+CellW && y+r >= oy-2 && y-r <= oy+CellH && z+r >= oz-2 && z-r <= oz+CellW
}
