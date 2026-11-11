// Package vertical is the Go host of the vertical world (genVersion 3,
// docs/cr/038-vertical-world.md): sky archipelagos, the Underground and the
// Depths. It reads the descriptor (worldgen `vertical_build`, LDVT) and layer
// tiles (`layer_tile`, LDLT), and is the line-for-line port of the TS
// collision core (worldgen/js/src/vertical.ts): the ground dispatch the
// movement step stands on, the push-outs, the updraft field. The golden
// table's vertical vectors pin both (TestGoldenVerticalQueries).
package vertical

import (
	"encoding/binary"
	"errors"
	"math"
)

// Layers.
const (
	LayerSurface = 0
	LayerSky     = 1
	LayerUnder   = 2
	LayerDepths  = 3
)

// LayerNames by layer.
var LayerNames = [4]string{"surface", "sky", "underground", "depths"}

// Surfaces of layer_height.
const (
	SurfUFloor    = 0
	SurfUCeil     = 1
	SurfUWater    = 2
	SurfDFloor    = 3
	SurfDCeil     = 4
	SurfDLava     = 5
	SurfSkyTop    = 6
	SurfSkyBottom = 7
)

// Kinds (worldgen/src/vertical/mod.rs).
const (
	IslandGrove  = 0
	IslandMeadow = 1
	IslandCrag   = 2
	IslandTown   = 3
	IslandPalace = 4
	IslandRuin   = 5

	ChamberCrystal = 0
	ChamberCenote  = 1
	ChamberRiver   = 2
	ChamberFungal  = 3
	ChamberInferno = 4
	ChamberAshen   = 5

	UpdraftColumn  = 0
	UpdraftLift    = 1
	UpdraftCurrent = 2
	UpdraftGeyser  = 3

	OpeningTunnel = 0
	OpeningCenote = 1
	OpeningGate   = 2
)

// None16 is the "no index" value of u16 fields.
const None16 = 0xFFFF

// OpenC is the ceiling inside an opening; NoWater is "no water".
const (
	OpenC   = 10000.0
	NoWater = -10000.0
)

type Arch struct {
	ID                    uint64
	X, Z, R, Base, CloudY float64
	Site, FirstIsland, N  int
	Town                  int
}

type Island struct {
	Index                                  int
	ID                                     uint64
	X, Z, R, Reach, Top, Thick, Cliff, Amp float64
	Kind, Biome                            int
	Arch, Site                             int
	Seed                                   uint32
	Lobes                                  [][3]float64
}

type Updraft struct {
	X, Z, R, Bottom, Top, Lift float64
	Kind, Arch                 int
}

type Chamber struct {
	Index                                                            int
	ID                                                               uint64
	X, Z, Rx, Rz, C, S, Floor, Height, Lake, LakeE, LakeDepth, Reach float64
	Layer, Kind, Tint                                                int
	Seed                                                             uint32
	Site                                                             int
}

type Corridor struct {
	Layer, Kind       int
	Lava              bool
	From, To          int
	Hw, Height, Water float64
	Pts               [][3]float64
}

// Opening uses the cave mouth mask rule (x, z, r).
type Opening struct {
	X, Z, R, Y        float64
	Into, Kind        int
	Yaw, Site, Target int
}

type Shaft struct {
	X, Z, R, Bottom, Top float64
	Chamber              int
}

type Column struct {
	X, Z, R, Y0, Y1 float64
	Layer, Chamber  int
}

type Deco struct {
	X, Y, Z, Size            float64
	Kind, Tint, Layer, Flags int
	Yaw, Aux                 int
}

// Vein is a mineable vein (the cave vein record format).
type Vein struct {
	ID                                uint64
	X, Y, Z                           float64
	N                                 [3]float64
	Kind, Material, Element, HP, Size int
	Flags, Band, Chamber              int
}

// World is a parsed descriptor.
type World struct {
	GenVersion int
	BaseSites  int
	Archs      []Arch
	Islands    []Island
	Updrafts   []Updraft
	Chambers   []Chamber
	Corridors  []Corridor
	Openings   []Opening
	// SurfaceOpenings are tunnel mouths and cenote tops (holes in the
	// terrain into the Underground); GateOpenings are Depths gates (holes in
	// the Underground floor).
	SurfaceOpenings []Opening
	GateOpenings    []Opening
	Shafts          []Shaft
	Columns         []Column
	Decos           []Deco
	Veins           []Vein
	// Domain per layer (index 0 sky, 1 Underground, 2 Depths): 64 x 64 chunk bits.
	Domain [3][]byte
}

// Parse reads a descriptor (LDVT format 1).
func Parse(b []byte) (*World, error) {
	if len(b) < 128 || string(b[0:4]) != "LDVT" {
		return nil, errors.New("vertical: not a descriptor")
	}
	le := binary.LittleEndian
	n := func(k int) int { return int(le.Uint32(b[12+k*4:])) }
	off := func(k int) int { return int(le.Uint32(b[56+k*4:])) }
	f := func(o int) float64 { return float64(math.Float32frombits(le.Uint32(b[o:]))) }
	u16 := func(o int) int { return int(le.Uint16(b[o:])) }
	w := &World{GenVersion: int(le.Uint16(b[6:])), BaseSites: int(le.Uint32(b[104:]))}
	for i := 0; i < n(0); i++ {
		r := off(0) + i*40
		w.Archs = append(w.Archs, Arch{ID: le.Uint64(b[r:]), X: f(r + 8), Z: f(r + 12), R: f(r + 16), Base: f(r + 20), CloudY: f(r + 24),
			Site: u16(r + 28), FirstIsland: u16(r + 30), N: u16(r + 32), Town: u16(r + 34)})
	}
	for i := 0; i < n(1); i++ {
		r := off(1) + i*104
		is := Island{Index: i, ID: le.Uint64(b[r:]), X: f(r + 8), Z: f(r + 12), R: f(r + 16), Reach: f(r + 20), Top: f(r + 24), Thick: f(r + 28),
			Cliff: f(r + 32), Amp: f(r + 36), Kind: int(b[r+40]), Arch: u16(r + 42), Site: u16(r + 44), Biome: int(b[r+46]), Seed: le.Uint32(b[r+48:])}
		for k := 0; k < int(b[r+41]); k++ {
			is.Lobes = append(is.Lobes, [3]float64{f(r + 52 + k*12), f(r + 56 + k*12), f(r + 60 + k*12)})
		}
		w.Islands = append(w.Islands, is)
	}
	for i := 0; i < n(2); i++ {
		r := off(2) + i*32
		w.Updrafts = append(w.Updrafts, Updraft{X: f(r), Z: f(r + 4), R: f(r + 8), Bottom: f(r + 12), Top: f(r + 16), Lift: f(r + 20), Kind: int(b[r+24]), Arch: u16(r + 26)})
	}
	for i := 0; i < n(3); i++ {
		r := off(3) + i*72
		w.Chambers = append(w.Chambers, Chamber{Index: i, ID: le.Uint64(b[r:]), X: f(r + 8), Z: f(r + 12), Rx: f(r + 16), Rz: f(r + 20), C: f(r + 24), S: f(r + 28),
			Floor: f(r + 32), Height: f(r + 36), Lake: f(r + 40), LakeE: f(r + 44), LakeDepth: f(r + 48), Reach: f(r + 52),
			Layer: int(b[r+56]), Kind: int(b[r+57]), Tint: int(b[r+58]), Seed: le.Uint32(b[r+60:]), Site: u16(r + 64)})
	}
	ptsOff := off(5)
	for i := 0; i < n(4); i++ {
		r := off(4) + i*32
		first := int(le.Uint32(b[r+20:]))
		count := int(le.Uint32(b[r+24:]))
		c := Corridor{Layer: int(b[r]), Kind: int(b[r+1]), Lava: b[r+2] != 0, From: u16(r + 4), To: u16(r + 6), Hw: f(r + 8), Height: f(r + 12), Water: f(r + 16)}
		for k := 0; k < count; k++ {
			o := ptsOff + (first+k)*12
			c.Pts = append(c.Pts, [3]float64{f(o), f(o + 4), f(o + 8)})
		}
		w.Corridors = append(w.Corridors, c)
	}
	for i := 0; i < n(6); i++ {
		r := off(6) + i*32
		o := Opening{X: f(r), Z: f(r + 4), R: f(r + 8), Y: f(r + 12), Into: int(b[r+16]), Kind: int(b[r+17]), Yaw: u16(r + 18), Site: u16(r + 20), Target: u16(r + 22)}
		w.Openings = append(w.Openings, o)
		if o.Into == LayerUnder {
			w.SurfaceOpenings = append(w.SurfaceOpenings, o)
		} else if o.Into == LayerDepths {
			w.GateOpenings = append(w.GateOpenings, o)
		}
	}
	for i := 0; i < n(7); i++ {
		r := off(7) + i*32
		w.Shafts = append(w.Shafts, Shaft{X: f(r), Z: f(r + 4), R: f(r + 8), Bottom: f(r + 12), Top: f(r + 16), Chamber: u16(r + 20)})
	}
	for i := 0; i < n(8); i++ {
		r := off(8) + i*32
		w.Columns = append(w.Columns, Column{X: f(r), Z: f(r + 4), R: f(r + 8), Y0: f(r + 12), Y1: f(r + 16), Layer: int(b[r+20]), Chamber: u16(r + 22)})
	}
	for i := 0; i < n(9); i++ {
		r := off(9) + i*24
		w.Decos = append(w.Decos, Deco{X: f(r), Y: f(r + 4), Z: f(r + 8), Size: f(r + 12), Kind: int(b[r+16]), Tint: int(b[r+17]), Layer: int(b[r+18]), Flags: int(b[r+19]), Yaw: u16(r + 20), Aux: u16(r + 22)})
	}
	for i := 0; i < n(10); i++ {
		r := off(10) + i*32
		w.Veins = append(w.Veins, Vein{ID: le.Uint64(b[r:]), X: f(r + 8), Y: f(r + 12), Z: f(r + 16),
			N:    [3]float64{float64(int8(b[r+20])) / 127, float64(int8(b[r+21])) / 127, float64(int8(b[r+22])) / 127},
			Kind: int(b[r+23]), Material: int(b[r+24]), Element: int(b[r+25]), HP: u16(r + 26), Size: int(b[r+28]), Flags: int(b[r+29]), Band: int(b[r+30]), Chamber: int(b[r+31])})
	}
	dom := int(le.Uint32(b[100:]))
	if dom+3*512 > len(b) {
		return nil, errors.New("vertical: descriptor truncated")
	}
	for k := 0; k < 3; k++ {
		w.Domain[k] = append([]byte(nil), b[dom+k*512:dom+(k+1)*512]...)
	}
	return w, nil
}

// InDomain: is chunk (floor(x/64), floor(z/64)) in layer's (1..3) domain?
func (w *World) InDomain(layer int, x, z float64) bool {
	cx := int(math.Floor(x / 64))
	cz := int(math.Floor(z / 64))
	if cx < 0 || cz < 0 || cx > 63 || cz > 63 || layer < 1 || layer > 3 {
		return false
	}
	k := cz*64 + cx
	return w.Domain[layer-1][k>>3]&(1<<(k&7)) != 0
}

// TileS is the tile lattice size.
const TileS = 65

// Tile is a parsed layer tile (LDLT format 1).
type Tile struct {
	Layer, Lod, Cx, Cz int
	Step               float64
	Flags              uint32
	A, B, W            []float32
}

// ParseTile reads a layer tile.
func ParseTile(b []byte) (*Tile, error) {
	if len(b) < 64 || string(b[0:4]) != "LDLT" {
		return nil, errors.New("vertical: not a layer tile")
	}
	le := binary.LittleEndian
	t := &Tile{Layer: int(b[12]), Lod: int(b[13]), Cx: int(int32(le.Uint32(b[16:]))), Cz: int(int32(le.Uint32(b[20:]))),
		Step: float64(math.Float32frombits(le.Uint32(b[24:]))), Flags: le.Uint32(b[28:])}
	arr := func(o int) []float32 {
		out := make([]float32, TileS*TileS)
		for k := range out {
			out[k] = math.Float32frombits(le.Uint32(b[o+k*4:]))
		}
		return out
	}
	if int(le.Uint32(b[56:]))+TileS*TileS*4 > len(b) {
		return nil, errors.New("vertical: tile truncated")
	}
	t.A = arr(int(le.Uint32(b[48:])))
	t.B = arr(int(le.Uint32(b[52:])))
	t.W = arr(int(le.Uint32(b[56:])))
	return t, nil
}
