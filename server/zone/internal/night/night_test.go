package night

import (
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/weather"
)

func TestDefensePlansAreSeededRareAndAtNight(t *testing.T) {
	w := &World{Seed: 20261108, Intensity: 0.5, Towns: make([]Town, 40)}
	hits, newMoonHits := 0, 0
	for n := int64(0); n < 64; n++ {
		for i := range w.Towns {
			at, ok := w.DefensePlan(i, n)
			at2, ok2 := w.DefensePlan(i, n)
			if ok != ok2 || at != at2 {
				t.Fatal("not deterministic")
			}
			if !ok {
				continue
			}
			hits++
			if weather.MoonPhase(w.Seed, n) == 0 {
				newMoonHits++
			}
			if !weather.IsNight(at) || weather.NightIndex(at) != n {
				t.Fatalf("defense at %v not inside night %d", at, n)
			}
		}
	}
	rate := float64(hits) / (64 * 40)
	if rate < 0.04 || rate > 0.2 || newMoonHits == 0 {
		t.Fatalf("defense rate %.3f (new moon %d)", rate, newMoonHits)
	}
	w.Intensity = 0
	if _, ok := w.DefensePlan(0, 8); ok {
		t.Fatal("demonIntensity 0 means no attacks")
	}
}

func TestWardsLanternsAndWaves(t *testing.T) {
	w := &World{Seed: 1, Intensity: 0.5, Towns: []Town{{X: 100, Z: 100, Radius: 20}}, lanterns: map[[2]int][]Point{}}
	if w.WardAt(100, 100+20+constants.WardMarginM-0.5) != 0 || w.WardAt(100, 100+20+constants.WardMarginM+0.5) != -1 {
		t.Fatal("ward radius")
	}
	w.AddLantern(300, 300)
	if !w.NearLantern(303, 300) || w.NearLantern(310, 300) {
		t.Fatal("lantern ward")
	}
	last := Wave(3, 1, 0)
	if len(Wave(1, 1, 0)) != 5 || len(Wave(3, 2, 0)) != 3+6+2+1 || last[len(last)-1] != "cinder_fiend" {
		t.Fatal("wave composition")
	}
	gates := w.WaveGates(&w.Towns[0], 5, 1)
	if len(gates) < 2 || w.WardAt(gates[0][0], gates[0][1]) != -1 {
		t.Fatal("gates sit outside the ward")
	}
	if w.HuntersPerPlayer(0) < 0 || GreaterFor(8) == "" {
		t.Fatal("tables")
	}
}
