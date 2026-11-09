package towns

import (
	"math"

	"lodestone/server/pkg/constants"
)

// MaskCell is the edge (m) of a Blocker mask square: the box index's cell.
const MaskCell = GridCell

// Blocker answers "does this body overlap a building" for server-side
// walkers that never run the player movement step (zone enemies, demons):
// the same solid boxes, the same "taller than a step above the feet,
// lower than the head" rule and the same closest-point test as
// Collision.collide, but a yes/no for any body radius and height, with no
// push-out. Go only: nothing predicts enemies, so it is not part of the
// TS twin and its golden vectors.
//
// Broadphase: a flat bitmask over the world, one bit per MaskCell square
// that holds or borders (within MaskCell) a solid box. A walker nowhere
// near a town costs one array read; only marked squares look at the box
// index. Read-only after NewBlocker: safe for concurrent queries.
type Blocker struct {
	C    *Collision
	per  int // mask squares per world edge
	mask []uint64
}

// NewBlocker builds the mask for a worldM-metre world over c's boxes.
func NewBlocker(c *Collision, worldM float64) *Blocker {
	per := max(1, int(math.Ceil(worldM/MaskCell)))
	b := &Blocker{C: c, per: per, mask: make([]uint64, (per*per+63)/64)}
	f := c.B.F
	for i := 0; i < c.B.Len(); i++ {
		if c.B.Flags[i]&FlagSolid == 0 {
			continue
		}
		o := i * 9
		r := math.Sqrt(f[o+4]*f[o+4]+f[o+5]*f[o+5]) + MaskCell // dilated: bodies up to MaskCell radius
		x0, x1 := max(0, int(math.Floor((f[o]-r)/MaskCell))), min(per-1, int(math.Floor((f[o]+r)/MaskCell)))
		z0, z1 := max(0, int(math.Floor((f[o+1]-r)/MaskCell))), min(per-1, int(math.Floor((f[o+1]+r)/MaskCell)))
		for cz := z0; cz <= z1; cz++ {
			for cx := x0; cx <= x1; cx++ {
				k := cz*per + cx
				b.mask[k>>6] |= 1 << (k & 63)
			}
		}
	}
	return b
}

// Near is the broadphase: false = no solid box within MaskCell of (x, z).
func (b *Blocker) Near(x, z float64) bool {
	if !(x >= 0 && z >= 0) {
		return false
	}
	cx, cz := int(x/MaskCell), int(z/MaskCell)
	if cx >= b.per || cz >= b.per {
		return false
	}
	k := cz*b.per + cx
	return b.mask[k>>6]&(1<<(k&63)) != 0
}

// Marked is the number of mask squares near a solid box (tests, logs).
func (b *Blocker) Marked() int {
	n := 0
	for _, w := range b.mask {
		for ; w != 0; w &= w - 1 {
			n++
		}
	}
	return n
}

// Blocked reports a body of radius r with feet at (x, y, z) and its head h
// above them overlapping a solid box whose top is more than a step above
// the feet (a wall, a plinth too tall to step on, furniture): where the
// player's push-out would move a player.
func (b *Blocker) Blocked(x, y, z, r, h float64) bool {
	if r <= MaskCell && !b.Near(x, z) {
		return false
	}
	// Straight off the box index, no candidate list: a yes/no needs no
	// order and tolerates a box seen twice (it borders two cells).
	lim := y + constants.MaxStepUpM
	head := y + h
	for cz := cellOf(z - r); cz <= cellOf(z+r); cz++ {
		for cx := cellOf(x - r); cx <= cellOf(x+r); cx++ {
			for _, i := range b.C.cells[cellKey(cx, cz)] {
				if b.hit(int(i), x, z, r, lim, head) {
					return true
				}
			}
		}
	}
	return false
}

// hit: solid box i rises more than a step above the feet (lim) and starts
// below the head, and the body's circle reaches its rectangle.
func (b *Blocker) hit(i int, x, z, r, lim, head float64) bool {
	if b.C.B.Flags[i]&FlagSolid == 0 {
		return false
	}
	f := b.C.B.F[i*9 : i*9+9]
	if !(max(f[7], f[8]) > lim && f[6] < head) {
		return false
	}
	cs, sn, hx, hz := f[2], f[3], f[4], f[5]
	dx, dz := x-f[0], z-f[1]
	u := dx*cs + dz*sn
	v := dz*cs - dx*sn
	du := u - min(max(u, -hx), hx)
	dv := v - min(max(v, -hz), hz)
	return du*du+dv*dv < r*r
}
