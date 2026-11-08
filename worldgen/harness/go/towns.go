package harness

// Towns export (WP20): towns_build. The building collision vectors of the
// golden table are replayed by the Go port of the queries in
// server/pkg/towns (TestGoldenTownQueries); this host checks the
// generator's bytes and their size.

import (
	"context"
	"fmt"
	"time"
)

type goldenTowns struct {
	Hash  string `json:"hash"`
	Bytes int    `json:"bytes"`
}

type townCounters struct {
	worlds int
	maxMs  float64
}

var lastTowns townCounters

// TownsBuild returns a copy of the world's towns buffer.
func (h *Host) TownsBuild(ctx context.Context, atlas uint32) ([]byte, error) {
	h.fnFor("towns_build")
	return h.result(ctx, h.call(ctx, "towns_build", uint64(atlas)))
}

func checkTowns(ctx context.Context, h *Host, label string, atlas uint32, g *goldenTowns, st *townCounters) []string {
	t0 := time.Now()
	b, err := h.TownsBuild(ctx, atlas)
	if ms := float64(time.Since(t0).Microseconds()) / 1000; ms > st.maxMs {
		st.maxMs = ms
	}
	if err != nil {
		return []string{fmt.Sprintf("%s: towns_build: %v", label, err)}
	}
	var fails []string
	if s := fmt.Sprintf("%016x", FNV1a64(b)); s != g.Hash {
		fails = append(fails, fmt.Sprintf("%s: towns %s != %s", label, s, g.Hash))
	}
	if len(b) != g.Bytes {
		fails = append(fails, fmt.Sprintf("%s: towns %d bytes != %d", label, len(b), g.Bytes))
	}
	if len(fails) == 0 {
		st.worlds++
	}
	return fails
}
