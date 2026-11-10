package content

import (
	"math"

	"lodestone/server/pkg/contentdefs"
)

// Fishing (playtest 2, CR 026; contracts/content.yaml `fishing`): which
// species bite in a water, biome, hour and weather, the seeded roll of one
// cast (species, weight, bite time, false nibbles, the fight's seed) and the
// fastest a fight can be won. Pure: the glue (game/fishing.go) supplies the
// conditions from the atlas, the world clock and the weather.

// Water kinds (contentdefs Fishing.Waters order).
const (
	WaterLake  = 0
	WaterRiver = 1
	WaterSea   = 2
)

// FishConditions is where and when a line is cast.
type FishConditions struct {
	Water   int
	Biome   int
	Hour    float64 // 0..24, the world clock
	Raining bool
}

// TimeMatches reports whether a species' time window holds at hour.
func TimeMatches(t string, hour float64) bool {
	switch t {
	case "day":
		return hour >= 6 && hour < 19
	case "night":
		return hour >= 19 || hour < 6
	case "dawn":
		return hour >= 4.5 && hour < 8.5
	case "dusk":
		return hour >= 17 && hour < 21
	}
	return true
}

// FishBites reports whether species f can bite under c.
func FishBites(f *contentdefs.Fish, c FishConditions) bool {
	inWater := false
	for _, w := range f.Water {
		inWater = inWater || w == c.Water
	}
	if !inWater {
		return false
	}
	if len(f.Biomes) > 0 {
		in := false
		for _, b := range f.Biomes {
			in = in || b == c.Biome
		}
		if !in {
			return false
		}
	}
	switch f.Weather {
	case "rain":
		if !c.Raining {
			return false
		}
	case "clear":
		if c.Raining {
			return false
		}
	}
	return TimeMatches(f.Time, c.Hour)
}

// FishCandidates lists the species that can bite under c.
func FishCandidates(c FishConditions) []*contentdefs.Fish {
	var out []*contentdefs.Fish
	sp := contentdefs.D.Fishing.Species
	for i := range sp {
		if FishBites(&sp[i], c) {
			out = append(out, &sp[i])
		}
	}
	return out
}

// Catch is one cast's seeded outcome. The species and weight stay on the
// zone until the fish is landed; the client learns the bite time, the
// nibbles and the fight (seed, strength, erratic, stamina).
type Catch struct {
	Species   int // contentdefs fish id
	WeightG   int
	BiteMs    int
	Nibbles   []int // ms after the cast of false dips before the bite (show only)
	FightSeed uint32
}

// FishSeed is the roll seed of a cast: the world seed, the character, the
// character's cast count and the bobber's 4 m cell (a new spot, a new roll).
func FishSeed(worldSeed, char uint64, cast uint32, x, z float64) uint64 {
	cx, cz := uint64(int64(math.Floor(x/4))), uint64(int64(math.Floor(z/4)))
	return mix(worldSeed ^ 0xf15c0de ^ mix(char) ^ uint64(cast)*0x9e3779b97f4a7c15 ^ cx*0xc2b2ae3d27d4eb4f ^ cz*0x165667b19e3779f9)
}

// RollCatch rolls a cast from seed under c: a species among the candidates
// weighted by rarity, its weight (skewed small), when it bites and how it
// fights. ok is false when nothing lives there (the line comes back empty).
func RollCatch(seed uint64, c FishConditions) (Catch, bool) {
	fi := &contentdefs.D.Fishing
	cands := FishCandidates(c)
	if len(cands) == 0 {
		return Catch{}, false
	}
	tot := 0.0
	for _, f := range cands {
		tot += fi.Rarities[f.Rarity].Weight
	}
	u := unit(mix(seed+1)) * tot
	pick := cands[len(cands)-1]
	for _, f := range cands {
		if u -= fi.Rarities[f.Rarity].Weight; u < 0 {
			pick = f
			break
		}
	}
	w := unit(mix(seed + 2))
	kg := pick.Weight[0] + (pick.Weight[1]-pick.Weight[0])*w*w
	bite := fi.BiteS[0] + (fi.BiteS[1]-fi.BiteS[0])*unit(mix(seed+3))
	out := Catch{Species: pick.ID, WeightG: int(math.Round(kg * 1000)), BiteMs: int(bite * 1000), FightSeed: uint32(mix(seed+4) >> 32)}
	if out.FightSeed == 0 {
		out.FightSeed = 1
	}
	// 0-3 false nibbles, at least 0.9 s apart and before the bite.
	n := int(mix(seed+5) % 4)
	at := 900
	for k := 0; k < n; k++ {
		at += 500 + int(unit(mix(seed+6+uint64(k)))*1400)
		if at > out.BiteMs-700 {
			break
		}
		out.Nibbles = append(out.Nibbles, at)
	}
	return out, true
}

// FightMinMs is the fastest a fight against species f can be won: the
// minigame (client/src/ui/fishing/minigame.ts) raises progress from 0.25 to
// 1 at most at 0.6 / stamina per second (a calm fish, reeling the whole
// time), so 1250 ms per second of stamina.
func FightMinMs(f *contentdefs.Fish) int { return int(1250 * f.Fight.Stamina) }
