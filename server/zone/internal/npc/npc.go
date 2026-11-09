// Package npc runs the townsfolk (WP20, spec 5 and 8): who is where at
// what time of day, how they walk there, and what they say and sell. The
// generator (worldgen towns buffer, server/pkg/towns) fixes the people,
// their homes, work spots and names; this package is game logic and may
// change freely with normal deploys (spec 5: only shape is pinned).
//
// Schedules ("out by day, indoors at night"): a working NPC walks to its
// work spot at 07:00 and home at 19:00 (farmers 06:00-18:00); innkeepers
// and guards keep their posts round the clock (the inn is open at night,
// which is where you want to be). Villagers potter around their work spot
// by day. Walking follows the town's streets: out through the door of the
// building it is in, along the street graph (streets, the ring, the
// square), in through the door of the target.
//
// The package is pure (no clocks, no randomness beyond hashes of ids and
// time buckets) so tests can drive it with any time of day; the zone glue
// (internal/game/towns.go) turns active NPCs into snapshot entities.
package npc

import (
	"container/heap"
	"math"

	"lodestone/server/pkg/towns"
)

// DayLengthS is one in-game day (spec 8: 60 real minutes; constants
// DAY_LENGTH_S).
const DayLengthS = 3600

// WalkSpeed is how fast townsfolk walk (m/s).
const WalkSpeed = 1.4

// Goals.
const (
	GoalWork = iota
	GoalHome
	GoalWander
)

// Hour of the in-game day (0..24) at time of day t seconds.
func Hour(todS float64) float64 { return math.Mod(todS, DayLengthS) / DayLengthS * 24 }

// TimeOfDay maps a Unix time (seconds) plus an offset to seconds into the
// day. Day/night are functions of world time and the seed (spec 8); until
// WP15 owns the world clock the zone uses its own clock, like WP10's
// weather stub.
func TimeOfDay(unixS, offsetS float64) float64 {
	t := math.Mod(unixS+offsetS, DayLengthS)
	if t < 0 {
		t += DayLengthS
	}
	return t
}

// State is one NPC's live state.
type State struct {
	Def        *towns.NPC
	X, Y, Z    float64
	Yaw        float64
	VX, VZ     float64
	Goal       int
	path       [][2]float64
	pathI      int
	target     [2]float64
	wanderSlot int64
	At         bool // standing at its goal
}

// World is every NPC of a world plus the street graphs they walk.
type World struct {
	T      *towns.Towns
	Seed   uint64
	NPCs   []State
	graphs []*graph
	// footpaths: per building, the walk from the foot of its door steps
	// along its footpath (and the footpaths it joins) to the street or the
	// square (genVersion 2); nil for doors that open onto the street.
	footpaths map[int][][2]float64
	// SiteName returns an atlas site's display name (bounty texts); may be nil.
	SiteName func(site int) string
	// Sites lists atlas sites usable as bounty targets.
	Sites []Site
}

// Site is the part of an atlas site the bounty board needs.
type Site struct {
	Index    int
	Category uint8 // 0 POI, 1 settlement, 2 structure
	Kind     uint8
	X, Z     float64
	Name     string
}

// New builds the NPC world from a parsed towns buffer.
func New(t *towns.Towns, seed uint64, sites []Site) *World {
	w := &World{T: t, Seed: seed, Sites: sites, footpaths: footpaths(t)}
	for si := range t.Settlements {
		w.graphs = append(w.graphs, buildGraph(t, si))
	}
	w.NPCs = make([]State, len(t.NPCs))
	for i := range t.NPCs {
		w.NPCs[i] = State{Def: &t.NPCs[i]}
	}
	return w
}

// Works reports whether NPC i is at (or heading to) work at hour h.
func (w *World) Works(i int, h float64) bool {
	d := w.NPCs[i].Def
	switch d.Role {
	case towns.RoleInnkeeper, towns.RoleGuard:
		return true
	case towns.RoleFarmer:
		return h >= 6 && h < 18
	}
	return h >= 7 && h < 19
}

// Open reports whether NPC i offers its service now: working and at its post.
func (w *World) Open(i int, todS float64) bool {
	s := &w.NPCs[i]
	return w.Works(i, Hour(todS)) && s.Goal != GoalHome
}

// building returns the building index whose interior contains (x, z), or -1.
func (w *World) building(x, z float64, settlement int) int {
	st := &w.T.Settlements[settlement]
	for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
		bd := &w.T.Buildings[b]
		if bd.Floors == 0 {
			continue
		}
		dx, dz := x-bd.X, z-bd.Z
		u := dx*bd.C + dz*bd.S
		v := dz*bd.C - dx*bd.S
		if math.Abs(u) < bd.HX && math.Abs(v) < bd.HZ {
			return b
		}
	}
	return -1
}

// goalPoint is where NPC i should be for goal g at time of day t.
func (w *World) goalPoint(i, g int, todS float64) [2]float64 {
	d := w.NPCs[i].Def
	switch g {
	case GoalHome:
		return [2]float64{d.HomeX, d.HomeZ}
	case GoalWander:
		// A point within 5 m of the work spot, changing every ~25 s.
		slot := int64(todS / 25)
		h := mix(uint64(d.ID) ^ uint64(slot)*0x9E3779B97F4A7C15)
		a := float64(h&0xFFFF) / 65536 * 2 * math.Pi
		r := 1 + float64((h>>16)&0xFFFF)/65536*4
		return [2]float64{d.WorkX + r*math.Cos(a), d.WorkZ + r*math.Sin(a)}
	}
	return [2]float64{d.WorkX, d.WorkZ}
}

// Want is the goal NPC i should pursue at time of day t.
func (w *World) Want(i int, todS float64) int {
	if !w.Works(i, Hour(todS)) {
		return GoalHome
	}
	if w.NPCs[i].Def.Role == towns.RoleVillager {
		return GoalWander
	}
	return GoalWork
}

// Place puts NPC i where it should be at time t (activation: an NPC
// nobody watched has been living its schedule off-screen). The height is
// the ground viewed from just above the bare surface, so an NPC indoors
// lands on its floor (stilt houses included), never on the roof and never
// in a cave below.
func (w *World) Place(i int, todS float64, ground func(x, y, z float64) float64, surface func(x, z float64) float64) {
	s := &w.NPCs[i]
	s.Goal = w.Want(i, todS)
	p := w.goalPoint(i, s.Goal, todS)
	s.X, s.Z = p[0], p[1]
	// From 2 m above the surface the level view sees every floor within
	// 2.6 m (indoor floors on a downhill plinth, stilt floors, decks) but
	// never a roof (wall tops are >= 2.8 m above any floor).
	s.Y = surface(s.X, s.Z) + 2
	for k := 0; k < 3; k++ {
		s.Y = ground(s.X, s.Y, s.Z)
	}
	s.path, s.pathI, s.target = nil, 0, p
	s.wanderSlot = int64(todS / 25)
	s.VX, s.VZ = 0, 0
	s.Yaw = s.Def.WorkYaw
	s.At = true
}

// Step advances NPC i by dt seconds at time of day t: re-plan when the goal
// changes, walk along the path, snap to the ground (floors, ramps, terrain).
func (w *World) Step(i int, todS, dt float64, ground func(x, y, z float64) float64) {
	s := &w.NPCs[i]
	g := w.Want(i, todS)
	slot := int64(todS / 25)
	if g != s.Goal || s.path == nil && !s.At || (g == GoalWander && slot != s.wanderSlot) {
		s.Goal = g
		s.wanderSlot = slot
		s.target = w.goalPoint(i, g, todS)
		s.path = w.Route(s.Def.Settlement, s.X, s.Z, s.target[0], s.target[1])
		s.pathI = 0
		s.At = false
	}
	s.VX, s.VZ = 0, 0
	if !s.At && s.path != nil {
		left := WalkSpeed * dt
		for left > 0 && s.pathI < len(s.path) {
			p := s.path[s.pathI]
			dx, dz := p[0]-s.X, p[1]-s.Z
			d := math.Hypot(dx, dz)
			if d <= left {
				s.X, s.Z = p[0], p[1]
				left -= d
				s.pathI++
				continue
			}
			s.X += dx / d * left
			s.Z += dz / d * left
			s.VX, s.VZ = dx/d*WalkSpeed, dz/d*WalkSpeed
			s.Yaw = math.Atan2(dz, dx)
			left = 0
		}
		if s.pathI >= len(s.path) {
			s.At = true
			s.path = nil
			if s.Goal == GoalWork {
				s.Yaw = s.Def.WorkYaw
			}
		}
	}
	s.Y = ground(s.X, s.Y, s.Z)
}

// Route is the walking path from (ax, az) to (bx, bz) inside settlement si:
// out of the building the start is in (through its door), along the street
// graph, into the building of the target. The start point is not included.
func (w *World) Route(si int, ax, az, bx, bz float64) [][2]float64 {
	g := w.graphs[si]
	var out [][2]float64
	ba := w.building(ax, az, si)
	bb := w.building(bx, bz, si)
	if ba >= 0 && ba == bb {
		return [][2]float64{{bx, bz}}
	}
	from := [2]float64{ax, az}
	if ba >= 0 {
		out = append(out, w.doorPath(ba, false)...)
		from = out[len(out)-1]
	}
	to := [2]float64{bx, bz}
	var tail [][2]float64
	if bb >= 0 {
		tail = w.doorPath(bb, true)
		to = tail[0]
	}
	out = append(out, g.path(from, to)...)
	out = append(out, tail...)
	return append(out, [2]float64{bx, bz})
}

// doorPath: inside the door, outside it, the street point in front (or the
// reverse when entering). A door with a footpath (genVersion 2: back lanes,
// doors up steps on a slope) walks it: from inside straight down the steps
// to the path's first point (the foot of the steps, on the door's axis) and
// along it to the street.
func (w *World) doorPath(b int, enter bool) [][2]float64 {
	bd := &w.T.Buildings[b]
	ix, iz := bd.Door(-0.9)
	var p [][2]float64
	if fp := w.footpaths[b]; fp != nil {
		p = append([][2]float64{{ix, iz}}, fp...)
	} else {
		ox, oz := bd.Door(1.6)
		if bd.Flags&towns.BuildingPorch != 0 { // porch: step off its far edge
			ox, oz = bd.Door(3.4)
		}
		p = [][2]float64{{ix, iz}, {ox, oz}, {bd.FrontX, bd.FrontZ}}
	}
	if enter {
		for i, j := 0, len(p)-1; i < j; i, j = i+1, j-1 {
			p[i], p[j] = p[j], p[i]
		}
	}
	return p
}

// footpaths follows each building's footpath to the network: its points,
// then those of the footpath it joins from the point nearest the join, and
// so on (bounded: paths join earlier paths, so chains are short).
func footpaths(t *towns.Towns) map[int][][2]float64 {
	out := map[int][][2]float64{}
	for i := range t.Roads {
		r := &t.Roads[i]
		if r.Class != towns.ClassPath || r.From < 0 {
			continue
		}
		var pts [][2]float64
		for _, q := range r.Points {
			pts = append(pts, [2]float64{q[0], q[2]})
		}
		for hop, to := 0, r.To; to >= 0 && to < len(t.Roads) && hop < 16; hop++ {
			n := &t.Roads[to]
			last := pts[len(pts)-1]
			best, bd := 0, math.Inf(1)
			for k, q := range n.Points {
				if d := math.Hypot(q[0]-last[0], q[2]-last[1]); d < bd {
					best, bd = k, d
				}
			}
			for _, q := range n.Points[best+1:] {
				pts = append(pts, [2]float64{q[0], q[2]})
			}
			to = n.To
		}
		out[r.From] = pts
	}
	return out
}

// ---- street graph ------------------------------------------------------

type graph struct {
	pts [][2]float64
	adj [][]int
}

func buildGraph(t *towns.Towns, si int) *graph {
	st := &t.Settlements[si]
	g := &graph{pts: [][2]float64{{st.X, st.Z}}, adj: [][]int{nil}}
	link := func(a, b int) {
		g.adj[a] = append(g.adj[a], b)
		g.adj[b] = append(g.adj[b], a)
	}
	var radialStart, ringN, radN []int
	for r := st.RoadFirst; r < st.RoadFirst+st.Roads; r++ {
		rd := &t.Roads[r]
		if rd.Class != 1 || len(rd.Points) == 0 {
			continue
		}
		first := len(g.pts)
		for k, p := range rd.Points {
			g.pts = append(g.pts, [2]float64{p[0], p[2]})
			g.adj = append(g.adj, nil)
			if k > 0 {
				link(len(g.pts)-2, len(g.pts)-1)
			}
		}
		// A radial street starts at the square's edge; the ring starts and
		// ends at the same point.
		p0, pn := rd.Points[0], rd.Points[len(rd.Points)-1]
		for k := range rd.Points {
			if math.Hypot(p0[0]-pn[0], p0[2]-pn[2]) < 1 {
				ringN = append(ringN, first+k)
			} else {
				radN = append(radN, first+k)
			}
		}
		if math.Hypot(p0[0]-pn[0], p0[2]-pn[2]) < 1 {
			link(first, len(g.pts)-1)
		} else {
			radialStart = append(radialStart, first)
		}
	}
	for _, s := range radialStart {
		link(0, s)
	}
	// Ring nodes join the radial street nodes they cross.
	for _, a := range ringN {
		best, bd := -1, 4.5
		for _, b := range radN {
			if d := math.Hypot(g.pts[a][0]-g.pts[b][0], g.pts[a][1]-g.pts[b][1]); d < bd {
				best, bd = b, d
			}
		}
		if best >= 0 {
			link(a, best)
		}
	}
	return g
}

func (g *graph) nearest(p [2]float64) int {
	best, bd := 0, math.Inf(1)
	for i, q := range g.pts {
		if d := math.Hypot(p[0]-q[0], p[1]-q[1]); d < bd {
			best, bd = i, d
		}
	}
	return best
}

type pq []pqItem
type pqItem struct {
	d float64
	n int
}

func (q pq) Len() int { return len(q) }
func (q pq) Less(i, j int) bool {
	if q[i].d != q[j].d {
		return q[i].d < q[j].d
	}
	return q[i].n < q[j].n
}
func (q pq) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *pq) Push(x any)   { *q = append(*q, x.(pqItem)) }
func (q *pq) Pop() any {
	o := *q
	it := o[len(o)-1]
	*q = o[:len(o)-1]
	return it
}

// path from a to b over the graph (Dijkstra; ends included as points).
func (g *graph) path(a, b [2]float64) [][2]float64 {
	s, t := g.nearest(a), g.nearest(b)
	direct := math.Hypot(a[0]-b[0], a[1]-b[1])
	if s == t || direct < 6 {
		return [][2]float64{b}
	}
	dist := make([]float64, len(g.pts))
	prev := make([]int, len(g.pts))
	for i := range dist {
		dist[i] = math.Inf(1)
		prev[i] = -1
	}
	dist[s] = 0
	q := &pq{{0, s}}
	for q.Len() > 0 {
		it := heap.Pop(q).(pqItem)
		if it.d > dist[it.n] {
			continue
		}
		if it.n == t {
			break
		}
		for _, m := range g.adj[it.n] {
			nd := it.d + math.Hypot(g.pts[it.n][0]-g.pts[m][0], g.pts[it.n][1]-g.pts[m][1])
			if nd < dist[m] {
				dist[m], prev[m] = nd, it.n
				heap.Push(q, pqItem{nd, m})
			}
		}
	}
	if math.IsInf(dist[t], 1) {
		return [][2]float64{b}
	}
	var rev [][2]float64
	for n := t; n >= 0; n = prev[n] {
		rev = append(rev, g.pts[n])
	}
	out := make([][2]float64, 0, len(rev)+1)
	for i := len(rev) - 1; i >= 0; i-- {
		out = append(out, rev[i])
	}
	return append(out, b)
}

// mix is the SplitMix64 finalizer.
func mix(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}
