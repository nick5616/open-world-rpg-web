package weather

// The world clock (WP15, CR 011). Spec 8: "Day, night and weather are
// functions of world time and the seed, so they need no sync beyond the
// clock." One clock feeds the zone (demons, NPC schedules, rain, the
// chemistry wind) and every client (sky, sun and moon, rain, the fire
// simulation): world time is the protocol's server clock plus a per-world
// offset the zone announces (Event 500 world_clock), so a dev zone started
// with LODESTONE_ZONE_TIME_OFFSET_S shows night in the sky and in its NPCs
// alike. The TS twin is client/src/systems/clock.ts; both replay
// testdata/clock_vectors.json.
//
// Everything a simulation depends on is integer arithmetic on whole steps
// or a comparison of one float division, so JS and Go agree to the bit.

import (
	"math"

	"lodestone/server/pkg/constants"
)

// Clock is a world's clock: its seed and the offset added to the server
// clock (seconds).
type Clock struct {
	Seed    uint64
	OffsetS float64
}

// WorldTime is world time in seconds at a server time (Unix ms).
func (c Clock) WorldTime(serverTimeMs float64) float64 { return serverTimeMs/1000 + c.OffsetS }

const hourS = float64(constants.DayLengthS) / 24

// TimeOfDayS is seconds into the in-game day (0 = midnight) at world time t.
func TimeOfDayS(t float64) float64 {
	d := math.Mod(t, constants.DayLengthS)
	if d < 0 {
		d += constants.DayLengthS
	}
	return d
}

// Hour is the hour of the in-game day (0..24) at world time t.
func Hour(t float64) float64 { return TimeOfDayS(t) / hourS }

// Day is the in-game day number at world time t.
func Day(t float64) int64 { return int64(math.Floor(t / constants.DayLengthS)) }

// IsNight reports demon time: from DUSK_HOUR to DAWN_HOUR.
func IsNight(t float64) bool {
	h := Hour(t)
	return h >= constants.DuskHour || h < constants.DawnHour
}

// NightIndex is the night that ends at the next dawn: night n runs from dusk
// of day n to dawn of day n + 1 (during the day it is tonight's index).
func NightIndex(t float64) int64 {
	return int64(math.Floor((t - constants.DawnHour*hourS) / constants.DayLengthS))
}

// NightStart is the world time night n's dusk falls.
func NightStart(n int64) float64 {
	return float64(n)*constants.DayLengthS + constants.DuskHour*hourS
}

// NightEnd is the world time night n's dawn breaks.
func NightEnd(n int64) float64 {
	return float64(n+1)*constants.DayLengthS + constants.DawnHour*hourS
}

// MoonOffset seeds where in the 8-night cycle night 0 falls.
func MoonOffset(seed uint64) int64 {
	return int64(Hash(seed^0x6d6f6f6e, 0x4d4f4f4e) % constants.MoonCycleNights)
}

// MoonPhase is night n's phase: 0 = new moon (the worst nights), 4 = full.
func MoonPhase(seed uint64, n int64) int {
	return int(floorMod(n+MoonOffset(seed), constants.MoonCycleNights))
}

// moonDemons scales demon numbers by phase (spec 8: a seeded 8-night moon
// cycle sets how many; new-moon nights are the worst).
var moonDemons = [constants.MoonCycleNights]float64{1, 0.85, 0.65, 0.5, 0.35, 0.5, 0.65, 0.85}

// MoonDemonFactor is the phase's demon multiplier (1 at new moon).
func MoonDemonFactor(phase int) float64 {
	return moonDemons[floorMod(int64(phase), constants.MoonCycleNights)]
}

// MoonIllumination is the lit fraction of the moon (0 new .. 1 full).
func MoonIllumination(phase int) float64 {
	return (1 - math.Cos(2*math.Pi*float64(phase)/constants.MoonCycleNights)) / 2
}

// IsLordNight reports a night demon lords roam (new moon).
func IsLordNight(phase int) bool { return phase == 0 }

// ---- the chemistry clock: whole steps ----

// Step is the chemistry step at world time t (CHEM_STEP_HZ).
func Step(t float64) int64 { return int64(math.Floor(t * constants.ChemStepHz)) }

// RainingAtStep is the weather at a chemistry step: the same seeded
// windows as IsRaining, computed on whole steps.
func RainingAtStep(seed uint64, step int64) bool {
	return Hash(seed, floorDiv(step, int64(constants.WeatherStubWindowS)*constants.ChemStepHz))%100 < constants.WeatherStubRainPct
}

// Wind is the chemistry wind: where it blows from in 45-degree sectors
// (0 = from the north, -z; 2 = from the east, +x), the unit-ish vector it
// blows toward (each component -1, 0 or 1) and a strength 1..3.
type Wind struct {
	Sector   int
	DX, DZ   int
	Strength int
}

// windToward[s] is the direction a wind from sector s blows toward:
// (-round(sin a), round(cos a)) for a = 45 s degrees, client/src/world/wind.ts's convention.
var windToward = [8][2]int{{0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}, {1, 0}, {1, 1}}

// WindAt is the chemistry wind at a step: the WorldSpec's prevailing
// direction (degrees it blows from) veering by up to one sector and
// changing strength every CHEM_WIND_WINDOW_S, seeded. One wind field drives
// the grass (the client sets the shader's wind from it) and the fire.
func WindAt(seed uint64, prevailingDeg int, step int64) Wind {
	h := Hash(seed^0x77696e64, floorDiv(step, int64(constants.ChemWindWindowS)*constants.ChemStepHz))
	base := int(floorMod(int64(prevailingDeg*2+45)/90, 8))
	s := int(floorMod(int64(base+int(h%3)-1), 8))
	return Wind{Sector: s, DX: windToward[s][0], DZ: windToward[s][1], Strength: 1 + int((h>>8)%3)}
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func floorMod(a, b int64) int64 { return a - floorDiv(a, b)*b }
