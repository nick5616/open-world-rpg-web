package camps_test

// Camp rules (CR 025) and the collision twin's golden vectors:
// testdata/camps.json is written here (-update) and replayed bit for bit by
// client/src/ui/camps/camps.test.ts (client/src/ui/camps/collide.ts).

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/movement"
)

var update = flag.Bool("update", false, "rewrite testdata/camps.json")

// flatEnv is open, dry, gently sloped ground with one town and one structure box.
type flatEnv struct {
	slope   float64 // dy/dx
	water   float64
	townX   float64
	townZ   float64
	townR   float64
	struct_ camps.Footprint
}

func (e flatEnv) HeightAt(x, z float64) float64 { return 50 + e.slope*x }
func (e flatEnv) WaterAt(x, z float64) float64  { return e.water }
func (e flatEnv) InTown(x, z, m float64) bool {
	return e.townR > 0 && math.Hypot(x-e.townX, z-e.townZ) < e.townR+m
}
func (e flatEnv) Structure(f camps.Footprint) bool {
	return e.struct_.Hx > 0 && f.Overlaps(e.struct_, 0)
}

func env() flatEnv {
	return flatEnv{water: -100, townX: 500, townZ: 500, townR: 60, struct_: camps.Footprint{X: 1200, Z: 1200, Cs: 1, Hx: 3, Hz: 3}}
}

func want(kind int, x, z float64) camps.Want {
	return camps.Want{Kind: kind, X: x, Z: z, Owner: "a", FeetX: x - 2, FeetY: 1e4, FeetZ: z} // feet never under the test grounds
}

func TestPlacementRules(t *testing.T) {
	e := env()
	d := campdefs.D
	// Valid on open ground.
	if y, r := camps.Check(want(campdefs.Campfire, 1000, 1000), nil, e); r != 0 || y != 50 {
		t.Fatalf("open ground: y %v refusal %d", y, r)
	}
	cases := []struct {
		name string
		w    camps.Want
		near []camps.Placed
		env  flatEnv
		want int
	}{
		{"unknown kind", want(99, 1000, 1000), nil, e, camps.RefuseUnknown},
		{"too far", camps.Want{Kind: campdefs.Chest, X: 1000, Z: 1000, Owner: "a", FeetX: 990, FeetY: 50, FeetZ: 1000}, nil, e, camps.RefuseTooFar},
		{"in town", want(campdefs.Chest, 560, 500), nil, e, camps.RefuseTown},
		{"town margin", want(campdefs.Chest, 500+60+d.Placement.TownMarginM-1, 500), nil, e, camps.RefuseTown},
		{"steep", want(campdefs.Workbench, 1000, 1000), nil, flatEnv{slope: 0.9, water: -100}, camps.RefuseSlope},
		{"water", want(campdefs.Chest, 1000, 1000), nil, flatEnv{water: 60}, camps.RefuseWater},
		{"structure", want(campdefs.Chest, 1203, 1200), nil, e, camps.RefuseBlocked},
		{"underground", camps.Want{Kind: campdefs.Chest, X: 1000, Z: 1000, Owner: "a", FeetX: 998, FeetY: 40, FeetZ: 1000}, nil, e, camps.RefuseUnderground},
		{"overlap own piece", want(campdefs.Chest, 1000.5, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Workbench, X: 1000, Z: 1000, Owner: "a"}}, e, camps.RefuseBlocked},
		{"near someone else's camp", want(campdefs.Chest, 1005, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Campfire, X: 1000, Z: 1000, Owner: "b"}}, e, camps.RefuseOtherCamp},
		{"outside the camp area", want(campdefs.Chest, 1000+d.Limits.CampRadiusM+1, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Campfire, X: 1000, Z: 1000, Owner: "a"}}, e, camps.RefuseOutside},
		{"one bedroll", want(campdefs.Bedroll, 1004, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Bedroll, X: 1000, Z: 1000, Owner: "a"}}, e, camps.RefuseKindLimit},
	}
	full := []camps.Placed{}
	for i := 0; i < d.Limits.MaxPieces; i++ {
		full = append(full, camps.Placed{ID: uint64(i + 1), Kind: campdefs.Signpost + 0*i, X: 990 + float64(i)*2, Z: 990, Owner: "a"})
	}
	// Signposts max out at 2, so mix kinds to reach the total limit.
	kinds := []int{campdefs.Campfire, campdefs.Campfire, campdefs.Chest, campdefs.Chest, campdefs.Workbench, campdefs.Signpost}
	for i := range full {
		full[i].Kind = kinds[i%len(kinds)]
	}
	cases = append(cases, struct {
		name string
		w    camps.Want
		near []camps.Placed
		env  flatEnv
		want int
	}{"camp full", want(campdefs.Bedroll, 1000, 1004), full, e, camps.RefuseLimit})
	for _, c := range cases {
		if _, r := camps.Check(c.w, c.near, c.env); r != c.want {
			t.Errorf("%s: refusal %d, want %d", c.name, r, c.want)
		}
	}
	// Someone else's camp far enough away, and own pieces side by side, are fine.
	if _, r := camps.Check(want(campdefs.Chest, 1030, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Campfire, X: 1000, Z: 1000, Owner: "b"}}, e); r != 0 {
		t.Errorf("far from another camp: refusal %d", r)
	}
	if _, r := camps.Check(want(campdefs.Chest, 1002.5, 1000), []camps.Placed{{ID: 1, Kind: campdefs.Campfire, X: 1000, Z: 1000, Owner: "a"}}, e); r != 0 {
		t.Errorf("beside own campfire: refusal %d", r)
	}
	// A gentle slope is fine; the base is the footprint's mean height.
	if y, r := camps.Check(want(campdefs.Campfire, 1000, 1000), nil, flatEnv{slope: 0.1, water: -100}); r != 0 || math.Abs(y-150) > 0.01 {
		t.Errorf("gentle slope: y %v refusal %d", y, r)
	}
}

func TestFootprintOverlap(t *testing.T) {
	a := camps.FootprintOf(campdefs.Workbench, 0, 0, 0) // 1.9 x 0.9
	for r := 0; r < 8; r++ {
		b := camps.FootprintOf(campdefs.Workbench, r, 0, 0)
		if !a.Overlaps(b, 0) {
			t.Errorf("same centre, rot %d: no overlap", r)
		}
	}
	// Side by side along x: 1.9 wide each, 2.0 apart: clear; 1.8 apart: overlap.
	if a.Overlaps(camps.FootprintOf(campdefs.Workbench, 0, 2.0, 0), 0) {
		t.Error("2.0 apart overlaps")
	}
	if !a.Overlaps(camps.FootprintOf(campdefs.Workbench, 0, 1.8, 0), 0) {
		t.Error("1.8 apart does not overlap")
	}
	// Rotated 90 degrees the depth (0.9) lies along x.
	if a.Overlaps(camps.FootprintOf(campdefs.Workbench, 2, 1.45, 0), 0) {
		t.Error("rot 90 at 1.45: should clear (0.95 + 0.45 < 1.45)")
	}
	// A 45 degree diamond near a corner.
	if !camps.FootprintOf(campdefs.Chest, 1, 0, 0).Overlaps(camps.FootprintOf(campdefs.Chest, 1, 0.8, 0.8), 0) {
		t.Error("45 degree neighbours along their axis should overlap")
	}
}

func TestFireFuel(t *testing.T) {
	fd := campdefs.D.Fire
	now := 1000.0
	until, used := camps.AddWood(0, now, 1)
	if used != 1 || math.Abs(until-now-fd.HoursPerWood*camps.HourS) > 1e-9 {
		t.Fatalf("one wood: until %v used %d", until, used)
	}
	until, used = camps.AddWood(until, now, 100)
	if math.Abs(until-now-fd.MaxHours*camps.HourS) > 1e-6 || used != int(fd.MaxHours/fd.HoursPerWood)-1 {
		t.Fatalf("capped: left %v h, used %d", (until-now)/camps.HourS, used)
	}
	if _, used = camps.AddWood(until, now, 1); used != 0 {
		t.Fatal("a full fire takes no wood")
	}
	// A burnt-out fire starts from now.
	until, _ = camps.AddWood(now-500, now, 1)
	if math.Abs(until-now-fd.HoursPerWood*camps.HourS) > 1e-9 {
		t.Fatal("burnt out: wood counts from now")
	}
}

func TestDecay(t *testing.T) {
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	days := time.Duration(campdefs.D.Decay.Days * 24 * float64(time.Hour))
	if camps.Decayed(now.Add(-days+time.Minute), now) {
		t.Error("decayed a minute early")
	}
	if !camps.Decayed(now.Add(-days-time.Minute), now) {
		t.Error("not decayed a minute late")
	}
}

// ---- collision ----

func TestCollisionBlocksSolidPieces(t *testing.T) {
	s := camps.NewSet([]camps.SolidPiece{
		{ID: 7, Kind: campdefs.Chest, X: 100, Y: 10, Z: 100},
		{ID: 3, Kind: campdefs.Campfire, X: 110, Y: 10, Z: 100}, // not solid
	})
	if s.Len() != 1 {
		t.Fatalf("boxes %d, want 1 (campfires are not solid)", s.Len())
	}
	// Walking into the chest's +x face from outside: pushed back to touching.
	r := s.After(movement.CollideResult{X: 100.7, Y: 10, Z: 100})
	if math.Abs(r.X-(100+0.6+0.4)) > 1e-9 || r.PushX <= 0 {
		t.Fatalf("pushed to %v (push %v), want 101.0", r.X, r.PushX)
	}
	// Standing on top (feet above top - step): no push.
	if r := s.After(movement.CollideResult{X: 100, Y: 10.5, Z: 100}); r.X != 100 || r.PushX != 0 {
		t.Fatalf("on top: pushed %v", r)
	}
	// Far away: unchanged.
	if r := s.After(movement.CollideResult{X: 120, Y: 10, Z: 100}); r.X != 120 {
		t.Fatal("far: moved")
	}
	if !s.Blocked(100.5, 10, 100, 0.5, 1.8) || s.Blocked(103, 10, 100, 0.5, 1.8) {
		t.Fatal("Blocked")
	}
	if !s.Near(100, 100, 2) || s.Near(300, 300, 2) {
		t.Fatal("Near")
	}
	// The wrapper passes through without pieces or without a push-out.
	if g := camps.With(movement.Flat{}, s); g != (movement.Ground)(movement.Flat{}) {
		t.Fatal("With on a ground without a push-out should be the ground itself")
	}
}

type vecPiece struct {
	ID   uint64 `json:"id"`
	Kind int    `json:"kind"`
	Rot  int    `json:"rot"`
	X    int32  `json:"x"`
	Y    int32  `json:"y"`
	Z    int32  `json:"z"`
}

type vecCase struct {
	In  [5]float64 `json:"in"`  // x, y, z, pushX, pushZ (the result under the pieces)
	Out [4]float64 `json:"out"` // x, z, pushX, pushZ
}

type vecFile struct {
	Note    string       `json:"note"`
	Pieces  []vecPiece   `json:"pieces"`
	Boxes   [][9]float64 `json:"boxes"`
	IDs     []uint64     `json:"ids"`
	Collide []vecCase    `json:"collide"`
}

func vectorPieces() []vecPiece {
	var ps []vecPiece
	id := uint64(1 << 39)
	// Every rotation of the chest and the workbench, a signpost, a tight
	// cluster (several boxes push at once) and non-solid pieces.
	for r := 0; r < 8; r++ {
		ps = append(ps, vecPiece{ID: id + uint64(r)*977, Kind: campdefs.Chest, Rot: r, X: 123456 + int32(r)*700, Y: 5432 + int32(r)*13, Z: 234567})
		ps = append(ps, vecPiece{ID: id + 50000 + uint64(r)*31, Kind: campdefs.Workbench, Rot: r, X: 123456 + int32(r)*700, Y: 5432, Z: 235467 + int32(r)*3})
	}
	ps = append(ps,
		vecPiece{ID: 99, Kind: campdefs.Signpost, Rot: 3, X: 130001, Y: 6000, Z: 240003},
		vecPiece{ID: 98, Kind: campdefs.Chest, Rot: 0, X: 130150, Y: 6000, Z: 240000},
		vecPiece{ID: 97, Kind: campdefs.Workbench, Rot: 2, X: 129880, Y: 6010, Z: 240090},
		vecPiece{ID: 96, Kind: campdefs.Campfire, Rot: 0, X: 130000, Y: 6000, Z: 239800},
		vecPiece{ID: 95, Kind: campdefs.Bedroll, Rot: 5, X: 129700, Y: 6000, Z: 240000},
	)
	return ps
}

func TestCollisionVectors(t *testing.T) {
	ps := vectorPieces()
	var sp []camps.SolidPiece
	for _, p := range ps {
		sp = append(sp, camps.SolidPiece{ID: p.ID, Kind: p.Kind, Rot: p.Rot, X: camps.Cm2M(p.X), Y: camps.Cm2M(p.Y), Z: camps.Cm2M(p.Z)})
	}
	s := camps.NewSet(sp)
	f := vecFile{Note: "CR 025 camp collision twin: server/pkg/camps (go test -run TestCollisionVectors -update) vs client/src/ui/camps/collide.ts", Pieces: ps, IDs: s.IDs}
	for i := 0; i < s.Len(); i++ {
		var b [9]float64
		copy(b[:], s.F[i*9:i*9+9])
		f.Boxes = append(f.Boxes, b)
	}
	// Deterministic samples around every piece (a xorshift), some on top,
	// some under, some deep inside (the face push), some with earlier pushes.
	x := uint64(0x9e3779b97f4a7c15)
	rnd := func() float64 {
		x ^= x << 13
		x ^= x >> 7
		x ^= x << 17
		return float64(x>>11) / (1 << 53)
	}
	for _, p := range ps {
		cx, cy, cz := camps.Cm2M(p.X), camps.Cm2M(p.Y), camps.Cm2M(p.Z)
		for k := 0; k < 40; k++ {
			in := [5]float64{cx + (rnd()-0.5)*4.4, cy + (rnd()-0.6)*2.2, cz + (rnd()-0.5)*4.4, 0, 0}
			if k%5 == 0 {
				in[3], in[4] = (rnd()-0.5)*0.3, (rnd()-0.5)*0.3
			}
			if k%7 == 0 {
				in[1] = cy // feet at the base: always below the top
			}
			r := s.After(movement.CollideResult{X: in[0], Y: in[1], Z: in[2], PushX: in[3], PushZ: in[4]})
			f.Collide = append(f.Collide, vecCase{In: in, Out: [4]float64{r.X, r.Z, r.PushX, r.PushZ}})
		}
	}
	path := filepath.Join("testdata", "camps.json")
	if *update {
		b, _ := json.MarshalIndent(f, "", " ")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update)", err)
	}
	var want vecFile
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Collide) != len(f.Collide) || len(want.Boxes) != len(f.Boxes) {
		t.Fatalf("vectors changed shape: %d/%d cases, %d/%d boxes (run with -update deliberately)", len(f.Collide), len(want.Collide), len(f.Boxes), len(want.Boxes))
	}
	for i := range f.Boxes {
		if f.Boxes[i] != want.Boxes[i] {
			t.Fatalf("box %d: %v, want %v", i, f.Boxes[i], want.Boxes[i])
		}
	}
	pushes := 0
	for i := range f.Collide {
		if f.Collide[i] != want.Collide[i] {
			t.Fatalf("case %d: %v, want %v", i, f.Collide[i].Out, want.Collide[i].Out)
		}
		if f.Collide[i].Out[0] != f.Collide[i].In[0] {
			pushes++
		}
	}
	if pushes < 50 {
		t.Fatalf("only %d of %d vectors push: the vectors do not exercise the boxes", pushes, len(f.Collide))
	}
}
