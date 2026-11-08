package worldhost

// Caves on the server (WP09): wasm wrappers for the cave exports, a cave
// cell cache fed by interest, world edits (mined veins carve the density),
// and CaveTerrain, the zone's movement ground with caves.
//
// Why cells are built in the background: cave_build costs 1-5 ms in wazero
// (more on an instance's first cave call, which builds every cave system of
// the world once). The zone announces players near mouths or underground
// (WantCaves) so their cells are ready before they arrive. Unlike the
// heightfield there is no cheap exact fallback for a cave floor, so a cell
// asked for and missing IS built synchronously (counted in Stats().Sync);
// interest keeps that rare.

import (
	"errors"
	"math"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tetratelabs/wazero/api"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/movement"
)

func (in *instance) caveCall(name string, args ...uint64) ([]byte, error) {
	f := in.mod.ExportedFunction(name)
	if f == nil {
		return nil, errors.New("worldgen.wasm lacks export " + name + " (built before WP09?)")
	}
	p, err := in.call(f, args...)
	if err != nil {
		return nil, err
	}
	if uint32(p) == 0 {
		return nil, in.lastError()
	}
	n, err := in.call1(in.fn.resultLen)
	if err != nil {
		return nil, err
	}
	return in.read(uint32(p), uint32(n))
}

func (in *instance) caveCell(cx, cy, cz int32, edits []byte) ([]byte, error) {
	if len(edits) == 0 {
		return in.caveCall("cave_build", uint64(in.atlasPtr), api.EncodeI32(cx), api.EncodeI32(cy), api.EncodeI32(cz))
	}
	p, err := in.put(edits)
	if err != nil {
		return nil, err
	}
	defer in.free(p, uint32(len(edits)))
	return in.caveCall("cave_build_edited", uint64(in.atlasPtr), api.EncodeI32(cx), api.EncodeI32(cy), api.EncodeI32(cz), uint64(p), uint64(len(edits)))
}

// CaveGraph runs cave_graph: every cave system of the world.
func (w *World) CaveGraph() ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCall("cave_graph", uint64(in.atlasPtr))
}

// CaveCell runs cave_build (or cave_build_edited with encoded edits).
func (w *World) CaveCell(cx, cy, cz int32, edits []byte) ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCell(cx, cy, cz, edits)
}

// CaveMask runs cave_mask for overworld chunk (cx, cz).
func (w *World) CaveMask(cx, cz int32) ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCall("cave_mask", uint64(in.atlasPtr), api.EncodeI32(cx), api.EncodeI32(cz))
}

// CaveOptions tune the cave cache.
type CaveOptions struct {
	// Capacity is the most cells kept (LRU beyond it, never evicting cells
	// wanted in the current epoch). Default 1024 (a mesh cell is ~20-80 KB).
	Capacity int
	// Workers build cells in the background, one instance each. Default 2.
	Workers int
}

type caveEntry struct {
	cell *caves.Cell
	used atomic.Int64
}

// Caves is the server's cave cell cache plus the active world edits.
type Caves struct {
	w     *World
	Graph *caves.Graph
	opt   CaveOptions

	mu    sync.RWMutex
	cells map[uint32]*caveEntry
	edits map[uint64]caves.Edit // by vein id

	qmu     sync.Mutex
	pending map[uint32]bool
	queue   chan uint32

	epoch atomic.Int64
	stop  chan struct{}
	wg    sync.WaitGroup

	hits, sync_, built, evicted, errs, rebuilt atomic.Int64
	buildNanos, buildMaxNanos                  atomic.Int64
}

// CaveStats are the cache counters (zone metrics, /debug/caves).
type CaveStats struct {
	Cells, Pending, Edits                       int
	Hits, Sync, Built, Evicted, Errors, Rebuilt int64
	BuildMeanMs, BuildMaxMs                     float64
	Systems                                     int
}

// NewCaves builds the cave graph (once) and starts the workers.
func NewCaves(w *World, opt CaveOptions) (*Caves, error) {
	if opt.Capacity <= 0 {
		opt.Capacity = 1024
	}
	if opt.Workers <= 0 {
		opt.Workers = min(2, max(1, runtime.GOMAXPROCS(0)/4))
	}
	gb, err := w.CaveGraph()
	if err != nil {
		return nil, err
	}
	g, err := caves.ParseGraph(gb)
	if err != nil {
		return nil, err
	}
	c := &Caves{w: w, Graph: g, opt: opt, cells: map[uint32]*caveEntry{}, edits: map[uint64]caves.Edit{},
		pending: map[uint32]bool{}, queue: make(chan uint32, 4096), stop: make(chan struct{})}
	for i := 0; i < opt.Workers; i++ {
		c.wg.Add(1)
		go c.worker()
	}
	return c, nil
}

// Close stops the workers.
func (c *Caves) Close() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	c.wg.Wait()
}

// Cell implements caves.CellSource: the cached cell, or a synchronous build
// on a miss (see the file comment). Invalid cells are nil.
func (c *Caves) Cell(cx, cy, cz int32) *caves.Cell {
	if !caves.ValidCell(cx, cy, cz) {
		return nil
	}
	k := caves.Key(cx, cy, cz)
	c.mu.RLock()
	e := c.cells[k]
	c.mu.RUnlock()
	if e != nil {
		c.hits.Add(1)
		e.used.Store(c.epoch.Load())
		return e.cell
	}
	c.sync_.Add(1)
	cell, err := c.buildWith(nil, k)
	if err != nil {
		c.errs.Add(1)
		return nil
	}
	c.insert(k, cell)
	return cell
}

// Cached returns a cell only if it is already built (no sync build).
func (c *Caves) Cached(cx, cy, cz int32) *caves.Cell {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if e := c.cells[caves.Key(cx, cy, cz)]; e != nil {
		return e.cell
	}
	return nil
}

// editsFor returns the active edits touching a cell, in vein-id order (so
// the encoded list, and the cell built from it, is deterministic).
func (c *Caves) editsFor(cx, cy, cz int32) []caves.Edit {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var out []caves.Edit
	for _, e := range c.edits {
		if e.Touches(cx, cy, cz) {
			out = append(out, e)
		}
	}
	slices.SortFunc(out, func(a, b caves.Edit) int {
		switch {
		case a.VeinID < b.VeinID:
			return -1
		case a.VeinID > b.VeinID:
			return 1
		}
		return 0
	})
	return out
}

func (c *Caves) buildWith(in *instance, k uint32) (*caves.Cell, error) {
	cx, cy, cz := caves.Unkey(k)
	edits := caves.EncodeEdits(c.editsFor(cx, cy, cz))
	start := time.Now()
	var b []byte
	var err error
	if in != nil {
		b, err = in.caveCell(cx, cy, cz, edits)
	} else {
		b, err = c.w.CaveCell(cx, cy, cz, edits)
	}
	if err != nil {
		return nil, err
	}
	d := time.Since(start).Nanoseconds()
	c.buildNanos.Add(d)
	if d > c.buildMaxNanos.Load() {
		c.buildMaxNanos.Store(d)
	}
	c.built.Add(1)
	return caves.ParseCell(b)
}

// WantCaves marks the cells within r (horizontally) and one cell up/down of
// (x, y, z) as in use and queues missing ones. The zone calls it for
// players who are underground or near a mouth.
func (c *Caves) WantCaves(x, y, z, r float64) {
	if math.IsNaN(x+y+z+r) || math.IsInf(x+y+z+r, 0) {
		return
	}
	ep := c.epoch.Add(1)
	x0, x1 := int32(math.Floor((x-r)/caves.CellW)), int32(math.Floor((x+r)/caves.CellW))
	z0, z1 := int32(math.Floor((z-r)/caves.CellW)), int32(math.Floor((z+r)/caves.CellW))
	ym := int32(math.Floor(y / caves.CellH))
	var missing []uint32
	c.mu.RLock()
	for cy := ym - 1; cy <= ym+1; cy++ {
		for cz := z0; cz <= z1; cz++ {
			for cx := x0; cx <= x1; cx++ {
				if !caves.ValidCell(cx, cy, cz) {
					continue
				}
				k := caves.Key(cx, cy, cz)
				if e := c.cells[k]; e != nil {
					e.used.Store(ep)
				} else {
					missing = append(missing, k)
				}
			}
		}
	}
	c.mu.RUnlock()
	for _, k := range missing {
		c.request(k)
	}
}

// Ensure builds the cells around a point synchronously (warm-up, tests).
func (c *Caves) Ensure(x, y, z, r float64) {
	x0, x1 := int32(math.Floor((x-r)/caves.CellW)), int32(math.Floor((x+r)/caves.CellW))
	z0, z1 := int32(math.Floor((z-r)/caves.CellW)), int32(math.Floor((z+r)/caves.CellW))
	y0, y1 := int32(math.Floor((y-r)/caves.CellH)), int32(math.Floor((y+r)/caves.CellH))
	for cy := y0; cy <= y1; cy++ {
		for cz := z0; cz <= z1; cz++ {
			for cx := x0; cx <= x1; cx++ {
				c.Cell(cx, cy, cz)
			}
		}
	}
}

func (c *Caves) request(k uint32) {
	c.qmu.Lock()
	defer c.qmu.Unlock()
	if c.pending[k] {
		return
	}
	select {
	case c.queue <- k:
		c.pending[k] = true
	default:
	}
}

func (c *Caves) worker() {
	defer c.wg.Done()
	in, err := c.w.newInstance()
	for err != nil {
		c.errs.Add(1)
		select {
		case <-c.stop:
			return
		case <-time.After(time.Second):
		}
		in, err = c.w.newInstance()
	}
	defer func() { in.close() }()
	for {
		select {
		case <-c.stop:
			return
		case k := <-c.queue:
			c.qmu.Lock()
			delete(c.pending, k)
			c.qmu.Unlock()
			cell, err := c.buildWith(in, k)
			if err != nil {
				c.errs.Add(1)
				if in.broken {
					in.close()
					if in, err = c.w.newInstance(); err != nil {
						return
					}
				}
				continue
			}
			c.insert(k, cell)
		}
	}
}

func (c *Caves) insert(k uint32, cell *caves.Cell) {
	e := &caveEntry{cell: cell}
	e.used.Store(c.epoch.Load())
	c.mu.Lock()
	c.cells[k] = e
	n := len(c.cells)
	c.mu.Unlock()
	if n <= c.opt.Capacity {
		return
	}
	cur := c.epoch.Load()
	c.mu.Lock()
	defer c.mu.Unlock()
	type kv struct {
		k    uint32
		used int64
	}
	all := make([]kv, 0, len(c.cells))
	for kk, ee := range c.cells {
		if u := ee.used.Load(); u < cur {
			all = append(all, kv{kk, u})
		}
	}
	slices.SortFunc(all, func(a, b kv) int { return int(a.used - b.used) })
	drop := len(c.cells) - c.opt.Capacity*15/16
	for i := 0; i < drop && i < len(all); i++ {
		delete(c.cells, all[i].k)
		c.evicted.Add(1)
	}
}

// SetEdit makes an edit active (a mined vein: carve + flag) and rebuilds the
// cached cells it touches. Rebuilds happen synchronously on the caller (the
// zone's tick, once per vein break, ~1-5 ms per touched cell) so collision
// changes in the same tick the WorldEdits message goes out.
func (c *Caves) SetEdit(e caves.Edit) {
	c.mu.Lock()
	c.edits[e.VeinID] = e
	c.mu.Unlock()
	c.rebuildTouched(e)
}

// RemoveEdit drops an edit (vein respawned) and restores the cells.
func (c *Caves) RemoveEdit(veinID uint64) {
	c.mu.Lock()
	e, ok := c.edits[veinID]
	delete(c.edits, veinID)
	c.mu.Unlock()
	if ok {
		c.rebuildTouched(e)
	}
}

// Edits is a snapshot of the active edits.
func (c *Caves) Edits() []caves.Edit {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]caves.Edit, 0, len(c.edits))
	for _, e := range c.edits {
		out = append(out, e)
	}
	return out
}

func (c *Caves) rebuildTouched(e caves.Edit) {
	r := float64(e.R)
	x, y, z := float64(e.X), float64(e.Y), float64(e.Z)
	for cy := int32(math.Floor((y - r) / caves.CellH)); cy <= int32(math.Floor((y+r+2)/caves.CellH)); cy++ {
		for cz := int32(math.Floor((z - r) / caves.CellW)); cz <= int32(math.Floor((z+r+2)/caves.CellW)); cz++ {
			for cx := int32(math.Floor((x - r) / caves.CellW)); cx <= int32(math.Floor((x+r+2)/caves.CellW)); cx++ {
				if !caves.ValidCell(cx, cy, cz) || !e.Touches(cx, cy, cz) {
					continue
				}
				k := caves.Key(cx, cy, cz)
				c.mu.RLock()
				_, cached := c.cells[k]
				c.mu.RUnlock()
				if !cached {
					continue
				}
				if cell, err := c.buildWith(nil, k); err == nil {
					c.insert(k, cell)
					c.rebuilt.Add(1)
				} else {
					c.errs.Add(1)
				}
			}
		}
	}
}

// Stats returns the cache counters.
func (c *Caves) Stats() CaveStats {
	c.mu.RLock()
	n, ne := len(c.cells), len(c.edits)
	c.mu.RUnlock()
	c.qmu.Lock()
	p := len(c.pending)
	c.qmu.Unlock()
	s := CaveStats{Cells: n, Pending: p, Edits: ne, Hits: c.hits.Load(), Sync: c.sync_.Load(), Built: c.built.Load(),
		Evicted: c.evicted.Load(), Errors: c.errs.Load(), Rebuilt: c.rebuilt.Load(), Systems: len(c.Graph.Systems)}
	if s.Built > 0 {
		s.BuildMeanMs = float64(c.buildNanos.Load()) / float64(s.Built) / 1e6
	}
	s.BuildMaxMs = float64(c.buildMaxNanos.Load()) / 1e6
	return s
}

// CaveTerrain is Terrain plus caves: the zone's movement ground. Its
// surface is whatever ground it wraps (terrain, or WP12's terrain +
// structures overlay), so towers keep working on the surface; in mouth holes
// and underground the movement step sees cave floors (movement.LevelGround)
// and walls (movement.Collider). Still a spawner and a chunk wanter through
// the embedded Terrain.
type CaveTerrain struct {
	*Terrain
	Caves *Caves
	g     *caves.Ground
}

// NewCaveTerrain puts caves under surface (nil = the plain terrain).
func NewCaveTerrain(t *Terrain, surface movement.Ground, c *Caves) *CaveTerrain {
	if surface == nil {
		surface = t
	}
	ct := &CaveTerrain{Terrain: t, Caves: c}
	ct.g = &caves.Ground{Height: surface.HeightAt, Openings: c.Graph.OpeningsList, Cells: c,
		Water: func(x, z float64) float64 { return movement.WaterAt(surface, x, z) }}
	return ct
}

// HeightAt is the surface ground (non-step callers: spawns, hints).
func (ct *CaveTerrain) HeightAt(x, z float64) float64 { return ct.g.HeightAt(x, z) }

// WaterAt is the surface water (movement.Water).
func (ct *CaveTerrain) WaterAt(x, z float64) float64 { return ct.g.WaterAt(x, z) }

// AtLevel implements movement.LevelGround (the step's view at feet height y).
func (ct *CaveTerrain) AtLevel(y float64) movement.Ground { return ct.g.AtLevel(y) }

// FloorAt is the ground under feet height y (same as AtLevel(y).HeightAt).
func (ct *CaveTerrain) FloorAt(x, y, z float64) float64 { return ct.g.FloorAt(x, y, z) }

// Collide is the cave wall/ceiling push-out.
func (ct *CaveTerrain) Collide(x, y, z float64) movement.CollideResult { return ct.g.Collide(x, y, z) }

// InCave reports whether a point is in a mouth hole or underground.
func (ct *CaveTerrain) InCave(x, y, z float64) bool { return ct.g.InCave(x, y, z) }

// SystemAt is the cave-system index of an underground point, else -1:
// points on the open surface (not in a cave) are never "in" a system.
func (ct *CaveTerrain) SystemAt(x, y, z float64) int {
	if !ct.g.InCave(x, y, z) {
		return -1
	}
	return ct.Caves.Graph.SystemAt(x, y+1, z)
}

// NearMouth returns the system whose opening is within r (horizontally) of
// (x, z), or -1.
func (ct *CaveTerrain) NearMouth(x, z, r float64) int {
	for _, o := range ct.Caves.Graph.OpeningsList {
		dx, dz := x-o.X, z-o.Z
		if dx*dx+dz*dz <= r*r {
			return o.System
		}
	}
	return -1
}

// CaveGraph is the world's cave graph (vein registry, openings, nav graph).
func (ct *CaveTerrain) CaveGraph() *caves.Graph { return ct.Caves.Graph }

// SetEdit activates a mined-vein edit (see Caves.SetEdit).
func (ct *CaveTerrain) SetEdit(e caves.Edit) { ct.Caves.SetEdit(e) }

// RemoveEdit restores a respawned vein (see Caves.RemoveEdit).
func (ct *CaveTerrain) RemoveEdit(veinID uint64) { ct.Caves.RemoveEdit(veinID) }

// WantCaves feeds the cave cell cache (see Caves.WantCaves).
func (ct *CaveTerrain) WantCaves(x, y, z, r float64) { ct.Caves.WantCaves(x, y, z, r) }

// CaveStats exposes the cave cache counters.
func (ct *CaveTerrain) CaveStats() CaveStats { return ct.Caves.Stats() }
