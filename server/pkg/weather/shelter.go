package weather

// Dry discs (playtest 2 co-op): the crystal towers' walls stay dry to climb
// in any weather. In rain a climber goes at half speed and slips every 3 s,
// so the wheel ran out 10 m short of a tower's ledge and a main story step
// waited out a 13-minute storm. The crystal hums the rain off its stone
// (the rain still falls; wind and snow still apply). Same as dryField in
// client/src/sim/shelter.ts.

// Disc is a circle on the ground (x, z, radius).
type Disc struct{ X, Z, R float64 }

// TowerShelterPad: how far past a tower's footprint the stone stays dry.
const TowerShelterPad = 2.0

// Sheltered wraps a move field: no rain inside any disc.
type Sheltered struct {
	F     MoveField
	Discs []Disc
}

// MoveWeatherAt implements MoveField.
func (s Sheltered) MoveWeatherAt(x, z float64) MoveWeather {
	w := s.F.MoveWeatherAt(x, z)
	if !w.Rain {
		return w
	}
	for _, d := range s.Discs {
		if dx, dz := x-d.X, z-d.Z; dx*dx+dz*dz <= d.R*d.R {
			w.Rain = false
			return w
		}
	}
	return w
}
