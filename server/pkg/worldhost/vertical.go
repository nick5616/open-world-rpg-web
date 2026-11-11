package worldhost

// The vertical world on the server (genVersion 3, CR 038): wasm wrappers
// for vertical_build / layer_tile / layer_height, a LOD 0 layer-tile cache
// fed by interest (pure Go collision from cached tiles, bit-identical to the
// wasm; a wasm layer_height on a miss, never a synchronous tile build), and
// the vertical ground wired into CaveTerrain.

import (
	"errors"
	"math"
	"sync"
	"sync/atomic"

	"github.com/tetratelabs/wazero/api"

	"lodestone/server/pkg/vertical"
)

// VerticalDesc runs vertical_build: the world's vertical descriptor.
func (w *World) VerticalDesc() ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCall("vertical_build", uint64(in.atlasPtr))
}

// LayerTile runs layer_tile.
func (w *World) LayerTile(layer, cx, cz, lod int32) ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.caveCall("layer_tile", uint64(in.atlasPtr), api.EncodeI32(layer), api.EncodeI32(cx), api.EncodeI32(cz), api.EncodeI32(lod))
}

// LayerHeight runs layer_height (vertical.Source): NaN if the instance trapped.
func (w *World) LayerHeight(surf int, x, z float64) float64 {
	w.wasmQueries.Add(1)
	in, err := w.pool.get()
	if err != nil {
		return math.NaN()
	}
	defer w.pool.put(in)
	f := in.mod.ExportedFunction("layer_height")
	if f == nil {
		return math.NaN()
	}
	r, err := in.call(f, uint64(in.atlasPtr), api.EncodeI32(int32(surf)), api.EncodeF64(x), api.EncodeF64(z))
	if err != nil {
		return math.NaN()
	}
	return api.DecodeF64(r)
}

// Layers is the vertical world of a World: its descriptor and a LOD 0 tile
// cache (vertical.Source).
type Layers struct {
	W    *World
	Vert *vertical.World

	mu                  sync.RWMutex
	tiles               map[uint32]*vertical.Tile
	order               []uint32
	cap                 int
	want                chan uint32
	queued              sync.Map
	hits, misses, built atomic.Int64
	stop                chan struct{}
}

// LayerStats are the cache counters.
type LayerStats struct {
	Tiles               int
	Hits, Misses, Built int64
}

// NewLayers parses the descriptor and starts `workers` tile builders.
func NewLayers(w *World, capacity, workers int) (*Layers, error) {
	b, err := w.VerticalDesc()
	if err != nil {
		return nil, err
	}
	v, err := vertical.Parse(b)
	if err != nil {
		return nil, err
	}
	if capacity <= 0 {
		capacity = 512
	}
	if workers <= 0 {
		workers = 1
	}
	l := &Layers{W: w, Vert: v, tiles: map[uint32]*vertical.Tile{}, cap: capacity, want: make(chan uint32, 256), stop: make(chan struct{})}
	for i := 0; i < workers; i++ {
		go l.worker()
	}
	return l, nil
}

// Close stops the workers.
func (l *Layers) Close() {
	select {
	case <-l.stop:
	default:
		close(l.stop)
	}
}

func tileKey(layer, cx, cz int) uint32 { return uint32(layer)<<12 | uint32(cz)<<6 | uint32(cx) }

// LayerHeight implements vertical.Source: the cached LOD 0 tile, else the wasm.
func (l *Layers) LayerHeight(surf int, x, z float64) float64 {
	layer := vertical.SurfLayer(surf)
	x0 := math.Floor(x)
	z0 := math.Floor(z)
	cx := int(math.Floor(x0 / 64))
	cz := int(math.Floor(z0 / 64))
	if cx >= 0 && cz >= 0 && cx < 64 && cz < 64 {
		l.mu.RLock()
		t := l.tiles[tileKey(layer, cx, cz)]
		l.mu.RUnlock()
		if t != nil {
			l.hits.Add(1)
			return vertical.TileValue(t, surf, x, z)
		}
	}
	l.misses.Add(1)
	return l.W.LayerHeight(surf, x, z)
}

// Want asks for the LOD 0 tiles of every layer whose domain covers the
// square of half size r around (x, z).
func (l *Layers) Want(x, z, r float64) {
	c0 := int(math.Floor((x - r) / 64))
	c1 := int(math.Floor((x + r) / 64))
	d0 := int(math.Floor((z - r) / 64))
	d1 := int(math.Floor((z + r) / 64))
	for cz := d0; cz <= d1; cz++ {
		for cx := c0; cx <= c1; cx++ {
			if cx < 0 || cz < 0 || cx > 63 || cz > 63 {
				continue
			}
			for layer := 1; layer <= 3; layer++ {
				if !l.Vert.InDomain(layer, float64(cx*64)+1, float64(cz*64)+1) {
					continue
				}
				k := tileKey(layer, cx, cz)
				l.mu.RLock()
				_, have := l.tiles[k]
				l.mu.RUnlock()
				if have {
					continue
				}
				if _, busy := l.queued.LoadOrStore(k, true); busy {
					continue
				}
				select {
				case l.want <- k:
				default:
					l.queued.Delete(k)
				}
			}
		}
	}
}

func (l *Layers) worker() {
	for {
		select {
		case <-l.stop:
			return
		case k := <-l.want:
			layer, cz, cx := int(k>>12), int(k>>6&63), int(k&63)
			b, err := l.W.LayerTile(int32(layer), int32(cx), int32(cz), 0)
			if err == nil {
				if t, err := vertical.ParseTile(b); err == nil {
					l.insert(k, t)
					l.built.Add(1)
				}
			}
			l.queued.Delete(k)
		}
	}
}

func (l *Layers) insert(k uint32, t *vertical.Tile) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.tiles[k]; !ok {
		l.order = append(l.order, k)
	}
	l.tiles[k] = t
	for len(l.order) > l.cap {
		delete(l.tiles, l.order[0])
		l.order = l.order[1:]
	}
}

// Ensure builds the tiles around (x, z) synchronously (warm-ups, tests).
func (l *Layers) Ensure(x, z, r float64) error {
	c0 := int(math.Floor((x - r) / 64))
	c1 := int(math.Floor((x + r) / 64))
	d0 := int(math.Floor((z - r) / 64))
	d1 := int(math.Floor((z + r) / 64))
	for cz := d0; cz <= d1; cz++ {
		for cx := c0; cx <= c1; cx++ {
			for layer := 1; layer <= 3; layer++ {
				if cx < 0 || cz < 0 || cx > 63 || cz > 63 || !l.Vert.InDomain(layer, float64(cx*64)+1, float64(cz*64)+1) {
					continue
				}
				b, err := l.W.LayerTile(int32(layer), int32(cx), int32(cz), 0)
				if err != nil {
					return err
				}
				t, err := vertical.ParseTile(b)
				if err != nil {
					return err
				}
				l.insert(tileKey(layer, cx, cz), t)
			}
		}
	}
	return nil
}

// Stats are the cache counters.
func (l *Layers) Stats() LayerStats {
	l.mu.RLock()
	n := len(l.tiles)
	l.mu.RUnlock()
	return LayerStats{Tiles: n, Hits: l.hits.Load(), Misses: l.misses.Load(), Built: l.built.Load()}
}

// ErrNoVertical: the wasm predates genVersion 3.
var ErrNoVertical = errors.New("worldgen.wasm has no vertical exports (genVersion < 3)")

// WithVertical puts the vertical world on the cave terrain's ground (its
// movement view, push-outs and layer queries). A wasm without the exports
// returns ErrNoVertical and leaves the cave terrain as it was.
func (ct *CaveTerrain) WithVertical(capacity, workers int) (*Layers, error) {
	l, err := NewLayers(ct.Terrain.World(), capacity, workers)
	if err != nil {
		return nil, errors.Join(ErrNoVertical, err)
	}
	ct.V = &vertical.Ground{Base: ct.g, W: l.Vert, Src: l}
	ct.Layers = l
	return l, nil
}
