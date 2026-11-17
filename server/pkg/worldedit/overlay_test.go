package worldedit

import (
	"math"
	"testing"
)

type fakeWorld struct {
	base      float32
	water     float64
	forbidden func(x, z int32) bool
}

func (f fakeWorld) Base(x, z int32) float32  { return f.base + float32(x%7)*0.1 }
func (f fakeWorld) Water(x, z int32) float64 { return f.water }
func (f fakeWorld) Allowed(x, z int32) bool {
	return f.forbidden == nil || !f.forbidden(x, z)
}

func apply(t *testing.T, o *Overlay, p Plan) {
	t.Helper()
	if _, err := o.Apply(p.Changes); err != nil {
		t.Fatal(err)
	}
}

func TestDigBowlIsWalkable(t *testing.T) {
	o := New()
	w := fakeWorld{base: 50, water: 0}
	for i := 0; i < 60; i++ {
		p, r := PlanSwing(o, w, Dig, 300.2, 410.6)
		if r != OK {
			if i < 10 {
				t.Fatalf("swing %d refused: %d", i, r)
			}
			break
		}
		apply(t, o, p)
	}
	if d := o.Delta(300, 411); d != -MaxDelta {
		t.Fatalf("centre should be at the cap, got %d", d)
	}
	// every neighbouring pair obeys the slope limit
	for z := int32(380); z < 440; z++ {
		for x := int32(270); x < 330; x++ {
			a := int(o.Delta(x, z))
			if b := int(o.Delta(x+1, z)); abs(a-b) > MaxSlope {
				t.Fatalf("slope %d at %d,%d", a-b, x, z)
			}
			if b := int(o.Delta(x, z+1)); abs(a-b) > MaxSlope {
				t.Fatalf("slope %d at %d,%d", a-b, x, z)
			}
		}
	}
	if o.Blocks() == 0 || o.Vertices() == 0 {
		t.Fatal("counters")
	}
	// Every cell triangle of the deepest pit is walkable (under 50 degrees: tan = 1.19), whatever the generated ground does.
	worst := 0.0
	for z := int32(380); z < 440; z++ {
		for x := int32(270); x < 330; x++ {
			d := func(dx, dz int32) float64 { return float64(o.Delta(x+dx, z+dz)) * StepM }
			for _, g := range [][2]float64{{d(1, 0) - d(0, 0), d(0, 1) - d(0, 0)}, {d(1, 1) - d(0, 1), d(1, 1) - d(1, 0)}} {
				worst = math.Max(worst, math.Hypot(g[0], g[1]))
			}
		}
	}
	if worst > 1.19 {
		t.Fatalf("a pit triangle is %.0f degrees", math.Atan(worst)*180/math.Pi)
	}
	t.Logf("steepest pit triangle %.1f degrees", math.Atan(worst)*180/math.Pi)
}

func abs(a int) int {
	if a < 0 {
		return -a
	}
	return a
}

func TestFillUndoesDig(t *testing.T) {
	o := New()
	w := fakeWorld{base: 50, water: 0}
	for i := 0; i < 6; i++ {
		p, r := PlanSwing(o, w, Dig, 100.5, 100.5)
		if r != OK {
			t.Fatal(r)
		}
		apply(t, o, p)
	}
	for i := 0; i < 200; i++ {
		p, r := PlanSwing(o, w, Fill, 100.5, 100.5)
		if r != OK {
			break
		}
		apply(t, o, p)
	}
	if d := o.Delta(100, 100); d <= 0 {
		t.Fatalf("filling past the original makes a mound, got %d", d)
	}
	if d := o.Delta(100, 100); d > MaxDelta {
		t.Fatal("cap")
	}
}

func TestWaterFloorAndForbidden(t *testing.T) {
	o := New()
	// ground 1 m above the water: a dig can take at most ~0.7 m (2 steps, floor ceil((0.3+... )
	w := fakeWorld{base: 1.0, water: 0}
	for i := 0; i < 40; i++ {
		p, r := PlanSwing(o, w, Dig, 200.5, 200.5)
		if r != OK {
			break
		}
		apply(t, o, p)
	}
	for z := int32(190); z < 210; z++ {
		for x := int32(190); x < 210; x++ {
			h := float64(Lift(w.Base(x, z), o.Delta(x, z)))
			if o.Delta(x, z) != 0 && h < w.water+WaterMargin-1e-9 {
				t.Fatalf("dug below the water margin at %d,%d: %v", x, z, h)
			}
		}
	}
	w2 := fakeWorld{base: 50, forbidden: func(x, z int32) bool { return x >= 500 && x < 520 }}
	if _, r := PlanSwing(New(), w2, Dig, 505.5, 100.5); r != Forbidden {
		t.Fatalf("forbidden: %d", r)
	}
	if _, r := PlanSwing(New(), w2, Dig, 499.2, 100.5); r != Forbidden {
		t.Fatalf("a brush touching forbidden ground is refused: %d", r)
	}
	if _, r := PlanSwing(New(), fakeWorld{base: 50}, Dig, -10, 5); r != Forbidden {
		t.Fatalf("outside the world: %d", r)
	}
}

func TestEntriesRoundTripAndBounds(t *testing.T) {
	o := New()
	ch := []Change{{X: 64, Z: 64, D: -5}, {X: 127, Z: 127, D: 99}, {X: 70, Z: 65, D: -100}}
	blocks, err := o.Apply(ch)
	if err != nil || len(blocks) != 1 {
		t.Fatal(err, blocks)
	}
	if o.Delta(127, 127) != MaxDelta || o.Delta(70, 65) != -MaxDelta {
		t.Fatal("clamped")
	}
	es := o.BlockEntries(1, 1)
	if len(es) != 3 {
		t.Fatal(len(es))
	}
	dec, err := DecodeEntries(EncodeEntries(es))
	if err != nil || len(dec) != 3 {
		t.Fatal(err)
	}
	o2 := New()
	if err := o2.SetBlock(1, 1, dec); err != nil {
		t.Fatal(err)
	}
	if o2.Delta(64, 64) != -5 || o2.Vertices() != 3 {
		t.Fatal("restore")
	}
	// clearing the last vertex frees the block
	if _, err := o2.Apply([]Change{{64, 64, 0}, {127, 127, 0}, {70, 65, 0}}); err != nil {
		t.Fatal(err)
	}
	if o2.Blocks() != 0 || o2.Any() || o2.Vertices() != 0 {
		t.Fatal("empty again")
	}
	if _, err := DecodeEntries([]byte{1, 2}); err == nil {
		t.Fatal("bad length")
	}
	if _, err := DecodeEntries([]byte{0xff, 0xff, 1}); err == nil {
		t.Fatal("bad index")
	}
}

func TestStorageBound(t *testing.T) {
	o := New()
	n := 0
	for bz := int32(0); bz < WorldBlocks; bz++ {
		for bx := int32(0); bx < WorldBlocks; bx++ {
			if _, err := o.Apply([]Change{{X: bx * 64, Z: bz * 64, D: 1}}); err != nil {
				if n != MaxBlocks {
					t.Fatalf("full at %d blocks, want %d", n, MaxBlocks)
				}
				return
			}
			n++
		}
	}
	t.Fatal("never full")
}

func TestSurfaceMatchesCollisionFormula(t *testing.T) {
	// A flat edited cell is flat; a tilted one interpolates on the (x0+1,z0)-(x0,z0+1) diagonal.
	if h := Surface(10, 10, 10, 10, 0.3, 0.9); h != 10 {
		t.Fatal(h)
	}
	if h := Surface(0, 4, 8, 12, 0.5, 0.5); math.Abs(h-6) > 1e-12 {
		t.Fatal(h)
	}
	if h := Surface(0, 4, 8, 12, 1, 1); h != 12 {
		t.Fatal(h)
	}
	if Lift(10.1, -3) != float32(float64(float32(10.1))-0.75) {
		t.Fatal("lift")
	}
}

func TestItemsFor(t *testing.T) {
	i, r := ItemsFor(10, 4)
	if i != 2 || r != 2 {
		t.Fatal(i, r)
	}
	if CostFor(1) != 1 || CostFor(13) != 3 {
		t.Fatal("cost")
	}
}
