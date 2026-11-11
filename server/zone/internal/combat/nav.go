package combat

// Enemy pathfinding (playtest 2): the navigation grid and its search.
//
// A coarse walkability grid derived from what the zone already knows, the
// same rules stepMove applies to every enemy step: the ground's height
// (slopes: an edge may not climb more than navMaxRise), water (deeper than
// 0.6 m) and World.Obstacles (town boxes, closed doors, solid camp pieces).
// 0.5 m cells, built lazily per 16 m chunk the first time a search touches
// it, cached (deterministic LRU) and dropped by NavInvalidate when a door
// or a camp piece changes. Each cell stores its height and one bit per body
// class (navClassR): "a body this wide, with its feet on the ground here,
// overlaps no obstacle".
//
// Searches are weighted A* (octile x navHeur, 8-connected, no corner
// cutting, uphill-limited directed edges) inside a 128 m window around
// start and goal, on a shared arena: only one search is in flight at a
// time, the rest wait in a FIFO, and a global per-tick budget of node
// expansions (navTickBudget; a chunk build costs navChunkCost) slices long
// searches across ticks (navai.go). A search that has not arrived after
// navFloodAfter expansions floods the goal's pocket once (navFlood): a
// player in a shut house fails in a few hundred cells, not a window's
// worth. The cell path is string-pulled with grid line of sight into a few
// waypoints. Everything here runs on the tick goroutine (the serial nav
// pass after the enemy loop); AI workers only read built chunks
// (navPeekLOS, navshare.go), never build or evict them.

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

const (
	navCell       = 0.5                // m per grid cell
	navChunk      = 32                 // cells per chunk edge (16 m)
	navChunkM     = navCell * navChunk // m per chunk edge
	navPerEdge    = int32(constants.WorldSizeM / navChunkM)
	navWinChunks  = 8                       // search window edge in chunks (128 m)
	navWin        = navWinChunks * navChunk // search window edge in cells
	navClasses    = 3
	navTickBudget = 1200  // node expansions per tick, all searches together (~0.1 ms)
	navSearchCap  = 16000 // expansions before a search gives up (partial path)
	navChunkCost  = 160   // budget units one chunk build costs (1,024 cells sampled)
	navCacheMax   = 768   // chunks kept (~4 MB)
	navMaxRise    = 0.5   // m an edge may climb (enemy steps refuse ~0.35 m + 1.3 x step)
	navLOSRise    = 0.35  // m a smoothed leg may climb between two cells (margin for a walker off the line)
	navWaterDepth = 0.6   // m of water an enemy wades (stepMove)
	navHeur       = 2.0   // A* heuristic weight (greedy: far fewer expansions; smoothing straightens)
	navMaxLeg     = 32    // cells a smoothed leg spans at most (bounds the smoothing's line-of-sight cost)
)

// navClassR are the body radii the grid is sampled for (with their head
// heights navClassH): a body of radius r uses the first class whose radius
// is at least r - 0.1 (navClassOf).
var (
	navClassR = [navClasses]float64{0.45, 0.75, 1.25}
	navClassH = [navClasses]float64{1.62, 2.7, 4.5}
)

func navClassOf(r float64) uint8 {
	for c := 0; c < navClasses; c++ {
		if navClassR[c] >= r-0.1 {
			return uint8(c)
		}
	}
	return navClasses - 1
}

// navChunkData is one 16 m chunk: heights and per-class walkable bits.
type navChunkData struct {
	h    [navChunk * navChunk]float32
	walk [navChunk * navChunk]uint8
	used uint32 // tick of the last search that touched it (LRU)
}

// navWorld is the grid cache, the search arena and the request queue.
type navWorld struct {
	chunks map[int32]*navChunkData
	// arena (one search at a time, generation-stamped)
	g      []float32
	par    []int32
	stamp  []uint32
	closed []uint32
	gen    uint32
	fstamp []uint32 // navFlood's own stamps and queue
	fgen   uint32
	fq     []int32
	heap   []uint64
	cells  []int32 // path reconstruction scratch
	cur    *navSearch
	queue  []*Enemy
	caves  map[int]*caveNav // cave systems' graphs (navcave.go)
	recent [navRecent]navCached
	nextRc int
	// stats (tests, benchmarks)
	Stats NavStats
}

// navCached is a recent search's answer, shared with walkers asking for
// nearly the same thing (a pack chasing one player round one house).
type navCached struct {
	class uint8
	ok    bool
	tick  uint32
	from  movement.Vec3
	goal  movement.Vec3
	pts   []movement.Vec3 // the path's start, then its waypoints
}

const (
	navRecent     = 32
	navReuseTicks = 90  // a cached answer is good for 3 s (doors and camps clear them)
	navReuseGoal  = 1.5 // m: the goals of two asks this close are the same goal
	navReuseJoin  = 6.0 // m: a walker joins a cached path at a point of it this close it can see
)

// NavStats are cumulative counters of the nav pass.
type NavStats struct {
	Requests, Paths, Partial, Failed, CavePaths int64
	Shared, SharedFail                          int64 // asks answered from a recent search
	Expanded, ChunkBuilds, Evicted, Invalidated int64
	MaxTickUnits                                int64 // most budget units spent in one tick
	MaxQueue                                    int64
}

func newNavWorld() *navWorld {
	n := navWin * navWin
	return &navWorld{chunks: map[int32]*navChunkData{}, g: make([]float32, n), par: make([]int32, n), stamp: make([]uint32, n), closed: make([]uint32, n)}
}

// NavStats reports the pathfinding counters (zero before the first request).
func (w *World) NavStats() NavStats {
	if w.nav == nil {
		return NavStats{}
	}
	return w.nav.Stats
}

// NavInvalidate drops the grid chunks within r of the box [x0, x1] x [z0,
// z1] (a door opened or closed, a camp piece placed or picked up). Tick
// goroutine, outside the combat phase.
func (w *World) NavInvalidate(x0, z0, x1, z1 float64) {
	if w.nav == nil {
		return
	}
	for i := range w.nav.recent { // shared answers may run through the change
		w.nav.recent[i].pts = w.nav.recent[i].pts[:0]
	}
	if s := w.nav.cur; s != nil {
		// the search in flight may hold the old chunks: start it again
		w.nav.cur = nil
		w.nav.queue = append([]*Enemy{s.e}, w.nav.queue...)
	}
	if len(w.nav.chunks) == 0 {
		return
	}
	m := navClassR[navClasses-1] + 1
	cx0, cx1 := int32(math.Floor((x0-m)/navChunkM)), int32(math.Floor((x1+m)/navChunkM))
	cz0, cz1 := int32(math.Floor((z0-m)/navChunkM)), int32(math.Floor((z1+m)/navChunkM))
	for cz := cz0; cz <= cz1; cz++ {
		for cx := cx0; cx <= cx1; cx++ {
			if cx < 0 || cz < 0 || cx >= navPerEdge || cz >= navPerEdge {
				continue
			}
			k := cz*navPerEdge + cx
			if _, ok := w.nav.chunks[k]; ok {
				delete(w.nav.chunks, k)
				w.nav.Stats.Invalidated++
			}
		}
	}
}

// navBuild samples one chunk (the rules of stepMove at every cell centre).
func (w *World) navBuild(cx, cz int32) *navChunkData {
	c := &navChunkData{}
	edge := float64(constants.WorldSizeM)
	for j := 0; j < navChunk; j++ {
		z := (float64(cz*navChunk+int32(j)) + 0.5) * navCell
		for i := 0; i < navChunk; i++ {
			x := (float64(cx*navChunk+int32(i)) + 0.5) * navCell
			k := j*navChunk + i
			if x < 1 || z < 1 || x > edge-1 || z > edge-1 {
				c.h[k] = float32(math.Inf(1))
				continue
			}
			gy := w.ground.HeightAt(x, z)
			c.h[k] = float32(gy)
			if movement.WaterAt(w.ground, x, z) > gy+navWaterDepth {
				continue
			}
			if w.Obstacles == nil {
				c.walk[k] = 1<<navClasses - 1
				continue
			}
			// widest first: open ground answers with one query
			for cl := navClasses - 1; cl >= 0; cl-- {
				if !w.Obstacles(x, gy, z, navClassR[cl], navClassH[cl]) {
					c.walk[k] = 1<<(cl+1) - 1
					break
				}
			}
		}
	}
	return c
}

// navChunkAt returns chunk (cx, cz), building it (and evicting the least
// recently used one past navCacheMax) when missing. units is charged.
func (w *World) navChunkAt(cx, cz int32, units *int) *navChunkData {
	n := w.nav
	k := cz*navPerEdge + cx
	c := n.chunks[k]
	if c == nil {
		c = w.navBuild(cx, cz)
		n.Stats.ChunkBuilds++
		*units += navChunkCost
		if len(n.chunks) >= navCacheMax {
			// oldest, ties by key: the same choice whatever the map order
			var vk int32 = -1
			var vu uint32
			for kk, cc := range n.chunks {
				if vk < 0 || cc.used < vu || (cc.used == vu && kk < vk) {
					vk, vu = kk, cc.used
				}
			}
			delete(n.chunks, vk)
			n.Stats.Evicted++
		}
		n.chunks[k] = c
	}
	c.used = w.tick
	return c
}

func navCellOf(v float64) int32 { return int32(math.Floor(v / navCell)) }
func navCenter(c int32) float64 { return (float64(c) + 0.5) * navCell }

// ---- the search ----

// navSearch is the in-flight A* (one at a time; the arena is navWorld's).
type navSearch struct {
	e        *Enemy
	class    uint8
	wx0, wz0 int32 // window origin (global cells, chunk aligned)
	slots    [navWinChunks * navWinChunks]*navChunkData
	start    int32
	goal     int32
	goalPos  movement.Vec3
	best     int32
	bestH    float32
	startH   float32
	expanded int
	done     bool
	found    bool
	// goalSnapped: the goal's own cell is blocked for this body; the path
	// ends at the nearest open cell instead.
	goalSnapped bool
	tail        []movement.Vec3 // cave waypoints appended after the grid path (navcave.go)
	floodable   bool            // the goal has an open cell: navFlood can test its pocket
	from        movement.Vec3   // where the walker stood when the search began (navshare.go)
}

// cell returns window cell i's height and walk bits (building its chunk if
// needed, charging units).
func (w *World) navSearchCell(s *navSearch, i int32, units *int) (float32, uint8) {
	lx, lz := i%navWin, i/navWin
	si := (lz/navChunk)*navWinChunks + lx/navChunk
	c := s.slots[si]
	if c == nil {
		c = w.navChunkAt(s.wx0/navChunk+lx/navChunk, s.wz0/navChunk+lz/navChunk, units)
		s.slots[si] = c
	}
	k := (lz%navChunk)*navChunk + lx%navChunk
	return c.h[k], c.walk[k]
}

func navOctile(ax, az, bx, bz int32) float32 {
	dx, dz := ax-bx, az-bz
	if dx < 0 {
		dx = -dx
	}
	if dz < 0 {
		dz = -dz
	}
	if dx < dz {
		dx, dz = dz, dx
	}
	return float32(dx-dz) + float32(dz)*1.41421356
}

// navBegin sets up a search from `from` to `to` for a body class; false when
// the two are too far apart for one window.
func (w *World) navBegin(e *Enemy, from, to movement.Vec3, class uint8) (*navSearch, bool) {
	fx, fz, tx, tz := navCellOf(from.X), navCellOf(from.Z), navCellOf(to.X), navCellOf(to.Z)
	// chunk-aligned window centred between the two
	mcx := (fx+tx)/2/navChunk - navWinChunks/2
	mcz := (fz+tz)/2/navChunk - navWinChunks/2
	mcx = min(max(mcx, 0), navPerEdge-navWinChunks)
	mcz = min(max(mcz, 0), navPerEdge-navWinChunks)
	s := &navSearch{e: e, class: class, wx0: mcx * navChunk, wz0: mcz * navChunk, goalPos: to}
	in := func(x, z int32) bool {
		return x >= s.wx0+1 && z >= s.wz0+1 && x < s.wx0+navWin-1 && z < s.wz0+navWin-1
	}
	if !in(fx, fz) || !in(tx, tz) {
		return nil, false
	}
	s.start = (fz-s.wz0)*navWin + (fx - s.wx0)
	s.goal = (tz-s.wz0)*navWin + (tx - s.wx0)
	return s, true
}

// navSnap moves a window cell to the nearest walkable one within r cells
// (rings outward, fixed order); -1 when none.
func (w *World) navSnap(s *navSearch, i int32, r int32, units *int) int32 {
	bit := uint8(1) << s.class
	if _, wk := w.navSearchCell(s, i, units); wk&bit != 0 {
		return i
	}
	lx, lz := i%navWin, i/navWin
	for d := int32(1); d <= r; d++ {
		best, bestD := int32(-1), int32(1<<30)
		for dz := -d; dz <= d; dz++ {
			for dx := -d; dx <= d; dx++ {
				if max(abs32(dx), abs32(dz)) != d {
					continue
				}
				x, z := lx+dx, lz+dz
				if x < 1 || z < 1 || x >= navWin-1 || z >= navWin-1 {
					continue
				}
				j := z*navWin + x
				if _, wk := w.navSearchCell(s, j, units); wk&bit != 0 && dx*dx+dz*dz < bestD {
					best, bestD = j, dx*dx+dz*dz
				}
			}
		}
		if best >= 0 {
			return best
		}
	}
	return -1
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

var navDirs = [8][3]int32{{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {1, 1, 1}, {-1, 1, 1}, {1, -1, 1}, {-1, -1, 1}}

// navStart initialises the arena for s (snapping start and goal).
func (w *World) navStart(s *navSearch, units *int) bool {
	n := w.nav
	st := w.navSnap(s, s.start, 4, units)
	if st < 0 {
		return false
	}
	s.start = st
	gl := w.navSnap(s, s.goal, 6, units)
	if gl >= 0 && gl != s.goal {
		s.goal, s.goalSnapped = gl, true
	}
	s.floodable = gl >= 0
	n.nextGen()
	n.heap = n.heap[:0]
	gx, gz := s.goal%navWin, s.goal/navWin
	h := navOctile(s.start%navWin, s.start/navWin, gx, gz)
	n.stamp[s.start] = n.gen
	n.g[s.start] = 0
	n.par[s.start] = -1
	s.best, s.bestH, s.startH = s.start, h, h
	w.navPush(s.start, h*navHeur)
	return true
}

func (n *navWorld) nextGen() {
	n.gen++
	if n.gen == 0 { // wrapped: clear the stamps once every 4 billion searches
		clear(n.stamp)
		clear(n.closed)
		n.gen = 1
	}
}

// navFloodAfter: a search that has not reached its goal after this many
// expansions floods the goal's pocket (navFlood) once; navFloodCap is how
// many cells that flood fills before it assumes the region is open (a closed
// house of up to ~375 m2 is caught).
const (
	navFloodAfter = 600
	navFloodCap   = 1500
)

// navFlood fills the goal's region backwards (cells that can walk to it)
// up to navFloodCap cells: false when the region is closed and the start is
// not in it, so an unreachable goal (a player in a shut house, on a sheer
// rock) costs a few hundred cells instead of a whole window's search.
// Reachability with the no-corner-cutting diagonals is the 4-neighbour one,
// so the flood uses those. Own stamps and queue: the search's are live.
func (w *World) navFlood(s *navSearch, units *int) bool {
	n := w.nav
	if n.fstamp == nil {
		n.fstamp = make([]uint32, navWin*navWin)
	}
	n.fgen++
	if n.fgen == 0 {
		clear(n.fstamp)
		n.fgen = 1
	}
	bit := uint8(1) << s.class
	q := append(n.fq[:0], s.goal)
	n.fstamp[s.goal] = n.fgen
	defer func() { n.fq = q[:0] }()
	units0 := *units
	for head := 0; head < len(q); head++ {
		if head >= navFloodCap || *units-units0 > navFloodCap {
			return true
		}
		i := q[head]
		if i == s.start {
			return true
		}
		*units++
		hi, _ := w.navSearchCell(s, i, units)
		lx, lz := i%navWin, i/navWin
		for _, dir := range navDirs[:4] {
			x, z := lx+dir[0], lz+dir[1]
			if x < 0 || z < 0 || x >= navWin || z >= navWin {
				continue
			}
			j := z*navWin + x
			if n.fstamp[j] == n.fgen {
				continue
			}
			hj, wk := w.navSearchCell(s, j, units)
			if wk&bit == 0 || hi-hj > navMaxRise { // j -> i must be a walkable edge
				continue
			}
			n.fstamp[j] = n.fgen
			q = append(q, j)
		}
	}
	return false
}

// The open list is a binary heap of uint64 keys: f's float32 bits (f >= 0,
// so they order like f) above the cell index, so ties go to the lower cell
// and the expansion order is fixed. Stale entries (a cell re-pushed
// cheaper) are skipped when popped closed.
func (w *World) navPush(i int32, f float32) {
	n := w.nav
	h := append(n.heap, uint64(math.Float32bits(f))<<32|uint64(uint32(i)))
	k := len(h) - 1
	v := h[k]
	for k > 0 {
		p := (k - 1) / 2
		if h[p] <= v {
			break
		}
		h[k] = h[p]
		k = p
	}
	h[k] = v
	n.heap = h
}

func (w *World) navPop() int32 {
	n := w.nav
	h := n.heap
	top := int32(uint32(h[0]))
	last := len(h) - 1
	v := h[last]
	h = h[:last]
	if last > 0 {
		k := 0
		for {
			l := 2*k + 1
			if l >= last {
				break
			}
			if r := l + 1; r < last && h[r] < h[l] {
				l = r
			}
			if v <= h[l] {
				break
			}
			h[k] = h[l]
			k = l
		}
		h[k] = v
	}
	n.heap = h
	return top
}

// navRun expands up to `allow` nodes of s; returns the units spent.
func (w *World) navRun(s *navSearch, allow int) int {
	n := w.nav
	units := 0
	bit := uint8(1) << s.class
	gx, gz := s.goal%navWin, s.goal/navWin
	for units < allow && len(n.heap) > 0 {
		i := w.navPop()
		if n.closed[i] == n.gen {
			continue
		}
		n.closed[i] = n.gen
		s.expanded++
		units++
		if i == s.goal {
			s.done, s.found = true, true
			break
		}
		lx, lz := i%navWin, i/navWin
		if h := navOctile(lx, lz, gx, gz); h < s.bestH {
			s.best, s.bestH = i, h
		}
		if s.expanded >= navSearchCap {
			s.done = true
			break
		}
		if s.expanded >= navFloodAfter && s.floodable && allow-units >= navFloodCap {
			s.floodable = false // once, when this tick's budget can take it
			if !w.navFlood(s, &units) {
				s.done, s.best = true, s.start // a closed pocket: no way (and no partial path to its wall)
				break
			}
		}
		hi, _ := w.navSearchCell(s, i, &units)
		// inside a chunk (not on its rim) the neighbours are in the same chunk
		ix, iz := lx%navChunk, lz%navChunk
		inner := ix > 0 && iz > 0 && ix < navChunk-1 && iz < navChunk-1
		var c *navChunkData
		var ck int32
		if inner {
			c, ck = s.slots[(lz/navChunk)*navWinChunks+lx/navChunk], iz*navChunk+ix
		}
		var open [4]bool // orthogonal neighbours passable (no corner cutting)
		for d, dir := range navDirs {
			x, z := lx+dir[0], lz+dir[1]
			if !inner && (x < 0 || z < 0 || x >= navWin || z >= navWin) {
				continue
			}
			j := z*navWin + x
			if dir[2] == 1 {
				// diagonal: both orthogonal neighbours must be open
				ox, oz := 0, 2
				if dir[0] < 0 {
					ox = 1
				}
				if dir[1] < 0 {
					oz = 3
				}
				if !open[ox] || !open[oz] {
					continue
				}
			}
			var hj float32
			var wk uint8
			if inner {
				k := ck + dir[1]*navChunk + dir[0]
				hj, wk = c.h[k], c.walk[k]
			} else {
				hj, wk = w.navSearchCell(s, j, &units)
			}
			if wk&bit == 0 || hj-hi > navMaxRise {
				continue
			}
			if dir[2] == 0 {
				open[d] = true
			}
			cost := float32(1)
			if dir[2] == 1 {
				cost = 1.41421356
			}
			if n.closed[j] == n.gen {
				continue
			}
			ng := n.g[i] + cost
			if n.stamp[j] != n.gen || ng < n.g[j] {
				n.stamp[j] = n.gen
				n.g[j] = ng
				n.par[j] = i
				w.navPush(j, ng+navHeur*navOctile(x, z, gx, gz))
			}
		}
	}
	if len(n.heap) == 0 && !s.done {
		s.done = true
	}
	return units
}

// navLOS: a body of the search's class walks the straight line between
// window cells a and b (samples every 0.2 m: walkable cells, no climb over
// navMaxRise per cell edge's worth of distance).
func (w *World) navLOS(s *navSearch, a, b int32, units *int) bool {
	ax, az := navCenter(a%navWin), navCenter(a/navWin)
	bx, bz := navCenter(b%navWin), navCenter(b/navWin)
	d := math.Hypot(bx-ax, bz-az)
	steps := int(d/0.2) + 1
	bit := uint8(1) << s.class
	prevH, _ := w.navSearchCell(s, a, units)
	prev := a
	*units += steps / 16
	for k := 1; k <= steps; k++ {
		t := float64(k) / float64(steps)
		x := int32(math.Floor((ax + (bx-ax)*t) / navCell)) // window-local metres
		z := int32(math.Floor((az + (bz-az)*t) / navCell))
		j := z*navWin + x
		if j == prev {
			continue
		}
		h, wk := w.navSearchCell(s, j, units)
		if wk&bit == 0 || h-prevH > navLOSRise {
			return false
		}
		prev, prevH = j, h
	}
	return true
}

// navFinish turns a finished search into waypoints (nil: no path). partial
// reports a path to the closest reachable cell, not the goal.
func (w *World) navFinish(s *navSearch, units *int) (wps []movement.Vec3, length float64, partial bool) {
	n := w.nav
	end := s.goal
	if !s.found {
		// the closest cell reached, if it is real progress toward the goal
		if s.best == s.start || s.startH-s.bestH < 2/navCell {
			return nil, 0, false
		}
		end, partial = s.best, true
	}
	cells := n.cells[:0]
	for i := end; i >= 0; i = n.par[i] {
		cells = append(cells, i)
		if i == s.start {
			break
		}
	}
	for l, r := 0, len(cells)-1; l < r; l, r = l+1, r-1 {
		cells[l], cells[r] = cells[r], cells[l]
	}
	n.cells = cells
	// string pulling: from each anchor, the farthest cell still in sight
	pos := func(i int32) movement.Vec3 {
		return movement.Vec3{X: navCenter(s.wx0 + i%navWin), Z: navCenter(s.wz0 + i/navWin)}
	}
	a := 0
	last := movement.Vec3{X: s.e.Pos.X, Z: s.e.Pos.Z}
	for a < len(cells)-1 {
		j := a + 1
		for j+1 < len(cells) && j+1-a <= navMaxLeg && w.navLOS(s, cells[a], cells[j+1], units) {
			j++
		}
		p := pos(cells[j])
		length += hdist(last, p)
		last = p
		wps = append(wps, p)
		a = j
	}
	if !partial && !s.goalSnapped && len(wps) > 0 {
		wps[len(wps)-1] = movement.Vec3{X: s.goalPos.X, Z: s.goalPos.Z} // the goal itself, not its cell centre
	}
	length = 0
	last = movement.Vec3{X: s.e.Pos.X, Z: s.e.Pos.Z}
	for _, p := range wps {
		length += hdist(last, p)
		last = p
	}
	return wps, length, partial
}
