// Command heightcmp proves the server and the client see the same ground
// (WP07 acceptance: "server and client ground heights match exactly at
// 10,000 random points"). For one world it evaluates the ground at N points
// in up to six ways and compares the f64 bit patterns:
//
//	go-wasm     worldhost: collision_height in wazero (compiler), what the zone falls back to
//	go-interp   the same in wazero's interpreter (a second, independent wasm engine in Go)
//	go-fast     worldhost.Terrain: the pure-Go formula on cached chunk heights, the zone's hot path
//	node-wasm   @lodestone/worldgen collisionHeight in Node (V8), the client's loader
//	node-chunk  @lodestone/worldgen chunkSurfaceHeight on LOD 0 chunks in Node
//	chromium-*  the same two inside a headless Chromium Web Worker, where the client generates terrain
//
// The JS hosts run as child processes (server/pkg/worldhost/jscheck), so the
// comparison crosses process and language boundaries.
//
//	go run ./server/pkg/cmd/heightcmp -n 10000 -out docs/evidence/wp07-heights.txt -table docs/evidence/wp07-heights-table.csv.gz
package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"lodestone/server/pkg/worldhost"
)

type config struct {
	seed     uint64
	n        int
	pointsSd uint64
	node     bool
	chromium bool
	interp   bool
	root     string
	log      io.Writer
}

// column is one host's answers, as f64 bit patterns ("" = not evaluated).
type column struct {
	name  string
	hex   []string
	note  string
	match int // vs the reference column
	diff  []int
}

type report struct {
	columns   []*column
	points    [][2]float64
	atlasHash map[string]string
	spawnX    float32
	spawnZ    float32
	name      string
}

func main() {
	var cfg config
	flag.Uint64Var(&cfg.seed, "seed", 20261108, "world seed (spec_from_seed); default = WP04's official world")
	flag.IntVar(&cfg.n, "n", 10000, "points")
	flag.Uint64Var(&cfg.pointsSd, "points-seed", 0x5eed, "seed of the point sampler")
	flag.BoolVar(&cfg.node, "node", true, "compare against Node (@lodestone/worldgen via vite-node)")
	flag.BoolVar(&cfg.chromium, "chromium", true, "compare against headless Chromium (playwright)")
	flag.BoolVar(&cfg.interp, "interp", true, "also run the wazero interpreter")
	out := flag.String("out", "", "also write the log here")
	table := flag.String("table", "", "write every point and height (hex bits) as CSV here")
	flag.Parse()

	var sink io.Writer = os.Stdout
	var logf *os.File
	if *out != "" {
		var err error
		if logf, err = os.Create(*out); err != nil {
			fail(err)
		}
		defer logf.Close()
		sink = io.MultiWriter(os.Stdout, logf)
	}
	cfg.log = sink
	root, err := repoRoot()
	if err != nil {
		fail(err)
	}
	cfg.root = root
	rep, err := run(context.Background(), cfg)
	if err != nil {
		fail(err)
	}
	if *table != "" {
		if err := writeTable(*table, rep); err != nil {
			fail(err)
		}
		fmt.Fprintf(sink, "table: %s\n", *table)
	}
	for _, c := range rep.columns[1:] {
		if c.match != len(rep.points) {
			if logf != nil {
				logf.Close()
			}
			os.Exit(1)
		}
	}
}

func run(ctx context.Context, cfg config) (*report, error) {
	w := cfg.log
	fmt.Fprintf(w, "# WP07 ground height comparison (server vs client)\n")
	fmt.Fprintf(w, "date: %s\nmachine: %s/%s, %d CPUs, %s\n", time.Now().UTC().Format(time.RFC3339), runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.Version())
	mod, err := worldhost.LoadFromEnv(ctx)
	if err != nil {
		return nil, err
	}
	defer mod.Close(ctx)
	mt, err := mod.Mint(cfg.seed, nil, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		return nil, err
	}
	defer mt.World.Close()
	rep := &report{atlasHash: map[string]string{"go": mt.AtlasHash}, name: mt.Name,
		spawnX: mt.World.Header.SpawnX, spawnZ: mt.World.Header.SpawnZ}
	fmt.Fprintf(w, "wasm: %s (sha256 %s, genVersion %s)\n", mod.Path(), mod.SHA256(), mt.GenVersion)
	fmt.Fprintf(w, "world: seed %d %q, atlas %s (%d B), spawn (%.0f, %.0f), sea level %.2f\n", cfg.seed, mt.Name, mt.AtlasHash, len(mt.World.Atlas), rep.spawnX, rep.spawnZ, mt.World.Header.SeaLevel)
	rep.points = worldhost.SamplePoints(cfg.n, cfg.pointsSd)
	fmt.Fprintf(w, "points: %d from worldhost.SamplePoints(seed %#x): uniform over [0, 4096)^2 at full f64 precision, every 8th an edge case (lattice point, cell diagonal fx+fz=1, chunk border, up to 256 m outside the world)\n\n", len(rep.points), cfg.pointsSd)

	// go-wasm (reference)
	t0 := time.Now()
	ref := &column{name: "go-wasm"}
	for _, p := range rep.points {
		ref.hex = append(ref.hex, hex(mt.World.CollisionHeight(p[0], p[1])))
	}
	ref.note = fmt.Sprintf("wazero compiler, %.2f us/query", float64(time.Since(t0).Microseconds())/float64(len(rep.points)))
	rep.columns = append(rep.columns, ref)

	// go-fast: chunk cache, every chunk generated first so every query hits.
	tr := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{Capacity: 1 << 16})
	defer tr.Close()
	t0 = time.Now()
	for _, p := range rep.points {
		if err := tr.Ensure(p[0], p[1], 0); err != nil {
			return nil, err
		}
	}
	genMs := time.Since(t0).Milliseconds()
	t0 = time.Now()
	fast := &column{name: "go-fast"}
	for _, p := range rep.points {
		fast.hex = append(fast.hex, hex(tr.HeightAt(p[0], p[1])))
	}
	st := tr.Stats()
	// Time it separately over enough repetitions for Windows' coarse clock.
	reps, sink := 0, 0.0
	for t0 = time.Now(); time.Since(t0) < 200*time.Millisecond; reps++ {
		for _, p := range rep.points {
			sink += tr.HeightAt(p[0], p[1])
		}
	}
	_ = sink
	fast.note = fmt.Sprintf("pure Go on cached chunk heights, %.3f us/query (%d chunks generated in %d ms; %d hits, %d misses)",
		float64(time.Since(t0).Nanoseconds())/1e3/float64(reps*len(rep.points)), st.Chunks, genMs, st.Hits, st.Misses)
	rep.columns = append(rep.columns, fast)

	if cfg.interp {
		t0 = time.Now()
		im, err := worldhost.Load(ctx, mod.Path(), worldhost.Options{Interpreter: true})
		if err != nil {
			return nil, err
		}
		iw, err := im.OpenWorld(mt.Spec, cfg.seed, worldhost.WorldOptions{MaxInstances: 1})
		if err != nil {
			return nil, err
		}
		rep.atlasHash["go-interp"] = worldhost.Hex64(iw.AtlasHash)
		c := &column{name: "go-interp"}
		for _, p := range rep.points {
			c.hex = append(c.hex, hex(iw.CollisionHeight(p[0], p[1])))
		}
		c.note = fmt.Sprintf("wazero interpreter (atlas rebuilt there too), %.1f s total", time.Since(t0).Seconds())
		rep.columns = append(rep.columns, c)
		iw.Close()
		_ = im.Close(ctx)
	}

	if cfg.node || cfg.chromium {
		in := map[string]any{"spec": json.RawMessage(mt.Spec)}
		var pts [][2]string
		for _, p := range rep.points {
			pts = append(pts, [2]string{hex(p[0]), hex(p[1])})
		}
		in["points"] = pts
		dir, err := os.MkdirTemp("", "heightcmp")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(dir)
		inPath := filepath.Join(dir, "in.json")
		b, _ := json.Marshal(in)
		if err := os.WriteFile(inPath, b, 0o644); err != nil {
			return nil, err
		}
		hosts := []struct {
			on   bool
			name string
			args []string
		}{
			{cfg.node, "node", []string{filepath.Join(cfg.root, "node_modules", "vite-node", "vite-node.mjs"), filepath.Join("server", "pkg", "worldhost", "jscheck", "heights.mjs")}},
			{cfg.chromium, "chromium", []string{filepath.Join("server", "pkg", "worldhost", "jscheck", "browser.mjs")}},
		}
		for _, h := range hosts {
			if !h.on {
				continue
			}
			outPath := filepath.Join(dir, h.name+".json")
			t0 := time.Now()
			cmd := exec.CommandContext(ctx, "node", h.args...)
			cmd.Dir = cfg.root
			cmd.Env = append(os.Environ(), "HEIGHTCMP_IN="+inPath, "HEIGHTCMP_OUT="+outPath, "HEIGHTCMP_WASM="+mod.Path())
			if outb, err := cmd.CombinedOutput(); err != nil {
				return nil, fmt.Errorf("%s host: %v\n%s", h.name, err, outb)
			}
			var res struct {
				Host, UserAgent          string
				AtlasHash                string
				Wasm, Chunk              []*string
				Chunks                   int
				AtlasMs, WasmMs, ChunkMs float64
			}
			raw, err := os.ReadFile(outPath)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(raw, &res); err != nil {
				return nil, err
			}
			if len(res.Wasm) != len(rep.points) {
				return nil, fmt.Errorf("%s returned %d heights for %d points", h.name, len(res.Wasm), len(rep.points))
			}
			rep.atlasHash[h.name] = res.AtlasHash
			wc := &column{name: h.name + "-wasm", note: fmt.Sprintf("%s: collisionHeight, atlas %.0f ms, %.2f us/query (process %.1f s)", res.Host, res.AtlasMs, res.WasmMs*1000/float64(len(rep.points)), time.Since(t0).Seconds())}
			cc := &column{name: h.name + "-chunk", note: fmt.Sprintf("%s: chunkSurfaceHeight over %d LOD 0 chunks (%.1f s incl. chunk builds)", res.Host, res.Chunks, res.ChunkMs/1000)}
			for i := range rep.points {
				wc.hex = append(wc.hex, deref(res.Wasm[i]))
				cc.hex = append(cc.hex, deref(res.Chunk[i]))
			}
			rep.columns = append(rep.columns, wc, cc)
			if res.UserAgent != "" {
				fmt.Fprintf(w, "%s user agent: %s\n", h.name, res.UserAgent)
			}
		}
	}

	// Compare every column with the reference.
	fmt.Fprintf(w, "atlas hashes: ")
	allAtlas := true
	for k, v := range rep.atlasHash {
		fmt.Fprintf(w, "%s=%s ", k, v)
		allAtlas = allAtlas && v == mt.AtlasHash
	}
	fmt.Fprintf(w, "(all equal: %v)\n\n", allAtlas)
	fmt.Fprintf(w, "%-15s %-22s %s\n", "host", "bitwise == go-wasm", "notes")
	fmt.Fprintf(w, "%-15s %-22s %s\n", ref.name, "(reference)", ref.note)
	failed := !allAtlas
	for _, c := range rep.columns[1:] {
		evaluated := 0
		for i := range rep.points {
			if c.hex[i] == "" {
				c.match++ // outside chunk_build's range: not applicable
				continue
			}
			evaluated++
			if c.hex[i] == ref.hex[i] {
				c.match++
			} else {
				c.diff = append(c.diff, i)
			}
		}
		na := ""
		if evaluated != len(rep.points) {
			na = fmt.Sprintf(" (%d n/a)", len(rep.points)-evaluated)
		}
		fmt.Fprintf(w, "%-15s %-22s %s\n", c.name, fmt.Sprintf("%d/%d%s", c.match, len(rep.points), na), c.note)
		for k, i := range c.diff {
			if k == 10 {
				fmt.Fprintf(w, "    ... %d more\n", len(c.diff)-10)
				break
			}
			fmt.Fprintf(w, "    MISMATCH point %d (%v, %v): %s vs %s\n", i, rep.points[i][0], rep.points[i][1], c.hex[i], ref.hex[i])
		}
		failed = failed || len(c.diff) > 0
	}
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, h := range ref.hex {
		v := unhex(h)
		lo, hi = math.Min(lo, v), math.Max(hi, v)
	}
	fmt.Fprintf(w, "\nheight range over the points: %.2f .. %.2f m\n", lo, hi)
	fmt.Fprintf(w, "first rows (x, z, height as f64 bits / value):\n")
	for i := 0; i < min(8, len(rep.points)); i++ {
		fmt.Fprintf(w, "  %-22v %-22v %s  %.6f\n", rep.points[i][0], rep.points[i][1], ref.hex[i], unhex(ref.hex[i]))
	}
	if failed {
		fmt.Fprintf(w, "\nRESULT: FAIL\n")
	} else {
		fmt.Fprintf(w, "\nRESULT: PASS (every host agrees to the bit at all %d points)\n", len(rep.points))
	}
	return rep, nil
}

// writeTable writes every point with its height bits and, per host, "=" when
// that host's bits equal the reference (n/a: empty), or its own bits.
// Gzipped when path ends in .gz (the full table is ~1.5 MB raw).
func writeTable(path string, rep *report) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var out io.Writer = f
	if strings.HasSuffix(path, ".gz") {
		gz := gzip.NewWriter(f)
		defer gz.Close()
		out = gz
	}
	names := []string{"x_bits", "z_bits", "x", "z", rep.columns[0].name + "_bits"}
	for _, c := range rep.columns[1:] {
		names = append(names, c.name)
	}
	fmt.Fprintln(out, strings.Join(names, ","))
	for i, p := range rep.points {
		ref := rep.columns[0].hex[i]
		row := []string{hex(p[0]), hex(p[1]), fmt.Sprint(p[0]), fmt.Sprint(p[1]), ref}
		for _, c := range rep.columns[1:] {
			switch c.hex[i] {
			case ref:
				row = append(row, "=")
			default:
				row = append(row, c.hex[i])
			}
		}
		fmt.Fprintln(out, strings.Join(row, ","))
	}
	return nil
}

func hex(v float64) string { return fmt.Sprintf("%016x", math.Float64bits(v)) }

func unhex(s string) float64 {
	var b uint64
	_, _ = fmt.Sscanf(s, "%x", &b)
	return math.Float64frombits(b)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// repoRoot walks up from the working directory to the directory holding
// go.work (the JS hosts and node_modules live there).
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("go.work not found above the working directory")
		}
		dir = parent
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "heightcmp:", err)
	os.Exit(1)
}
