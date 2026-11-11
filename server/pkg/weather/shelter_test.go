package weather

import "testing"

type wetEverywhere struct{}

func (wetEverywhere) MoveWeatherAt(x, z float64) MoveWeather {
	return MoveWeather{Rain: true, SpeedMult: 0.8, PushX: 1}
}

func TestShelteredTowersAreDry(t *testing.T) {
	s := Sheltered{F: wetEverywhere{}, Discs: []Disc{{X: 100, Z: 100, R: 13}}}
	if w := s.MoveWeatherAt(110, 105); w.Rain || w.SpeedMult != 0.8 || w.PushX != 1 {
		t.Fatalf("at the tower wall: %+v (only the rain goes)", w)
	}
	if w := s.MoveWeatherAt(120, 100); !w.Rain {
		t.Fatalf("20 m out it still rains: %+v", w)
	}
}
