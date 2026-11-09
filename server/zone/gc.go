package main

// Garbage collector pacing for the zone (G5, 4 vCPU follow-up;
// docs/decisions/v1-capacity.md).
//
// A crowded zone allocates ~30-45 MB/s (WebSocket read/write contexts and
// buffers, snapshot copies) on a live heap of ~400-700 MB (snapshot
// baselines), so at Go's default GOGC=100 it collected every ~15 s. Each
// cycle's mark phase takes one of the four Ps (and, on a 4 vCPU slice, a
// hyperthread whose sibling runs a tick worker) for tens of milliseconds:
// a few slow ticks per cycle, enough to sit in a 60 s window's p99. At
// GOGC=300 the zone collects about a third as often; the soft memory limit
// keeps a much larger zone from growing to 4x its live heap (the collector
// runs earlier as the heap nears the limit).
//
//	LODESTONE_ZONE_GOGC         default 300 (ignored when GOGC is set)
//	LODESTONE_ZONE_MEMLIMIT_MB  default 3072 (ignored when GOMEMLIMIT is set; 0 = none)

import (
	"log/slog"
	"os"
	"runtime/debug"
	"strconv"

	"lodestone/server/pkg/env"
)

const (
	defaultGOGC       = 300
	defaultMemLimitMB = 3072
)

// tuneGC applies the zone's GC defaults unless the standard Go variables
// say otherwise.
func tuneGC(log *slog.Logger) {
	gogc, limit := "env", "env"
	if os.Getenv("GOGC") == "" {
		p := env.Int("LODESTONE_ZONE_GOGC", defaultGOGC)
		debug.SetGCPercent(p)
		gogc = strconv.Itoa(p)
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		if mb := env.Int("LODESTONE_ZONE_MEMLIMIT_MB", defaultMemLimitMB); mb > 0 {
			debug.SetMemoryLimit(int64(mb) << 20)
			limit = strconv.Itoa(mb) + " MiB"
		} else {
			limit = "none"
		}
	}
	log.Info("gc", "gogc", gogc, "memlimit", limit)
}
