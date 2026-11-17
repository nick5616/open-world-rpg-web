package palace

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"testing"

	"lodestone/server/pkg/towns"
)

var update = flag.Bool("update", false, "rewrite testdata/golden.json")

// golden is what the TS twin (client/src/world/palace/palace.test.ts) must
// reproduce bit for bit: the appended boxes of five synthetic palaces, as
// f64 bit patterns, and the atrium shafts.
type golden struct {
	Sites [][4]float64 `json:"sites"` // x, y, z, yaw16
	Boxes [][]string   `json:"boxes"` // per site: 9 hex f64 bit patterns per box, concatenated
	Cols  [][]string   `json:"cols"`
}

func hexOf(v float64) string {
	const digits = "0123456789abcdef"
	b := math.Float64bits(v)
	var out [16]byte
	for i := 15; i >= 0; i-- {
		out[i] = digits[b&15]
		b >>= 4
	}
	return string(out[:])
}

func build() golden {
	g := golden{Sites: [][4]float64{{1000.5, 700.25, 800.75, 27404}, {1000.5, 700.25, 800.75, 0}, {2000.25, 512.5, 333.125, 16384}, {300, 900.125, 4000, 32768}, {77.5, 400, 123.5, 49152}}}
	for _, s := range g.Sites {
		site := NewSite(1, s[0], s[1], s[2], int(s[3]))
		tw := &towns.Towns{}
		AppendBoxes(tw, []Site{site})
		row := []string{}
		for _, f := range tw.Boxes.F {
			row = append(row, hexOf(f))
		}
		for i := range tw.Boxes.Kind {
			row = append(row, hexOf(float64(tw.Boxes.Kind[i])), hexOf(float64(tw.Boxes.Flags[i])))
		}
		g.Boxes = append(g.Boxes, row)
		var col []string
		for _, c := range Wind([]Site{site}) {
			col = append(col, hexOf(c.X), hexOf(c.Z), hexOf(c.Radius), hexOf(c.Top), hexOf(c.Lift))
		}
		g.Cols = append(g.Cols, col)
	}
	return g
}

func TestGoldenForTheTSTwin(t *testing.T) {
	got := build()
	b, _ := json.Marshal(got)
	const path = "testdata/golden.json"
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != string(b)+"\n" {
		t.Fatal("golden.json is stale: go test ./palace -update, then run the client palace test")
	}
}

func TestLayoutSanity(t *testing.T) {
	d := D
	if len(d.Boxes) < 60 || len(d.Wards) != 3 || len(d.Packs) == 0 {
		t.Fatalf("table: %d boxes, %d wards, %d packs", len(d.Boxes), len(d.Wards), len(d.Packs))
	}
	for i, b := range d.Boxes {
		if len(b) != 9 || b[4] <= 0 || b[5] <= 0 || b[7] < b[6]-0.0001 && b[8] < b[6]-0.0001 {
			t.Fatalf("box %d malformed: %v", i, b)
		}
	}
	for _, p := range d.Packs {
		if math.Abs(p.X) > d.Half.X || math.Abs(p.Z) > d.Half.Z {
			t.Fatalf("pack %s outside the palace", p.Room)
		}
	}
	// A quarter turn maps the gate (+z local) to +-x / +-z world exactly.
	s := NewSite(0, 100, 50, 200, 16384)
	x, z := s.World(0, 10)
	if x != 100+10*s.Sn*-1 || z != 200+0 {
		// q=1: cs=0, sn=-1: world x = lz * -sn = 10, z = lz*cs = 0
		t.Fatalf("gate direction %v %v", x, z)
	}
	lx, lz := s.Local(x, z)
	if lx != 0 || lz != 10 {
		t.Fatalf("round trip %v %v", lx, lz)
	}
}
