package worldhost

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"

	"github.com/tetratelabs/wazero/api"
)

// AtlasHeader is the fixed 64-byte atlas header (worldgen/README.md, "Atlas
// buffer").
type AtlasHeader struct {
	FormatVersion uint16
	GenVersion    uint16
	ByteLength    uint32
	Seed          uint64
	WorldSize     uint16 // m
	MacroRes      uint16 // m
	GridN         uint16
	SeaLevel      float32
	SpawnX        float32
	SpawnZ        float32
	MinHeight     float32
	MaxHeight     float32
	SiteCount     uint32
}

// ParseAtlasHeader reads the header and checks the magic.
func ParseAtlasHeader(b []byte) (AtlasHeader, error) {
	if len(b) < 64 || string(b[:4]) != "LDAT" {
		return AtlasHeader{}, errors.New("not an atlas (bad magic or short)")
	}
	le := binary.LittleEndian
	f32 := func(o int) float32 { return math.Float32frombits(le.Uint32(b[o:])) }
	h := AtlasHeader{
		FormatVersion: le.Uint16(b[4:]),
		GenVersion:    le.Uint16(b[6:]),
		ByteLength:    le.Uint32(b[8:]),
		Seed:          le.Uint64(b[16:]),
		WorldSize:     le.Uint16(b[24:]),
		MacroRes:      le.Uint16(b[26:]),
		GridN:         le.Uint16(b[28:]),
		SeaLevel:      f32(32),
		SpawnX:        f32(36),
		SpawnZ:        f32(40),
		MinHeight:     f32(44),
		MaxHeight:     f32(48),
		SiteCount:     le.Uint32(b[52:]),
	}
	if int(h.ByteLength) != len(b) {
		return h, fmt.Errorf("atlas header says %d bytes, buffer has %d", h.ByteLength, len(b))
	}
	return h, nil
}

// atlasSection returns section id's bytes via the directory at offset 64.
func atlasSection(b []byte, id int) []byte {
	le := binary.LittleEndian
	o := 64 + id*8
	if o+8 > len(b) {
		return nil
	}
	off, n := le.Uint32(b[o:]), le.Uint32(b[o+4:])
	if n == 0 || int(off)+int(n) > len(b) {
		return nil
	}
	return b[off : off+n]
}

// World is one world's atlas loaded into a pool of wasm instances. All
// methods are safe for concurrent use.
type World struct {
	mod       *Module
	Atlas     []byte // the atlas bytes (owned; do not modify)
	Header    AtlasHeader
	AtlasHash uint64 // hash_buffer(atlas), stored as worlds.atlas_hash
	Seed      uint64

	pool *pool

	// wasmQueries counts direct collision_height calls (the slow path).
	wasmQueries atomic.Int64
}

// WorldOptions tune a World.
type WorldOptions struct {
	// MaxInstances bounds the query pool (instances are created lazily).
	// Default: GOMAXPROCS, at most 8. Each instance holds its own copy of the
	// atlas (~310 KB) plus the module's working memory (a few MB).
	MaxInstances int
}

// OpenWorld builds the atlas for (spec, seed) with this module and loads it.
func (m *Module) OpenWorld(spec []byte, seed uint64, opt WorldOptions) (*World, error) {
	atlas, err := m.BuildAtlas(spec, seed)
	if err != nil {
		return nil, err
	}
	return m.OpenAtlas(atlas, opt)
}

// OpenAtlas loads existing atlas bytes (e.g. cached by hash). The atlas must
// come from the same generator version as the module (atlas_check enforces
// the format; the header's genVersion is checked here).
func (m *Module) OpenAtlas(atlas []byte, opt WorldOptions) (*World, error) {
	h, err := ParseAtlasHeader(atlas)
	if err != nil {
		return nil, err
	}
	if uint32(h.GenVersion) != m.genVersion {
		return nil, fmt.Errorf("atlas genVersion %d but worldgen.wasm is genVersion %d", h.GenVersion, m.genVersion)
	}
	if opt.MaxInstances <= 0 {
		opt.MaxInstances = min(runtime.GOMAXPROCS(0), 8)
	}
	w := &World{mod: m, Atlas: atlas, Header: h, AtlasHash: FNV1a64(atlas), Seed: h.Seed}
	w.pool = &pool{max: opt.MaxInstances, ch: make(chan *instance, opt.MaxInstances), make: w.newInstance}
	// Create one instance eagerly so a bad atlas fails here, not mid-tick.
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	w.pool.put(in)
	return w, nil
}

func (w *World) newInstance() (*instance, error) {
	in, err := w.mod.newInstance(context.Background())
	if err != nil {
		return nil, err
	}
	if err := in.loadAtlas(w.Atlas); err != nil {
		in.close()
		return nil, err
	}
	return in, nil
}

// Module returns the module the world runs on.
func (w *World) Module() *Module { return w.mod }

// SpecJSON returns the canonical WorldSpec JSON embedded in the atlas
// (section 0), which is exactly what spec_from_seed/atlas_build used.
func (w *World) SpecJSON() []byte {
	return append([]byte(nil), atlasSection(w.Atlas, 0)...)
}

// SpawnY is the atlas spawn height (PARAMS slot 22).
func (w *World) SpawnY() float64 {
	p := atlasSection(w.Atlas, 1)
	if len(p) < 23*8 {
		return 0
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(p[22*8:]))
}

// WasmQueries is the number of collision_height calls that went to wasm.
func (w *World) WasmQueries() int64 { return w.wasmQueries.Load() }

// Close drops pooled instances (the Module stays usable).
func (w *World) Close() { w.pool.close() }

// CollisionHeight is the wasm collision_height (the exact ground surface,
// worldgen/README.md "Collision"). Returns NaN only if the instance trapped,
// which callers treat like any invalid position.
func (w *World) CollisionHeight(x, z float64) float64 {
	w.wasmQueries.Add(1)
	in, err := w.pool.get()
	if err != nil {
		return math.NaN()
	}
	defer w.pool.put(in)
	r, err := in.call(in.fn.collisionHeight, uint64(in.atlasPtr), api.EncodeF64(x), api.EncodeF64(z))
	if err != nil {
		return math.NaN()
	}
	return api.DecodeF64(r)
}

// WaterHeight is the wasm water_height (WP10): the water surface over the
// same triangle mesh as CollisionHeight, sea level where no lake or river
// covers the point (under dry land). NaN only if the instance trapped.
func (w *World) WaterHeight(x, z float64) float64 {
	w.wasmQueries.Add(1)
	in, err := w.pool.get()
	if err != nil {
		return math.NaN()
	}
	defer w.pool.put(in)
	r, err := in.call(in.fn.waterHeight, uint64(in.atlasPtr), api.EncodeF64(x), api.EncodeF64(z))
	if err != nil {
		return math.NaN()
	}
	return api.DecodeF64(r)
}

// GroundNormal returns the unit normal of the surface triangle at (x, z) and
// its slope in degrees.
func (w *World) GroundNormal(x, z float64) (n [3]float64, slopeDeg float64, err error) {
	in, err := w.pool.get()
	if err != nil {
		return n, 0, err
	}
	defer w.pool.put(in)
	r, err := in.call(in.fn.groundNormal, uint64(in.atlasPtr), api.EncodeF64(x), api.EncodeF64(z), uint64(in.outPtr))
	if err != nil {
		return n, 0, err
	}
	slopeDeg = api.DecodeF64(r)
	if slopeDeg < 0 {
		return n, 0, in.lastError()
	}
	b, ok := in.mem.Read(in.outPtr, 24)
	if !ok {
		return n, 0, errors.New("ground_normal: read out of range")
	}
	for i := range n {
		n[i] = math.Float64frombits(binary.LittleEndian.Uint64(b[i*8:]))
	}
	return n, slopeDeg, nil
}

// Raycast intersects the ray with the ground mesh. ok=false: no hit within
// min(maxDist, 1024 m).
func (w *World) Raycast(o, d [3]float64, maxDist float64) (dist float64, ok bool, err error) {
	in, err := w.pool.get()
	if err != nil {
		return 0, false, err
	}
	defer w.pool.put(in)
	r, err := in.call(in.fn.raycast, uint64(in.atlasPtr),
		api.EncodeF64(o[0]), api.EncodeF64(o[1]), api.EncodeF64(o[2]),
		api.EncodeF64(d[0]), api.EncodeF64(d[1]), api.EncodeF64(d[2]), api.EncodeF64(maxDist))
	if err != nil {
		return 0, false, err
	}
	dist = api.DecodeF64(r)
	return dist, dist >= 0, nil
}

// ChunkBytes runs chunk_build and returns a copy of the whole chunk buffer
// (layout in worldgen/README.md). ~3-6 ms at LOD 0 under wazero: never call
// it from a tick; Terrain does it on worker goroutines.
func (w *World) ChunkBytes(cx, cz int32, lod uint8) ([]byte, error) {
	in, err := w.pool.get()
	if err != nil {
		return nil, err
	}
	defer w.pool.put(in)
	return in.chunkBytes(cx, cz, lod)
}

func (in *instance) chunkPtr(cx, cz int32, lod uint8) (uint32, uint32, error) {
	p, err := in.call(in.fn.chunkBuild, uint64(in.atlasPtr), api.EncodeI32(cx), api.EncodeI32(cz), uint64(lod))
	if err != nil {
		return 0, 0, err
	}
	if uint32(p) == 0 {
		return 0, 0, in.lastError()
	}
	n, err := in.call1(in.fn.resultLen)
	if err != nil {
		return 0, 0, err
	}
	return uint32(p), uint32(n), nil
}

func (in *instance) chunkBytes(cx, cz int32, lod uint8) ([]byte, error) {
	p, n, err := in.chunkPtr(cx, cz, lod)
	if err != nil {
		return nil, err
	}
	return in.read(p, n)
}

// pool hands out instances, creating them lazily up to max. A trapped
// instance is closed and replaced on demand (ABI rule 5).
type pool struct {
	mu   sync.Mutex
	n    int
	max  int
	ch   chan *instance
	make func() (*instance, error)
}

func (p *pool) get() (*instance, error) {
	select {
	case in := <-p.ch:
		return in, nil
	default:
	}
	p.mu.Lock()
	if p.n < p.max {
		p.n++
		p.mu.Unlock()
		in, err := p.make()
		if err != nil {
			p.mu.Lock()
			p.n--
			p.mu.Unlock()
			return nil, err
		}
		return in, nil
	}
	p.mu.Unlock()
	return <-p.ch, nil
}

func (p *pool) put(in *instance) {
	if in.broken {
		in.close()
		// Replace it right away rather than lowering n: a goroutine may be
		// blocked in get waiting for exactly this slot.
		fresh, err := p.make()
		if err != nil {
			p.mu.Lock()
			p.n--
			p.mu.Unlock()
			return
		}
		in = fresh
	}
	p.ch <- in
}

func (p *pool) close() {
	for {
		select {
		case in := <-p.ch:
			in.close()
		default:
			return
		}
	}
}
