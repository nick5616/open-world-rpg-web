package worldhost

import (
	"context"
	"errors"
	"math"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Terrain is the server's ground: a chunk cache by interest in front of a
// World, implementing movement.Ground (HeightAt).
//
// Why a cache when collision_height already exists: a wasm call costs ~1-3
// us through wazero (pool hand-off + call + four lattice evaluations of the
// height noise), while the same answer from cached chunk heights costs tens
// of nanoseconds. The zone asks for ground ~4 times per input frame per
// player (grounded test, snap, quantize, self state), 60 frames a second.
//
// Why it never blocks: generating a chunk takes 3-6 ms in wazero, a fifth of
// a 33 ms tick. So HeightAt never generates. A miss is answered by a direct
// collision_height call (same bits, see height.go) and the chunk is queued
// for the worker goroutines, which use their own instances so a query never
// waits behind a generation. Want() lets the zone ask for chunks around
// players (and ahead of them) before anyone stands there.
type Terrain struct {
	w   *World
	opt TerrainOptions

	mu    sync.RWMutex
	tiles map[uint32]*tile

	qmu     sync.Mutex
	pending map[uint32]bool
	queue   chan uint32

	epoch atomic.Int64 // bumped by Want; tiles remember the last epoch they were used

	stop chan struct{}
	wg   sync.WaitGroup

	hits, misses, generated, evicted, genErrors, dropped atomic.Int64
	genNanos, genMaxNanos                                atomic.Int64
}

type tile struct {
	c    *Chunk
	used atomic.Int64
}

// TerrainOptions tune the cache.
type TerrainOptions struct {
	// Capacity is the most chunks kept (LRU beyond it). Each holds the
	// height and water lattices (2 x 16.9 KB) plus records. Default 3072
	// (~110 MB worst case); the whole v1 world is 4096 chunks.
	Capacity int
	// Workers generate chunks in the background, one wasm instance each.
	// Default: GOMAXPROCS/4, between 1 and 4, so generation never starves
	// the tick of cores.
	Workers int
	// QueueLen bounds pending generation requests; extra requests are
	// dropped and simply asked for again by the next Want. Default 8192.
	QueueLen int
}

// NewTerrain starts the cache's worker goroutines. Close stops them.
func NewTerrain(w *World, opt TerrainOptions) *Terrain {
	if opt.Capacity <= 0 {
		opt.Capacity = 3072
	}
	if opt.Workers <= 0 {
		opt.Workers = min(max(runtime.GOMAXPROCS(0)/4, 1), 4)
	}
	if opt.QueueLen <= 0 {
		opt.QueueLen = 8192
	}
	t := &Terrain{
		w: w, opt: opt,
		tiles:   map[uint32]*tile{},
		pending: map[uint32]bool{},
		queue:   make(chan uint32, opt.QueueLen),
		stop:    make(chan struct{}),
	}
	for i := 0; i < opt.Workers; i++ {
		t.wg.Add(1)
		go t.worker()
	}
	return t
}

// World returns the world behind the cache.
func (t *Terrain) World() *World { return t.w }

// Close stops the workers (queued requests are abandoned).
func (t *Terrain) Close() {
	select {
	case <-t.stop:
	default:
		close(t.stop)
	}
	t.wg.Wait()
}

func key(cx, cz int32) uint32 { return uint32(uint16(int16(cx)))<<16 | uint32(uint16(int16(cz))) }

func unkey(k uint32) (int32, int32) { return int32(int16(k >> 16)), int32(int16(k)) }

// HeightAt implements movement.Ground: the exact collision surface at
// (x, z). Never blocks on generation (see the type comment).
func (t *Terrain) HeightAt(x, z float64) float64 {
	cx, cz, ok := chunkOf(x, z)
	if ok {
		k := key(cx, cz)
		t.mu.RLock()
		tl := t.tiles[k]
		t.mu.RUnlock()
		if tl != nil {
			t.hits.Add(1)
			if e := t.epoch.Load(); tl.used.Load() != e {
				tl.used.Store(e)
			}
			return tl.c.Height(x, z)
		}
		t.request(k)
	}
	t.misses.Add(1)
	return t.w.CollisionHeight(x, z)
}

// Chunk returns the cached chunk, if present (never generates).
func (t *Terrain) Chunk(cx, cz int32) (*Chunk, bool) {
	t.mu.RLock()
	tl := t.tiles[key(cx, cz)]
	t.mu.RUnlock()
	if tl == nil {
		return nil, false
	}
	return tl.c, true
}

// Want marks the chunks overlapping the square of half-size marginM around
// (x, z) as in use and queues the missing ones for generation. The zone
// calls it per player with a margin that grows with speed, which is the
// "generated ahead" part: a chunk is ready before anyone steps on it.
func (t *Terrain) Want(x, z, marginM float64) {
	if math.IsNaN(x+z+marginM) || math.IsInf(x+z+marginM, 0) {
		return
	}
	e := t.epoch.Add(1)
	// Players live inside the world (the zone clamps), so interest stays
	// within the world's chunks.
	clamp := func(v float64) int32 {
		c := int32(math.Floor(v / ChunkSize))
		return min(max(c, 0), WorldChunks-1)
	}
	x0, x1 := clamp(x-marginM), clamp(x+marginM)
	z0, z1 := clamp(z-marginM), clamp(z+marginM)
	var missing [64]uint32
	nm := 0
	t.mu.RLock()
	for cz := z0; cz <= z1; cz++ {
		for cx := x0; cx <= x1; cx++ {
			k := key(cx, cz)
			if tl := t.tiles[k]; tl != nil {
				tl.used.Store(e)
			} else if nm < len(missing) {
				missing[nm] = k
				nm++
			}
		}
	}
	t.mu.RUnlock()
	for _, k := range missing[:nm] {
		t.request(k)
	}
}

// Ensure generates the chunks overlapping the square synchronously (on the
// caller's goroutine, using the query pool). For startup warm-up and tests;
// never call it from a tick.
func (t *Terrain) Ensure(x, z, marginM float64) error {
	x0, x1 := int32(math.Floor((x-marginM)/ChunkSize)), int32(math.Floor((x+marginM)/ChunkSize))
	z0, z1 := int32(math.Floor((z-marginM)/ChunkSize)), int32(math.Floor((z+marginM)/ChunkSize))
	for cz := z0; cz <= z1; cz++ {
		for cx := x0; cx <= x1; cx++ {
			if _, ok := t.Chunk(cx, cz); ok || cx < minChunk || cx > maxChunk || cz < minChunk || cz > maxChunk {
				continue
			}
			b, err := t.w.ChunkBytes(cx, cz, 0)
			if err != nil {
				return err
			}
			c, err := ParseChunk(b)
			if err != nil {
				return err
			}
			t.insert(key(cx, cz), c)
		}
	}
	return nil
}

// request queues a chunk once (deduplicated while pending).
func (t *Terrain) request(k uint32) {
	t.qmu.Lock()
	if t.pending[k] {
		t.qmu.Unlock()
		return
	}
	select {
	case t.queue <- k:
		t.pending[k] = true
	default:
		t.dropped.Add(1)
	}
	t.qmu.Unlock()
}

func (t *Terrain) worker() {
	defer t.wg.Done()
	// A dedicated instance (not from the query pool): queries must never
	// wait behind a 5 ms generation.
	in, err := t.w.newInstance()
	for err != nil {
		t.genErrors.Add(1)
		select {
		case <-t.stop:
			return
		case <-time.After(time.Second):
		}
		in, err = t.w.newInstance()
	}
	defer func() { in.close() }()
	for {
		select {
		case <-t.stop:
			return
		case k := <-t.queue:
			if _, ok := t.Chunk(unkey(k)); !ok {
				start := time.Now()
				c, err := t.build(in, k)
				if err != nil {
					t.genErrors.Add(1)
					if in.broken {
						in.close()
						if in, err = t.w.newInstance(); err != nil {
							t.qmu.Lock()
							delete(t.pending, k)
							t.qmu.Unlock()
							return
						}
					}
				} else {
					d := time.Since(start).Nanoseconds()
					t.genNanos.Add(d)
					if d > t.genMaxNanos.Load() {
						t.genMaxNanos.Store(d)
					}
					t.generated.Add(1)
					t.insert(k, c)
				}
			}
			t.qmu.Lock()
			delete(t.pending, k)
			t.qmu.Unlock()
		}
	}
}

func (t *Terrain) build(in *instance, k uint32) (*Chunk, error) {
	cx, cz := unkey(k)
	p, n, err := in.chunkPtr(cx, cz, 0)
	if err != nil {
		return nil, err
	}
	// Parse straight from wasm memory (no intermediate copy of the ~70 KB
	// buffer); ParseChunk copies what it keeps.
	b, ok := in.mem.Read(p, n)
	if !ok {
		return nil, errors.New("chunk buffer out of range")
	}
	return ParseChunk(b)
}

// insert adds a chunk and evicts the least recently used ones beyond
// Capacity (down to 15/16 of it, so eviction runs in batches, not on every
// insert). Chunks used in the current epoch are never evicted.
func (t *Terrain) insert(k uint32, c *Chunk) {
	tl := &tile{c: c}
	tl.used.Store(t.epoch.Load())
	t.mu.Lock()
	t.tiles[k] = tl
	n := len(t.tiles)
	t.mu.Unlock()
	if n <= t.opt.Capacity {
		return
	}
	type cand struct {
		k    uint32
		used int64
	}
	t.mu.RLock()
	cands := make([]cand, 0, len(t.tiles))
	for kk, v := range t.tiles {
		cands = append(cands, cand{kk, v.used.Load()})
	}
	t.mu.RUnlock()
	slices.SortFunc(cands, func(a, b cand) int { return int(a.used - b.used) })
	drop := len(cands) - t.opt.Capacity*15/16
	now := t.epoch.Load()
	t.mu.Lock()
	for _, c := range cands {
		if drop <= 0 || c.used >= now {
			break
		}
		if v := t.tiles[c.k]; v != nil && v.used.Load() == c.used {
			delete(t.tiles, c.k)
			t.evicted.Add(1)
			drop--
		}
	}
	t.mu.Unlock()
}

// TerrainStats is a snapshot of the cache counters.
type TerrainStats struct {
	Chunks      int     `json:"chunks"`
	Pending     int     `json:"pending"`
	Hits        int64   `json:"hits"`
	Misses      int64   `json:"misses"` // answered by a wasm collision_height call
	Generated   int64   `json:"generated"`
	Evicted     int64   `json:"evicted"`
	Dropped     int64   `json:"dropped"` // requests dropped because the queue was full
	GenErrors   int64   `json:"genErrors"`
	GenMeanMs   float64 `json:"genMeanMs"`
	GenMaxMs    float64 `json:"genMaxMs"`
	WasmQueries int64   `json:"wasmQueries"`
}

// Stats returns the current counters.
func (t *Terrain) Stats() TerrainStats {
	t.mu.RLock()
	n := len(t.tiles)
	t.mu.RUnlock()
	t.qmu.Lock()
	p := len(t.pending)
	t.qmu.Unlock()
	s := TerrainStats{
		Chunks: n, Pending: p,
		Hits: t.hits.Load(), Misses: t.misses.Load(), Generated: t.generated.Load(),
		Evicted: t.evicted.Load(), Dropped: t.dropped.Load(), GenErrors: t.genErrors.Load(),
		GenMaxMs: float64(t.genMaxNanos.Load()) / 1e6, WasmQueries: t.w.WasmQueries(),
	}
	if s.Generated > 0 {
		s.GenMeanMs = float64(t.genNanos.Load()) / 1e6 / float64(s.Generated)
	}
	return s
}

// WaitIdle blocks until no generation is pending or ctx ends (tests,
// warm-up).
func (t *Terrain) WaitIdle(ctx context.Context) error {
	for {
		t.qmu.Lock()
		p := len(t.pending)
		t.qmu.Unlock()
		if p == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Millisecond):
		}
	}
}
