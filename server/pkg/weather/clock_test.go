package weather

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/clock_vectors.json")

// clockVector is one sample both languages evaluate (client/src/systems/clock.test.ts).
type clockVector struct {
	Seed      string  `json:"seed"`
	T         float64 `json:"t"`
	Hour      float64 `json:"hour"`
	Night     bool    `json:"night"`
	NightIdx  int64   `json:"nightIndex"`
	Phase     int     `json:"phase"`
	Step      int64   `json:"step"`
	Rain      bool    `json:"rain"`
	WindDeg   int     `json:"windDeg"`
	Sector    int     `json:"sector"`
	DX        int     `json:"dx"`
	DZ        int     `json:"dz"`
	Strength  int     `json:"strength"`
	RainStepT bool    `json:"rainStepVsT"` // RainingAtStep(Step(t)) == IsRaining(t)
}

func clockVectors() []clockVector {
	var out []clockVector
	seeds := []uint64{20261108, 1234, 7, 18446744073709551557}
	times := []float64{0, 1, 899.9, 900, 3599.99, 66600, 66599.8, 1.7626e9 + 0.37, 1.7626e9 + 2345.6, -5000.25, 86400 * 3.5}
	for si, seed := range seeds {
		for ti, t := range times {
			deg := (si*97 + ti*41) % 360
			st := Step(t)
			w := WindAt(seed, deg, st)
			out = append(out, clockVector{
				Seed: jsonU64(seed), T: t, Hour: Hour(t), Night: IsNight(t), NightIdx: NightIndex(t),
				Phase: MoonPhase(seed, NightIndex(t)), Step: st, Rain: RainingAtStep(seed, st), WindDeg: deg,
				Sector: w.Sector, DX: w.DX, DZ: w.DZ, Strength: w.Strength, RainStepT: RainingAtStep(seed, st) == IsRaining(seed, t),
			})
		}
	}
	return out
}

func jsonU64(v uint64) string { b, _ := json.Marshal(v); return string(b) }

// TestClockVectors pins the clock both languages share; -update rewrites
// the file the TS test replays.
func TestClockVectors(t *testing.T) {
	path := filepath.Join("testdata", "clock_vectors.json")
	got := clockVectors()
	if *update {
		b, _ := json.MarshalIndent(got, "", " ")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test ./weather -run ClockVectors -update)", err)
	}
	var want []clockVector
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(got) {
		t.Fatalf("%d vectors, want %d", len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("vector %d: %+v want %+v", i, got[i], want[i])
		}
	}
}

func TestNightRules(t *testing.T) {
	day := float64(3600)
	if IsNight(5 * day / 24 * 2.4) { // 12:00
		t.Fatal("noon is not night")
	}
	if !IsNight(19 * 150) || !IsNight(2 * 150) || IsNight(6*150) || IsNight(18*150) {
		t.Fatal("night is 18:30-06:00")
	}
	// Night n: dusk of day n to dawn of day n+1.
	for n := int64(-2); n < 5; n++ {
		if NightIndex(NightStart(n)+1) != n || NightIndex(NightEnd(n)-1) != n || NightIndex(NightEnd(n)+1) != n+1 {
			t.Fatalf("night %d boundaries", n)
		}
	}
	// The moon walks the 8-night cycle; new moon is the worst.
	seen := map[int]bool{}
	for n := int64(0); n < 8; n++ {
		seen[MoonPhase(20261108, n)] = true
	}
	if len(seen) != 8 || MoonDemonFactor(0) != 1 || MoonDemonFactor(4) >= MoonDemonFactor(2) || !IsLordNight(0) {
		t.Fatal("moon cycle")
	}
	if MoonIllumination(0) != 0 || MoonIllumination(4) != 1 {
		t.Fatal("illumination")
	}
}

func TestWindVeersAroundPrevailing(t *testing.T) {
	counts := map[int]int{}
	for w := int64(0); w < 300; w++ {
		x := WindAt(5, 90, w*600)
		counts[x.Sector]++
		if x.Strength < 1 || x.Strength > 3 {
			t.Fatal("strength")
		}
	}
	// From the east (sector 2) +- one sector.
	if len(counts) != 3 || counts[1] == 0 || counts[2] == 0 || counts[3] == 0 {
		t.Fatalf("sectors %v", counts)
	}
}
