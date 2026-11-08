// Package weather is WP10's deterministic weather stub until the
// night/chemistry package (WP15) owns weather. Spec 8: day, night and weather
// are functions of world time and the seed, so they need no sync beyond the
// clock. Movement needs one bit (rain halves climb speed and makes climbers
// slip), so world time is cut into WEATHER_STUB_WINDOW_S windows and each
// window rains when a 32-bit hash of (seed, window) lands in the first
// WEATHER_STUB_RAIN_PCT percent. The TS twin is client/src/sim/weather.ts;
// both test the same vectors.
package weather

import (
	"math"

	"lodestone/server/pkg/constants"
)

// WorldTimeS is world time in seconds from the protocol's server clock (Unix ms).
func WorldTimeS(serverTimeMs float64) float64 { return serverTimeMs / 1000 }

// Hash is murmur3's fmix32 over (seed lo, seed hi, window) in u32 arithmetic.
func Hash(seed uint64, window int64) uint32 {
	lo, hi := uint32(seed), uint32(seed>>32)
	h := lo ^ hi*0x9e3779b1 ^ uint32(window)*0x85ebca6b
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

// IsRaining reports rain in the world with this seed at world time t (s).
func IsRaining(seed uint64, t float64) bool {
	window := int64(math.Floor(t / constants.WeatherStubWindowS))
	return Hash(seed, window)%100 < constants.WeatherStubRainPct
}
