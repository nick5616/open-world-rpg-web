//go:build !windows

package gameloop

// Elsewhere Go's monotonic clock is clock_gettime(CLOCK_MONOTONIC) with
// nanosecond resolution, so the portable clock is already precise.
func monoNow() int64 { return portableNow() }

// PreciseClock reports which clock the scheduler spins on (for evidence).
const PreciseClock = "time.Now (CLOCK_MONOTONIC)"
