package difficulty

import (
	"context"
	"testing"

	"lodestone/server/pkg/combatdefs"
)

// CR 038: every vertical layer has its own areas over the same grid, never
// below its floor; neighbours stay in their layer; the Haven is surface only;
// the memory store keeps layers apart.
func TestLayeredAreas(t *testing.T) {
	def := &combatdefs.D.Difficulty
	m := New(def, 4096, 2048, 2048, nil)
	if m.Cells() != Layers*m.BaseCells() {
		t.Fatalf("cells %d", m.Cells())
	}
	spawn := m.Cell(2048, 2048)
	if !m.Haven(spawn) || m.Haven(m.LayerCell(2, 2048, 2048)) {
		t.Fatal("the Haven is the surface's only")
	}
	for layer := 0; layer < Layers; layer++ {
		c := m.LayerCell(layer, 1000, 3000)
		if m.LayerOf(c) != layer || c%m.BaseCells() != m.Cell(1000, 3000) {
			t.Fatalf("layer %d cell %d", layer, c)
		}
		for _, n := range m.Neighbours(c) {
			if m.LayerOf(n) != layer {
				t.Fatalf("neighbour %d of %d in layer %d", n, c, m.LayerOf(n))
			}
		}
		x, z := m.Center(c)
		if m.Cell(x, z) != c%m.BaseCells() {
			t.Fatal("centre")
		}
		for _, n := range m.NearLayer(layer, 1000, 3000, 300, nil) {
			if m.LayerOf(n) != layer {
				t.Fatal("NearLayer left its layer")
			}
		}
	}
	st := NewMemStore()
	g := m.Geometry("w")
	for layer, floor := range LayerFloor {
		c := m.LayerCell(layer, 3000, 1000)
		s, err := st.Claim(context.Background(), g, Claim{Cell: c, PlayerLevel: 2, CharID: "c", Name: "n"})
		if err != nil {
			t.Fatal(err)
		}
		if s.Level < max(2, floor) {
			t.Fatalf("layer %d stamped %d (floor %d)", layer, s.Level, floor)
		}
		m.Set(s, 0)
		if l, tier, ok := m.AreaAtLayer(3000, 1000, layer); !ok || l != s.Level || tier == nil {
			t.Fatalf("AreaAtLayer %d: %d %v", layer, l, ok)
		}
	}
	if _, i := def.TierFor(LayerFloor[3]); i != len(def.Tiers)-1 {
		t.Fatalf("the Depths' floor is tier %d, not the top", i)
	}
}
