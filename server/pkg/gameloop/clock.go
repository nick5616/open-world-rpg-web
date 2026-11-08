package gameloop

import "time"

var processStart = time.Now()

func portableNow() int64 { return int64(time.Since(processStart)) }

// Now returns the scheduler's monotonic clock in nanoseconds since process
// start. Use it (not time.Now) when measuring sub-millisecond intervals; see
// clock_windows.go for why.
func Now() time.Duration { return time.Duration(monoNow()) }
