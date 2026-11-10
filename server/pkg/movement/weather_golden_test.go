package movement

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
)

// CR 030: the weather goldens (client/src/sim/golden/weather.ts). The grounds
// and the band field are the TS ones, same arithmetic.

type weatherBand struct {
	FromX     float64 `json:"fromX"`
	Rain      bool    `json:"rain"`
	SpeedMult float64 `json:"speedMult"`
	PushX     float64 `json:"pushX"`
	PushZ     float64 `json:"pushZ"`
}

type bandField []weatherBand

func (b bandField) MoveWeatherAt(x, _ float64) weather.MoveWeather {
	c := b[0]
	for _, o := range b {
		if x >= o.FromX {
			c = o
		}
	}
	return weather.MoveWeather{Rain: c.Rain, SpeedMult: c.SpeedMult, PushX: c.PushX, PushZ: c.PushZ}
}

type mesa struct{ top, edgeX float64 }

func (m mesa) HeightAt(x, _ float64) float64 {
	if x < m.edgeX {
		return m.top
	}
	return 0
}

type gradeWall struct{ edgeX, grade, top float64 }

func (w gradeWall) HeightAt(x, _ float64) float64 {
	if x >= w.edgeX {
		return 0
	}
	return math.Min(w.top, (w.edgeX-x)*w.grade)
}

// TestReplaysWeatherGoldens: snow slows the walk, rain from the field makes
// the climb slip, a gale carries the glider; positions within 1e-9 m, the
// discrete state exactly, and every step inside the zone's speed bound.
func TestReplaysWeatherGoldens(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "client", "src", "sim", "golden")
	for _, name := range []string{"movement_pt2_weather_snow_walk.json", "movement_pt2_weather_gale_glide.json", "movement_pt2_weather_storm_climb.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Skipf("client goldens not available: %v", err)
		}
		var g struct {
			Ground struct {
				Kind                      string
				Height, Top, EdgeX, Grade float64
			} `json:"ground"`
			Bands   bandField     `json:"bands"`
			Initial [12]float64   `json:"initial"`
			Frames  [][5]float64  `json:"frames"`
			States  [][12]float64 `json:"states"`
		}
		if err := json.Unmarshal(raw, &g); err != nil {
			t.Fatal(err)
		}
		var ground Ground = Flat{Y: g.Ground.Height}
		switch g.Ground.Kind {
		case "mesa":
			ground = mesa{g.Ground.Top, g.Ground.EdgeX}
		case "wall":
			ground = gradeWall{g.Ground.EdgeX, g.Ground.Grade, g.Ground.Top}
		}
		env := Env{Weather: g.Bands}
		in := g.Initial
		s := NewState(Vec3{in[0], in[1], in[2]})
		modes := map[int]int{}
		for i, f := range g.Frames {
			prev := s
			s = StepFrameEnv(s, proto.InputFrame{Seq: uint32(f[0]), Flags: uint16(f[1]), Yaw: uint16(f[2]), Pitch: int16(f[3]), CastSlot: uint8(f[4])}, ground, env)
			w := g.States[i]
			got := [12]float64{s.Pos.X, s.Pos.Y, s.Pos.Z, s.Vel.X, s.Vel.Y, s.Vel.Z, float64(s.AirJumps), float64(s.Mode), float64(s.Stamina), float64(s.Timer), float64(s.Lunge), float64(s.Flags)}
			for k := range got {
				tol := 1e-9
				if k >= 6 {
					tol = 0
				}
				if math.Abs(got[k]-w[k]) > tol {
					t.Fatalf("%s frame %d field %d: go %v vs ts %v", name, i, k, got[k], w[k])
				}
			}
			if HorizontalSpeed(s) > MaxHorizontalSpeed(prev, s) {
				t.Fatalf("%s frame %d: speed %v over bound %v", name, i, HorizontalSpeed(s), MaxHorizontalSpeed(prev, s))
			}
			modes[s.Mode]++
		}
		t.Logf("%s: %d frames, modes %v", name, len(g.Frames), modes)
	}
}

// Snow slows walking by exactly the multiplier; no field = the old step.
func TestWeatherSnowAndPushRules(t *testing.T) {
	run := func(env Env, n int, flags uint16) State {
		s := NewState(Vec3{X: 100, Z: 100})
		for i := 0; i < n; i++ {
			s = StepFrameEnv(s, proto.InputFrame{Flags: flags, Yaw: proto.YawToU16(-math.Pi / 2)}, Flat{}, env)
		}
		return s
	}
	calm := run(Env{}, 240, proto.InputFlagForward)
	same := run(Env{Weather: bandField{{FromX: -1e9, SpeedMult: 1}}}, 240, proto.InputFlagForward)
	if calm != same {
		t.Fatal("a calm field changed the step")
	}
	snow := run(Env{Weather: bandField{{FromX: -1e9, SpeedMult: constants.SnowstormMoveMult}}}, 240, proto.InputFlagForward)
	if r := HorizontalSpeed(snow) / HorizontalSpeed(calm); math.Abs(r-constants.SnowstormMoveMult) > 1e-6 {
		t.Fatalf("snowstorm walk speed ratio %v", r)
	}
	// Field rain = Env.Raining for the climb.
	wall := gradeWall{10, 3, 30}
	climb := func(env Env) State {
		s := NewState(Vec3{X: 10.3})
		for i := 0; i < 300; i++ {
			s = StepFrameEnv(s, proto.InputFrame{Flags: proto.InputFlagForward, Yaw: west}, wall, env)
		}
		return s
	}
	if climb(Env{Raining: true}) != climb(Env{Weather: bandField{{FromX: -1e9, Rain: true, SpeedMult: 1}}}) {
		t.Fatal("rain from the field differs from Env.Raining")
	}
	if climb(Env{}).Pos.Y <= climb(Env{Raining: true}).Pos.Y {
		t.Fatal("rain did not slow the climb")
	}
}
