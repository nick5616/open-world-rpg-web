package towns

// Building doors (playtest follow-up to WP20): a dynamic overlay on the
// town collision, a line-for-line port of worldgen/js/src/doors.ts (client
// prediction runs that). Door boxes are copied from the towns buffer (no
// arithmetic): the doorway of every building with floors and a closed
// front is its lintel box (the one wall box whose bottom is more than 1 m
// above the floor) lowered to the bottom of the other walls, topped at the
// lintel's bottom. The town collision and its golden vectors never see door
// boxes: a closed door is pushed out of after the town's push-out (After),
// two passes over the closed doors near the body in ascending door index,
// the same per-box arithmetic as Collision.collide. Doors start open (a
// WP20 doorway). testdata/doors.json pins the boxes and pushes against TS.

import (
	"math"
	"slices"

	"lodestone/server/pkg/movement"
)

const (
	boxKindWall = 1
	propDoorKnd = 0
	flagOpenFnt = 8
)

// Door is one closable building door.
type Door struct {
	Index      int
	Building   int
	Prop       int    // PROPS index of the door prop (kind 0)
	ID         uint64 // the door prop's stable id (Interact 34 targetId)
	Settlement int
	X, Y, Z    float64 // door prop: doorway centre on the wall's mid-plane, floor height
	Yaw        float64
	Width      float64 // doorway width (2 hx)
	Thick      float64 // wall thickness (2 hz)
}

// DoorView answers which doors are closed for one collision query.
type DoorView interface {
	DoorClosed(d int) bool
}

// Doors is every closable door of a towns layer with its box (9 f64 per
// door in the Boxes layout) and a grid index.
type Doors struct {
	D          []Door
	F          []float64
	ByProp     map[uint64]int
	ByBuilding map[int]int
	ByPropIdx  map[int]int // PROPS index -> door index (Events 970/971)
	cells      map[uint64][]int32
}

// NewDoors finds the doors of t (TS: new TownDoors).
func NewDoors(t *Towns) *Doors {
	s := &Doors{ByProp: map[uint64]int{}, ByBuilding: map[int]int{}, ByPropIdx: map[int]int{}, cells: map[uint64][]int32{}}
	bx := &t.Boxes
	for bi := range t.Buildings {
		b := &t.Buildings[bi]
		if b.Floors == 0 || b.Flags&flagOpenFnt != 0 {
			continue
		}
		prop := -1
		for p := b.PropFirst; p < b.PropFirst+b.Props; p++ {
			if t.Props[p].Kind == propDoorKnd {
				prop = p
				break
			}
		}
		if prop < 0 {
			continue
		}
		lintel, y0 := -1, math.Inf(1)
		for i := b.BoxFirst; i < b.BoxFirst+b.Boxes; i++ {
			if bx.Kind[i] != boxKindWall {
				continue
			}
			b0 := bx.F[i*9+6]
			if b0 > b.FloorY+1 {
				if lintel < 0 {
					lintel = i
				}
			} else if b0 < y0 {
				y0 = b0
			}
		}
		if lintel < 0 || math.IsInf(y0, 1) {
			continue
		}
		o := lintel * 9
		top := bx.F[o+6]
		s.F = append(s.F, bx.F[o], bx.F[o+1], bx.F[o+2], bx.F[o+3], bx.F[o+4], bx.F[o+5], y0, top, top)
		pr := &t.Props[prop]
		d := len(s.D)
		s.D = append(s.D, Door{Index: d, Building: bi, Prop: prop, ID: pr.ID, Settlement: b.Settlement, X: pr.X, Y: pr.Y, Z: pr.Z, Yaw: pr.Yaw, Width: bx.F[o+4] * 2, Thick: bx.F[o+5] * 2})
		s.ByProp[pr.ID] = d
		s.ByBuilding[bi] = d
		s.ByPropIdx[prop] = d
	}
	f := s.F
	for d := range s.D {
		o := d * 9
		r := math.Sqrt(float64(f[o+4]*f[o+4]) + float64(f[o+5]*f[o+5]))
		for cz := cellOf(f[o+1] - r); cz <= cellOf(f[o+1]+r); cz++ {
			for cx := cellOf(f[o] - r); cx <= cellOf(f[o]+r); cx++ {
				k := cellKey(cx, cz)
				s.cells[k] = append(s.cells[k], int32(d))
			}
		}
	}
	return s
}

// Len is the number of doors.
func (s *Doors) Len() int { return len(s.D) }

// Candidates returns the doors indexed in [x-m, x+m] x [z-m, z+m],
// ascending and deduplicated.
func (s *Doors) Candidates(x, z, m float64, out []int32) []int32 {
	out = out[:0]
	for cz := cellOf(z - m); cz <= cellOf(z+m); cz++ {
		for cx := cellOf(x - m); cx <= cellOf(x+m); cx++ {
			out = append(out, s.cells[cellKey(cx, cz)]...)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// After pushes the body (feet at the result r of the collision under the
// doors) out of the doors v says are closed (TS: TownDoors.after). Pushes
// add to r's; y and the ceiling flag pass through; with no push r comes
// back unchanged.
func (s *Doors) After(r movement.CollideResult, v DoorView) movement.CollideResult {
	var buf [16]int32
	cands := s.Candidates(r.X, r.Z, rad+1, buf[:0])
	if len(cands) == 0 {
		return r
	}
	f := s.F
	lim := r.Y + step
	head := r.Y + HeadM
	r2 := rad * rad
	px, pz := r.X, r.Z
	dpx, dpz := 0.0, 0.0
	pushed := false
	for pass := 0; pass < 2; pass++ {
		for _, ii := range cands {
			i := int(ii)
			if !v.DoorClosed(i) {
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
			vv := float64(dz*cs) - float64(dx*sn)
			cu, cv := u, vv
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
			dv := vv - cv
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
				au, av := u, vv
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
					if vv >= 0 {
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
			dpx = dpx + wx
			dpz = dpz + wz
			pushed = true
		}
	}
	if !pushed {
		return r
	}
	r.X, r.Z = px, pz
	r.PushX = dpx + r.PushX
	r.PushZ = dpz + r.PushZ
	return r
}

// Touches reports whether a body of radius rd with feet at y (head y +
// HeadM) touches door d's box (TS: TownDoors.touches).
func (s *Doors) Touches(d int, x, y, z, rd float64) bool {
	f := s.F
	o := d * 9
	if !(f[o+7] > y && f[o+6] < y+HeadM) {
		return false
	}
	cs, sn, hx, hz := f[o+2], f[o+3], f[o+4], f[o+5]
	dx := x - f[o]
	dz := z - f[o+1]
	u := float64(dx*cs) + float64(dz*sn)
	v := float64(dz*cs) - float64(dx*sn)
	cu, cv := min(max(u, -hx), hx), min(max(v, -hz), hz)
	du, dv := u-cu, v-cv
	return float64(du*du)+float64(dv*dv) < rd*rd
}

// DoorLevel is a level view with doors: the inner view's floors and water,
// its push-out then the closed doors'.
type DoorLevel struct {
	Inner movement.Ground
	S     *Doors
	V     DoorView
}

// HeightAt is the inner view's.
func (l DoorLevel) HeightAt(x, z float64) float64 { return l.Inner.HeightAt(x, z) }

// WaterAt is the inner view's.
func (l DoorLevel) WaterAt(x, z float64) float64 { return movement.WaterAt(l.Inner, x, z) }

// Collide implements movement.Collider (only meaningful over a Collider
// inner view; see WithDoors).
func (l DoorLevel) Collide(x, y, z float64) movement.CollideResult {
	r := movement.CollideResult{X: x, Y: y, Z: z}
	if c, ok := l.Inner.(movement.Collider); ok {
		r = c.Collide(x, y, z)
	}
	return l.S.After(r, l.V)
}

// WithDoors wraps a level view with the doors v says are closed. A view
// without a push-out (no town ground under it) is returned as is: doors
// only exist over the town collision.
func WithDoors(inner movement.Ground, s *Doors, v DoorView) movement.Ground {
	if _, ok := inner.(movement.Collider); !ok {
		return inner
	}
	return DoorLevel{Inner: inner, S: s, V: v}
}
