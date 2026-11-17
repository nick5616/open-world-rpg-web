package camps

// Base building rules (playtest 3, CR 041, contracts/build.yaml): the pure
// half of the building pieces. A building piece is a camp piece whose
// definition carries a campdefs.Shape: where it may stand (grid parity,
// anchor), how it connects (sockets), what it collides with (boxes, walkable
// surfaces) and what it costs. Everything is integer centimetres in the piece's
// local frame, turned by quarter turns, so this file and
// client/src/ui/build/rules.ts agree exactly (golden vectors in
// testdata/build.json).

import (
	"math"
	"slices"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/constants"
)

// More refusal reasons (Event 1103 value), after camps.go's 1-23.
const (
	RefuseGrid      = 24 // not on the build grid (or a turn it can't take)
	RefuseSite      = 25 // inside a ruin, shrine, camp or tower's ground
	RefuseRoad      = 26 // on a road or footpath
	RefuseHigh      = 27 // too high above the ground
	RefuseSupport   = 28 // nothing to rest on or hang from
	RefuseBudget    = 29 // you have placed as many pieces as you may
	RefuseAreaFull  = 30 // this stretch of land has all the pieces it can carry
	RefuseMaterials = 31 // missing materials
	RefuseHolds     = 32 // other pieces rest on it
	RefuseNoHome    = 33 // no bed to go home to
	RefuseCooldown  = 34 // too soon
)

// BP is a placed building piece as the rules see it (centimetres).
type BP struct {
	ID      uint64
	Kind    int
	Rot     int
	X, Y, Z int32
	State   int // bit 0: open (doors, gates)
	Owner   string
	Party   uint32
	Lock    int // 1: shared with the owner's party
}

// Pt3 is a world point in centimetres: x, z, y.
type Pt3 [3]int32

// quarter turns: world (x, z) of local (u, v) for quarter q.
func turn(q int, u, v int) (int, int) {
	switch q & 3 {
	case 1:
		return -v, u
	case 2:
		return -u, -v
	case 3:
		return v, -u
	}
	return u, v
}

func quarter(rot int) int { return (rot >> 1) & 3 }

// World is a local point of p turned and moved to the world.
func world(bp *BP, u, v, y int) Pt3 {
	x, z := turn(quarter(bp.Rot), u, v)
	return Pt3{bp.X + int32(x), bp.Z + int32(z), bp.Y + int32(y)}
}

// Sockets are a piece's world socket points.
func socketsOf(bp *BP, pts []campdefs.Pt) []Pt3 {
	out := make([]Pt3, len(pts))
	for i, p := range pts {
		out[i] = world(bp, p[0], p[1], p[2])
	}
	return out
}

// AABB is a world box in centimetres: x0, x1, z0, z1, y0, y1.
type AABB [6]int32

// OccOf is the piece's occupancy box in the world.
func OccOf(bp *BP, sh *campdefs.Shape) AABB { return boxWorld(bp, sh.Occ) }

func boxWorld(bp *BP, b campdefs.Box6) AABB {
	a := world(bp, b[0], b[2], b[4])
	c := world(bp, b[1], b[3], b[5])
	return AABB{min(a[0], c[0]), max(a[0], c[0]), min(a[1], c[1]), max(a[1], c[1]), bp.Y + int32(b[4]), bp.Y + int32(b[5])}
}

func overlapsBy(a, b AABB, pen int32) bool {
	return a[0]+pen < b[1] && b[0]+pen < a[1] && a[2]+pen < b[3] && b[2]+pen < a[3] && a[4]+pen < b[5] && b[4]+pen < a[5]
}

func near(a, b AABB, d int32) bool {
	return a[0]-d < b[1] && b[0]-d < a[1] && a[2]-d < b[3] && b[2]-d < a[3] && a[4]-d < b[5]+300 && b[4]-d < a[5]+300
}

// Builds reports a kind that is a building piece.
func Builds(kind int) bool {
	p := campdefs.D.ByID(kind)
	return p != nil && p.Build != nil
}

// ---- collision geometry ----

// LocalBoxes are the boxes a piece collides with (a door's depend on State).
func LocalBoxes(sh *campdefs.Shape, state int) []campdefs.Box6 {
	if sh.Door && state&1 == 1 && sh.OpenBoxes != nil {
		return *sh.OpenBoxes
	}
	return sh.Boxes
}

// BoxesOf is a building piece's collision boxes in the towns layout (x, z,
// cos, sin, hx, hz, bottom, top, top), centimetres divided by 100 (the twin
// does the same division).
func BoxesOf(bp *BP) [][9]float64 {
	d := campdefs.D.ByID(bp.Kind)
	if d == nil || d.Build == nil {
		return nil
	}
	lb := LocalBoxes(d.Build, bp.State)
	cs, sn := Rot(bp.Rot)
	out := make([][9]float64, 0, len(lb))
	for _, b := range lb {
		cu, cv := (b[0]+b[1])/2, (b[2]+b[3])/2
		wx, wz := turn(quarter(bp.Rot), cu, cv)
		top := float64(int(bp.Y)+b[5]) / 100
		out = append(out, [9]float64{
			float64(int(bp.X)+wx) / 100, float64(int(bp.Z)+wz) / 100, cs, sn,
			float64(b[1]-b[0]) / 2 / 100, float64(b[3]-b[2]) / 2 / 100,
			float64(int(bp.Y)+b[4])/100 - 0, top, top,
		})
	}
	return out
}

// SurfaceOf is a walkable surface: centre x, z, cos, sin, half extents and the
// heights at local u = -hx and u = +hx.
type SurfaceOf struct {
	X, Z, Cs, Sn, Hx, Hz, Ya, Yb float64
}

// SurfacesOf are a piece's walkable surfaces (foundations, floors, stairs,
// ramps).
func SurfacesOf(bp *BP) (SurfaceOf, bool) {
	d := campdefs.D.ByID(bp.Kind)
	if d == nil || d.Build == nil || d.Build.Surface == nil {
		return SurfaceOf{}, false
	}
	s := d.Build.Surface
	cu, cv := (s[0]+s[1])/2, (s[2]+s[3])/2
	wx, wz := turn(quarter(bp.Rot), cu, cv)
	cs, sn := Rot(bp.Rot)
	return SurfaceOf{
		X: float64(int(bp.X)+wx) / 100, Z: float64(int(bp.Z)+wz) / 100, Cs: cs, Sn: sn,
		Hx: float64(s[1]-s[0]) / 2 / 100, Hz: float64(s[3]-s[2]) / 2 / 100,
		Ya: float64(int(bp.Y)+s[4]) / 100, Yb: float64(int(bp.Y)+s[5]) / 100,
	}, true
}

// ---- support ----

// BuildEnv is what the building rules ask of the world.
type BuildEnv interface {
	Env
	// NoBuild: 0 or RefuseTown / RefuseSite / RefuseRoad for a point and the radius around it.
	NoBuild(x, z, r float64) int
}

func ptIn(p Pt3, l []Pt3) bool { return slices.Contains(l, p) }

func sharesPt(a, b []Pt3) bool {
	for _, p := range a {
		if slices.Contains(b, p) {
			return true
		}
	}
	return false
}

type node struct {
	bp                *BP
	def               *campdefs.Piece
	up, down, side, f []Pt3
	depth             int
	stable            bool
}

func newNode(bp *BP) *node {
	d := campdefs.D.ByID(bp.Kind)
	if d == nil || d.Build == nil {
		return nil
	}
	sh := d.Build
	return &node{bp: bp, def: d, up: socketsOf(bp, sh.Up), down: socketsOf(bp, sh.Down), side: socketsOf(bp, sh.Side), f: socketsOf(bp, sh.Face)}
}

func hasAnchor(sh *campdefs.Shape, a string) bool { return slices.Contains(sh.Anchor, a) }

// rooted: stands on its own (a foundation, or a ground piece on the ground).
func rooted(n *node, env Env) bool {
	sh := n.def.Build
	if hasAnchor(sh, "foundation") {
		return true
	}
	if hasAnchor(sh, "ground") || hasAnchor(sh, "surface") {
		g := world(n.bp, sh.Gpt[0], sh.Gpt[1], 0)
		h := M2Cm(env.HeightAt(float64(g[0])/100, float64(g[1])/100))
		if d := h - n.bp.Y; d >= -groundTol && d <= groundTol {
			return true
		}
	}
	return false
}

// groundTol is how far (cm) a ground piece's height may differ from the
// terrain the client measured.
const groundTol = 3

// Supported reports whether n is held up by the stable nodes (and its depth).
func supported(n *node, stable []*node) (bool, int) {
	sh := n.def.Build
	if hasAnchor(sh, "wall") {
		pt := Pt3{n.bp.X, n.bp.Z, n.bp.Y}
		for _, q := range stable {
			if ptIn(pt, q.f) {
				return true, 0
			}
		}
		return false, 0
	}
	if hasAnchor(sh, "surface") {
		for _, q := range stable {
			if s, ok := SurfacesOf(q.bp); ok && s.Ya == s.Yb && math.Abs(s.Ya*100-float64(n.bp.Y)) < 1 && onRect(s, float64(n.bp.X)/100, float64(n.bp.Z)/100) {
				return true, 0
			}
		}
	}
	if !hasAnchor(sh, "sockets") || len(n.down) == 0 && len(n.side) == 0 {
		return false, 0
	}
	for _, q := range stable {
		if sharesPt(n.down, q.up) {
			return true, 0
		}
	}
	if sh.Reach > 0 {
		best := -1
		for _, q := range stable {
			if len(q.side) > 0 && sharesPt(n.side, q.side) && q.depth < sh.Reach {
				if best < 0 || q.depth+1 < best {
					best = q.depth + 1
				}
			}
		}
		if best > 0 {
			return true, best
		}
	}
	return false, 0
}

func onRect(s SurfaceOf, x, z float64) bool {
	dx, dz := x-s.X, z-s.Z
	u := dx*s.Cs + dz*s.Sn
	v := dz*s.Cs - dx*s.Sn
	return math.Abs(u) <= s.Hx+1e-9 && math.Abs(v) <= s.Hz+1e-9
}

// stabilize returns the held-up nodes (rooted, or supported through sockets
// from a rooted piece) with their lateral depth.
func stabilize(ps []*BP, env Env) []*node {
	nodes := make([]*node, 0, len(ps))
	for _, p := range ps {
		if n := newNode(p); n != nil {
			nodes = append(nodes, n)
		}
	}
	var stable []*node
	for _, n := range nodes {
		if rooted(n, env) {
			n.stable = true
			stable = append(stable, n)
		}
	}
	for changed := true; changed; {
		changed = false
		for _, n := range nodes {
			if n.stable {
				continue
			}
			if ok, d := supported(n, stable); ok {
				n.stable, n.depth = true, d
				stable = append(stable, n)
				changed = true
			}
		}
	}
	return stable
}

// Stability returns the ids of the pieces that are held up.
func Stability(ps []*BP, env Env) map[uint64]bool {
	st := stabilize(ps, env)
	out := make(map[uint64]bool, len(st))
	for _, n := range st {
		out[n.bp.ID] = true
	}
	return out
}

// Orphans lists the pieces of ps that are held up now but would not be
// without piece id (what a deconstruct would drop).
func Orphans(ps []*BP, id uint64, env Env) []uint64 {
	before := Stability(ps, env)
	rest := make([]*BP, 0, len(ps))
	for _, p := range ps {
		if p.ID != id {
			rest = append(rest, p)
		}
	}
	after := Stability(rest, env)
	var out []uint64
	for _, p := range rest {
		if before[p.ID] && !after[p.ID] {
			out = append(out, p.ID)
		}
	}
	return out
}

// ---- placement ----

// BuildWant is one placement request.
type BuildWant struct {
	Kind, Rot int
	X, Y, Z   int32 // cm; Y is the client's height (0 with HasY false: let the server pick)
	HasY      bool
	Owner     string
	Party     uint32
	FeetX     float64
	FeetY     float64
	FeetZ     float64
}

func parityOK(sh *campdefs.Shape, rot int, x, z int32) bool {
	if sh.Par == nil {
		return x%50 == 0 && z%50 == 0
	}
	px, pz := sh.Par[0], sh.Par[1]
	if quarter(rot)&1 == 1 {
		px, pz = pz, px
	}
	return mod(int(x), 200) == px && mod(int(z), 200) == pz
}

func mod(a, m int) int { return ((a % m) + m) % m }

func snapUp(cm int, step int) int {
	return int(math.Ceil(float64(cm)/float64(step)-1e-9)) * step
}

// Allows reports whether actor may touch (build next to, use, repair,
// deconstruct) a piece: the owner, or the owner's party when shared.
func Allows(actor string, actorParty uint32, p *BP) bool {
	return p.Owner == actor || (p.Lock == 1 && p.Party != 0 && p.Party == actorParty)
}

// CheckBuild validates a building piece's placement and returns its base
// height in centimetres. `all` is every piece within ~16 m of the spot (the
// zone passes its area index); the budgets are the zone's.
func CheckBuild(w BuildWant, all []*BP, env BuildEnv) (int32, int) {
	d := campdefs.D
	def := d.ByID(w.Kind)
	if def == nil || def.Build == nil {
		return 0, RefuseUnknown
	}
	sh := def.Build
	b := &d.Build
	if w.Rot&1 != 0 || w.Rot < 0 || w.Rot > 7 {
		return 0, RefuseGrid
	}
	if !parityOK(sh, w.Rot, w.X, w.Z) {
		return 0, RefuseGrid
	}
	x, z := float64(w.X)/100, float64(w.Z)/100
	if x < 4 || z < 4 || x > constants.WorldSizeM-4 || z > constants.WorldSizeM-4 {
		return 0, RefuseTooFar
	}
	if math.Hypot(x-w.FeetX, z-w.FeetZ) > b.ReachM {
		return 0, RefuseTooFar
	}
	if why := env.NoBuild(x, z, math.Hypot(def.W, def.D)/2); why != 0 {
		return 0, why
	}
	surf := env.HeightAt(x, z)
	if w.FeetY < surf-d.Placement.MaxDepthM {
		return 0, RefuseUnderground
	}
	bp := &BP{Kind: w.Kind, Rot: w.Rot, X: w.X, Z: w.Z, Owner: w.Owner, Party: w.Party}
	// Height.
	y, why := buildHeight(w, bp, sh, all, env)
	if why != 0 {
		return 0, why
	}
	bp.Y = y
	if float64(y)/100 > surf+b.MaxHeightM {
		return 0, RefuseHigh
	}
	// Water under ground-standing pieces.
	if hasAnchor(sh, "foundation") || hasAnchor(sh, "ground") {
		f := FootprintOf(w.Kind, w.Rot, x, z)
		cs := f.Corners(0)
		for _, c := range append(cs[:], [2]float64{x, z}) {
			if env.WaterAt(c[0], c[1]) > env.HeightAt(c[0], c[1])-0.05 {
				return 0, RefuseWater
			}
		}
	}
	occ := OccOf(bp, sh)
	for _, q := range all {
		qd := d.ByID(q.Kind)
		if qd == nil {
			continue
		}
		if qd.Build == nil {
			// A camp piece: footprints must not overlap.
			if FootprintOf(w.Kind, w.Rot, x, z).Overlaps(FootprintOf(q.Kind, q.Rot, float64(q.X)/100, float64(q.Z)/100), d.Placement.GapM/2) {
				return 0, RefuseBlocked
			}
			continue
		}
		qocc := OccOf(q, qd.Build)
		if overlapsBy(occ, qocc, 4) && !coexists(sh, qd.Build) {
			return 0, RefuseBlocked
		}
		if q.Owner != w.Owner && !(q.Lock == 1 && q.Party != 0 && q.Party == w.Party) && near(occ, qocc, int32(b.OtherBuildM*100)) {
			return 0, RefuseOtherCamp
		}
	}
	if env.Structure(FootprintOf(w.Kind, w.Rot, x, z)) {
		return 0, RefuseBlocked
	}
	return y, 0
}

func coexists(a, b *campdefs.Shape) bool {
	return slices.Contains(a.Coexist, b.Base) || slices.Contains(b.Coexist, a.Base)
}

// buildHeight resolves the piece's base height by its anchor.
func buildHeight(w BuildWant, bp *BP, sh *campdefs.Shape, all []*BP, env BuildEnv) (int32, int) {
	b := &campdefs.D.Build
	x, z := float64(w.X)/100, float64(w.Z)/100
	// Foundations: level on the ground, or flush with a neighbouring foundation.
	if hasAnchor(sh, "foundation") {
		lo, hi := math.Inf(1), math.Inf(-1)
		f := FootprintOf(bp.Kind, bp.Rot, x, z)
		cs := f.Corners(0)
		for _, c := range append(cs[:], [2]float64{x, z}) {
			h := env.HeightAt(c[0], c[1])
			lo, hi = min(lo, h), max(hi, h)
		}
		if hi-lo > b.Foundation.MaxSpreadM {
			return 0, RefuseSlope
		}
		snap := int(math.Round(b.Foundation.SnapM * 100))
		def0 := int32(snapUp(int(math.Ceil(hi*100-1e-6)), snap))
		ok := func(y int32) bool {
			return hi <= float64(y)/100+b.Foundation.MaxBuriedM+1e-9 && lo >= float64(y)/100-b.Foundation.SkirtM-1e-9
		}
		var alts []int32
		if ok(def0) {
			alts = append(alts, def0)
		}
		n := newNode(bp)
		for _, q := range all {
			qd := campdefs.D.ByID(q.Kind)
			if qd == nil || qd.Build == nil || !hasAnchor(qd.Build, "foundation") {
				continue
			}
			// Flush neighbour: its side socket is mine at some height.
			for _, qs := range socketsOf(q, qd.Build.Side) {
				for _, ms := range n.side {
					if qs[0] == ms[0] && qs[1] == ms[1] {
						if ok(q.Y) && !slices.Contains(alts, q.Y) {
							alts = append(alts, q.Y)
						}
					}
				}
			}
		}
		if len(alts) == 0 {
			return 0, RefuseSlope
		}
		if w.HasY {
			if slices.Contains(alts, w.Y) {
				return w.Y, 0
			}
			return 0, RefuseSupport
		}
		return alts[len(alts)-1], 0
	}
	// Ground pieces (and sockets pieces that can also stand on the ground).
	if hasAnchor(sh, "ground") {
		g := world(bp, sh.Gpt[0], sh.Gpt[1], 0)
		gh := M2Cm(env.HeightAt(float64(g[0])/100, float64(g[1])/100))
		if !w.HasY || absI(int(w.Y-gh)) <= groundTol {
			return gh, 0
		}
	}
	if !w.HasY {
		if hasAnchor(sh, "surface") {
			return M2Cm(env.HeightAt(x, z)), 0
		}
		return 0, RefuseSupport
	}
	bp.Y = w.Y
	switch {
	case hasAnchor(sh, "wall"), hasAnchor(sh, "sockets"):
		if okSupport(bp, all, env) {
			return w.Y, 0
		}
		return 0, RefuseSupport
	case hasAnchor(sh, "surface"):
		if absI(int(w.Y-M2Cm(env.HeightAt(x, z)))) <= groundTol {
			return M2Cm(env.HeightAt(x, z)), 0
		}
		if okSupport(bp, all, env) {
			return w.Y, 0
		}
		return 0, RefuseSupport
	}
	return 0, RefuseSupport
}

func absI(a int) int {
	if a < 0 {
		return -a
	}
	return a
}

// okSupport: bp would be held up by the stable pieces among all.
func okSupport(bp *BP, all []*BP, env Env) bool {
	n := newNode(bp)
	if n == nil {
		return false
	}
	ok, _ := supported(n, stabilize(all, env))
	return ok
}
