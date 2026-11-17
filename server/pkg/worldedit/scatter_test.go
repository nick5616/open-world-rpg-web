package worldedit

import "testing"

func TestScatterIDRoundTrip(t *testing.T) {
	for _, c := range []struct {
		layer  uint8
		cx, cz int32
		idx    uint32
	}{{1, 0, 0, 0}, {1, 63, 12, 4095}, {2, -3, 70, 17}, {4, 127, -64, 0xffffff}} {
		raw := uint64(c.layer)<<56 | uint64(uint16(c.cx))<<40 | uint64(uint16(c.cz))<<24 | uint64(c.idx)
		l, cx, cz, i := ScatterID(mix64(raw))
		if l != c.layer || cx != c.cx || cz != c.cz || i != c.idx {
			t.Fatalf("%v: got %d %d %d %d", c, l, cx, cz, i)
		}
	}
}

func TestDefsAndRolls(t *testing.T) {
	d, ok := DefFor(LayerTree, 3)
	if !ok || d.Tool != ToolAxe {
		t.Fatal("pine needs an axe")
	}
	if _, ok := DefFor(LayerTuft, 0); ok {
		t.Fatal("tufts are not harvestable")
	}
	if _, ok := DefFor(LayerTree, 99); ok {
		t.Fatal("unknown tree kind")
	}
	logs := 0
	for s := uint64(0); s < 200; s++ {
		for _, y := range d.Roll(200, s) {
			if y.Qty <= 0 {
				t.Fatal("empty yield")
			}
			if y.Item == "wood:log" {
				logs += y.Qty
			}
		}
	}
	if logs < 200*2 {
		t.Fatalf("a pine drops at least 2 logs: %d over 200", logs)
	}
	a, b := d.Roll(128, 7), d.Roll(128, 7)
	if len(a) != len(b) {
		t.Fatal("rolls are deterministic")
	}
	if g := d.Regrow(5); g < d.RegrowMin || g > d.RegrowMax {
		t.Fatalf("regrow %v", g)
	}
	if d.MaxHP(255) <= d.MaxHP(0) {
		t.Fatal("bigger takes longer")
	}
}
