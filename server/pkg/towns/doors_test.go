package towns_test

// Door boxes and the door push-out (playtest follow-up to WP20), bit for bit
// against TS: testdata/doors.json is written here (-update) and replayed by
// client/src/world/buildings/doors.test.ts (worldgen/js doors.ts). Plus
// unit checks on the official world: open doors are the WP20 doorway,
// closed doors block from both sides, Touches sees a body in the doorway.

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
)

var updateDoors = flag.Bool("update", false, "rewrite testdata/doors.json")

type doorVec struct {
	X, Y, Z float64
	Doors   string `json:"doors"`
	Ground  string `json:"ground"`
}

type doorWorld struct {
	Seed  string `json:"seed"`
	Count int    `json:"count"`
	Hash  string `json:"hash"`
	Boxes []struct {
		D        int      `json:"d"`
		Building int      `json:"building"`
		Prop     int      `json:"prop"`
		ID       string   `json:"id"`
		F        []string `json:"f"`
	} `json:"boxes"`
	Collide []doorVec `json:"collide"`
}

type doorFile struct {
	Note   string      `json:"note"`
	Rule   string      `json:"rule"`
	Worlds []doorWorld `json:"worlds"`
}

// ruleView: the vectors' closed set (d % 3 != 1).
type ruleView struct{}

func (ruleView) DoorClosed(d int) bool { return d%3 != 1 }

type allView bool

func (v allView) DoorClosed(int) bool { return bool(v) }

func resString(r movement.CollideResult) string {
	c := 0
	if r.Ceiling {
		c = 1
	}
	return fmt.Sprintf("%s,%s,%s,%s,%s,%d", bits(r.X), bits(r.Y), bits(r.Z), bits(r.PushX), bits(r.PushZ), c)
}

// q: quarter-millimetre grid so coordinates survive JSON exactly (townGolden.ts).
func q(v float64) float64 { return math.Round(v*4096) / 4096 }

func doorTowns(t testing.TB, mod *worldhost.Module, seed uint64) *towns.Towns {
	t.Helper()
	spec, err := mod.SpecFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	w, err := mod.OpenWorld(spec, seed, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	b, err := w.TownsBytes()
	if err != nil {
		t.Fatal(err)
	}
	tw, err := towns.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return tw
}

func doorHash(s *towns.Doors) string {
	h := fnv.New64a()
	var b [8]byte
	for d, dr := range s.D {
		binary.LittleEndian.PutUint32(b[:4], uint32(dr.Building))
		h.Write(b[:4])
		binary.LittleEndian.PutUint32(b[:4], uint32(dr.Prop))
		h.Write(b[:4])
		for k := 0; k < 9; k++ {
			binary.LittleEndian.PutUint64(b[:], math.Float64bits(s.F[d*9+k]))
			h.Write(b[:])
		}
	}
	return fmt.Sprintf("%016x", h.Sum64())
}

func generateDoorWorld(tw *towns.Towns, seed string) doorWorld {
	s := towns.NewDoors(tw)
	c := towns.NewCollision(&tw.Boxes)
	w := doorWorld{Seed: seed, Count: s.Len(), Hash: doorHash(s)}
	for d := 0; d < s.Len(); d += 9 {
		dr := s.D[d]
		e := struct {
			D        int      `json:"d"`
			Building int      `json:"building"`
			Prop     int      `json:"prop"`
			ID       string   `json:"id"`
			F        []string `json:"f"`
		}{D: d, Building: dr.Building, Prop: dr.Prop, ID: strconv.FormatUint(dr.ID, 16)}
		for k := 0; k < 9; k++ {
			e.F = append(e.F, bits(s.F[d*9+k]))
		}
		w.Boxes = append(w.Boxes, e)
	}
	for d := 0; d < s.Len() && len(w.Collide) < 600; d += 4 {
		o := d * 9
		cx, cz, cs, sn, hx, y0 := s.F[o], s.F[o+1], s.F[o+2], s.F[o+3], s.F[o+4], s.F[o+6]
		pts := [][3]float64{{0, -0.5, 0.05}, {0, 0.5, 0.05}, {0, 0, 0.05}, {hx * 0.9, -0.3, 0.3}, {hx + 0.2, 0.25, 0.05}, {-hx - 0.3, -0.45, 0.05}, {0, -0.4, 1.6}}
		for _, p := range pts {
			x := q(cx + p[0]*cs - p[1]*sn)
			z := q(cz + p[0]*sn + p[1]*cs)
			y := q(y0 + p[2])
			dv := s.After(movement.CollideResult{X: x, Y: y, Z: z}, ruleView{})
			gv := s.After(c.Collide(x, y, z), ruleView{})
			w.Collide = append(w.Collide, doorVec{X: x, Y: y, Z: z, Doors: resString(dv), Ground: resString(gv)})
		}
	}
	return w
}

var doorSeeds = []string{"20261108", "7"}

func TestDoorVectors(t *testing.T) {
	mod := loadModule(t)
	path := filepath.Join("testdata", "doors.json")
	if *updateDoors {
		f := doorFile{
			Note: "Door boxes (towns.NewDoors / TS TownDoors) and the door push-out (After) on spec_from_seed worlds; written by `go test ./towns -run DoorVectors -update` (server/pkg), replayed bit for bit by client/src/world/buildings/doors.test.ts.",
			Rule: "closed(d) = d % 3 != 1; doors = After({x,y,z}); ground = After(Collision.Collide(x,y,z)); 'xbits,ybits,zbits,pushXbits,pushZbits,ceiling'; hash = FNV-1a 64 over (u32 building, u32 prop, 9 x f64 bits) per door, LE",
		}
		for _, sd := range doorSeeds {
			seed, _ := strconv.ParseUint(sd, 10, 64)
			f.Worlds = append(f.Worlds, generateDoorWorld(doorTowns(t, mod, seed), sd))
		}
		b, _ := json.MarshalIndent(f, "", " ")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f doorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, w := range f.Worlds {
		seed, _ := strconv.ParseUint(w.Seed, 10, 64)
		got := generateDoorWorld(doorTowns(t, mod, seed), w.Seed)
		if got.Count != w.Count || got.Hash != w.Hash {
			t.Errorf("seed %s: %d doors hash %s, file %d %s", w.Seed, got.Count, got.Hash, w.Count, w.Hash)
		}
		if len(got.Collide) != len(w.Collide) {
			t.Fatalf("seed %s: %d vectors, file %d", w.Seed, len(got.Collide), len(w.Collide))
		}
		for i, v := range w.Collide {
			g := got.Collide[i]
			if g.X != v.X || g.Y != v.Y || g.Z != v.Z || g.Doors != v.Doors || g.Ground != v.Ground {
				t.Errorf("seed %s vector %d (%v, %v, %v): doors %s ground %s, file %s %s", w.Seed, i, v.X, v.Y, v.Z, g.Doors, g.Ground, v.Doors, v.Ground)
			}
			n++
		}
	}
	t.Logf("doors: %d worlds, %d collide vectors", len(f.Worlds), n)
	if n < 500 {
		t.Fatalf("only %d vectors", n)
	}
}

// On the official world: every inn and house has a door; closed doors stop
// a body walking through the doorway from either side; open doors are the
// WP20 doorway (After is the identity); Touches sees a body in the doorway.
func TestDoorsBlockWhenClosed(t *testing.T) {
	mod := loadModule(t)
	tw := doorTowns(t, mod, 20261108)
	s := towns.NewDoors(tw)
	c := towns.NewCollision(&tw.Boxes)
	withFloors, forges := 0, 0
	for _, b := range tw.Buildings {
		if b.Floors > 0 {
			withFloors++
			if b.Role == towns.BuildingForge {
				forges++
			}
		}
	}
	if s.Len() != withFloors-forges {
		t.Fatalf("%d doors, want %d (buildings with floors %d minus open-front forges %d)", s.Len(), withFloors-forges, withFloors, forges)
	}
	for d := range s.D {
		dr := s.D[d]
		b := tw.Buildings[dr.Building]
		if math.Abs(dr.Width-b.DoorW) > 1e-5 {
			t.Fatalf("door %d width %v, building door %v", d, dr.Width, b.DoorW)
		}
		o := d * 9
		if s.F[o+6] >= b.FloorY || s.F[o+7] < b.FloorY+2.2 {
			t.Fatalf("door %d spans y %v..%v, floor %v", d, s.F[o+6], s.F[o+7], b.FloorY)
		}
	}
	// Walk a body through the first 40 doorways along the building's +v.
	for d := 0; d < s.Len() && d < 40; d++ {
		dr := s.D[d]
		b := tw.Buildings[dr.Building]
		vx, vz := -b.S, b.C // local v (inward)
		y := b.FloorY
		for _, from := range []float64{-1, 1} { // outside (-v), inside (+v)
			x, z := dr.X+from*1.2*vx, dr.Z+from*1.2*vz
			blocked, crossed := false, false
			for k := 0; k < 60; k++ {
				x -= from * 0.04 * vx
				z -= from * 0.04 * vz
				r := c.Collide(x, y, z)
				r = s.After(r, allView(true))
				x, z = r.X, r.Z
				dv := (x-dr.X)*vx + (z-dr.Z)*vz
				if from < 0 && dv > 0 || from > 0 && dv < 0 {
					crossed = true
				}
				if r.PushX != 0 || r.PushZ != 0 {
					blocked = true
				}
			}
			if crossed || !blocked {
				t.Fatalf("door %d (building %d) from %v: crossed %v blocked %v", d, dr.Building, from, crossed, blocked)
			}
			if !s.Touches(d, dr.X, y, dr.Z, 0.4) || s.Touches(d, dr.X+3*vx, y, dr.Z+3*vz, 0.4) {
				t.Fatalf("door %d: Touches wrong", d)
			}
		}
		// Open: After is the identity.
		r := c.Collide(dr.X, y, dr.Z)
		if got := s.After(r, allView(false)); got != r {
			t.Fatalf("door %d: open door changed the result", d)
		}
	}
}
