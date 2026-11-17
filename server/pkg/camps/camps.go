// Package camps holds the pure rules of playtest 2's camps (CR 025,
// contracts/camps.yaml): piece footprints and collision boxes, the
// placement rules, the campfire's fuel and the decay rule. The zone's glue
// is server/zone/internal/game/camps*.go.
//
// Collision is one half of a TS/Go twin (client/src/ui/camps/collide.ts):
// solid pieces are boxes in the towns layout (9 f64: x, z, cos, sin, hx, hz,
// bottom, top, top) pushed out of after the town collision and the closed
// doors, with exactly the per-box arithmetic of towns.Collision.collide and
// towns.Doors.After (two passes over the boxes near the body, ascending
// piece id). Every input is exact on both sides: positions are the wire's
// centimetres divided by 100, rotations are 45 degree steps whose cos/sin
// come from one table, and the box only adds the generated footprint and
// height. testdata/camps.json (written by camps_test.go -update) pins the
// pushes; the client test replays it.
package camps

import (
	"math"
	"slices"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// S is cos(45 degrees) as both sides spell it (Math.SQRT1_2).
const S = 0.7071067811865476

// rot is the exact cos/sin of rotation step k (45 degrees each).
var rot = [8][2]float64{{1, 0}, {S, S}, {0, 1}, {-S, S}, {-1, 0}, {-S, -S}, {0, -1}, {S, -S}}

// Rot is the cos and sin of rotation step k (mod 8).
func Rot(k int) (cs, sn float64) {
	r := rot[k&7]
	return r[0], r[1]
}

// BaseDepth is how far a piece's box reaches under its base (slopes).
const BaseDepth = 0.5

// cellM is the box index's cell size.
const cellM = 8

const (
	step  = constants.MaxStepUpM
	rad   = constants.PlayerCapsuleRadius
	headM = 1.9 // towns.HeadM (the body's head above its feet)
)

// Cm2M is a wire coordinate (cm) in metres: the one conversion both sides use.
func Cm2M(cm int32) float64 { return float64(cm) / 100 }

// M2Cm rounds metres to the wire's centimetres.
func M2Cm(m float64) int32 { return int32(math.Round(m * 100)) }

// Footprint is a piece's rectangle on the ground.
type Footprint struct {
	X, Z, Cs, Sn, Hx, Hz float64
}

// FootprintOf is piece kind's footprint at (x, z) with rotation step r.
func FootprintOf(kind, r int, x, z float64) Footprint {
	p := campdefs.D.ByID(kind)
	if p == nil {
		return Footprint{X: x, Z: z, Cs: 1}
	}
	cs, sn := Rot(r)
	return Footprint{X: x, Z: z, Cs: cs, Sn: sn, Hx: p.W / 2, Hz: p.D / 2}
}

// Corners are the footprint's four corners (x, z), grown by g.
func (f Footprint) Corners(g float64) [4][2]float64 {
	hx, hz := f.Hx+g, f.Hz+g
	var out [4][2]float64
	for i, s := range [4][2]float64{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}} {
		u, v := s[0]*hx, s[1]*hz
		out[i] = [2]float64{f.X + u*f.Cs - v*f.Sn, f.Z + u*f.Sn + v*f.Cs}
	}
	return out
}

// Radius is the footprint's bounding circle.
func (f Footprint) Radius() float64 { return math.Hypot(f.Hx, f.Hz) }

// Overlaps reports two footprints, each grown by g, overlapping (separating axes).
func (f Footprint) Overlaps(o Footprint, g float64) bool {
	if math.Hypot(f.X-o.X, f.Z-o.Z) > f.Radius()+o.Radius()+2*g {
		return false
	}
	a, b := f.Corners(g), o.Corners(g)
	axes := [4][2]float64{{f.Cs, f.Sn}, {-f.Sn, f.Cs}, {o.Cs, o.Sn}, {-o.Sn, o.Cs}}
	for _, ax := range axes {
		amin, amax := math.Inf(1), math.Inf(-1)
		bmin, bmax := math.Inf(1), math.Inf(-1)
		for i := 0; i < 4; i++ {
			pa := a[i][0]*ax[0] + a[i][1]*ax[1]
			pb := b[i][0]*ax[0] + b[i][1]*ax[1]
			amin, amax = min(amin, pa), max(amax, pa)
			bmin, bmax = min(bmin, pb), max(bmax, pb)
		}
		if amax <= bmin || bmax <= amin {
			return false
		}
	}
	return true
}

// Dist is the distance from (x, z) to the footprint (0 inside).
func (f Footprint) Dist(x, z float64) float64 {
	dx, dz := x-f.X, z-f.Z
	u := dx*f.Cs + dz*f.Sn
	v := dz*f.Cs - dx*f.Sn
	cu := math.Max(0, math.Abs(u)-f.Hx)
	cv := math.Max(0, math.Abs(v)-f.Hz)
	return math.Hypot(cu, cv)
}

// Box is a solid piece's collision box (towns layout).
func Box(kind, r int, x, y, z float64) [9]float64 {
	p := campdefs.D.ByID(kind)
	cs, sn := Rot(r)
	top := y + p.Height
	return [9]float64{x, z, cs, sn, p.W / 2, p.D / 2, y - BaseDepth, top, top}
}

// Solid reports a piece kind players collide with.
func Solid(kind int) bool {
	p := campdefs.D.ByID(kind)
	return p != nil && (p.Solid || (p.Build != nil && (len(p.Build.Boxes) > 0 || p.Build.Surface != nil)))
}

// ---- collision (the Go half of the twin) ----

// SolidPiece is one solid piece as the collision sees it.
type SolidPiece struct {
	ID      uint64
	Kind    int
	Rot     int
	X, Y, Z float64 // Cm2M of the wire values
	State   int     // building pieces: bit 0 open (doors and gates)
}

// Set is the solid pieces' boxes in ascending id order with a grid index.
// Build a new one on every change (a handful of pieces); it is read-only
// afterwards, so movement steps on many goroutines may share it.
type Set struct {
	IDs   []uint64
	F     []float64
	cells map[uint64][]int32
	// CR 041: walkable surfaces (floors, stairs), 8 f64 each: x, z, cos, sin,
	// hx, hz, y at u=-hx, y at u=+hx; indexed by cell like the boxes.
	SF     []float64
	scells map[uint64][]int32
}

func cellKey(cx, cz int64) uint64 { return uint64(cx+1<<31)<<32 | uint64(cz+1<<31)&0xFFFFFFFF }

func cellOf(v float64) int64 { return int64(math.Floor(v / cellM)) }

// NewSet indexes the solid pieces (order-independent: sorted by id here).
func NewSet(ps []SolidPiece) *Set {
	ps = slices.Clone(ps)
	slices.SortFunc(ps, func(a, b SolidPiece) int {
		switch {
		case a.ID < b.ID:
			return -1
		case a.ID > b.ID:
			return 1
		}
		return 0
	})
	s := &Set{cells: map[uint64][]int32{}, scells: map[uint64][]int32{}}
	add := func(id uint64, b [9]float64) {
		i := int32(len(s.IDs))
		s.IDs = append(s.IDs, id)
		s.F = append(s.F, b[:]...)
		r := math.Sqrt(float64(b[4]*b[4]) + float64(b[5]*b[5]))
		for cz := cellOf(b[1] - r); cz <= cellOf(b[1]+r); cz++ {
			for cx := cellOf(b[0] - r); cx <= cellOf(b[0]+r); cx++ {
				k := cellKey(cx, cz)
				s.cells[k] = append(s.cells[k], i)
			}
		}
	}
	for _, p := range ps {
		if !Solid(p.Kind) {
			continue
		}
		if Builds(p.Kind) {
			bp := &BP{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: M2Cm(p.X), Y: M2Cm(p.Y), Z: M2Cm(p.Z), State: p.State}
			for _, b := range BoxesOf(bp) {
				add(p.ID, b)
			}
			if sf, ok := SurfacesOf(bp); ok {
				i := int32(len(s.SF) / 8)
				s.SF = append(s.SF, sf.X, sf.Z, sf.Cs, sf.Sn, sf.Hx, sf.Hz, sf.Ya, sf.Yb)
				r := math.Hypot(sf.Hx, sf.Hz)
				for cz := cellOf(sf.Z - r); cz <= cellOf(sf.Z+r); cz++ {
					for cx := cellOf(sf.X - r); cx <= cellOf(sf.X+r); cx++ {
						k := cellKey(cx, cz)
						s.scells[k] = append(s.scells[k], i)
					}
				}
			}
			continue
		}
		add(p.ID, Box(p.Kind, p.Rot, p.X, p.Y, p.Z))
	}
	return s
}

// SurfaceAt is the highest walkable surface at (x, z) that a body whose feet
// are at y can step onto (top <= y + the step-up), ok=false when none.
func (s *Set) SurfaceAt(x, z, y float64) (float64, bool) {
	if s == nil || len(s.SF) == 0 {
		return 0, false
	}
	best, found := 0.0, false
	for _, i := range s.scells[cellKey(cellOf(x), cellOf(z))] {
		f := s.SF[int(i)*8 : int(i)*8+8]
		dx, dz := x-f[0], z-f[1]
		u := float64(dx*f[2]) + float64(dz*f[3])
		v := float64(dz*f[2]) - float64(dx*f[3])
		if u < -f[4] || u > f[4] || v < -f[5] || v > f[5] {
			continue
		}
		top := f[6] + float64((u+f[4])/(2*f[4]))*float64(f[7]-f[6])
		if top <= y+step && (!found || top > best) {
			best, found = top, true
		}
	}
	return best, found
}

// HasSurfaces reports walkable surfaces in the set.
func (s *Set) HasSurfaces() bool { return s != nil && len(s.SF) > 0 }

// Len is the number of boxes.
func (s *Set) Len() int {
	if s == nil {
		return 0
	}
	return len(s.IDs)
}

// Candidates returns the boxes indexed in the square [x-m, x+m] x [z-m, z+m],
// ascending and deduplicated.
func (s *Set) Candidates(x, z, m float64, out []int32) []int32 {
	out = out[:0]
	for cz := cellOf(z - m); cz <= cellOf(z+m); cz++ {
		for cx := cellOf(x - m); cx <= cellOf(x+m); cx++ {
			out = append(out, s.cells[cellKey(cx, cz)]...)
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// Near reports any box indexed within m of (x, z) (a cheap "wrap the ground?").
func (s *Set) Near(x, z, m float64) bool {
	if s.Len() == 0 && !s.HasSurfaces() {
		return false
	}
	for cz := cellOf(z - m); cz <= cellOf(z+m); cz++ {
		for cx := cellOf(x - m); cx <= cellOf(x+m); cx++ {
			k := cellKey(cx, cz)
			if len(s.cells[k]) > 0 || len(s.scells[k]) > 0 {
				return true
			}
		}
	}
	return false
}

// After pushes the body (feet at the result r of the collision under the
// pieces) out of the solid boxes (TS: CampSet.after). Pushes add to r's; y
// and the ceiling flag pass through; with no push r comes back unchanged.
func (s *Set) After(r movement.CollideResult) movement.CollideResult {
	var buf [16]int32
	cands := s.Candidates(r.X, r.Z, rad+1, buf[:0])
	if len(cands) == 0 {
		return r
	}
	f := s.F
	lim := r.Y + step
	head := r.Y + headM
	r2 := rad * rad
	px, pz := r.X, r.Z
	dpx, dpz := 0.0, 0.0
	pushed := false
	for pass := 0; pass < 2; pass++ {
		for _, ii := range cands {
			o := int(ii) * 9
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

// Blocked reports a body of radius rd (feet at y, h tall) overlapping a box
// (enemy movement: combat World.Obstacles).
func (s *Set) Blocked(x, y, z, rd, h float64) bool {
	if s.Len() == 0 {
		return false
	}
	var buf [16]int32
	f := s.F
	for _, ii := range s.Candidates(x, z, rd+1, buf[:0]) {
		o := int(ii) * 9
		if !(f[o+7] > y+step && f[o+6] < y+h) {
			continue
		}
		cs, sn, hx, hz := f[o+2], f[o+3], f[o+4], f[o+5]
		dx, dz := x-f[o], z-f[o+1]
		u := dx*cs + dz*sn
		v := dz*cs - dx*sn
		cu, cv := min(max(u, -hx), hx), min(max(v, -hz), hz)
		if (u-cu)*(u-cu)+(v-cv)*(v-cv) < rd*rd {
			return true
		}
	}
	return false
}

// Level is a level view with the camp pieces: the inner view's floors and
// water, its push-out (town, doors) then the pieces'.
type Level struct {
	Inner movement.Ground
	S     *Set
	Y     float64 // feet height of the view (floors above y + step are not stood on)
}

// HeightAt is the inner view's, or a floor or stair the body can step onto.
func (l Level) HeightAt(x, z float64) float64 {
	h := l.Inner.HeightAt(x, z)
	if l.S.HasSurfaces() {
		if t, ok := l.S.SurfaceAt(x, z, l.Y); ok && t > h {
			return t
		}
	}
	return h
}

// WaterAt is the inner view's.
func (l Level) WaterAt(x, z float64) float64 { return movement.WaterAt(l.Inner, x, z) }

// Collide implements movement.Collider.
func (l Level) Collide(x, y, z float64) movement.CollideResult {
	r := movement.CollideResult{X: x, Y: y, Z: z}
	if c, ok := l.Inner.(movement.Collider); ok {
		r = c.Collide(x, y, z)
	}
	return l.S.After(r)
}

// With wraps a level view with the pieces. A view without a push-out (no
// town ground under it: the flat and scale worlds) is returned as is, like
// towns.WithDoors: camps only exist over the town collision.
func With(inner movement.Ground, s *Set, y float64) movement.Ground {
	if s.Len() == 0 && !s.HasSurfaces() {
		return inner
	}
	if _, ok := inner.(movement.Collider); !ok {
		return inner
	}
	return Level{Inner: inner, S: s, Y: y}
}

// ---- placement ----

// Refusal reasons (Event 1103 value; contracts/events.md).
const (
	RefuseUnknown     = 1  // no such piece or kind
	RefuseTooFar      = 2  // out of reach
	RefuseTown        = 3  // inside a settlement's footprint
	RefuseSlope       = 4  // too steep or uneven
	RefuseWater       = 5  // in water
	RefuseBlocked     = 6  // overlaps a building, a structure or another piece
	RefuseOtherCamp   = 7  // too close to someone else's camp
	RefuseLimit       = 8  // your camp has its pieces
	RefuseKindLimit   = 9  // enough of this kind
	RefuseOutside     = 10 // outside your camp's area
	RefuseNoKit       = 11 // no kit in the pack
	RefuseBody        = 12 // someone stands there
	RefuseUnderground = 13
	RefuseNotYours    = 14
	RefuseNotEmpty    = 15 // a chest with items in it
	RefuseFull        = 16 // pack (or chest) full
	RefuseLocked      = 17
	RefuseNoWood      = 18
	RefuseFireFull    = 19
	RefuseElsewhere   = 20 // another zone owns that ground (WP16 border): step closer
	RefuseCombat      = 21 // just fought
	RefuseOff         = 22 // no camps in this world
	RefuseLocal       = 23 // a local profile cannot store items (they live in the browser's save)
)

// Env is what the placement rules ask of the world.
type Env interface {
	HeightAt(x, z float64) float64
	WaterAt(x, z float64) float64
	// InTown: inside a settlement's radius + margin.
	InTown(x, z, margin float64) bool
	// Structure: the footprint overlaps a building, wall, bridge or other
	// generated structure (the towns collision boxes).
	Structure(f Footprint) bool
}

// Placed is an existing piece as the rules see it.
type Placed struct {
	ID    uint64
	Kind  int
	Rot   int
	X, Z  float64
	Owner string
	Build bool // a building piece (CR 041): only its footprint counts, not the camp limits
}

// Want is one placement request.
type Want struct {
	Kind, Rot int
	X, Z      float64
	Owner     string
	FeetX     float64
	FeetY     float64
	FeetZ     float64
}

// Check validates a placement against the world and the pieces near it
// (every piece within limits.campRadiusM*2 + otherCampM; the owner's own
// pieces wherever they are, for the limits). It returns the base height.
// Bodies (players, NPCs) are the caller's (the client cannot see them all).
func Check(w Want, near []Placed, env Env) (float64, int) {
	d := campdefs.D
	p := d.ByID(w.Kind)
	if p == nil {
		return 0, RefuseUnknown
	}
	if math.Hypot(w.X-w.FeetX, w.Z-w.FeetZ) > d.Limits.ReachM {
		return 0, RefuseTooFar
	}
	if w.X < 4 || w.Z < 4 || w.X > constants.WorldSizeM-4 || w.Z > constants.WorldSizeM-4 {
		return 0, RefuseTooFar
	}
	// Limits (own pieces).
	own, ofKind := 0, 0
	var anchor *Placed
	for i := range near {
		q := &near[i]
		if q.Owner != w.Owner || q.Build {
			continue
		}
		own++
		if q.Kind == w.Kind {
			ofKind++
		}
		if anchor == nil || q.ID < anchor.ID {
			anchor = q
		}
	}
	if own >= d.Limits.MaxPieces {
		return 0, RefuseLimit
	}
	if ofKind >= p.Max {
		return 0, RefuseKindLimit
	}
	if anchor != nil && math.Hypot(w.X-anchor.X, w.Z-anchor.Z) > d.Limits.CampRadiusM {
		return 0, RefuseOutside
	}
	if env.InTown(w.X, w.Z, d.Placement.TownMarginM) {
		return 0, RefuseTown
	}
	surf := env.HeightAt(w.X, w.Z)
	if w.FeetY < surf-d.Placement.MaxDepthM {
		return 0, RefuseUnderground
	}
	f := FootprintOf(w.Kind, w.Rot, w.X, w.Z)
	y, ok := BaseHeight(f, env)
	if !ok {
		return 0, RefuseSlope
	}
	corners := f.Corners(0)
	for _, c := range append(corners[:], [2]float64{w.X, w.Z}) {
		if env.WaterAt(c[0], c[1]) > env.HeightAt(c[0], c[1])-0.05 {
			return 0, RefuseWater
		}
	}
	for i := range near {
		q := &near[i]
		qf := FootprintOf(q.Kind, q.Rot, q.X, q.Z)
		if !q.Build && q.Owner != w.Owner && qf.Dist(w.X, w.Z) < d.Placement.OtherCampM+f.Radius() {
			return 0, RefuseOtherCamp
		}
		if f.Overlaps(qf, d.Placement.GapM/2) {
			return 0, RefuseBlocked
		}
	}
	if env.Structure(f) {
		return 0, RefuseBlocked
	}
	return y, 0
}

// BaseHeight is a footprint's base: the mean of its corners and centre,
// ok=false when the ground under it is too steep or uneven.
func BaseHeight(f Footprint, env Env) (float64, bool) {
	cs := f.Corners(0)
	lo, hi := math.Inf(1), math.Inf(-1)
	sum := 0.0
	for _, c := range append(cs[:], [2]float64{f.X, f.Z}) {
		h := env.HeightAt(c[0], c[1])
		lo, hi = min(lo, h), max(hi, h)
		sum += h
	}
	pl := &campdefs.D.Placement
	spread := hi - lo
	diag := 2 * f.Radius()
	if spread > pl.MaxSpreadM || spread > math.Tan(pl.MaxSlopeDeg*math.Pi/180)*max(diag, 1) {
		return 0, false
	}
	return math.Round(sum/5*100) / 100, true
}

// ---- fire ----

// HourS is one in-game hour in real seconds.
const HourS = float64(constants.DayLengthS) / 24

// AddWood is the fire's new burn end (world-clock seconds) after adding n
// firewood at world time now, and the wood actually used (never past
// fire.maxHours of fuel).
func AddWood(until, now float64, n int) (float64, int) {
	fd := &campdefs.D.Fire
	left := max(0, until-now)
	maxS := fd.MaxHours * HourS
	per := fd.HoursPerWood * HourS
	used := 0
	for used < n && left+per <= maxS+1e-6 {
		left += per
		used++
	}
	return now + left, used
}

// ---- decay ----

// Decayed reports a camp whose owner was last near it at seen, at now.
func Decayed(seen, now time.Time) bool {
	return now.Sub(seen) > time.Duration(campdefs.D.Decay.Days*24*float64(time.Hour))
}
