package worldedit

import (
	"encoding/binary"
	"errors"
	"sync"
	"sync/atomic"
)

// The terrain edit overlay (CR 040): a signed height delta per lattice
// vertex, in steps of StepM, on top of the generated 1 m lattice. Generated
// heights never change (the goldens stay green); every host adds the delta
// to the f32 lattice value before the collision interpolation:
//
//	h' = f32(f64(h) + f64(d) * 0.25)
//
// 0.25 is a power of two, so the f64 sum is exact for any f32 within +-2^21
// m and the f32 rounding is the same in Go, TS (Math.fround) and Rust: the
// edited surface is bitwise identical in every host. The interpolation is
// the collision formula of worldgen/README.md "Collision" (Surface below).
//
// Storage: one 64 x 64 block of int8 per chunk, owning the vertices
// [cx*64, cx*64+63] x [cz*64, cz*64+63] (the +1 edge belongs to the next
// chunk). Blocks are immutable once published (copy on write), read without
// locks from the tick's workers like worldhost.Terrain's chunk index.
const (
	StepM = 0.25
	// MaxDelta bounds an edit: +-6 m from the generated ground.
	MaxDelta = 24
	// BlockSize vertices per block edge; WorldBlocks blocks per world edge.
	BlockSize   = 64
	WorldBlocks = 64
	// MaxBlocks bounds storage per zone (4 KB each in memory, sparse on the wire).
	MaxBlocks = 640
)

type block struct {
	d [BlockSize * BlockSize]int8
	n int32 // non-zero count
}

// Change sets the absolute delta (in steps) of one vertex.
type Change struct {
	X, Z int32
	D    int8
}

// Overlay is the set of terrain edits of one world.
type Overlay struct {
	mu     sync.Mutex // writers
	blocks [WorldBlocks * WorldBlocks]atomic.Pointer[block]
	live   atomic.Int32 // blocks with at least one edit
	verts  atomic.Int64 // edited vertices
	gen    atomic.Uint64
}

// New returns an empty overlay.
func New() *Overlay { return &Overlay{} }

func idx(bx, bz int32) int { return int(bz)*WorldBlocks + int(bx) }

func inWorld(bx, bz int32) bool { return bx >= 0 && bz >= 0 && bx < WorldBlocks && bz < WorldBlocks }

// Any reports whether any edit exists (the zero-cost fast path of every query).
func (o *Overlay) Any() bool { return o != nil && o.live.Load() > 0 }

// Blocks is the number of chunks holding edits; Vertices the edited vertices.
func (o *Overlay) Blocks() int     { return int(o.live.Load()) }
func (o *Overlay) Vertices() int64 { return o.verts.Load() }

// Gen increases with every applied change.
func (o *Overlay) Gen() uint64 { return o.gen.Load() }

// Delta is the vertex's delta in steps (0 outside the world or unedited).
func (o *Overlay) Delta(vx, vz int32) int8 {
	bx, bz := vx>>6, vz>>6
	if !inWorld(bx, bz) {
		return 0
	}
	b := o.blocks[idx(bx, bz)].Load()
	if b == nil {
		return 0
	}
	return b.d[(vz&63)*BlockSize+(vx&63)]
}

// Cell returns the four corner deltas of the cell with lower corner (x0, z0):
// (x0,z0), (x0+1,z0), (x0,z0+1), (x0+1,z0+1), and whether any is non-zero.
func (o *Overlay) Cell(x0, z0 int32) (d00, d10, d01, d11 int8, edited bool) {
	if o.live.Load() == 0 {
		return
	}
	d00, d10, d01, d11 = o.Delta(x0, z0), o.Delta(x0+1, z0), o.Delta(x0, z0+1), o.Delta(x0+1, z0+1)
	return d00, d10, d01, d11, d00|d10|d01|d11 != 0
}

// Lift is an edited lattice value: the generated f32 plus the delta.
func Lift(h float32, d int8) float32 { return float32(float64(h) + float64(d)*StepM) }

// Surface is the collision interpolation over one cell's four corner heights
// (worldgen/README.md "Collision", the same f64 operation order as
// worldhost's surfaceHeight and the wasm tri_interp). The explicit float64
// conversions forbid fused multiply-add, which would break bit equality on
// some architectures.
func Surface(h00, h10, h01, h11 float32, fx, fz float64) float64 {
	a, b, c, e := float64(h00), float64(h10), float64(h01), float64(h11)
	if fx+fz <= 1 {
		return float64(a+float64((b-a)*fx)) + float64((c-a)*fz)
	}
	return float64(e+float64((c-e)*(1-fx))) + float64((b-e)*(1-fz))
}

// ErrFull: the zone's edit storage is full.
var ErrFull = errors.New("worldedit: edit storage is full")

// Apply sets the given vertices (absolute deltas, clamped to +-MaxDelta) and
// returns the chunks that changed. Vertices outside the world are ignored.
// It refuses (nothing applied) when the change would need more than MaxBlocks
// blocks.
func (o *Overlay) Apply(changes []Change) ([][2]int32, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	type work struct {
		old *block
		nb  *block
	}
	touched := map[int32]*work{}
	var order [][2]int32
	newBlocks := 0
	for _, c := range changes {
		bx, bz := c.X>>6, c.Z>>6
		if !inWorld(bx, bz) {
			continue
		}
		k := int32(idx(bx, bz))
		w := touched[k]
		if w == nil {
			old := o.blocks[k].Load()
			nb := &block{}
			if old != nil {
				*nb = *old
			} else {
				newBlocks++
			}
			w = &work{old, nb}
			touched[k] = w
			order = append(order, [2]int32{bx, bz})
		}
		d := c.D
		if d > MaxDelta {
			d = MaxDelta
		} else if d < -MaxDelta {
			d = -MaxDelta
		}
		i := (c.Z&63)*BlockSize + (c.X & 63)
		if w.nb.d[i] == 0 && d != 0 {
			w.nb.n++
		} else if w.nb.d[i] != 0 && d == 0 {
			w.nb.n--
		}
		w.nb.d[i] = d
	}
	if int(o.live.Load())+newBlocks > MaxBlocks {
		return nil, ErrFull
	}
	for k, w := range touched {
		var oldN int32
		if w.old != nil {
			oldN = w.old.n
		}
		o.verts.Add(int64(w.nb.n - oldN))
		switch {
		case w.nb.n == 0:
			if w.old != nil {
				o.blocks[k].Store(nil)
				o.live.Add(-1)
			}
		default:
			if w.old == nil {
				o.live.Add(1)
			}
			o.blocks[k].Store(w.nb)
		}
	}
	o.gen.Add(1)
	return order, nil
}

// Entry is one non-zero vertex of a block on the wire and in the database.
// The wire format of a chunk's edits (message TerrainEdits, the database
// column) is a list of: u16 local index (z*64 + x), i8 delta, for the
// vertices that are set; an update lists vertices with their NEW delta (0
// clears one). The Go and TS codecs are twins (client/src/world/edits/codec.ts).
type Entry struct {
	I uint16
	D int8
}

// BlockEntries lists the non-zero vertices of chunk (cx, cz).
func (o *Overlay) BlockEntries(cx, cz int32) []Entry {
	if !inWorld(cx, cz) {
		return nil
	}
	b := o.blocks[idx(cx, cz)].Load()
	if b == nil {
		return nil
	}
	out := make([]Entry, 0, b.n)
	for i, d := range b.d {
		if d != 0 {
			out = append(out, Entry{uint16(i), d})
		}
	}
	return out
}

// EncodeEntries packs entries as 3 bytes each.
func EncodeEntries(es []Entry) []byte {
	out := make([]byte, 0, len(es)*3)
	for _, e := range es {
		out = binary.LittleEndian.AppendUint16(out, e.I)
		out = append(out, byte(e.D))
	}
	return out
}

// DecodeEntries unpacks EncodeEntries; bad lengths or indexes are errors.
func DecodeEntries(b []byte) ([]Entry, error) {
	if len(b)%3 != 0 {
		return nil, errors.New("worldedit: entries not a multiple of 3 bytes")
	}
	out := make([]Entry, len(b)/3)
	for i := range out {
		idx := binary.LittleEndian.Uint16(b[i*3:])
		if idx >= BlockSize*BlockSize {
			return nil, errors.New("worldedit: entry index out of range")
		}
		out[i] = Entry{idx, int8(b[i*3+2])}
	}
	return out, nil
}

// SetBlock replaces chunk (cx, cz)'s edits with the entries (a restore from
// the database). Entries beyond +-MaxDelta are clamped.
func (o *Overlay) SetBlock(cx, cz int32, es []Entry) error {
	if !inWorld(cx, cz) {
		return errors.New("worldedit: chunk outside the world")
	}
	changes := make([]Change, 0, len(es))
	cur := o.BlockEntries(cx, cz)
	seen := map[uint16]bool{}
	for _, e := range es {
		seen[e.I] = true
		changes = append(changes, Change{X: cx*BlockSize + int32(e.I&63), Z: cz*BlockSize + int32(e.I>>6), D: e.D})
	}
	for _, e := range cur {
		if !seen[e.I] {
			changes = append(changes, Change{X: cx*BlockSize + int32(e.I&63), Z: cz*BlockSize + int32(e.I>>6), D: 0})
		}
	}
	_, err := o.Apply(changes)
	return err
}

// ChunksWithEdits lists every chunk holding edits.
func (o *Overlay) ChunksWithEdits() [][2]int32 {
	var out [][2]int32
	for bz := int32(0); bz < WorldBlocks; bz++ {
		for bx := int32(0); bx < WorldBlocks; bx++ {
			if o.blocks[idx(bx, bz)].Load() != nil {
				out = append(out, [2]int32{bx, bz})
			}
		}
	}
	return out
}

// LiftedF64 is the f32 height of an edited vertex as a float64 (tests, golden).
func LiftedF64(h float32, d int8) float64 { return float64(Lift(h, d)) }
