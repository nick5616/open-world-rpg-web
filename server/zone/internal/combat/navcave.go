package combat

// Pets and summons into caves (playtest 2 pathfinding). Allies walk the
// zone's level ground (the players' "ground at my feet": town floors, cave
// floors under the surface, stepMove) and are kept out of cave walls by the
// ground's push-out; enemies stay on the surface heightfield as before.
//
// A cave's nav graph is the cave graph buffer's own (worldgen README "Cave
// graph buffer": "The enemy nav graph is chambers + these polylines"):
// nodes are chamber centres, every tunnel's four axis points and the
// mouths; edges run along each tunnel and from its ends to the chambers
// they join (an entry tunnel's outer end to its mouth). Shafts and
// sinkholes are left out (nothing walks up a shaft). Built once per system
// on first use, on the tick goroutine.
//
// A route from the surface into a cave is a grid path to a point just
// outside the mouth nearest the walker, then the mouth, the graph's
// shortest chain to the node nearest the goal, and the goal; out of a cave
// the reverse; inside one, the chain alone. The pet's warp stays the
// fallback (no system, no route, or no progress for petCaveWarpS).

import (
	"math"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/movement"
)

// caveQuery is the cave side of the zone's ground (worldhost.CaveTerrain,
// also through the towns wrapper). nil: no caves.
type caveQuery interface {
	CaveGraph() *caves.Graph
	InCave(x, y, z float64) bool
	SystemAt(x, y, z float64) int
}

// caveNav is one system's walking graph.
type caveNav struct {
	pts      []movement.Vec3
	adj      [][]int32
	open     []int32         // mouth nodes
	approach []movement.Vec3 // per mouth: a surface point just outside it
	mouth    int32           // first mouth node (nodes before it are underground)
}

func (w *World) caveNavOf(sys int) *caveNav {
	n := w.nav
	if cn, ok := n.caves[sys]; ok {
		return cn
	}
	if n.caves == nil {
		n.caves = map[int]*caveNav{}
	}
	cn := buildCaveNav(w.caveQ.CaveGraph(), sys)
	n.caves[sys] = cn
	return cn
}

func buildCaveNav(g *caves.Graph, sys int) *caveNav {
	if g == nil || sys < 0 || sys >= len(g.Systems) {
		return nil
	}
	s := &g.Systems[sys]
	cn := &caveNav{}
	add := func(p movement.Vec3) int32 {
		cn.pts = append(cn.pts, p)
		cn.adj = append(cn.adj, nil)
		return int32(len(cn.pts) - 1)
	}
	link := func(a, b int32) {
		cn.adj[a] = append(cn.adj[a], b)
		cn.adj[b] = append(cn.adj[b], a)
	}
	d3 := func(a, b movement.Vec3) float64 { return math.Sqrt(sq(a.X-b.X) + sq(a.Y-b.Y) + sq(a.Z-b.Z)) }
	for k := 0; k < s.Chambers; k++ {
		c := g.Chambers[s.FirstChamber+k]
		add(movement.Vec3{X: c.X, Y: c.Y, Z: c.Z})
	}
	// per tunnel: its first node and the node of its mouth end (entries)
	first := make([]int32, s.Tunnels)
	outer := make([]int32, s.Tunnels)
	inner := make([]int32, s.Tunnels)
	for ti := 0; ti < s.Tunnels; ti++ {
		t := g.TunnelsList[s.FirstTunnel+ti]
		first[ti], outer[ti] = -1, -1
		if t.Kind == 3 || t.A >= s.Chambers || t.B >= s.Chambers {
			continue // a shaft: nothing walks up it
		}
		var ids [4]int32
		for p := 0; p < 4; p++ {
			ids[p] = add(movement.Vec3{X: t.Pts[p*3], Y: t.Pts[p*3+1], Z: t.Pts[p*3+2]})
			if p > 0 {
				link(ids[p-1], ids[p])
			}
		}
		first[ti] = ids[0]
		a, b := int32(t.A), int32(t.B)
		p0, p3 := cn.pts[ids[0]], cn.pts[ids[3]]
		if t.Kind == 0 {
			// entry: the end nearer its chamber joins it, the other is the mouth's
			if d3(p0, cn.pts[a]) <= d3(p3, cn.pts[a]) {
				link(ids[0], a)
				outer[ti], inner[ti] = ids[3], ids[2]
			} else {
				link(ids[3], a)
				outer[ti], inner[ti] = ids[0], ids[1]
			}
			continue
		}
		if d3(p0, cn.pts[a])+d3(p3, cn.pts[b]) <= d3(p0, cn.pts[b])+d3(p3, cn.pts[a]) {
			link(ids[0], a)
			link(ids[3], b)
		} else {
			link(ids[0], b)
			link(ids[3], a)
		}
	}
	cn.mouth = int32(len(cn.pts))
	for oi := 0; oi < s.Openings; oi++ {
		o := g.OpeningsList[s.FirstOpening+oi]
		if o.Sinkhole {
			continue
		}
		ti := o.Tunnel
		if ti >= s.Tunnels && ti-s.FirstTunnel >= 0 && ti-s.FirstTunnel < s.Tunnels {
			ti -= s.FirstTunnel // a global index
		}
		if ti < 0 || ti >= s.Tunnels || outer[ti] < 0 {
			continue
		}
		op := movement.Vec3{X: o.X, Y: o.Y, Z: o.Z}
		id := add(op)
		link(id, outer[ti])
		cn.open = append(cn.open, id)
		// outside: from the tunnel's inner point out through the mouth
		in := cn.pts[inner[ti]]
		dx, dz := o.X-in.X, o.Z-in.Z
		if l := math.Hypot(dx, dz); l > 1e-6 {
			dx, dz = dx/l, dz/l
		} else {
			dx, dz = 1, 0
		}
		cn.approach = append(cn.approach, movement.Vec3{X: o.X + dx*(o.RMask+2), Y: o.Y, Z: o.Z + dz*(o.RMask+2)})
	}
	if len(cn.open) == 0 {
		return nil
	}
	return cn
}

func sq(v float64) float64 { return v * v }

// caveWall: an ally at (x, y, z) in a cave would be pushed out of rock (the
// players' wall push-out on the level ground g).
func (w *World) caveWall(g movement.Ground, x, y, z float64) bool {
	if w.caveQ == nil || !w.caveQ.InCave(x, y, z) {
		return false
	}
	c, ok := g.(movement.Collider)
	if !ok {
		return false
	}
	r := c.Collide(x, y, z)
	return r.PushX != 0 || r.PushZ != 0
}

// nearest is the underground node nearest p (vertical distance counts
// double: never a tunnel on the level above).
func (cn *caveNav) nearest(p movement.Vec3) int32 {
	best, bd := int32(-1), math.Inf(1)
	for i := int32(0); i < cn.mouth; i++ {
		q := cn.pts[i]
		if d := sq(q.X-p.X) + 4*sq(q.Y-p.Y) + sq(q.Z-p.Z); d < bd {
			best, bd = i, d
		}
	}
	return best
}

// mouthNear is the index (in open) of the mouth nearest p on the surface.
func (cn *caveNav) mouthNear(p movement.Vec3) int {
	best, bd := 0, math.Inf(1)
	for k, id := range cn.open {
		if d := hdist(cn.pts[id], p); d < bd {
			best, bd = k, d
		}
	}
	return best
}

// route is the shortest chain of nodes from a to b (Dijkstra; a few dozen
// nodes), a and b included; nil when they are not connected.
func (cn *caveNav) route(a, b int32) []movement.Vec3 {
	if a < 0 || b < 0 {
		return nil
	}
	n := len(cn.pts)
	dist := make([]float64, n)
	prev := make([]int32, n)
	done := make([]bool, n)
	for i := range dist {
		dist[i], prev[i] = math.Inf(1), -1
	}
	dist[a] = 0
	for {
		u, ud := int32(-1), math.Inf(1)
		for i := 0; i < n; i++ {
			if !done[i] && dist[i] < ud {
				u, ud = int32(i), dist[i]
			}
		}
		if u < 0 || u == b {
			break
		}
		done[u] = true
		for _, v := range cn.adj[u] {
			p, q := cn.pts[u], cn.pts[v]
			if nd := ud + math.Sqrt(sq(p.X-q.X)+sq(p.Y-q.Y)+sq(p.Z-q.Z)); nd < dist[v] {
				dist[v], prev[v] = nd, u
			}
		}
	}
	if math.IsInf(dist[b], 1) {
		return nil
	}
	var out []movement.Vec3
	for i := b; i >= 0; i = prev[i] {
		out = append(out, cn.pts[i])
		if i == a {
			break
		}
	}
	for l, r := 0, len(out)-1; l < r; l, r = l+1, r-1 {
		out[l], out[r] = out[r], out[l]
	}
	return out
}

// navCaveCheck (allies, every 10 ticks while walking): the goal and the
// walker on different sides of a cave mouth need a route even while the
// straight step is free (walking on the surface over the cave never
// reaches it).
func (w *World) navCaveCheck(e *Enemy, t movement.Vec3) {
	if e.nav != nil && (e.nav.cave && e.nav.following() || e.nav.queued) {
		return
	}
	if w.caveQ.InCave(e.Pos.X, e.Pos.Y, e.Pos.Z) != w.caveQ.InCave(t.X, t.Y, t.Z) {
		w.navWant(e, t)
	}
}

// navCaveRoute plans e's way to `to` through caves. grid: search the grid
// to gridTo, then append tail; !grid: tail is the whole path. ok false: no
// route (the caller fails the request). Enemies stay on the surface: for
// them, and for two surface points, it is the plain grid search.
func (w *World) navCaveRoute(e *Enemy, to movement.Vec3) (gridTo movement.Vec3, tail []movement.Vec3, ok, grid bool) {
	if e.ally == nil {
		return to, nil, true, true
	}
	inP := w.caveQ.InCave(e.Pos.X, e.Pos.Y, e.Pos.Z)
	inG := w.caveQ.InCave(to.X, to.Y, to.Z)
	if !inP && !inG {
		return to, nil, true, true
	}
	sys := -1
	if inG {
		sys = w.caveQ.SystemAt(to.X, to.Y, to.Z)
	}
	if sys < 0 && inP {
		sys = w.caveQ.SystemAt(e.Pos.X, e.Pos.Y, e.Pos.Z)
	}
	cn := w.caveNavOf(sys)
	if cn == nil {
		return to, nil, false, false
	}
	goal := movement.Vec3{X: to.X, Y: to.Y, Z: to.Z}
	switch {
	case !inP: // in through the mouth nearest the walker
		k := cn.mouthNear(e.Pos)
		chain := cn.route(cn.open[k], cn.nearest(to))
		if chain == nil {
			return to, nil, false, false
		}
		return cn.approach[k], append(chain, goal), true, true
	case !inG: // out through the mouth nearest the goal
		k := cn.mouthNear(to)
		chain := cn.route(cn.nearest(e.Pos), cn.open[k])
		if chain == nil {
			return to, nil, false, false
		}
		return to, append(chain, cn.approach[k], goal), true, false
	default:
		chain := cn.route(cn.nearest(e.Pos), cn.nearest(to))
		if chain == nil {
			return to, nil, false, false
		}
		return to, append(chain, goal), true, false
	}
}
