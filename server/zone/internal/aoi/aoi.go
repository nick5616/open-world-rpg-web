// Package aoi is the zone's interest management (spec 9): a 32 m cell grid
// over the world and the distance rings that decide what each client hears
// about and how often.
//
// The grid is rebuilt from scratch every tick instead of being updated
// incrementally. With hundreds to a few thousand entities that costs a few
// microseconds, and it removes a whole class of bugs (entities left in stale
// cells after teleports, zone transfers or despawns).
package aoi

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// Grid buckets entity indices by 32 m cell. Positions outside the world are
// clamped into the edge cells (they are still found by queries).
type Grid struct {
	cellM float64
	n     int       // cells per side
	cells [][]int32 // entity indices per cell
	used  []int32   // cells that are non-empty this tick
}

// New makes a grid covering [0, worldM) on x and z.
func New(worldM, cellM float64) *Grid {
	n := int(math.Ceil(worldM / cellM))
	return &Grid{cellM: cellM, n: n, cells: make([][]int32, n*n)}
}

// NewWorld makes the grid for the v1 world (WORLD_SIZE_M, AOI_CELL_M).
func NewWorld() *Grid { return New(constants.WorldSizeM, constants.AoiCellM) }

func (g *Grid) cellOf(v float64) int {
	c := int(math.Floor(v / g.cellM))
	if c < 0 {
		return 0
	}
	if c >= g.n {
		return g.n - 1
	}
	return c
}

// Reset empties the grid, keeping cell capacity.
func (g *Grid) Reset() {
	for _, c := range g.used {
		g.cells[c] = g.cells[c][:0]
	}
	g.used = g.used[:0]
}

// Insert adds entity index idx at (x, z).
func (g *Grid) Insert(idx int32, x, z float64) {
	c := int32(g.cellOf(z)*g.n + g.cellOf(x))
	if len(g.cells[c]) == 0 {
		g.used = append(g.used, c)
	}
	g.cells[c] = append(g.cells[c], idx)
}

// Query calls fn for every entity in a cell overlapping the square of half
// side r around (x, z). Callers filter by exact distance. When the world is
// sparse it walks only the occupied cells: a 600 m far-ring query spans ~1,400
// cells, while 150 spread-out players occupy ~150.
func (g *Grid) Query(x, z, r float64, fn func(idx int32)) {
	x0, x1 := g.cellOf(x-r), g.cellOf(x+r)
	z0, z1 := g.cellOf(z-r), g.cellOf(z+r)
	if (x1-x0+1)*(z1-z0+1) > len(g.used) {
		for _, c := range g.used {
			cx, cz := int(c)%g.n, int(c)/g.n
			if cx < x0 || cx > x1 || cz < z0 || cz > z1 {
				continue
			}
			for _, i := range g.cells[c] {
				fn(i)
			}
		}
		return
	}
	for cz := z0; cz <= z1; cz++ {
		row := cz * g.n
		for cx := x0; cx <= x1; cx++ {
			for _, i := range g.cells[row+cx] {
				fn(i)
			}
		}
	}
}

// Ring is an interest ring (spec 9 table).
type Ring uint8

const (
	None  Ring = iota
	Near       // 0-64 m, everything, 30 Hz
	Mid        // 64-200 m, players/enemies/large effects, 10 Hz
	Far        // 200-600 m, players only, 2 Hz
	Party      // party members beyond the rings, 2 Hz
)

func (r Ring) String() string {
	return [...]string{"none", "near", "mid", "far", "party"}[r]
}

// LeaveMarginM is hysteresis at the far edge: a known player stays in the far
// ring until 616 m, so someone walking along the 600 m boundary does not cost
// a removal plus a full first-sight record every few ticks.
const LeaveMarginM = 16

// QueryRadius is how far a client's interest query must reach.
const QueryRadius = constants.RingFarM + LeaveMarginM

// Classify picks the ring for an entity at horizontal distance d. known says
// the client already has it (for hysteresis); sameParty puts party members in
// the party ring at any distance.
func Classify(d float64, kind proto.EntityKind, known, sameParty bool) Ring {
	switch {
	case d < constants.RingNearM:
		return Near
	case d < constants.RingMidM && kind != proto.EntityKindPickup && kind != proto.EntityKindProjectile:
		// Mid ring: players, enemies, large effects. Small things (pickups,
		// projectiles) only matter up close.
		return Mid
	case kind == proto.EntityKindPlayer && (d < constants.RingFarM || (known && d < constants.RingFarM+LeaveMarginM)):
		return Far
	case sameParty:
		return Party
	}
	return None
}

// divisors: ticks between updates for each ring at TICK_RATE_HZ.
var divisors = [...]uint32{
	None:  0,
	Near:  constants.TickRateHz / constants.RateNearHz,
	Mid:   constants.TickRateHz / constants.RateMidHz,
	Far:   constants.TickRateHz / constants.RateFarHz,
	Party: constants.TickRateHz / constants.RatePartyHz,
}

// Due reports whether an entity in ring r is updated this tick. The entity id
// staggers the phase so a client's mid-ring entities are spread over three
// ticks instead of all landing on one (smoother bandwidth, same average).
func Due(r Ring, tick, id uint32) bool {
	d := divisors[r]
	if d <= 1 {
		return r != None
	}
	return (tick+id)%d == 0
}
