package towns

import (
	"math"
	"slices"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// GridCell is the box index cell size (m). Any superset of the touching
// boxes gives the same answers, so the TS and Go indexes need not match
// cell for cell; they do anyway (same rule).
const GridCell = 8

// HeadM is the head height of the player body: the cave capsule's top
// sphere (feet + 1.5 + 0.4). TS: TOWN_HEAD_M.
const HeadM = 1.9

const (
	step = constants.MaxStepUpM
	rad  = constants.PlayerCapsuleRadius
)

// Collision is the town collision core (TS: TownCollision). See
// worldgen/README.md "Town collision".
type Collision struct {
	B     *Boxes
	cells map[uint64][]int32
}

func cellKey(cx, cz int64) uint64 { return uint64(cx+1<<31)<<32 | uint64(cz+1<<31)&0xFFFFFFFF }

func cellOf(v float64) int64 { return int64(math.Floor(v / GridCell)) }

// NewCollision indexes the boxes.
func NewCollision(b *Boxes) *Collision {
	c := &Collision{B: b, cells: map[uint64][]int32{}}
	f := b.F
	for i := 0; i < b.Len(); i++ {
		o := i * 9
		r := math.Sqrt(float64(f[o+4]*f[o+4]) + float64(f[o+5]*f[o+5]))
		for cz := cellOf(f[o+1] - r); cz <= cellOf(f[o+1]+r); cz++ {
			for cx := cellOf(f[o] - r); cx <= cellOf(f[o]+r); cx++ {
				k := cellKey(cx, cz)
				c.cells[k] = append(c.cells[k], int32(i))
			}
		}
	}
	return c
}

// Empty reports that no box is indexed in the cell of (x, z).
func (c *Collision) Empty(x, z float64) bool {
	_, ok := c.cells[cellKey(cellOf(x), cellOf(z))]
	return !ok
}

// Candidates returns the boxes indexed in the square [x-m, x+m] x [z-m,
// z+m], ascending and deduplicated.
func (c *Collision) Candidates(x, z, m float64, out []int32) []int32 {
	out = out[:0]
	for cz := cellOf(z - m); cz <= cellOf(z+m); cz++ {
		for cx := cellOf(x - m); cx <= cellOf(x+m); cx++ {
			out = append(out, c.cells[cellKey(cx, cz)]...)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// TopAt is the top of box i at (x, z); ok=false outside its rectangle.
func (c *Collision) TopAt(i int, x, z float64) (float64, bool) {
	f := c.B.F
	o := i * 9
	dx := x - f[o]
	dz := z - f[o+1]
	cs, sn, hx, hz := f[o+2], f[o+3], f[o+4], f[o+5]
	u := float64(dx*cs) + float64(dz*sn)
	v := float64(dz*cs) - float64(dx*sn)
	if u < -hx || u > hx || v < -hz || v > hz {
		return 0, false
	}
	y1, y2 := f[o+7], f[o+8]
	return y1 + float64((y2-y1)*((u+hx)/(hx+hx))), true
}

// FloorAt is the highest walkable top at (x, z) at most a step above feet
// height y; -Inf when there is none.
func (c *Collision) FloorAt(x, y, z float64) float64 {
	best := math.Inf(-1)
	l, ok := c.cells[cellKey(cellOf(x), cellOf(z))]
	if !ok {
		return best
	}
	lim := y + step
	for _, i := range l {
		if c.B.Flags[i]&FlagWalk == 0 {
			continue
		}
		if t, ok := c.TopAt(int(i), x, z); ok && t <= lim && t > best {
			best = t
		}
	}
	return best
}

// Collide pushes the player body (feet at x, y, z) out of solid boxes and
// lowers it under ceilings (TS: TownCollision.collide, same order).
func (c *Collision) Collide(x, y, z float64) movement.CollideResult {
	var buf [64]int32
	return c.collide(x, y, z, buf[:0])
}

func (c *Collision) collide(x, y, z float64, buf []int32) movement.CollideResult {
	out := movement.CollideResult{X: x, Y: y, Z: z}
	cands := c.Candidates(x, z, rad+1, buf)
	if len(cands) == 0 {
		return out
	}
	f := c.B.F
	flags := c.B.Flags
	lim := y + step
	head := y + HeadM
	r2 := rad * rad
	px, pz := x, z
	for pass := 0; pass < 2; pass++ {
		for _, ii := range cands {
			i := int(ii)
			if flags[i]&FlagSolid == 0 {
				continue
			}
			o := i * 9
			y1, y2 := f[o+7], f[o+8]
			top := y2
			if y1 > y2 {
				top = y1
			}
			if !(top > lim && f[o+6] < head) {
				continue
			}
			cs, sn, hx, hz := f[o+2], f[o+3], f[o+4], f[o+5]
			dx := px - f[o]
			dz := pz - f[o+1]
			u := float64(dx*cs) + float64(dz*sn)
			v := float64(dz*cs) - float64(dx*sn)
			cu, cv := u, v
			if cu < -hx {
				cu = -hx
			} else if cu > hx {
				cu = hx
			}
			if cv < -hz {
				cv = -hz
			} else if cv > hz {
				cv = hz
			}
			du := u - cu
			dv := v - cv
			d2 := float64(du*du) + float64(dv*dv)
			if d2 >= r2 {
				continue
			}
			var pu, pv float64
			if d2 > 0 {
				d := math.Sqrt(d2)
				k := (rad - d) / d
				pu = du * k
				pv = dv * k
			} else {
				au, av := u, v
				if au < 0 {
					au = -au
				}
				if av < 0 {
					av = -av
				}
				ex := hx - au
				ez := hz - av
				if ex <= ez {
					sg := -1.0
					if u >= 0 {
						sg = 1
					}
					pu = sg * (ex + rad)
					pv = 0
				} else {
					sg := -1.0
					if v >= 0 {
						sg = 1
					}
					pu = 0
					pv = sg * (ez + rad)
				}
			}
			wx := float64(pu*cs) - float64(pv*sn)
			wz := float64(pu*sn) + float64(pv*cs)
			px = px + wx
			pz = pz + wz
			out.PushX = out.PushX + wx
			out.PushZ = out.PushZ + wz
		}
	}
	ny := y
	for _, ii := range cands {
		i := int(ii)
		if flags[i]&FlagCeil == 0 {
			continue
		}
		y0 := f[i*9+6]
		if !(y0 > lim && y0 < ny+HeadM) {
			continue
		}
		if _, ok := c.TopAt(i, px, pz); !ok {
			continue
		}
		ny = y0 - HeadM
		out.Ceiling = true
	}
	out.X, out.Y, out.Z = px, ny, pz
	return out
}

// Ground is the movement ground with buildings (TS: TownGroundCore): the
// step views it at the player's level, where the ground is the higher of
// the base view (terrain, towers, caves) and the town floor within a step,
// and collide runs the base view's push-out (caves) then the town's.
// Non-step callers see the base surface.
type Ground struct {
	Base movement.Ground
	C    *Collision
}

// NewGround wraps base with the towns' collision.
func NewGround(base movement.Ground, t *Towns) *Ground {
	return &Ground{Base: base, C: NewCollision(&t.Boxes)}
}

// HeightAt is the base surface.
func (g *Ground) HeightAt(x, z float64) float64 { return g.Base.HeightAt(x, z) }

// WaterAt is the base water (movement.Water).
func (g *Ground) WaterAt(x, z float64) float64 { return movement.WaterAt(g.Base, x, z) }

// AtLevel implements movement.LevelGround.
func (g *Ground) AtLevel(y float64) movement.Ground {
	return Level{C: g.C, B: movement.AtLevel(g.Base, y), Y: y}
}

// FloorAt is the ground under feet at height y (base view and town floors).
func (g *Ground) FloorAt(x, y, z float64) float64 {
	return Level{C: g.C, B: movement.AtLevel(g.Base, y), Y: y}.HeightAt(x, z)
}

// Level is the town ground viewed at feet height Y.
type Level struct {
	C *Collision
	B movement.Ground
	Y float64
}

// HeightAt is max(base view, town floor within a step of Y).
func (l Level) HeightAt(x, z float64) float64 {
	b := l.B.HeightAt(x, z)
	if t := l.C.FloorAt(x, l.Y, z); t > b {
		return t
	}
	return b
}

// WaterAt is the base view's water.
func (l Level) WaterAt(x, z float64) float64 { return movement.WaterAt(l.B, x, z) }

// Collide implements movement.Collider: the base view's push-out (caves),
// then the town's from where that left the body.
func (l Level) Collide(x, y, z float64) movement.CollideResult {
	var bx, by, bz, ppx, ppz float64 = x, y, z, 0, 0
	ceil := false
	if bc, ok := l.B.(movement.Collider); ok {
		r := bc.Collide(x, y, z)
		bx, by, bz, ppx, ppz, ceil = r.X, r.Y, r.Z, r.PushX, r.PushZ, r.Ceiling
	}
	out := l.C.Collide(bx, by, bz)
	out.PushX = out.PushX + ppx
	out.PushZ = out.PushZ + ppz
	out.Ceiling = out.Ceiling || ceil
	return out
}
