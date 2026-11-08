package worldhost

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// The tests need the built wasm (`npm run build:wasm`). They skip without it,
// and fail under LODESTONE_REQUIRE_WASM=1 (CI after the wasm build).

// OfficialSeed is WP04's default official world seed (LODESTONE_WORLD_SEED).
const officialSeed = 20261108

var (
	shared struct {
		once sync.Once
		mod  *Module
		w    *World
		err  error
	}
)

func testModule(t testing.TB) *Module {
	t.Helper()
	shared.once.Do(func() {
		shared.mod, shared.err = LoadFromEnv(context.Background())
		if shared.err == nil {
			var mt Minted
			mt, shared.err = shared.mod.Mint(officialSeed, nil, WorldOptions{})
			shared.w = mt.World
		}
	})
	if shared.err != nil {
		if errors.Is(shared.err, ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", shared.err)
		}
		t.Fatal(shared.err)
	}
	return shared.mod
}

func testWorld(t testing.TB) *World {
	testModule(t)
	return shared.w
}

func TestModuleBasics(t *testing.T) {
	m := testModule(t)
	if m.GenVersion() != 1 {
		t.Fatalf("genVersion %d", m.GenVersion())
	}
	if len(m.SHA256()) != 64 {
		t.Fatalf("sha %q", m.SHA256())
	}
	// The manifest written by build-wasm.mjs names the same hash.
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(m.Path()), "manifest.json"))
	if err == nil {
		var man struct {
			SHA256     string `json:"sha256"`
			GenVersion uint32 `json:"genVersion"`
		}
		if err := json.Unmarshal(raw, &man); err != nil {
			t.Fatal(err)
		}
		if man.SHA256 != m.SHA256() || man.GenVersion != m.GenVersion() {
			t.Fatalf("manifest %+v vs module %s/%d", man, m.SHA256(), m.GenVersion())
		}
	}
	b := []byte("lodestone worldhost")
	h, err := m.Hash(b)
	if err != nil || h != FNV1a64(b) {
		t.Fatalf("hash_buffer %x vs Go %x (%v)", h, FNV1a64(b), err)
	}
}

func TestRefusesImports(t *testing.T) {
	// A minimal module importing m.f: a host import is how host math (Go's
	// math.Sin vs V8's Math.sin) would leak in, so Compile must refuse it.
	wasm := []byte{0, 'a', 's', 'm', 1, 0, 0, 0,
		1, 4, 1, 0x60, 0, 0, // type section: () -> ()
		2, 7, 1, 1, 'm', 1, 'f', 0, 0, // import section: func m.f type 0
	}
	if _, err := Compile(context.Background(), wasm, Options{}); err == nil {
		t.Fatal("module with an import was accepted")
	}
}

func TestEnvSHAPin(t *testing.T) {
	testModule(t)
	t.Setenv(EnvWasmSHA256, "deadbeef")
	if _, err := LoadFromEnv(context.Background()); err == nil {
		t.Fatal("wrong sha pin accepted")
	}
	t.Setenv(EnvWasmSHA256, shared.mod.SHA256()[:16])
	m, err := LoadFromEnv(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = m.Close(context.Background())
}

// TestGoldenCollision checks WP01's golden collision heights (Node,
// Chromium, Go harness and native Rust already agree on them) through this
// host: the wasm path and the pure-Go fast path from cached chunks.
func TestGoldenCollision(t *testing.T) {
	m := testModule(t)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(m.Path()), "..", "golden", "golden.json"))
	if err != nil {
		t.Skipf("golden table not found: %v", err)
	}
	var g struct {
		Worlds []struct {
			Label string          `json:"label"`
			Seed  string          `json:"seed"`
			Spec  json.RawMessage `json:"spec"`
			Atlas struct {
				Hash string `json:"hash"`
			} `json:"atlas"`
			Collision []struct {
				X, Z float64
				H    string
			} `json:"collision"`
		} `json:"worlds"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, gw := range g.Worlds {
		seed, _ := strconv.ParseUint(gw.Seed, 10, 64)
		mt, err := m.Mint(seed, gw.Spec, WorldOptions{MaxInstances: 2})
		if err != nil {
			t.Fatal(err)
		}
		if mt.AtlasHash != gw.Atlas.Hash {
			t.Fatalf("%s: atlas hash %s, golden %s", gw.Label, mt.AtlasHash, gw.Atlas.Hash)
		}
		tr := NewTerrain(mt.World, TerrainOptions{Workers: 1})
		for _, c := range gw.Collision {
			want, _ := strconv.ParseUint(c.H, 16, 64)
			if got := math.Float64bits(mt.World.CollisionHeight(c.X, c.Z)); got != want {
				t.Fatalf("%s wasm (%v, %v): %016x want %016x", gw.Label, c.X, c.Z, got, want)
			}
			if err := tr.Ensure(c.X, c.Z, 0); err != nil {
				t.Fatal(err)
			}
			if got := math.Float64bits(tr.HeightAt(c.X, c.Z)); got != want {
				t.Fatalf("%s fast path (%v, %v): %016x want %016x", gw.Label, c.X, c.Z, got, want)
			}
			n++
		}
		tr.Close()
		mt.World.Close()
	}
	t.Logf("%d golden collision heights match (wasm + fast path)", n)
}

// TestFastPathBitwise: the pure-Go formula on cached chunk heights equals
// collision_height to the bit, at random points and at the awkward ones
// (lattice points, cell diagonals, chunk borders, outside the world).
func TestFastPathBitwise(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 2, Capacity: 8192})
	defer tr.Close()
	pts := SamplePoints(20000, 99)
	cx, cz := float64(w.Header.SpawnX), float64(w.Header.SpawnZ)
	for _, p := range [][2]float64{
		{cx, cz}, {math.Floor(cx), math.Floor(cz)}, {math.Floor(cx) + 0.25, math.Floor(cz) + 0.75}, // fx+fz == 1
		{64, 64}, {63.999999, 64}, {0, 0}, {4095.99, 4095.99}, {-10.5, 300.25}, {4100.5, 4200.75}, {-4095.5, -4095.5}, {8191.9, 8191.9},
	} {
		pts = append(pts, p)
	}
	for _, p := range pts {
		tr.Want(p[0], p[1], 0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := tr.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	for _, p := range pts {
		if err := tr.Ensure(p[0], p[1], 0); err != nil {
			t.Fatal(err)
		}
	}
	before := tr.Stats()
	for _, p := range pts {
		fast := tr.HeightAt(p[0], p[1])
		slow := w.CollisionHeight(p[0], p[1])
		if math.Float64bits(fast) != math.Float64bits(slow) {
			t.Fatalf("(%v, %v): fast %v (%016x) vs wasm %v (%016x)", p[0], p[1], fast, math.Float64bits(fast), slow, math.Float64bits(slow))
		}
	}
	after := tr.Stats()
	if after.Misses != before.Misses {
		t.Fatalf("expected every point to hit the cache: %+v", after)
	}
	t.Logf("%d points bitwise equal; cache %+v", len(pts), after)
}

func TestTerrainNeverBlocksAndCaches(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 1})
	defer tr.Close()
	x, z := 1000.3, 2000.7
	h := tr.HeightAt(x, z) // cold: answered by wasm, chunk queued
	st := tr.Stats()
	if st.Misses != 1 || st.Hits != 0 {
		t.Fatalf("cold query: %+v", st)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := tr.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := tr.Chunk(15, 31); !ok {
		t.Fatalf("chunk (15, 31) not generated: %+v", tr.Stats())
	}
	if h2 := tr.HeightAt(x, z); h2 != h || tr.Stats().Hits != 1 {
		t.Fatalf("warm query %v vs %v, %+v", h2, h, tr.Stats())
	}
}

func TestTerrainWantAndEviction(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 2, Capacity: 16})
	defer tr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	// A 100 m margin around a chunk center covers 5 x 5 chunks.
	tr.Want(32*64+32, 32*64+32, 100)
	if err := tr.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	st := tr.Stats()
	if st.Generated != 25 {
		t.Fatalf("want 25 generated: %+v", st)
	}
	// All 25 were wanted by the latest Want call (the current epoch), so
	// none may be evicted yet, even over capacity: the cache never drops a
	// chunk somebody is standing on to make room.
	if st.Chunks != 25 || st.Evicted != 0 {
		t.Fatalf("current-epoch chunks evicted: %+v", st)
	}
	// A newer Want makes the old ones evictable; the next insert trims the
	// cache to 15/16 of capacity, keeping the freshly wanted chunk.
	tr.Want(10*64+32, 10*64+32, 0)
	if err := tr.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := tr.Chunk(10, 10); !ok {
		t.Fatal("freshly wanted chunk was evicted")
	}
	if tr.Stats().Chunks > 16 {
		t.Fatalf("over capacity: %+v", tr.Stats())
	}
}

func TestConcurrentQueries(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 2})
	defer tr.Close()
	pts := SamplePoints(4000, 5)
	want := make([]float64, len(pts))
	for i, p := range pts {
		want[i] = w.CollisionHeight(p[0], p[1])
	}
	var wg sync.WaitGroup
	errs := make(chan string, 16)
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for k := range pts {
				i := (k + g*251) % len(pts)
				p := pts[i]
				tr.Want(p[0], p[1], 32)
				if h := tr.HeightAt(p[0], p[1]); math.Float64bits(h) != math.Float64bits(want[i]) {
					errs <- "mismatch"
					return
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	t.Logf("16 goroutines x %d queries; %+v", len(pts), tr.Stats())
}

func TestGroundNormalAndRaycast(t *testing.T) {
	w := testWorld(t)
	x, z := float64(w.Header.SpawnX), float64(w.Header.SpawnZ)
	n, slope, err := w.GroundNormal(x, z)
	if err != nil {
		t.Fatal(err)
	}
	if l := math.Sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2]); math.Abs(l-1) > 1e-12 || n[1] <= 0 || slope < 0 || slope > 90 {
		t.Fatalf("normal %v slope %v", n, slope)
	}
	h := w.CollisionHeight(x, z)
	d, ok, err := w.Raycast([3]float64{x, h + 50, z}, [3]float64{0, -1, 0}, 200)
	if err != nil || !ok || math.Abs(d-50) > 1e-9 {
		t.Fatalf("raycast down: %v %v %v", d, ok, err)
	}
	if _, ok, _ := w.Raycast([3]float64{x, h + 50, z}, [3]float64{0, 1, 0}, 200); ok {
		t.Fatal("raycast up should miss")
	}
}

func TestPinAndMint(t *testing.T) {
	m := testModule(t)
	w := testWorld(t)
	if err := m.CheckGenVersion("1"); err != nil {
		t.Fatal(err)
	}
	if err := m.CheckGenVersion("v1"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"2", "0", "d38abb3027caa709", "1.0"} {
		if err := m.CheckGenVersion(bad); !errors.Is(err, ErrGenVersion) {
			t.Fatalf("%q accepted: %v", bad, err)
		}
	}
	spec := w.SpecJSON()
	good := WorldRow{Seed: officialSeed, Spec: spec, GenVersion: "1", AtlasHash: Hex64(w.AtlasHash)}
	mt, ph, err := m.OpenRow(good, WorldOptions{MaxInstances: 1})
	if err != nil || ph || mt.AtlasHash != Hex64(w.AtlasHash) {
		t.Fatalf("good row: %v %v %+v", err, ph, mt.AtlasHash)
	}
	mt.World.Close()

	// jsonb reorders keys; atlas_build canonicalizes, so the hash holds.
	var anyJSON map[string]any
	_ = json.Unmarshal(spec, &anyJSON)
	reordered, _ := json.Marshal(anyJSON) // Go sorts keys
	mt, _, err = m.OpenRow(WorldRow{Seed: officialSeed, Spec: reordered, GenVersion: "1", AtlasHash: good.AtlasHash}, WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatalf("reordered spec: %v", err)
	}
	mt.World.Close()

	if _, _, err := m.OpenRow(WorldRow{Seed: officialSeed, Spec: spec, GenVersion: "2"}, WorldOptions{}); !errors.Is(err, ErrGenVersion) {
		t.Fatalf("wrong gen version: %v", err)
	}
	if _, _, err := m.OpenRow(WorldRow{Seed: officialSeed, Spec: spec, GenVersion: "1", AtlasHash: "0123456789abcdef"}, WorldOptions{}); !errors.Is(err, ErrAtlasHash) {
		t.Fatalf("wrong atlas hash: %v", err)
	}
	mt, ph, err = m.OpenRow(WorldRow{Seed: officialSeed, Spec: []byte(`{"placeholder":true}`), GenVersion: "placeholder", AtlasHash: "placeholder"}, WorldOptions{MaxInstances: 1})
	if err != nil || !ph || mt.AtlasHash != good.AtlasHash || mt.GenVersion != "1" || mt.Name == "" {
		t.Fatalf("placeholder row: %v %v %+v", err, ph, mt)
	}
	mt.World.Close()
}

func TestSpawnPoint(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 1})
	defer tr.Close()
	for i := 0; i < 50; i++ {
		id := "character-" + strconv.Itoa(i)
		p := tr.SpawnPoint(id)
		if q := tr.SpawnPoint(id); q != p {
			t.Fatalf("spawn not stable: %v vs %v", p, q)
		}
		d := math.Hypot(p.X-float64(w.Header.SpawnX), p.Z-float64(w.Header.SpawnZ))
		if d > SpawnRadiusM*7 {
			t.Fatalf("spawn %v is %v m from the atlas spawn", p, d)
		}
		if _, ok := tr.DryPoint(p.X, p.Z); !ok {
			t.Fatalf("spawn %v is wet", p)
		}
		if math.Float64bits(p.Y) != math.Float64bits(w.CollisionHeight(p.X, p.Z)) {
			t.Fatalf("spawn y %v not on the ground", p.Y)
		}
		if p.Y < float64(w.Header.SeaLevel) {
			t.Fatalf("spawn %v under sea level %v", p, w.Header.SeaLevel)
		}
	}
}

// TestMovementOnTerrain walks the shared movement step across generated
// terrain and checks it stays glued to the surface (ground snap) and never
// sinks below it.
func TestMovementOnTerrain(t *testing.T) {
	w := testWorld(t)
	tr := NewTerrain(w, TerrainOptions{Workers: 2})
	defer tr.Close()
	s := movement.State{Pos: tr.SpawnPoint("walker")}
	climbed := 0.0
	for i := 0; i < 60*20; i++ { // 20 s of sprinting in a slow circle
		yaw := float64(i) / 600 * math.Pi
		prevY := s.Pos.Y
		tr.Want(s.Pos.X, s.Pos.Z, 64)
		s = movement.Step(s, proto.InputFlagForward|proto.InputFlagSprint, yaw, tr)
		g := tr.HeightAt(s.Pos.X, s.Pos.Z)
		if s.Pos.Y < g-1e-9 {
			t.Fatalf("step %d sank below ground: y %v ground %v", i, s.Pos.Y, g)
		}
		climbed += math.Abs(s.Pos.Y - prevY)
	}
	if climbed == 0 {
		t.Fatal("terrain was flat the whole walk; not exercising the ground")
	}
	t.Logf("walked to %+v, total |dy| %.2f m, cache %+v", s.Pos, climbed, tr.Stats())
}

func BenchmarkHeightAtCached(b *testing.B) {
	w := testWorld(b)
	tr := NewTerrain(w, TerrainOptions{Workers: 1})
	defer tr.Close()
	x0, z0 := float64(w.Header.SpawnX), float64(w.Header.SpawnZ)
	if err := tr.Ensure(x0, z0, 64); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tr.HeightAt(x0+float64(i%97)*0.37, z0+float64(i%89)*0.41)
	}
}

func BenchmarkCollisionHeightWasm(b *testing.B) {
	w := testWorld(b)
	x0, z0 := float64(w.Header.SpawnX), float64(w.Header.SpawnZ)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w.CollisionHeight(x0+float64(i%97)*0.37, z0+float64(i%89)*0.41)
	}
}

func BenchmarkChunkBuild(b *testing.B) {
	w := testWorld(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := w.ChunkBytes(int32(i%64), int32((i/64)%64), 0); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkTick150 is the terrain share of one 30 Hz zone tick with 150
// players spread over the world: two input frames each (2 ground queries per
// step) plus the grounded checks for quantize and SelfState, with the chunk
// cache warm (Want keeps it so). Players walk ~50 m circles so the benchmark
// measures the steady state, not an endless march into cold chunks (the
// soak covers that). One op = one tick.
func BenchmarkTick150(b *testing.B) {
	w := testWorld(b)
	tr := NewTerrain(w, TerrainOptions{})
	defer tr.Close()
	pts := SamplePoints(150, 3)
	states := make([]movement.State, len(pts))
	for i, p := range pts {
		x := 512 + math.Mod(p[0], 3072)
		z := 512 + math.Mod(p[1], 3072)
		states[i].Pos = movement.Vec3{X: x, Y: w.CollisionHeight(x, z), Z: z}
		if err := tr.Ensure(x, z, 96); err != nil {
			b.Fatal(err)
		}
	}
	before := tr.Stats()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for k := range states {
			s := states[k]
			yaw := float64(k) + float64(i)/300 // 0.1 rad/s at 4.9 m/s: r ~ 49 m
			for f := 0; f < constants.MoveStepHz/constants.TickRateHz; f++ {
				s = movement.Step(s, proto.InputFlagForward, yaw, tr)
			}
			movement.Grounded(s, tr)
			movement.Grounded(s, tr)
			if (i+k)%15 == 0 {
				tr.Want(s.Pos.X, s.Pos.Z, 48+movement.HorizontalSpeed(s)*3)
			}
			states[k] = s
		}
	}
	b.StopTimer()
	st := tr.Stats()
	if q := st.Hits + st.Misses - before.Hits - before.Misses; q > 0 {
		b.ReportMetric(float64(st.Misses-before.Misses)/float64(q)*100, "miss%")
		b.ReportMetric(float64(q)/float64(b.N), "queries/tick")
	}
}
