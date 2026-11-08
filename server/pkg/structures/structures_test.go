package structures

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/worldhost"
)

// go test ./structures -run Golden -update rewrites testdata/golden.json
// (after an intentional change to the overlay or tower geometry; the TS
// test client/src/world/structures/overlay.test.ts replays the file).
var update = flag.Bool("update", false, "rewrite testdata/golden.json")

// plane is a tilted test ground written FMA-proof, like the TS PlaneGround
// (V8 never fuses).
type plane struct{ base, sx, sz float64 }

func (p plane) HeightAt(x, z float64) float64 { return p.base + float64(p.sx*x) + float64(p.sz*z) }

func TestRadialProfile(t *testing.T) {
	tw := NewTower(movement.Flat{Y: 100}, 500, 700)
	if tw.TopY != 100+TowerHeight {
		t.Fatalf("top %v", tw.TopY)
	}
	r, drop := TowerProfile()
	// Platform, wall, ledge, lower wall.
	cases := []struct {
		x, want float64
	}{
		{500, tw.TopY},
		{500 + 3.9, tw.TopY},
		{500 + r[0], tw.TopY},
		{500 + r[1], tw.TopY - drop[1]},
		{500 + r[1] + 0.7, tw.TopY - TowerUpperDrop},
		{500 + r[2] + 1, tw.TopY - TowerUpperDrop - TowerWallSlope},
	}
	for _, c := range cases {
		h, ok := tw.Top(c.x, 700)
		if !ok || math.Abs(h-c.want) > 1e-9 {
			t.Errorf("Top(%v) = %v %v, want %v", c.x-500, h, ok, c.want)
		}
	}
	if _, ok := tw.Top(500+tw.MaxR+0.01, 700); ok {
		t.Error("outside MaxR must not be covered")
	}
	// The lower wall ends exactly towerSkirt below the flat ground.
	if b := TowerBottom(tw); math.Abs(b-(100-towerSkirt)) > 1e-9 {
		t.Errorf("bottom %v", b)
	}
	// Walls are 80 degrees, platform and ledge flat.
	for _, c := range []struct{ dx, deg float64 }{{1, 0}, {r[0] + 1, 80}, {r[1] + 0.5, 0}, {r[2] + 2, 80}} {
		n := tw.Normal(500+c.dx*s2, 700+c.dx*s2)
		deg := math.Acos(n.Y) * 180 / math.Pi
		if math.Abs(deg-c.deg) > 1e-6 || math.Abs(math.Hypot(math.Hypot(n.X, n.Y), n.Z)-1) > 1e-12 {
			t.Errorf("normal at r=%v: %v (%v deg), want %v deg", c.dx, n, deg, c.deg)
		}
		// Normal points away from the axis on walls.
		if c.deg > 0 && (n.X <= 0 || n.Z <= 0) {
			t.Errorf("wall normal must point outward: %v", n)
		}
	}
}

func TestOverlayMaxAndIndex(t *testing.T) {
	base := plane{50, 0.02, -0.01}
	o := NewOverlay()
	a := o.Add(NewTower(base, 100, 100))
	b := o.Add(NewTower(movement.Flat{Y: 10}, 104, 100)) // overlapping, lower
	g := Wrap(base, o)
	if g.StructureAt(100, 100) != a {
		t.Fatal("the taller tower forms the ground at its axis")
	}
	if g.StructureAt(300, 300) != -1 || g.HeightAt(300, 300) != base.HeightAt(300, 300) {
		t.Fatal("away from structures the ground is the base")
	}
	// Far down tower b's tail (below the plane) the terrain wins.
	tb := o.At(b).(*Radial)
	x := 104 + tb.MaxR - 0.01
	if h, ok := tb.Top(x, 100); !ok || h > base.HeightAt(x, 100) {
		t.Fatalf("test setup: tail should be under the plane (%v)", h)
	}
	if g.HeightAt(x, 100) != base.HeightAt(x, 100) {
		t.Fatal("max(): terrain above a structure's tail wins")
	}
	if n := g.NormalAt(300, 300); n != (movement.Vec3{Y: 1}) {
		t.Fatalf("base without normals reports up: %v", n)
	}
	// Order independence: the same structures added in reverse give the
	// same heights everywhere.
	o2 := NewOverlay()
	o2.Add(o.At(b))
	o2.Add(o.At(a))
	g2 := Wrap(base, o2)
	for i := 0; i < 2000; i++ {
		x, z := 80+float64(i%50), 80+float64(i/50)
		if g.HeightAt(x, z) != g2.HeightAt(x, z) {
			t.Fatalf("order dependent at %v,%v", x, z)
		}
	}
}

func TestOverlayNaNAndEmpty(t *testing.T) {
	var o *Overlay
	if _, _, ok := o.Top(1, 1); ok {
		t.Fatal("nil overlay covers nothing")
	}
	o = NewOverlay()
	o.Add(NewTower(movement.Flat{}, 10, 10))
	if _, _, ok := o.Top(math.NaN(), 10); ok {
		t.Fatal("NaN covers nothing")
	}
}

// ---- golden vectors shared with the TS twin ----

type goldenTower struct {
	CX, CZ float64
	TopY   string // float64 bits, hex
	MaxR   string
}

type goldenPoint struct {
	X, Z float64
	H    string    // combined ground height bits
	S    int       // structure index forming the ground, -1 terrain
	N    [3]string `json:",omitempty"` // normal bits where S >= 0
}

type goldenCase struct {
	Name string
	// Base: "plane:<base>,<sx>,<sz>" or "world:<seed>" (spec_from_seed +
	// atlas_build, terrain = collision_height).
	Base   string
	Towers []goldenTower
	Points []goldenPoint
}

type goldenFile struct {
	Comment string
	Profile struct{ R, Drop []float64 }
	Cases   []goldenCase
}

func bits(f float64) string { return fmt.Sprintf("%016x", math.Float64bits(f)) }

func splitmix(s uint64) uint64 {
	s += 0x9e3779b97f4a7c15
	z := s
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// points samples around every tower: exact breakpoint radii on the axes and
// diagonals, the axis itself, and random points over the whole footprint
// plus a margin, at full f64 precision.
func points(o *Overlay, perTower int, seed uint64) [][2]float64 {
	s := seed
	next := func() float64 { s = splitmix(s); return float64(s>>11) / (1 << 53) }
	var pts [][2]float64
	r, _ := TowerProfile()
	for i := 0; i < o.Len(); i++ {
		t := o.At(i).(*Radial)
		pts = append(pts, [2]float64{t.CX, t.CZ})
		for _, rr := range append(append([]float64{}, r...), t.MaxR, t.MaxR+0.5) {
			for _, d := range dirs8 {
				pts = append(pts, [2]float64{t.CX + float64(d[0]*rr), t.CZ + float64(d[1]*rr)})
			}
		}
		for k := 0; k < perTower; k++ {
			pts = append(pts, [2]float64{t.CX + (next()*2-1)*(t.MaxR+3), t.CZ + (next()*2-1)*(t.MaxR+3)})
		}
	}
	return pts
}

func buildCase(name, baseSpec string, base movement.Ground, o *Overlay, perTower int) goldenCase {
	c := goldenCase{Name: name, Base: baseSpec}
	for i := 0; i < o.Len(); i++ {
		t := o.At(i).(*Radial)
		c.Towers = append(c.Towers, goldenTower{CX: t.CX, CZ: t.CZ, TopY: bits(t.TopY), MaxR: bits(t.MaxR)})
	}
	g := Wrap(base, o)
	for _, p := range points(o, perTower, 0x12c0ffee) {
		gp := goldenPoint{X: p[0], Z: p[1], H: bits(g.HeightAt(p[0], p[1])), S: g.StructureAt(p[0], p[1])}
		if gp.S >= 0 {
			n := g.NormalAt(p[0], p[1])
			gp.N = [3]string{bits(n.X), bits(n.Y), bits(n.Z)}
		}
		c.Points = append(c.Points, gp)
	}
	return c
}

func syntheticCase() goldenCase {
	base := plane{37.25, 0.031, -0.047}
	o := NewOverlay()
	for _, c := range [][2]float64{{200.5, 300.25}, {1023.9, 1024.1}, {207.75, 310}} { // the third overlaps the first
		o.Add(NewTower(base, c[0], c[1]))
	}
	return buildCase("plane", "plane:37.25,0.031,-0.047", base, o, 400)
}

// wasmTerrain is the real world's terrain straight from collision_height.
type wasmTerrain struct{ w *worldhost.World }

func (t wasmTerrain) HeightAt(x, z float64) float64 { return t.w.CollisionHeight(x, z) }

const goldenSeed = 20261108 // the official dev world (WP04/WP07)

func worldCase(t *testing.T) (goldenCase, bool) {
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		if errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Log("worldgen.wasm not built: skipping the real-terrain golden case (npm run build:wasm)")
			return goldenCase{}, false
		}
		t.Fatal(err)
	}
	spec, err := mod.SpecFromSeed(goldenSeed)
	if err != nil {
		t.Fatal(err)
	}
	w, err := mod.OpenWorld(spec, goldenSeed, worldhost.WorldOptions{})
	if err != nil {
		t.Fatal(err)
	}
	a, err := ParseAtlas(w.Atlas)
	if err != nil {
		t.Fatal(err)
	}
	base := wasmTerrain{w}
	o, sites := Towers(a, base)
	if o.Len() < len(a.Regions) {
		t.Fatalf("%d towers for %d regions", o.Len(), len(a.Regions))
	}
	for _, r := range a.Regions {
		if r.Tower < 0 || !a.Sites[r.Tower].IsTower() {
			t.Fatalf("region %d has no tower site", r.Index)
		}
	}
	_ = sites
	return buildCase("world", fmt.Sprintf("world:%d", goldenSeed), base, o, 120), true
}

func TestGolden(t *testing.T) {
	path := filepath.Join("testdata", "golden.json")
	var gf goldenFile
	gf.Comment = "WP12 structure overlay golden vectors: generated by `go test ./structures -run Golden -update` (server/pkg), replayed bit for bit by client/src/world/structures/overlay.test.ts. Heights and normals are float64 bits in hex."
	gf.Profile.R, gf.Profile.Drop = TowerProfile()
	gf.Cases = append(gf.Cases, syntheticCase())
	wc, haveWorld := worldCase(t)
	if haveWorld {
		gf.Cases = append(gf.Cases, wc)
	}
	if *update {
		if !haveWorld {
			t.Fatal("-update needs worldgen.wasm (npm run build:wasm)")
		}
		// Compact: the file is data for two test suites, not for reading.
		b, _ := json.Marshal(gf)
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s: %d + %d points", path, len(gf.Cases[0].Points), len(gf.Cases[1].Points))
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want goldenFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	for _, got := range gf.Cases {
		var w *goldenCase
		for i := range want.Cases {
			if want.Cases[i].Name == got.Name {
				w = &want.Cases[i]
			}
		}
		if w == nil {
			t.Fatalf("golden has no case %q", got.Name)
		}
		if len(w.Points) != len(got.Points) || len(w.Towers) != len(got.Towers) {
			t.Fatalf("%s: %d points / %d towers, golden %d / %d", got.Name, len(got.Points), len(got.Towers), len(w.Points), len(w.Towers))
		}
		for i := range got.Towers {
			if got.Towers[i] != w.Towers[i] {
				t.Fatalf("%s tower %d: %+v, golden %+v", got.Name, i, got.Towers[i], w.Towers[i])
			}
		}
		bad := 0
		for i := range got.Points {
			if got.Points[i] != w.Points[i] {
				if bad < 5 {
					t.Errorf("%s point %d: %+v, golden %+v", got.Name, i, got.Points[i], w.Points[i])
				}
				bad++
			}
		}
		if bad > 0 {
			t.Fatalf("%s: %d/%d points differ", got.Name, bad, len(got.Points))
		}
		t.Logf("%s: %d towers, %d points bit-identical", got.Name, len(got.Towers), len(got.Points))
	}
}

func BenchmarkGroundHeightNearTower(b *testing.B) {
	base := plane{10, 0.01, 0.02}
	o := NewOverlay()
	for i := 0; i < 16; i++ {
		o.Add(NewTower(base, float64(200+i*250), float64(200+i*250)))
	}
	g := Wrap(base, o)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = g.HeightAt(200+float64(i%20), 200)
	}
}
