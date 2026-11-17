package worldedit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The planner golden: a scripted sequence of swings on a fake world, the
// non-zero vertices after it and the volumes of every swing. The TypeScript
// port (client/src/world/edits/planner.ts) replays it. LODESTONE_UPDATE_GOLDEN=1
// rewrites contracts/golden/world_edits_plan.json.

type goldenStep struct {
	Op      string  `json:"op"`
	X       float64 `json:"x"`
	Z       float64 `json:"z"`
	Lowered int     `json:"lowered"`
	Raised  int     `json:"raised"`
	Refused int     `json:"refused"`
}

type goldenVert struct {
	X int32 `json:"x"`
	Z int32 `json:"z"`
	D int8  `json:"d"`
}

func TestPlannerGolden(t *testing.T) {
	var script []goldenStep
	for i := 0; i < 14; i++ {
		script = append(script, goldenStep{Op: "dig", X: 300.2, Z: 410.6})
	}
	for i := 0; i < 5; i++ {
		script = append(script, goldenStep{Op: "dig", X: 304.7 + float64(i)*0.9, Z: 409.1})
	}
	for i := 0; i < 6; i++ {
		script = append(script, goldenStep{Op: "fill", X: 301.4, Z: 410.2})
	}
	script = append(script, goldenStep{Op: "dig", X: 5.5, Z: 5.5}, goldenStep{Op: "fill", X: 700.5, Z: 700.5})
	w := fakeWorld{base: 50, water: 0, forbidden: func(x, z int32) bool { return x < 8 }}
	o := New()
	for i := range script {
		s := &script[i]
		op := Dig
		if s.Op == "fill" {
			op = Fill
		}
		p, r := PlanSwing(o, w, op, s.X, s.Z)
		s.Refused = int(r)
		if r != OK {
			continue
		}
		s.Lowered, s.Raised = p.Lowered, p.Raised
		apply(t, o, p)
	}
	var verts []goldenVert
	for z := int32(280); z < 440; z++ {
		for x := int32(270); x < 340; x++ {
			if d := o.Delta(x, z); d != 0 {
				verts = append(verts, goldenVert{x, z, d})
			}
		}
	}
	for z := int32(690); z < 710; z++ {
		for x := int32(690); x < 710; x++ {
			if d := o.Delta(x, z); d != 0 {
				verts = append(verts, goldenVert{x, z, d})
			}
		}
	}
	if len(verts) < 100 {
		t.Fatalf("scripted edits left only %d vertices", len(verts))
	}
	got := struct {
		Note   string       `json:"note"`
		Steps  []goldenStep `json:"steps"`
		Result []goldenVert `json:"result"`
	}{"CR 040 dig planner on a fake world: base 50 + (x mod 7) * 0.1, water 0, vertices with x < 8 protected", script, verts}
	b, _ := json.Marshal(got)
	path := filepath.Join("..", "..", "..", "contracts", "golden", "world_edits_plan.json")
	if os.Getenv("LODESTONE_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("golden missing (LODESTONE_UPDATE_GOLDEN=1 writes it): %v", err)
	}
	if string(raw) != string(b)+"\n" {
		t.Fatal("planner output differs from contracts/golden/world_edits_plan.json (LODESTONE_UPDATE_GOLDEN=1 rewrites it)")
	}
}
