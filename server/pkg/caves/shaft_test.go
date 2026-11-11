package caves

import "testing"

type oneCell struct{ c *Cell }

func (o oneCell) Cell(cx, cy, cz int32) *Cell { return o.c }

// Playtest 2 co-op: a sinkhole's shaft has no floor for 140 m. With its
// cells there, standing over it is falling (it was a lid you could walk
// across); only a hole whose cells are missing keeps the old surface.
func TestShaftWithCellsDrops(t *testing.T) {
	op := []Opening{{X: 100, Y: 50, Z: 100, RMask: 5, RZone: 8, Sinkhole: true}}
	surface := func(x, z float64) float64 { return 50 }
	// Loaded, no triangles, all air: the shaft all the way down.
	empty := &Cell{OX: 64, OY: 32, OZ: 64, Density: make([]int8, SamplesXZ*SamplesY*SamplesXZ)}
	for i := range empty.Density {
		empty.Density[i] = -10
	}
	g := &Ground{Height: surface, Openings: op, Cells: oneCell{empty}}
	if f := g.FloorAt(100.2, 50, 100.3); f >= 50 {
		t.Fatalf("over a loaded shaft the floor is %v: still a lid", f)
	}
	missing := &Ground{Height: surface, Openings: op, Cells: oneCell{nil}}
	if f := missing.FloorAt(100.2, 50, 100.3); f != 50 {
		t.Fatalf("cells missing: want the old surface 50, got %v", f)
	}
	// Away from the opening nothing changes.
	if f := g.FloorAt(130, 50, 130); f != 50 {
		t.Fatalf("open ground: want 50, got %v", f)
	}
}
