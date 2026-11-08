// Package structures is the deterministic structure overlay on the ground
// query (WP12): solid things that stand on the terrain (towers now, WP20's
// buildings later) expressed as extra height functions, so the movement code
// that already walks, snaps to and (WP10) climbs the terrain heightfield
// walks, snaps to and climbs them too, with no change to the generator.
//
// The combined ground is
//
//	height(x, z) = max(terrain(x, z), max over structures s covering (x, z) of s.top(x, z))
//
// A structure is therefore a solid from its top surface down to the ground:
// no overhangs, interiors or tunnels (those need real collision volumes; see
// README "Limits"). Its walls are just steep parts of the height function,
// which is exactly what makes them climbable: WP10 climbs any surface between
// 50 and 89 degrees, and a tower wall is 80 degrees.
//
// Determinism: the client (TS, client/src/world/structures/overlay.ts) and
// the zone (this package) must return the same bits at every point, or
// prediction and server validation disagree on a tower wall. Both use only
// IEEE-exact operations (+, -, *, /, sqrt, comparisons) in the same order;
// Go may fuse a*b+c into one FMA on some CPUs, which rounds differently, so
// every product feeding a sum is wrapped in an explicit float64() conversion
// (the Go spec guarantees that conversion rounds, preventing fusion).
// testdata/golden.json pins the results; the TS test replays it bit for bit.
package structures

import (
	"math"

	"lodestone/server/pkg/movement"
)

// Structure is one solid on the terrain. Implementations must be pure
// functions of their construction parameters (no clocks, no randomness, no
// host math beyond sqrt) and must have a TS twin in
// client/src/world/structures/ that the golden test replays.
type Structure interface {
	// Bounds is the horizontal box outside which Top never reports ok.
	Bounds() (minX, minZ, maxX, maxZ float64)
	// Top returns the structure's top surface height at (x, z), ok=false
	// where the structure does not cover the point.
	Top(x, z float64) (h float64, ok bool)
	// Normal is the unit surface normal at (x, z); only called where Top is
	// ok.
	Normal(x, z float64) movement.Vec3
}

// cellSize of the lookup grid: 64 m (one chunk). A tower is ~25 m across, so
// a point checks at most a handful of structures.
const cellSize = 64

// Overlay indexes structures by grid cell. Build it once (Add), then query
// from any goroutine: queries never write.
type Overlay struct {
	items []Structure
	cells map[[2]int32][]int32
}

// NewOverlay returns an empty overlay.
func NewOverlay() *Overlay { return &Overlay{cells: map[[2]int32][]int32{}} }

// Add registers a structure and returns its index (the order of Add calls
// is part of the deterministic setup only for ids; the height max is
// order-independent).
func (o *Overlay) Add(s Structure) int {
	idx := int32(len(o.items))
	o.items = append(o.items, s)
	x0, z0, x1, z1 := s.Bounds()
	for cz := cellOf(z0); cz <= cellOf(z1); cz++ {
		for cx := cellOf(x0); cx <= cellOf(x1); cx++ {
			k := [2]int32{cx, cz}
			o.cells[k] = append(o.cells[k], idx)
		}
	}
	return int(idx)
}

// Len is the number of structures.
func (o *Overlay) Len() int { return len(o.items) }

// At returns structure i.
func (o *Overlay) At(i int) Structure { return o.items[i] }

func cellOf(v float64) int32 { return int32(math.Floor(v / cellSize)) }

// Top returns the highest structure surface covering (x, z) and its index,
// or ok=false where no structure covers the point.
func (o *Overlay) Top(x, z float64) (h float64, idx int, ok bool) {
	if o == nil || len(o.items) == 0 || math.IsNaN(x) || math.IsNaN(z) {
		return 0, -1, false
	}
	idx = -1
	for _, i := range o.cells[[2]int32{cellOf(x), cellOf(z)}] {
		if t, in := o.items[i].Top(x, z); in && (idx < 0 || t > h) {
			h, idx, ok = t, int(i), true
		}
	}
	return h, idx, ok
}

// Ground is a movement.Ground with the overlay on top of a base ground.
type Ground struct {
	Base    movement.Ground
	Overlay *Overlay
}

// Wrap returns base with o on top.
func Wrap(base movement.Ground, o *Overlay) *Ground { return &Ground{Base: base, Overlay: o} }

// HeightAt implements movement.Ground.
func (g *Ground) HeightAt(x, z float64) float64 {
	b := g.Base.HeightAt(x, z)
	if h, _, ok := g.Overlay.Top(x, z); ok && h > b {
		return h
	}
	return b
}

// WaterAt implements movement.Water (WP10) with the base ground's water:
// structures stand on land, and where a structure top is above the water
// the swim depth test fails by itself. Without a water-aware base there is
// no water. TS twin: StructureGround.waterAt.
func (g *Ground) WaterAt(x, z float64) float64 {
	return movement.WaterAt(g.Base, x, z)
}

// StructureAt reports which structure forms the ground at (x, z) (-1: the
// terrain does). Exploration uses it ("standing on tower 3").
func (g *Ground) StructureAt(x, z float64) int {
	h, i, ok := g.Overlay.Top(x, z)
	if !ok || !(h > g.Base.HeightAt(x, z)) {
		return -1
	}
	return i
}

// Normaler is a ground that knows its surface normal (worldhost's
// ground_normal); optional, used for the terrain part of NormalAt.
type Normaler interface {
	NormalAt(x, z float64) movement.Vec3
}

// NormalAt is the unit normal of the combined surface: the structure's where
// a structure forms the ground, else the base's (or straight up when the
// base can't say).
func (g *Ground) NormalAt(x, z float64) movement.Vec3 {
	if i := g.StructureAt(x, z); i >= 0 {
		return g.Overlay.items[i].Normal(x, z)
	}
	if n, ok := g.Base.(Normaler); ok {
		return n.NormalAt(x, z)
	}
	return movement.Vec3{Y: 1}
}
