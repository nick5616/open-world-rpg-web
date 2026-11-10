package weather

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"lodestone/server/pkg/constants"
)

// Golden vectors both languages replay (client/src/systems/weather/weather.test.ts).
// `go test ./weather -run WeatherVectors -update` rewrites them.

type cellDetail struct {
	CX      int   `json:"cx"`
	CZ      int   `json:"cz"`
	Phase   int64 `json:"phase"`
	Window  int64 `json:"w"`
	Roll    int   `json:"roll"`
	State   int   `json:"s"`
	Next    int   `json:"next"`
	NextAt  int64 `json:"nextAt"`
	Climate int   `json:"climate"`
}

type stateVector struct {
	Seed    string       `json:"seed"`
	Step    int64        `json:"k"`
	States  []int        `json:"states"`
	Details []cellDetail `json:"details"`
}

type moveVector struct {
	Seed     string     `json:"seed"`
	Step     int64      `json:"k"`
	WindDeg  int        `json:"windDeg"`
	Override int        `json:"override"`
	XZ       [2]float64 `json:"xz"`
	Rain     bool       `json:"rain"`
	Speed    float64    `json:"speed"`
	PushX    float64    `json:"px"`
	PushZ    float64    `json:"pz"`
	ArrowX   float64    `json:"ax"`
	ArrowZ   float64    `json:"az"`
	State    int        `json:"state"`
}

type strikeVector struct {
	Seed     string       `json:"seed"`
	Range    [2]int64     `json:"range"`
	Override int          `json:"override"`
	Strikes  [][6]float64 `json:"strikes"`
	Tall     [][2]float64 `json:"tall"`
}

type weatherVectors struct {
	Climates []int          `json:"climates"`
	States   []stateVector  `json:"states"`
	Moves    []moveVector   `json:"moves"`
	Strikes  []strikeVector `json:"strikes"`
}

// testBiomes is the synthetic atlas biome grid both tests build (129 x 129
// nodes, 32 m apart): blocky biome regions with a speckle.
func testBiomes() (int, int, []byte) {
	n := 129
	b := make([]byte, n*n)
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			v := (i/22 + 3*(j/40)) % 6
			if (i*31+j*17)%23 == 0 {
				v = (v + 3) % 6
			}
			b[j*n+i] = byte(v)
		}
	}
	return n, 32, b
}

// testHeight is the synthetic terrain for TallSpot (float ops both languages do exactly).
func testHeight(x, z float64) float64 { return math.Mod(x*0.37+z*0.61, 17) + math.Abs(x-2000)*0.01 }

func weatherVectorSet() weatherVectors {
	var v weatherVectors
	cl := NewClimate(testBiomes())
	for _, c := range cl.Cells {
		v.Climates = append(v.Climates, int(c))
	}
	seeds := []uint64{20261108, 1234, 7, 18446744073709551557}
	steps := []int64{0, 1, 2999, 3000, 12345, Step(1.7626e9 + 0.37), Step(1.7626e9 + 1234.5), -25001, 86400 * 5 * 3}
	for _, seed := range seeds {
		for _, k := range steps {
			sv := stateVector{Seed: jsonU64(seed), Step: k}
			for cz := 0; cz < CellsN; cz++ {
				for cx := 0; cx < CellsN; cx++ {
					sv.States = append(sv.States, StateAtStep(seed, cl, cx, cz, k))
				}
			}
			for _, c := range [][2]int{{0, 0}, {1, 0}, {3, 2}, {7, 7}, {4, 5}, {6, 1}} {
				w := WindowAt(seed, c[0], c[1], k)
				nx, at := Next(seed, cl, c[0], c[1], k)
				sv.Details = append(sv.Details, cellDetail{CX: c[0], CZ: c[1], Phase: FrontPhase(seed, c[0], c[1]), Window: w, Roll: Roll(seed, c[0], c[1], w),
					State: StateAtStep(seed, cl, c[0], c[1], k), Next: nx, NextAt: at, Climate: cl.At(c[0], c[1])})
			}
			v.States = append(v.States, sv)
		}
	}
	points := [][2]float64{{10, 10}, {511.99, 512}, {1800.5, 2300.25}, {4095.9, 3000}, {-20, 5000}, {2600, 700}}
	for si, seed := range seeds[:2] {
		for ki, k := range steps[:6] {
			for o := -1; o < NumStates; o += 3 {
				deg := (si*97 + ki*53 + o*31 + 360) % 360
				f := NewField(seed, cl, deg, k, o)
				for _, p := range points {
					mw := f.MoveWeatherAt(p[0], p[1])
					st := f.StateAt(p[0], p[1])
					ax, az := ArrowAccel(st, f.Wind)
					v.Moves = append(v.Moves, moveVector{Seed: jsonU64(seed), Step: k, WindDeg: deg, Override: o, XZ: p, Rain: mw.Rain, Speed: mw.SpeedMult, PushX: mw.PushX, PushZ: mw.PushZ, ArrowX: ax, ArrowZ: az, State: st})
				}
			}
		}
	}
	for _, c := range []struct {
		seed     uint64
		k0, k1   int64
		override int
	}{{20261108, 0, 4000, -1}, {1234, Step(1.7626e9), Step(1.7626e9) + 3000, -1}, {7, 100, 160, Thunderstorm}, {20261108, -301, -200, Thunderstorm}} {
		sv := strikeVector{Seed: jsonU64(c.seed), Range: [2]int64{c.k0, c.k1}, Override: c.override}
		StrikesBetween(c.seed, cl, c.k0, c.k1, c.override, func(s Strike) {
			sv.Strikes = append(sv.Strikes, [6]float64{float64(s.ID), float64(s.Step), s.X, s.Z, float64(s.CX), float64(s.CZ)})
			x, z := TallSpot(testHeight, s.X, s.Z)
			sv.Tall = append(sv.Tall, [2]float64{x, z})
		})
		v.Strikes = append(v.Strikes, sv)
	}
	return v
}

func TestWeatherVectors(t *testing.T) {
	path := filepath.Join("testdata", "weather_vectors.json")
	got := weatherVectorSet()
	if *update {
		b, _ := json.Marshal(got)
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test ./weather -run WeatherVectors -update)", err)
	}
	var want weatherVectors
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	gb, _ := json.Marshal(got)
	var round weatherVectors
	_ = json.Unmarshal(gb, &round)
	if !reflect.DeepEqual(round, want) {
		t.Fatal("weather vectors changed (go test ./weather -run WeatherVectors -update, then the TS twin and its test)")
	}
	n := 0
	for _, s := range want.Strikes {
		n += len(s.Strikes)
	}
	if n < 20 {
		t.Fatalf("only %d strikes in the vectors", n)
	}
}

func TestTablesSumTo100AndOrderFairToFoul(t *testing.T) {
	for c, tb := range tables {
		sum := 0
		for _, b := range tb {
			sum += b.pct
		}
		if sum != 100 {
			t.Fatalf("climate %d sums to %d", c, sum)
		}
		if tb[0].state != Clear {
			t.Fatalf("climate %d starts fair", c)
		}
	}
}

// Over many windows every climate shows each of its states at roughly its share.
func TestStatesFollowTheTables(t *testing.T) {
	for c := 0; c < NumClimates; c++ {
		cl := UniformClimate(c)
		counts := map[int]int{}
		const n = 20000
		for w := int64(0); w < n; w++ {
			k := WindowStart(1, 2, 3, w) + WindowSteps/2
			counts[StateAtStep(1, cl, 2, 3, k)]++
		}
		for _, b := range tables[c] {
			got := float64(counts[b.state]) / n * 100
			want := float64(b.pct)
			if b.state == HeatHaze || (c == ClimateArid && b.state == Clear) {
				continue // heat haze only by day; the rest is clear
			}
			if math.Abs(got-want) > 4 {
				t.Fatalf("climate %d state %s: %.1f%% want ~%v%%", c, StateKeys[b.state], got, want)
			}
		}
	}
}

// One front: the cells of a front share a roll up to the jitter, so a storm
// over a meadow is a snowstorm on the peak next to it.
func TestFrontsAreCoherent(t *testing.T) {
	for w := int64(0); w < 500; w++ {
		a, b := Roll(9, 0, 0, w), Roll(9, 1, 1, w)
		if d := a - b; d > 2*constants.WeatherJitter || d < -2*constants.WeatherJitter {
			t.Fatalf("window %d: rolls %d and %d in one front", w, a, b)
		}
	}
	cl := UniformClimate(ClimateTemperate)
	cl.Cells[1] = ClimateCold
	storms, matched := 0, 0
	for w := int64(0); w < 3000; w++ {
		k := WindowStart(3, 0, 0, w) + 10
		if StateAtStep(3, cl, 0, 0, k) == Thunderstorm {
			storms++
			if s := StateAtStep(3, cl, 1, 0, k); s == Snowstorm || s == Snow {
				matched++
			}
		}
	}
	if storms == 0 || matched*10 < storms*8 {
		t.Fatalf("%d storms, %d with snow next door", storms, matched)
	}
}

func TestFrontsChangeAtDifferentMoments(t *testing.T) {
	seen := map[int64]bool{}
	for cz := 0; cz < CellsN; cz += 2 {
		for cx := 0; cx < CellsN; cx += 2 {
			seen[FrontPhase(20261108, cx, cz)] = true
		}
	}
	if len(seen) < 12 {
		t.Fatalf("only %d distinct phases over 16 fronts", len(seen))
	}
	// A window lasts exactly WindowSteps and Next reports its end.
	k := int64(777777)
	_, at := Next(20261108, UniformClimate(0), 3, 4, k)
	if at <= k || at > k+WindowSteps || WindowAt(20261108, 3, 4, at) != WindowAt(20261108, 3, 4, k)+1 || WindowAt(20261108, 3, 4, at-1) != WindowAt(20261108, 3, 4, k) {
		t.Fatalf("next window at %d from %d", at, k)
	}
}

func TestHeatHazeOnlyByDay(t *testing.T) {
	cl := UniformClimate(ClimateArid)
	for w := int64(0); w < 4000; w++ {
		k := WindowStart(5, 0, 0, w) + 1
		if StateAtStep(5, cl, 0, 0, k) == HeatHaze && !Daytime(k) {
			t.Fatal("heat haze at night")
		}
	}
}

func TestMoveWeatherRules(t *testing.T) {
	w := Wind{Sector: 1, DX: -1, DZ: 1, Strength: 2}
	if px, pz := GlidePush(Clear, w); px != 0 || pz != 0 {
		t.Fatal("calm weather pushes")
	}
	px, pz := GlidePush(Snowstorm, w)
	if math.Abs(math.Hypot(px, pz)-2*constants.WindGlidePushMs) > 1e-12 || px >= 0 || pz <= 0 {
		t.Fatalf("snowstorm push %v %v", px, pz)
	}
	if MoveSpeedMult(Snow) != constants.SnowMoveMult || MoveSpeedMult(Rain) != 1 {
		t.Fatal("speed mult")
	}
	f := NewField(1, UniformClimate(ClimateCold), 90, 0, Snowstorm)
	mw := f.MoveWeatherAt(100, 100)
	if mw.Rain || mw.SpeedMult != constants.SnowstormMoveMult {
		t.Fatalf("field %+v", mw)
	}
	if !NewField(1, UniformClimate(0), 90, 0, Drizzle).MoveWeatherAt(1, 1).Rain {
		t.Fatal("drizzle is wet")
	}
}

func TestStrikesOnlyInStorms(t *testing.T) {
	cl := NewClimate(testBiomes())
	n := 0
	StrikesBetween(20261108, cl, 0, 200000, -1, func(s Strike) {
		n++
		if StateAtStep(20261108, cl, s.CX, s.CZ, floorDiv(s.Step, SlotSteps)*SlotSteps) != Thunderstorm {
			t.Fatalf("strike %+v outside a storm", s)
		}
		cx, cz := CellOf(s.X, s.Z)
		if cx != s.CX || cz != s.CZ {
			t.Fatalf("strike %+v outside its cell", s)
		}
	})
	if n == 0 {
		t.Fatal("no strikes in 11 hours")
	}
	// A forced storm strikes each cell in about LIGHTNING_SLOT_PCT of slots.
	m := 0
	StrikesBetween(1, cl, 0, 100*SlotSteps, Thunderstorm, func(Strike) { m++ })
	if pct := float64(m) / (100 * CellsN * CellsN) * 100; math.Abs(pct-constants.LightningSlotPct) > 5 {
		t.Fatalf("forced storm: %.1f%% of slots", pct)
	}
	x, z := TallSpot(func(x, z float64) float64 { return -math.Hypot(x-112, z-88) }, 100, 100)
	if x != 112 || z != 88 {
		t.Fatalf("tall spot %v %v", x, z)
	}
}
