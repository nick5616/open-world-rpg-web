package caves

import (
	"math"
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Playtest 2 co-op polish, the rider who fell 330 m: a gallop into a cliff
// over a cave system. The step views the ground "at the player's level"
// (movement.AtLevel(start feet y)); a probe one step ahead where the cliff
// already stands more than UnderM above those feet reads the cave rules,
// and with open cave air there it found no floor: the wall was invisible
// and the rider went into the hill.
func cliffOverCave() *Ground {
	cliff := func(x, z float64) float64 {
		if x < 50 {
			return 100
		}
		return 100 + (x-50)*6 // ~80 degrees
	}
	air := &Cell{OX: 0, OY: 0, OZ: 0, System: 0, Density: make([]int8, SamplesXZ*SamplesY*SamplesXZ)}
	for i := range air.Density {
		air.Density[i] = -10
	}
	return &Ground{Height: cliff, Cells: oneCell{air}}
}

func TestGallopIntoCliffStaysOnTheSurface(t *testing.T) {
	g := cliffOverCave()
	s := movement.Mount(movement.NewState(movement.Vec3{X: 40, Y: 100, Z: 10}))
	yaw := math.Pi / 2 * 3 // yaw 3pi/2 faces +x (forward is (-sin, -cos))
	worst := 0.0
	for i := 0; i < 240; i++ {
		f := proto.InputFrame{Seq: uint32(i + 1), Flags: proto.InputFlagForward, Yaw: proto.YawToU16(yaw)}
		if i%40 == 0 {
			f.Flags |= proto.InputFlagSprint // spur to a gallop
		}
		prev := s
		s = movement.StepFrame(s, f, g)
		if d := g.Height(s.Pos.X, s.Pos.Z) - s.Pos.Y; d > UnderM && worst <= UnderM {
			t.Logf("step %d: %+v (mode %d, vel %+v) -> %+v (mode %d), surface there %.2f", i, prev.Pos, prev.Mode, prev.Vel, s.Pos, s.Mode, g.Height(s.Pos.X, s.Pos.Z))
		}
		if d := g.Height(s.Pos.X, s.Pos.Z) - s.Pos.Y; d > worst {
			worst = d
		}
	}
	t.Logf("end %+v, deepest under the surface %.2f m", s.Pos, worst)
	if worst > UnderM {
		t.Fatalf("the rider went %.2f m under the cliff's surface (end %+v)", worst, s.Pos)
	}
}
