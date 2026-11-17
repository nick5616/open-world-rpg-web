package camps_test

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"lodestone/server/pkg/campdefs"
	"lodestone/server/pkg/camps"
	"lodestone/server/pkg/movement"
)

// buildEnv is flat dry ground at 50 m (build rules).
type buildEnv struct {
	flatEnv
	noBuild int
}

func (e buildEnv) HeightAt(x, z float64) float64 { return 50 }
func (e buildEnv) NoBuild(x, z, r float64) int {
	if math.Hypot(x-3000, z-3000) < 40 {
		return camps.RefuseSite
	}
	return e.noBuild
}

func bk(key string) int { return campdefs.D.ByKey(key).ID }

func feet(x, z float64) camps.BuildWant {
	return camps.BuildWant{Owner: "a", FeetX: x, FeetY: 60, FeetZ: z}
}

type step struct {
	key        string
	rot        int
	x, y, z    int32 // cm; y 0: let the server pick the height for a first foundation
	hasY       bool
	state      int
	owner      string
	want       int // expected refusal
	wantY      int32
	note       string
	noPlaceChk bool
}

func place(t *testing.T, all *[]*camps.BP, env camps.BuildEnv, st step) {
	t.Helper()
	w := camps.BuildWant{Kind: bk(st.key), Rot: st.rot, X: st.x, Y: st.y, Z: st.z, HasY: st.hasY, Owner: "a", FeetX: float64(st.x) / 100, FeetY: 60, FeetZ: float64(st.z) / 100}
	if st.owner != "" {
		w.Owner = st.owner
	}
	y, why := camps.CheckBuild(w, *all, env)
	if why != st.want {
		t.Fatalf("%s %s: refusal %d want %d", st.key, st.note, why, st.want)
	}
	if why == 0 {
		if st.wantY != 0 && y != st.wantY {
			t.Fatalf("%s %s: y %d want %d", st.key, st.note, y, st.wantY)
		}
		*all = append(*all, &camps.BP{ID: uint64(len(*all) + 1), Kind: w.Kind, Rot: w.Rot, X: w.X, Y: y, Z: w.Z, State: st.state, Owner: w.Owner})
	}
}

func TestBuildHouse(t *testing.T) {
	e := buildEnv{flatEnv: env()}
	var all []*camps.BP
	// A foundation: flush with the highest ground (+0 snapped up to 0.25).
	place(t, &all, e, step{key: "foundation_wood", x: 100100, z: 100100, want: 0, wantY: 5000, note: "first foundation"})
	place(t, &all, e, step{key: "foundation_wood", x: 100100, z: 100100, want: camps.RefuseBlocked, note: "same cell"})
	place(t, &all, e, step{key: "foundation_wood", x: 100300, z: 100100, hasY: true, y: 5000, want: 0, note: "neighbour flush"})
	place(t, &all, e, step{key: "foundation_wood", x: 100300, z: 100300, hasY: true, y: 5050, want: camps.RefuseSupport, note: "not flush"})
	place(t, &all, e, step{key: "foundation_wood", x: 100150, z: 100100, want: camps.RefuseGrid, note: "off grid"})
	// A wall on the edge, a floor under nothing, a floor on walls.
	place(t, &all, e, step{key: "wall_wood", x: 100100, z: 100000, hasY: true, y: 5000, want: 0, note: "wall on foundation edge"})
	place(t, &all, e, step{key: "wall_wood", x: 100100, z: 100000, hasY: true, y: 5000, want: camps.RefuseBlocked, note: "same edge twice"})
	place(t, &all, e, step{key: "wall_wood", x: 100500, z: 100000, hasY: true, y: 5000, want: camps.RefuseSupport, note: "wall in the air"})
	place(t, &all, e, step{key: "wall_wood", rot: 4, x: 100100, z: 100200, hasY: true, y: 5000, want: 0, note: "wall on the far edge, turned round"})
	place(t, &all, e, step{key: "door_wood", x: 100300, z: 100000, hasY: true, y: 5000, want: 0, note: "door"})
	place(t, &all, e, step{key: "wall_wood", rot: 2, x: 100100, z: 100000, hasY: true, y: 5000, want: camps.RefuseGrid, note: "a quarter turn needs the other parity"})
	place(t, &all, e, step{key: "wall_wood", rot: 4, x: 100100, z: 100000, want: camps.RefuseSupport, note: "no hint: a wall needs one"})
	place(t, &all, e, step{key: "wall_wood", rot: 6, x: 100000, z: 100100, hasY: true, y: 5000, want: 0, note: "wall turned a quarter on the west edge"})
	// Upper floor on top of the walls, and a floor with nothing under it.
	place(t, &all, e, step{key: "floor_wood", x: 100100, z: 100100, hasY: true, y: 5250, want: 0, note: "floor on walls"})
	place(t, &all, e, step{key: "floor_wood", x: 100700, z: 100700, hasY: true, y: 5250, want: camps.RefuseSupport, note: "floor floating"})
	// Roof on the wall top.
	place(t, &all, e, step{key: "roof_wood", x: 100500, z: 100300, hasY: true, y: 5250, want: camps.RefuseSupport, note: "no wall under its low edge"})
	// Furnishings.
	place(t, &all, e, step{key: "bed", x: 100150, z: 100100, hasY: true, y: 5000, want: 0, note: "bed on a foundation"})
	place(t, &all, e, step{key: "bed", x: 100150, z: 100100, hasY: true, y: 5000, want: camps.RefuseBlocked, note: "bed on bed"})
	place(t, &all, e, step{key: "lantern", x: 100300, z: 100100, hasY: true, y: 5000, want: 0, note: "lantern"})
	place(t, &all, e, step{key: "wall_torch", x: 100100, z: 100000, hasY: true, y: 5000, want: 0, note: "torch on a wall face"})
	place(t, &all, e, step{key: "wall_torch", x: 100300, z: 100000, hasY: true, y: 5000, want: camps.RefuseSupport, note: "torch on a door face"})
	// Another player's piece: nothing within 3 m.
	place(t, &all, e, step{key: "foundation_wood", x: 100700, z: 100100, owner: "b", want: camps.RefuseOtherCamp, note: "near a's foundation"})
	place(t, &all, e, step{key: "foundation_wood", x: 101500, z: 100100, owner: "b", want: 0, note: "far enough"})
	// Sites.
	place(t, &all, e, step{key: "foundation_wood", x: 300100, z: 300100, want: camps.RefuseSite, note: "in a site"})
	// Stability: removing a wall drops nothing under the floor except via sockets.
	var ps []*camps.BP
	ps = append(ps, all...)
	for _, p := range all {
		if p.Kind == bk("foundation_wood") && p.X == 100100 && p.Z == 100100 {
			// The foundation holds up the walls around it.
			if got := camps.Orphans(ps, p.ID, e); len(got) == 0 {
				t.Fatalf("removing the first foundation should orphan its walls")
			}
		}
	}
}

func TestFloorsAndStairsAreWalkable(t *testing.T) {
	var ps []camps.SolidPiece
	ps = append(ps, camps.SolidPiece{ID: 1, Kind: bk("foundation_wood"), X: 1001, Y: 50, Z: 1001})
	ps = append(ps, camps.SolidPiece{ID: 2, Kind: bk("stairs_wood"), X: 1006, Y: 50, Z: 1001})
	ps = append(ps, camps.SolidPiece{ID: 3, Kind: bk("wall_wood"), X: 1001, Y: 50, Z: 1000})
	set := camps.NewSet(ps)
	if !set.HasSurfaces() {
		t.Fatal("no surfaces")
	}
	// Standing on the foundation.
	if h, ok := set.SurfaceAt(1001, 1001, 50); !ok || h != 50 {
		t.Fatalf("foundation %v %v", h, ok)
	}
	// The stairs rise 2.5 over 4 m starting at x = 1004.
	if h, ok := set.SurfaceAt(1006, 1001, 51.3); !ok || math.Abs(h-51.25) > 1e-9 {
		t.Fatalf("stairs middle %v %v", h, ok)
	}
	// A body on the ground does not step onto the high end.
	if _, ok := set.SurfaceAt(1007.9, 1001, 50); ok {
		t.Fatal("high end of the stairs reachable from the ground")
	}
	// A wall blocks.
	r := set.After(movement.CollideResult{X: 1001, Y: 50, Z: 1000.05})
	if r.PushZ == 0 && r.PushX == 0 {
		t.Fatal("wall did not push")
	}
	// An open door lets a body through.
	door := camps.SolidPiece{ID: 4, Kind: bk("door_wood"), X: 1003, Y: 50, Z: 1000}
	if r := camps.NewSet([]camps.SolidPiece{door}).After(movement.CollideResult{X: 1003, Y: 50, Z: 1000.05}); r.PushX == 0 && r.PushZ == 0 {
		t.Fatal("closed door did not push")
	}
	door.State = 1
	if r := camps.NewSet([]camps.SolidPiece{door}).After(movement.CollideResult{X: 1003, Y: 50, Z: 1000.05}); r.PushX != 0 || r.PushZ != 0 {
		t.Fatal("open door pushed")
	}
}

// TestBuildVectors writes (-update) or checks testdata/build.json: the
// placement results and surface heights the client's rules.ts replays.
func TestBuildVectors(t *testing.T) {
	type vp struct {
		Kind    string `json:"kind"`
		Rot     int    `json:"rot"`
		X, Y, Z int32
		State   int    `json:"state,omitempty"`
		Owner   string `json:"owner,omitempty"`
		Party   uint32 `json:"party,omitempty"`
		Lock    int    `json:"lock,omitempty"`
	}
	type vc struct {
		Kind    string `json:"kind"`
		Rot     int    `json:"rot"`
		X, Y, Z int32
		HasY    bool   `json:"hasY"`
		Owner   string `json:"owner"`
		Party   uint32 `json:"party,omitempty"`
		Y2      int32  `json:"yOut"`
		Why     int    `json:"why"`
	}
	type vh struct {
		X, Z, Y float64
		H       float64 `json:"h"`
		Ok      bool    `json:"ok"`
		PushX   float64 `json:"pushX"`
		PushZ   float64 `json:"pushZ"`
	}
	type vecs struct {
		GroundCm int32 `json:"groundCm"`
		Pieces   []vp  `json:"pieces"`
		Checks   []vc  `json:"checks"`
		Bodies   []vh  `json:"bodies"`
	}
	e := buildEnv{flatEnv: env()}
	var out vecs
	out.GroundCm = 5000
	var all []*camps.BP
	add := func(key string, rot int, x, y, z int32, owner string) {
		w := camps.BuildWant{Kind: bk(key), Rot: rot, X: x, Y: y, Z: z, HasY: y != 0, Owner: owner, FeetX: float64(x) / 100, FeetY: 60, FeetZ: float64(z) / 100}
		yy, why := camps.CheckBuild(w, all, e)
		if why != 0 {
			t.Fatalf("setup %s: %d", key, why)
		}
		all = append(all, &camps.BP{ID: uint64(len(all) + 1), Kind: w.Kind, Rot: rot, X: x, Y: yy, Z: z, Owner: owner})
		out.Pieces = append(out.Pieces, vp{Kind: key, Rot: rot, X: x, Y: yy, Z: z, Owner: owner})
	}
	add("foundation_stone", 0, 100100, 0, 100100, "a")
	add("foundation_stone", 0, 100300, 5000, 100100, "a")
	add("wall_stone", 0, 100100, 5000, 100000, "a")
	add("window_stone", 0, 100300, 5000, 100000, "a")
	add("door_stone", 4, 100100, 5000, 100200, "a")
	add("wall_stone", 6, 100000, 5000, 100100, "a")
	add("floor_wood", 0, 100100, 5250, 100100, "a")
	add("stairs_wood", 0, 100600, 5000, 100100, "a")
	add("pillar_wood", 0, 100000, 5000, 100000, "a")
	add("table", 0, 100300, 5000, 100150, "a")
	out.Pieces[len(out.Pieces)-1].State = 0
	// Open one door.
	all[4].State = 1
	out.Pieces[4].State = 1
	// Placement checks over the pieces (a candidate grid of kinds, spots, rots).
	for _, k := range campdefs.D.Pieces {
		if k.Build == nil {
			continue
		}
		for _, rot := range []int{0, 2} {
			for _, p := range [][2]int32{{100100, 100100}, {100300, 100000}, {100200, 100100}, {100500, 100300}, {100700, 100100}} {
				for _, y := range []int32{0, 5000, 5250} {
					for _, owner := range []string{"a", "b"}[:1+int(p[0]/100700)] {
						w := camps.BuildWant{Kind: k.ID, Rot: rot, X: p[0], Y: y, Z: p[1], HasY: y != 0, Owner: owner, FeetX: float64(p[0]) / 100, FeetY: 60, FeetZ: float64(p[1]) / 100}
						yy, why := camps.CheckBuild(w, all, e)
						out.Checks = append(out.Checks, vc{Kind: k.Key, Rot: rot, X: p[0], Y: y, Z: p[1], HasY: y != 0, Owner: owner, Y2: yy, Why: why})
					}
				}
			}
		}
	}
	var sp []camps.SolidPiece
	for i, p := range all {
		sp = append(sp, camps.SolidPiece{ID: uint64(i + 1), Kind: p.Kind, Rot: p.Rot, X: camps.Cm2M(p.X), Y: camps.Cm2M(p.Y), Z: camps.Cm2M(p.Z), State: p.State})
	}
	set := camps.NewSet(sp)
	for x := 1000.0; x <= 1008.01; x += 0.37 {
		for z := 999.5; z <= 1003.01; z += 0.41 {
			for _, y := range []float64{50, 51.3, 52.5} {
				h, ok := set.SurfaceAt(x, z, y)
				r := set.After(movement.CollideResult{X: x, Y: y, Z: z})
				out.Bodies = append(out.Bodies, vh{X: x, Z: z, Y: y, H: h, Ok: ok, PushX: r.PushX, PushZ: r.PushZ})
			}
		}
	}
	b, _ := json.Marshal(out)
	b = append(b, '\n')
	const path = "testdata/build.json"
	if *update {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test ./server/pkg/camps -run TestBuildVectors -update)", err)
	}
	if string(want) != string(b) {
		t.Fatal("build vectors changed: rerun with -update and check the client's rules.test.ts")
	}
}
