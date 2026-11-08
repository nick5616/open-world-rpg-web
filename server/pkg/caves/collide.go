package caves

import (
	"math"
	"slices"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// Collision constants (README "Cave collision"; same names in cave.ts).
const (
	// WallNY: triangles steeper than WALKABLE_SLOPE_DEG (cos 50 deg) are walls.
	WallNY = 0.6427876096865394
	// CeilNY: facing down more than this is a ceiling.
	CeilNY = -0.5
	// BodyHigh: the upper body sphere's height above the feet.
	BodyHigh = 1.5
	// FloorDrop: floors are searched this far below the feet.
	FloorDrop = 34.0
	// UnderM: this far under the heightfield (outside a mouth hole) is "in a cave".
	UnderM        = 1.0
	collidePasses = 2
)

// BodyLow sits on the step-up height so ledges up to MAX_STEP_UP_M are
// stepped over by the floor snap instead of blocked by the body.
const BodyLow = constants.MaxStepUpM + constants.PlayerCapsuleRadius

// CellSource returns a loaded cell, or nil.
type CellSource interface {
	Cell(cx, cy, cz int32) *Cell
}

func cellsAlong(v, size float64) (int32, int32) {
	c := math.Floor(v / size)
	if v-c*size >= size-2 {
		return int32(c), int32(c) + 1
	}
	return int32(c), int32(c)
}

func binOf(v, o float64) int {
	b := math.Floor((v - o + 2) / 2)
	if b < 0 {
		return 0
	}
	if b > Bins-1 {
		return Bins - 1
	}
	return int(b)
}

// FloorAt is the highest up-facing cave triangle under (x, z) whose height is
// within [y - FloorDrop, y + MAX_STEP_UP_M], or -Inf.
func FloorAt(src CellSource, x, y, z float64) float64 {
	top := y + constants.MaxStepUpM
	bottom := y - FloorDrop
	best := math.Inf(-1)
	cx0, cx1 := cellsAlong(x, CellW)
	cz0, cz1 := cellsAlong(z, CellW)
	cy0 := int32(math.Floor((bottom - 2) / CellH))
	cy1 := int32(math.Floor((top + 2) / CellH))
	for cy := cy0; cy <= cy1; cy++ {
		for cz := cz0; cz <= cz1; cz++ {
			for cx := cx0; cx <= cx1; cx++ {
				c := src.Cell(cx, cy, cz)
				if c == nil || c.TriangleCount == 0 || c.MaxY < bottom || c.MinY > top {
					continue
				}
				k := binOf(z, c.OZ)*Bins + binOf(x, c.OX)
				p := c.Pos
				for n := c.ColOff[k]; n < c.ColOff[k+1]; n++ {
					t := int(c.ColTris[n]) * 3
					a, b, d := int(c.Idx[t])*3, int(c.Idx[t+1])*3, int(c.Idx[t+2])*3
					h, ok := triHeight(p[a], p[a+1], p[a+2], p[b], p[b+1], p[b+2], p[d], p[d+1], p[d+2], x, z)
					if ok && h <= top && h >= bottom && h > best {
						best = h
					}
				}
			}
		}
	}
	return best
}

func triHeight(ax, ay, az, bx, by, bz, cx, cy, cz, x, z float64) (float64, bool) {
	e1x, e1y, e1z := bx-ax, by-ay, bz-az
	e2x, e2y, e2z := cx-ax, cy-ay, cz-az
	ny := float64(e1z*e2x) - float64(e1x*e2z)
	if !(ny > 0) {
		return 0, false
	}
	den := float64(e1x*e2z) - float64(e2x*e1z)
	if math.Abs(den) < 1e-12 {
		return 0, false
	}
	px, pz := x-ax, z-az
	u := (float64(px*e2z) - float64(e2x*pz)) / den
	v := (float64(e1x*pz) - float64(px*e1z)) / den
	if u < -1e-9 || v < -1e-9 || u+v > 1+1e-9 {
		return 0, false
	}
	return ay + float64(u*e1y) + float64(v*e2y), true
}

type triFn func(ax, ay, az, bx, by, bz, cx, cy, cz float64)

// forEachTri visits candidate triangles near a sphere at (x, y, z) radius r:
// cells in (cy, cz, cx) order, then that cell's ids ascending, deduplicated.
// Candidates are fixed by the arguments (the caller may move meanwhile).
func forEachTri(src CellSource, x, y, z, r float64, seen *[]uint32, fn triFn) {
	cx0, cx1 := cellsAlong(x, CellW)
	cz0, cz1 := cellsAlong(z, CellW)
	cy0 := int32(math.Floor((y - r - 2) / CellH))
	cy1 := int32(math.Floor((y + r + 2) / CellH))
	for cy := cy0; cy <= cy1; cy++ {
		for cz := cz0; cz <= cz1; cz++ {
			for cx := cx0; cx <= cx1; cx++ {
				c := src.Cell(cx, cy, cz)
				if c == nil || c.TriangleCount == 0 || c.MaxY < y-r || c.MinY > y+r {
					continue
				}
				b0, b1 := binOf(x-r, c.OX), binOf(x+r, c.OX)
				k0, k1 := binOf(z-r, c.OZ), binOf(z+r, c.OZ)
				s := (*seen)[:0]
				for bz := k0; bz <= k1; bz++ {
					for bx := b0; bx <= b1; bx++ {
						k := bz*Bins + bx
						s = append(s, c.ColTris[c.ColOff[k]:c.ColOff[k+1]]...)
					}
				}
				slices.Sort(s)
				*seen = s
				p := c.Pos
				last := int64(-1)
				for _, ti := range s {
					if int64(ti) == last {
						continue
					}
					last = int64(ti)
					t := int(ti) * 3
					a, b, d := int(c.Idx[t])*3, int(c.Idx[t+1])*3, int(c.Idx[t+2])*3
					fn(p[a], p[a+1], p[a+2], p[b], p[b+1], p[b+2], p[d], p[d+1], p[d+2])
				}
			}
		}
	}
}

func triNormal(ax, ay, az, bx, by, bz, cx, cy, cz float64) (float64, float64, float64, bool) {
	e1x, e1y, e1z := bx-ax, by-ay, bz-az
	e2x, e2y, e2z := cx-ax, cy-ay, cz-az
	nx := float64(e1y*e2z) - float64(e1z*e2y)
	ny := float64(e1z*e2x) - float64(e1x*e2z)
	nz := float64(e1x*e2y) - float64(e1y*e2x)
	l := math.Sqrt(float64(float64(nx*nx)+float64(ny*ny)) + float64(nz*nz))
	if l < 1e-12 {
		return 0, 0, 0, false
	}
	return nx / l, ny / l, nz / l, true
}

func dot3(ax, ay, az, bx, by, bz float64) float64 {
	return float64(float64(ax*bx)+float64(ay*by)) + float64(az*bz)
}

// closest point on triangle abc to p (Ericson 5.1.5), as in cave.ts.
func closest(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz float64) (float64, float64, float64) {
	abx, aby, abz := bx-ax, by-ay, bz-az
	acx, acy, acz := cx-ax, cy-ay, cz-az
	apx, apy, apz := px-ax, py-ay, pz-az
	d1 := dot3(abx, aby, abz, apx, apy, apz)
	d2 := dot3(acx, acy, acz, apx, apy, apz)
	if d1 <= 0 && d2 <= 0 {
		return ax, ay, az
	}
	bpx, bpy, bpz := px-bx, py-by, pz-bz
	d3 := dot3(abx, aby, abz, bpx, bpy, bpz)
	d4 := dot3(acx, acy, acz, bpx, bpy, bpz)
	if d3 >= 0 && d4 <= d3 {
		return bx, by, bz
	}
	vc := float64(d1*d4) - float64(d3*d2)
	if vc <= 0 && d1 >= 0 && d3 <= 0 {
		v := d1 / (d1 - d3)
		return ax + float64(v*abx), ay + float64(v*aby), az + float64(v*abz)
	}
	cpx, cpy, cpz := px-cx, py-cy, pz-cz
	d5 := dot3(abx, aby, abz, cpx, cpy, cpz)
	d6 := dot3(acx, acy, acz, cpx, cpy, cpz)
	if d6 >= 0 && d5 <= d6 {
		return cx, cy, cz
	}
	vb := float64(d5*d2) - float64(d1*d6)
	if vb <= 0 && d2 >= 0 && d6 <= 0 {
		w := d2 / (d2 - d6)
		return ax + float64(w*acx), ay + float64(w*acy), az + float64(w*acz)
	}
	va := float64(d3*d6) - float64(d5*d4)
	if va <= 0 && d4-d3 >= 0 && d5-d6 >= 0 {
		w := (d4 - d3) / (d4 - d3 + (d5 - d6))
		return bx + float64(w*(cx-bx)), by + float64(w*(cy-by)), bz + float64(w*(cz-bz))
	}
	denom := 1 / (va + vb + vc)
	v := float64(vb * denom)
	w := float64(vc * denom)
	return ax + float64(abx*v) + float64(acx*w), ay + float64(aby*v) + float64(acy*w), az + float64(abz*v) + float64(acz*w)
}

// Collide pushes a player (feet at x, y, z) out of cave walls (horizontally)
// and ceilings (down). Same passes and order as caveCollide in cave.ts.
func Collide(src CellSource, x, y, z float64) movement.CollideResult {
	r := constants.PlayerCapsuleRadius
	x0, z0 := x, z
	var seen []uint32
	for pass := 0; pass < collidePasses; pass++ {
		for s := 0; s < 2; s++ {
			sy := y + BodyLow
			if s == 1 {
				sy = y + BodyHigh
			}
			forEachTri(src, x, sy, z, r, &seen, func(ax, ay, az, bx, by, bz, cx, cy, cz float64) {
				nx, ny, nz, ok := triNormal(ax, ay, az, bx, by, bz, cx, cy, cz)
				if !ok || ny >= WallNY || ny <= CeilNY {
					return
				}
				qx, qy, qz := closest(x, sy, z, ax, ay, az, bx, by, bz, cx, cy, cz)
				dx, dy, dz := x-qx, sy-qy, z-qz
				d2 := dot3(dx, dy, dz, dx, dy, dz)
				if d2 >= float64(r*r) {
					return
				}
				d := math.Sqrt(d2)
				hx, hz := dx, dz
				hl := math.Sqrt(float64(hx*hx) + float64(hz*hz))
				if hl < 1e-6 {
					hx, hz = nx, nz
					hl = math.Sqrt(float64(hx*hx) + float64(hz*hz))
					if hl < 1e-6 {
						return
					}
				}
				push := r - d
				x = x + float64((hx/hl)*push)
				z = z + float64((hz/hl)*push)
			})
		}
	}
	ceiling := false
	forEachTri(src, x, y+BodyHigh, z, r, &seen, func(ax, ay, az, bx, by, bz, cx, cy, cz float64) {
		_, ny, _, ok := triNormal(ax, ay, az, bx, by, bz, cx, cy, cz)
		if !ok || ny > CeilNY {
			return
		}
		qx, qy, qz := closest(x, y+BodyHigh, z, ax, ay, az, bx, by, bz, cx, cy, cz)
		dx, dy, dz := x-qx, y+BodyHigh-qy, z-qz
		d2 := dot3(dx, dy, dz, dx, dy, dz)
		if d2 >= float64(r*r) {
			return
		}
		y = y - (r - math.Sqrt(d2))
		ceiling = true
	})
	return movement.CollideResult{X: x, Y: y, Z: z, PushX: x - x0, PushZ: z - z0, Ceiling: ceiling}
}

// Ground is the cave-aware movement ground (README "Ground dispatch"):
// heightfield on the open surface, cave triangles in mouth holes and
// underground. It implements movement.CaveGround.
type Ground struct {
	Height   func(x, z float64) float64
	Openings []Opening
	Cells    CellSource
}

// InCave: in a mouth hole, or more than UnderM under the heightfield at y.
func (g *Ground) InCave(x, y, z float64) bool {
	return y < g.Height(x, z)-UnderM || Masked(g.Openings, x, z)
}

func (g *Ground) inCaveH(x, y, z, h float64) bool {
	return y < h-UnderM || Masked(g.Openings, x, z)
}

// HeightAt is the heightfield (movement.Ground).
func (g *Ground) HeightAt(x, z float64) float64 { return g.Height(x, z) }

// FloorAt implements movement.CaveGround.
func (g *Ground) FloorAt(x, y, z float64) float64 {
	h := g.Height(x, z)
	if !g.inCaveH(x, y, z, h) {
		return h
	}
	if f := FloorAt(g.Cells, x, y, z); !math.IsInf(f, -1) {
		return f
	}
	return h
}

// Collide implements movement.CaveGround (a no-op outside caves).
func (g *Ground) Collide(x, y, z float64) movement.CollideResult {
	if !g.InCave(x, y, z) {
		return movement.CollideResult{X: x, Y: y, Z: z}
	}
	return Collide(g.Cells, x, y, z)
}
