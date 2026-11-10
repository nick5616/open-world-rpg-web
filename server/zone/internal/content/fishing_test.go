package content

import (
	"reflect"
	"testing"

	"lodestone/server/pkg/contentdefs"
)

func TestFishRollDeterministic(t *testing.T) {
	c := FishConditions{Water: WaterLake, Biome: 0, Hour: 10}
	for cast := uint32(1); cast < 200; cast++ {
		seed := FishSeed(42, 0xabcdef, cast, 2066.3, 2048.9)
		a, okA := RollCatch(seed, c)
		b, okB := RollCatch(seed, c)
		if okA != okB || !reflect.DeepEqual(a, b) {
			t.Fatalf("cast %d: %+v vs %+v", cast, a, b)
		}
	}
	// The seed depends on every input.
	base := FishSeed(42, 1, 7, 100, 100)
	for name, s := range map[string]uint64{
		"world": FishSeed(43, 1, 7, 100, 100), "char": FishSeed(42, 2, 7, 100, 100), "cast": FishSeed(42, 1, 8, 100, 100),
		"cell x": FishSeed(42, 1, 7, 104, 100), "cell z": FishSeed(42, 1, 7, 100, 104),
	} {
		if s == base {
			t.Fatalf("seed ignores the %s", name)
		}
	}
	if FishSeed(42, 1, 7, 100, 100) != FishSeed(42, 1, 7, 101.5, 102.9) {
		t.Fatal("the same 4 m cell gave another seed")
	}
}

func TestFishRollRanges(t *testing.T) {
	fi := &contentdefs.D.Fishing
	for cast := uint32(1); cast < 2000; cast++ {
		c := FishConditions{Water: int(cast % 3), Biome: int(cast/3) % 6, Hour: float64(cast%24) + 0.5, Raining: cast%5 == 0}
		got, ok := RollCatch(FishSeed(9, 3, cast, 0, 0), c)
		if !ok {
			t.Fatalf("nothing bites in %+v", c)
		}
		f := contentdefs.D.FishByID(got.Species)
		if f == nil || !FishBites(f, c) {
			t.Fatalf("rolled %v, which can't bite in %+v", f, c)
		}
		if w := float64(got.WeightG) / 1000; w < f.Weight[0]-0.001 || w > f.Weight[1]+0.001 {
			t.Fatalf("%s weighs %.3f kg, outside %v", f.Key, w, f.Weight)
		}
		if got.BiteMs < int(fi.BiteS[0]*1000) || got.BiteMs > int(fi.BiteS[1]*1000) {
			t.Fatalf("bite at %d ms", got.BiteMs)
		}
		last := 0
		for _, n := range got.Nibbles {
			if n <= last || n > got.BiteMs-700 {
				t.Fatalf("nibbles %v with the bite at %d", got.Nibbles, got.BiteMs)
			}
			last = n
		}
		if got.FightSeed == 0 {
			t.Fatal("zero fight seed")
		}
	}
}

func TestFishConditions(t *testing.T) {
	sp := func(key string) *contentdefs.Fish {
		for i := range contentdefs.D.Fishing.Species {
			if contentdefs.D.Fishing.Species[i].Key == key {
				return &contentdefs.D.Fishing.Species[i]
			}
		}
		t.Fatalf("no species %s", key)
		return nil
	}
	day := FishConditions{Water: WaterLake, Biome: 5, Hour: 12}
	night := FishConditions{Water: WaterLake, Biome: 5, Hour: 23}
	if FishBites(sp("gloam_eel"), day) || !FishBites(sp("gloam_eel"), night) {
		t.Fatal("the gloam eel bites only at night")
	}
	if FishBites(sp("tidewing_mackerel"), day) || !FishBites(sp("tidewing_mackerel"), FishConditions{Water: WaterSea, Hour: 12}) {
		t.Fatal("mackerel live in the sea only")
	}
	storm := FishConditions{Water: WaterSea, Hour: 23, Raining: true}
	if !FishBites(sp("deepmaw"), storm) || FishBites(sp("deepmaw"), FishConditions{Water: WaterSea, Hour: 23}) {
		t.Fatal("the deepmaw wants a rainy night at sea")
	}
	if FishBites(sp("moonlit_koi"), FishConditions{Water: WaterLake, Biome: 0, Hour: 23, Raining: true}) {
		t.Fatal("the moonlit koi wants a clear night")
	}
	if FishBites(sp("frostgill_char"), FishConditions{Water: WaterLake, Biome: 0, Hour: 12}) || !FishBites(sp("frostgill_char"), FishConditions{Water: WaterRiver, Biome: 3, Hour: 12}) {
		t.Fatal("frostgill char live in the cold")
	}
	// Every species can be caught somewhere, sometime.
	seen := map[int]bool{}
	for w := 0; w < 3; w++ {
		for b := 0; b < 6; b++ {
			for h := 0.5; h < 24; h += 1 {
				for _, rain := range []bool{false, true} {
					c := FishConditions{Water: w, Biome: b, Hour: h, Raining: rain}
					for cast := uint32(0); cast < 400; cast++ {
						if got, ok := RollCatch(FishSeed(1, 2, cast, float64(w), float64(b)), c); ok {
							seen[got.Species] = true
						}
					}
				}
			}
		}
	}
	for _, f := range contentdefs.D.Fishing.Species {
		if !seen[f.ID] {
			t.Errorf("%s is never caught", f.Key)
		}
	}
	if n := len(contentdefs.D.Fishing.Species); n < 10 || n > 15 {
		t.Fatalf("%d species", n)
	}
}

func TestFishLandedCodexAndFeats(t *testing.T) {
	s := NewState()
	if first, rec := s.Landed("reed_perch", 500, false); !first || rec {
		t.Fatal("first perch")
	}
	if first, rec := s.Landed("reed_perch", 400, false); first || rec {
		t.Fatal("a lighter perch is no record")
	}
	if _, rec := s.Landed("reed_perch", 900, false); !rec {
		t.Fatal("a heavier perch is a record")
	}
	s.Landed("deepmaw", 90000, true)
	if s.Fish["reed_perch"] != [2]int{3, 900} || s.Stat2("fish") != 4 || s.Stat2("fishspecies") != 2 || s.Stat2("fishlegend") != 1 {
		t.Fatalf("state %+v stats %+v", s.Fish, s.Stats)
	}
	feats := map[string]bool{}
	for _, f := range earn(s, func(string) int { return 0 }) {
		feats[f.Key] = true
	}
	if !feats["first_catch"] || !feats["tall_tale"] || feats["angler"] {
		t.Fatalf("feats %v", feats)
	}
	back := LoadState(s.JSON())
	if back.Fish["deepmaw"] != [2]int{1, 90000} {
		t.Fatalf("round trip %+v", back.Fish)
	}
}

func TestFightMinMs(t *testing.T) {
	for i := range contentdefs.D.Fishing.Species {
		f := &contentdefs.D.Fishing.Species[i]
		if got := FightMinMs(f); got != int(1250*f.Fight.Stamina) || got < 2000 {
			t.Fatalf("%s: %d", f.Key, got)
		}
	}
}
