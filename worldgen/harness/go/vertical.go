package harness

// Vertical world exports (genVersion 3, CR 038): vertical_build, layer_tile
// and layer_height. The floor / collide / updraft vectors of the golden
// table are replayed by the Go port of the queries in server/pkg/vertical
// (TestGoldenVerticalQueries); this host checks the generator's bytes, the
// tiles and the heights.

import (
	"context"
	"fmt"
	"math"
)

type goldenVertical struct {
	Hash  string `json:"hash"`
	Bytes int    `json:"bytes"`
	Tiles []struct {
		Layer, Cx, Cz, Lod int32
		Hash               string
	} `json:"tiles"`
	Heights []struct {
		Surf int32   `json:"surf"`
		X    float64 `json:"x"`
		Z    float64 `json:"z"`
		H    string  `json:"h"`
	} `json:"heights"`
}

type verticalCounters struct {
	worlds, tiles, heights int
}

var lastVertical verticalCounters

func checkVertical(ctx context.Context, h *Host, label string, atlas uint32, g *goldenVertical, st *verticalCounters) []string {
	var fails []string
	h.fnFor("vertical_build")
	b, err := h.result(ctx, h.call(ctx, "vertical_build", uint64(atlas)))
	if err != nil {
		return []string{fmt.Sprintf("%s: vertical_build: %v", label, err)}
	}
	if s := fmt.Sprintf("%016x", FNV1a64(b)); s != g.Hash {
		fails = append(fails, fmt.Sprintf("%s: vertical %s != %s", label, s, g.Hash))
	}
	if len(b) != g.Bytes {
		fails = append(fails, fmt.Sprintf("%s: vertical %d bytes != %d", label, len(b), g.Bytes))
	}
	h.fnFor("layer_tile")
	for _, t := range g.Tiles {
		tb, err := h.result(ctx, h.call(ctx, "layer_tile", uint64(atlas), uint64(uint32(t.Layer)), uint64(uint32(t.Cx)), uint64(uint32(t.Cz)), uint64(uint32(t.Lod))))
		if err != nil {
			fails = append(fails, fmt.Sprintf("%s: layer_tile: %v", label, err))
			continue
		}
		if s := fmt.Sprintf("%016x", FNV1a64(tb)); s != t.Hash {
			fails = append(fails, fmt.Sprintf("%s: layer tile (%d,%d,%d,lod%d) %s != %s", label, t.Layer, t.Cx, t.Cz, t.Lod, s, t.Hash))
		}
		st.tiles++
	}
	h.fnFor("layer_height")
	for _, p := range g.Heights {
		r := h.call(ctx, "layer_height", uint64(atlas), uint64(uint32(p.Surf)), math.Float64bits(p.X), math.Float64bits(p.Z))
		if s := fmt.Sprintf("%016x", r); s != p.H {
			fails = append(fails, fmt.Sprintf("%s: layer_height(%d, %v, %v) %s != %s", label, p.Surf, p.X, p.Z, s, p.H))
		}
		st.heights++
	}
	if len(fails) == 0 {
		st.worlds++
	}
	return fails
}
