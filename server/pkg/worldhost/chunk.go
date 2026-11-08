package worldhost

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Chunk geometry (worldgen/README.md "Chunk buffer"): 65 x 65 samples,
// 1 m apart at LOD 0, starting at (cx*64, cz*64).
const (
	ChunkSize    = 64
	ChunkSamples = 65
	// WorldChunks is the number of chunks per world edge (4096 m / 64 m).
	WorldChunks = 64
	// chunk_build accepts -64..127 (outside 0..63 is sea floor past the
	// coast); the fast path covers exactly that range.
	minChunk = -64
	maxChunk = 127
)

// Record is one 24-byte scatter / container / spawn-anchor record.
type Record struct {
	ID      uint64
	X, Y, Z float32
	Kind    uint8
	Variant uint8
	Extra   uint8 // scatter: scale byte; anchors: region danger x255
	Yaw     uint8 // fraction of a turn x256
}

// Chunk is the part of a LOD 0 chunk the server keeps: the height lattice
// (for collision), the water lattice (swimming, WP10) and the records (stable ids for world edits, loot
// containers and enemy spawn anchors; WP09/WP13 consume them). Splat
// planes are render data and are dropped. Immutable once built.
type Chunk struct {
	CX, CZ     int32
	Heights    []float32 // ChunkSamples^2, index j*65 + i
	Water      []float32 // ChunkSamples^2 water surface (draw/swim where water > ground)
	Scatter    []Record
	Containers []Record
	Spawns     []Record
}

// ParseChunk decodes a LOD 0 chunk buffer.
func ParseChunk(b []byte) (*Chunk, error) {
	if len(b) < 64 || string(b[:4]) != "LDCK" {
		return nil, errors.New("not a chunk (bad magic or short)")
	}
	le := binary.LittleEndian
	if lod := b[20]; lod != 0 {
		return nil, fmt.Errorf("chunk lod %d; the server keeps LOD 0 only", lod)
	}
	s := int(le.Uint16(b[22:]))
	if s != ChunkSamples {
		return nil, fmt.Errorf("chunk has %d samples per edge, want %d", s, ChunkSamples)
	}
	c := &Chunk{CX: int32(le.Uint32(b[12:])), CZ: int32(le.Uint32(b[16:]))}
	n := s * s
	floats := func(off uint32) ([]float32, error) {
		if int(off)+n*4 > len(b) {
			return nil, errors.New("chunk plane out of range")
		}
		out := make([]float32, n)
		for i := range out {
			out[i] = math.Float32frombits(le.Uint32(b[int(off)+i*4:]))
		}
		return out, nil
	}
	var err error
	if c.Heights, err = floats(le.Uint32(b[36:])); err != nil {
		return nil, err
	}
	if c.Water, err = floats(le.Uint32(b[40:])); err != nil {
		return nil, err
	}
	recOff := int(le.Uint32(b[52:]))
	ns, nc, nsp := int(le.Uint16(b[56:])), int(le.Uint16(b[58:])), int(le.Uint16(b[60:]))
	rs := int(le.Uint16(b[62:]))
	if ns+nc+nsp > 0 {
		if rs != 24 || recOff+(ns+nc+nsp)*rs > len(b) {
			return nil, errors.New("chunk records out of range")
		}
	}
	rec := func(k int) Record {
		o := recOff + k*rs
		return Record{
			ID: le.Uint64(b[o:]),
			X:  math.Float32frombits(le.Uint32(b[o+8:])), Y: math.Float32frombits(le.Uint32(b[o+12:])), Z: math.Float32frombits(le.Uint32(b[o+16:])),
			Kind: b[o+20], Variant: b[o+21], Extra: b[o+22], Yaw: b[o+23],
		}
	}
	list := func(from, count int) []Record {
		if count == 0 {
			return nil
		}
		out := make([]Record, count)
		for i := range out {
			out[i] = rec(from + i)
		}
		return out
	}
	c.Scatter = list(0, ns)
	c.Containers = list(ns, nc)
	c.Spawns = list(ns+nc, nsp)
	return c, nil
}

// Height evaluates the collision surface at (x, z) from this chunk's
// lattice. (x, z) must lie in the chunk's cell range: floor(x) in
// [cx*64, cx*64+63] (the +1 corner is sample 64, still inside the chunk).
func (c *Chunk) Height(x, z float64) float64 {
	x0, z0 := math.Floor(x), math.Floor(z)
	i := int(int64(x0) - int64(c.CX)*ChunkSize)
	j := int(int64(z0) - int64(c.CZ)*ChunkSize)
	return surfaceHeight(c.Heights, i, j, x-x0, z-z0)
}

// WaterHeight evaluates the water surface (wasm water_height, WP10) from
// this chunk's water lattice, with the same cell rule as Height.
func (c *Chunk) WaterHeight(x, z float64) float64 {
	x0, z0 := math.Floor(x), math.Floor(z)
	i := int(int64(x0) - int64(c.CX)*ChunkSize)
	j := int(int64(z0) - int64(c.CZ)*ChunkSize)
	return surfaceHeight(c.Water, i, j, x-x0, z-z0)
}

// surfaceHeight is the collision formula of worldgen/src/ground.rs
// (collision_height + tri_interp), evaluated on the f32 lattice a LOD 0
// chunk carries, in the same f64 operation order:
//
//	if fx + fz <= 1:  h00 + (h10 - h00) * fx + (h01 - h00) * fz
//	else:             h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
//
// Core wasm has no fused multiply-add, so every product is rounded before
// the add. Go's spec allows fusing x*y + z on some architectures (arm64,
// ppc64, s390x, riscv64, and amd64 with GOAMD64=v3); the explicit float64()
// conversions below forbid that fusion, which is what keeps this bitwise
// equal to the wasm on every GOARCH. Don't "simplify" them away.
func surfaceHeight(h []float32, i, j int, fx, fz float64) float64 {
	k := j*ChunkSamples + i
	h00 := float64(h[k])
	h10 := float64(h[k+1])
	h01 := float64(h[k+ChunkSamples])
	h11 := float64(h[k+ChunkSamples+1])
	if fx+fz <= 1 {
		return float64(h00+float64((h10-h00)*fx)) + float64((h01-h00)*fz)
	}
	return float64(h11+float64((h01-h11)*(1-fx))) + float64((h10-h11)*(1-fz))
}

// chunkOf returns the chunk holding the cell at floor(x), floor(z), and
// whether it is inside the range chunk_build serves.
func chunkOf(x, z float64) (cx, cz int32, ok bool) {
	// The comparisons also reject NaN.
	const lo, hi = float64(minChunk * ChunkSize), float64((maxChunk + 1) * ChunkSize)
	if !(x >= lo && x < hi && z >= lo && z < hi) {
		return 0, 0, false
	}
	// Arithmetic shift = floor division for negatives.
	return int32(int64(math.Floor(x)) >> 6), int32(int64(math.Floor(z)) >> 6), true
}
