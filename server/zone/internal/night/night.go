// Package night is the pure half of night and demons (WP15, spec 8 "Night
// and demons"): where the wards are, which settlements' wards weaken on
// which nights (town defense events), how many demons hunt a player under
// this moon, where a pack rises and what a defense wave is made of. The
// zone glue (internal/game/night.go) turns its answers into combat groups,
// Events and XP; the clock itself is server/pkg/weather (world time from
// wall time plus the world's configured offset, identical on every zone).
//
// Everything here is a function of the seed, the night index and ids, so
// two zones (WP16) agree about which towns are attacked tonight and a
// restarted zone picks the same plan up again.
package night

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/weather"
)

// Town is one settlement's ward.
type Town struct {
	Index            int
	Name             string
	X, Z, Radius     float64
	GardenX, GardenZ float64 // the ward garden demons go for in a defense event
	Element          int     // region element (combatdefs index, Physical none)
}

// WardRadius is the radius demons cannot cross.
func (t *Town) WardRadius() float64 { return t.Radius + constants.WardMarginM }

// Point is a place demons gather or flee to (demon lairs, cave mouths).
type Point struct{ X, Z float64 }

// World is the night layout of a world.
type World struct {
	Seed      uint64
	Intensity float64 // WorldSpec demonIntensity (0..1; 0.5 default)
	Towns     []Town
	Lairs     []Point // demon lairs (lords rise here)
	Refuges   []Point // demon lairs and cave mouths (demons near one flee at dawn instead of burning)
	lanterns  map[[2]int][]Point
}

const lanternCell = 32.0

// New builds the night layout from the towns buffer and the atlas sites.
// names maps settlement index to display name; element gives a position's
// region element.
func New(seed uint64, intensity float64, tw *towns.Towns, names func(i int) string, element func(x, z float64) int) *World {
	w := &World{Seed: seed, Intensity: intensity, lanterns: map[[2]int][]Point{}}
	if tw == nil {
		return w
	}
	for i := range tw.Settlements {
		st := &tw.Settlements[i]
		t := Town{Index: i, X: st.X, Z: st.Z, Radius: st.Radius, GardenX: st.X, GardenZ: st.Z, Element: combatdefs.Physical}
		if names != nil {
			t.Name = names(i)
		}
		if element != nil {
			t.Element = element(st.X, st.Z)
		}
		for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings && b < len(tw.Buildings); b++ {
			if tw.Buildings[b].Role == towns.BuildingGarden {
				t.GardenX, t.GardenZ = tw.Buildings[b].X, tw.Buildings[b].Z
				break
			}
		}
		w.Towns = append(w.Towns, t)
	}
	for i := range tw.Props {
		if p := &tw.Props[i]; p.Kind == PropLantern {
			w.AddLantern(p.X, p.Z)
		}
	}
	return w
}

// PropLantern is the towns prop kind of a road lantern (worldgen pk::LANTERN).
const PropLantern = 17

// AddLantern registers a lantern.
func (w *World) AddLantern(x, z float64) {
	c := [2]int{int(math.Floor(x / lanternCell)), int(math.Floor(z / lanternCell))}
	w.lanterns[c] = append(w.lanterns[c], Point{x, z})
}

// WardAt is the town whose ward covers (x, z), or -1.
func (w *World) WardAt(x, z float64) int {
	for i := range w.Towns {
		t := &w.Towns[i]
		r := t.WardRadius()
		if dx, dz := x-t.X, z-t.Z; dx*dx+dz*dz < r*r {
			return i
		}
	}
	return -1
}

// NearWard is the town whose ward, widened by margin metres, covers (x, z),
// or -1 (playtest 1: low-level players are not hunted near towns).
func (w *World) NearWard(x, z, margin float64) int {
	for i := range w.Towns {
		t := &w.Towns[i]
		r := t.WardRadius() + margin
		if dx, dz := x-t.X, z-t.Z; dx*dx+dz*dz < r*r {
			return i
		}
	}
	return -1
}

// NearLantern reports a point within LANTERN_WARD_M of a road lantern.
func (w *World) NearLantern(x, z float64) bool {
	cx, cz := int(math.Floor(x/lanternCell)), int(math.Floor(z/lanternCell))
	r2 := constants.LanternWardM * constants.LanternWardM
	for dz := -1; dz <= 1; dz++ {
		for dx := -1; dx <= 1; dx++ {
			for _, p := range w.lanterns[[2]int{cx + dx, cz + dz}] {
				if ddx, ddz := x-p.X, z-p.Z; ddx*ddx+ddz*ddz < r2 {
					return true
				}
			}
		}
	}
	return false
}

// NearRefuge reports a point within r of a lair or cave mouth.
func (w *World) NearRefuge(x, z, r float64) bool {
	for _, p := range w.Refuges {
		if math.Hypot(p.X-x, p.Z-z) < r {
			return true
		}
	}
	return false
}

// Scale is the night's demon multiplier: the moon times demonIntensity / 0.5.
func (w *World) Scale(nightIdx int64) float64 {
	return weather.MoonDemonFactor(weather.MoonPhase(w.Seed, nightIdx)) * w.Intensity / 0.5
}

// HuntersPerPlayer is how many lesser demons should hunt a player in the open.
func (w *World) HuntersPerPlayer(nightIdx int64) int {
	return int(math.Round(constants.DemonPerPlayer * w.Scale(nightIdx)))
}

func h64(seed uint64, a, b, c uint64) uint64 {
	x := seed ^ a*0x9e3779b97f4a7c15 ^ b*0xbf58476d1ce4e5b9 ^ c*0x94d049bb133111eb
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	return x ^ x>>31
}

func unit(h uint64) float64 { return float64(h>>11) / float64(1<<53) }

// DefensePlan says whether town i's ward weakens on night n and when the
// attack starts (world time). Spec 8: on some nights a town's ward weakens
// and demons attack.
func (w *World) DefensePlan(i int, n int64) (start float64, ok bool) {
	h := h64(w.Seed, 0x646566656e7365, uint64(i), uint64(n))
	if unit(h) >= constants.DefenseChance*w.Scale(n) {
		return 0, false
	}
	// One to four hours after dusk (an in-game hour is 150 s).
	return weather.NightStart(n) + (1+3*unit(h64(h, 1, 2, 3)))*float64(constants.DayLengthS)/24, true
}

// SpawnAngle is the seeded direction (radians) a pack tries first.
func (w *World) SpawnAngle(nightIdx int64, player uint32, n int) float64 {
	return unit(h64(w.Seed, uint64(nightIdx), uint64(player), uint64(n))) * 2 * math.Pi
}

// SpawnDistance is the seeded distance a pack rises at.
func (w *World) SpawnDistance(nightIdx int64, player uint32, n int) float64 {
	u := unit(h64(w.Seed^0x64, uint64(nightIdx), uint64(player), uint64(n)))
	return constants.DemonSpawnMinM + u*(constants.DemonSpawnMaxM-constants.DemonSpawnMinM)
}

// GreaterChance is the chance a top-up also raises a greater demon.
func (w *World) GreaterChance(nightIdx int64) float64 { return 0.12 * w.Scale(nightIdx) }

// Roll is a seeded uniform in [0, 1) for (night, a, b).
func (w *World) Roll(nightIdx int64, a, b uint64) float64 {
	return unit(h64(w.Seed^0x726f6c6c, uint64(nightIdx), a, b))
}

// GreaterFor is the greater demon of a region element.
func GreaterFor(element int) string {
	g := combatdefs.D.Demons.Greater
	if element < 0 || element >= len(g) {
		return g[int(uint(element))%len(g)]
	}
	return g[element]
}

// Wave is one defense wave's composition: lesser demons, plus a greater
// one on the last wave, more for more defenders.
func Wave(wave, defenders int, element int) []string {
	n := 3 + 2*wave + 2*max(0, defenders-1)
	keys := make([]string, 0, n+1)
	for i := 0; i < n; i++ {
		keys = append(keys, combatdefs.D.Demons.Lesser[i%len(combatdefs.D.Demons.Lesser)])
	}
	if wave == constants.DefenseWaves {
		keys = append(keys, GreaterFor(element))
	}
	return keys
}

// WaveGates are the points on the ward's edge a wave comes from (2 or 3
// seeded directions).
func (w *World) WaveGates(t *Town, nightIdx int64, wave int) [][2]float64 {
	n := 2 + int(h64(w.Seed, uint64(t.Index), uint64(nightIdx), uint64(wave))%2)
	a0 := w.Roll(nightIdx, uint64(t.Index)<<8|uint64(wave), 7) * 2 * math.Pi
	r := t.WardRadius() + 6
	out := make([][2]float64, n)
	for i := range out {
		a := a0 + float64(i)*2*math.Pi/float64(n)
		out[i] = [2]float64{t.X + r*math.Cos(a), t.Z + r*math.Sin(a)}
	}
	return out
}
