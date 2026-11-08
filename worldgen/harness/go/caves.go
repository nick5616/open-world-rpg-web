package harness

// Cave exports (WP09): cave_graph, cave_build, cave_build_edited, cave_mask.
// The collision vectors of the golden table are checked by the Go port of
// the cave queries in server/pkg/caves (TestGoldenCaveQueries); this host
// checks the generator's bytes.

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/tetratelabs/wazero/api"
)

func (h *Host) fnFor(name string) {
	if _, ok := h.fn[name]; ok {
		return
	}
	if f := h.mod.ExportedFunction(name); f != nil {
		h.fn[name] = f
	}
}

func (h *Host) result(ctx context.Context, p uint64) ([]byte, error) {
	if p == 0 {
		return nil, h.lastError(ctx)
	}
	return h.read(uint32(p), uint32(h.call(ctx, "result_len"))), nil
}

// CaveGraph returns a copy of the world's cave graph buffer.
func (h *Host) CaveGraph(ctx context.Context, atlas uint32) ([]byte, error) {
	h.fnFor("cave_graph")
	return h.result(ctx, h.call(ctx, "cave_graph", uint64(atlas)))
}

// CaveEdit is one carve + mined vein (README "Caves", edit records).
type CaveEdit struct {
	VeinID     uint64
	X, Y, Z, R float32
}

// CaveBuild returns a copy of cave cell (cx, cy, cz), with edits when given.
func (h *Host) CaveBuild(ctx context.Context, atlas uint32, cx, cy, cz int32, edits []CaveEdit) ([]byte, error) {
	if len(edits) == 0 {
		h.fnFor("cave_build")
		return h.result(ctx, h.call(ctx, "cave_build", uint64(atlas), api.EncodeI32(cx), api.EncodeI32(cy), api.EncodeI32(cz)))
	}
	h.fnFor("cave_build_edited")
	b := make([]byte, 32*len(edits))
	for i, e := range edits {
		o := i * 32
		binary.LittleEndian.PutUint64(b[o:], e.VeinID)
		binary.LittleEndian.PutUint32(b[o+8:], math.Float32bits(e.X))
		binary.LittleEndian.PutUint32(b[o+12:], math.Float32bits(e.Y))
		binary.LittleEndian.PutUint32(b[o+16:], math.Float32bits(e.Z))
		binary.LittleEndian.PutUint32(b[o+20:], math.Float32bits(e.R))
	}
	p := uint32(h.call(ctx, "alloc", uint64(len(b))))
	defer h.call(ctx, "free", uint64(p), uint64(len(b)))
	h.mod.Memory().Write(p, b)
	return h.result(ctx, h.call(ctx, "cave_build_edited", uint64(atlas), api.EncodeI32(cx), api.EncodeI32(cy), api.EncodeI32(cz), uint64(p), uint64(len(b))))
}

// CaveMask returns a copy of the mouth mask of overworld chunk (cx, cz).
func (h *Host) CaveMask(ctx context.Context, atlas uint32, cx, cz int32) ([]byte, error) {
	h.fnFor("cave_mask")
	return h.result(ctx, h.call(ctx, "cave_mask", uint64(atlas), api.EncodeI32(cx), api.EncodeI32(cz)))
}

type goldenCaves struct {
	Graph struct {
		Hash string `json:"hash"`
	} `json:"graph"`
	Cells []struct {
		Cx, Cy, Cz int32
		Tag, Hash  string
	} `json:"cells"`
	Edited []struct {
		Cx, Cy, Cz int32
		RawEdits   []map[string]any `json:"edits"`
		Hash       string           `json:"hash"`
	} `json:"edited"`
	Masks []struct {
		Cx, Cz int32
		Hash   string
	} `json:"masks"`
}

type caveCounters struct {
	cells, masks, graphs int
	maxMs                float64
}

// lastCaves holds the counters of the most recent check (tests run serially).
var lastCaves caveCounters

func checkCaves(ctx context.Context, h *Host, label string, atlas uint32, g *goldenCaves, maxCells int, st *caveCounters) (fails []string) {
	gb, err := h.CaveGraph(ctx, atlas)
	if err != nil {
		return []string{fmt.Sprintf("%s: cave_graph: %v", label, err)}
	}
	if s := fmt.Sprintf("%016x", FNV1a64(gb)); s != g.Graph.Hash {
		fails = append(fails, fmt.Sprintf("%s: cave graph %s != %s", label, s, g.Graph.Hash))
	} else {
		st.graphs++
	}
	for i, c := range g.Cells {
		if maxCells > 0 && i >= maxCells {
			break
		}
		t0 := time.Now()
		b, err := h.CaveBuild(ctx, atlas, c.Cx, c.Cy, c.Cz, nil)
		st.maxMs = math.Max(st.maxMs, float64(time.Since(t0).Microseconds())/1000)
		if err != nil {
			fails = append(fails, fmt.Sprintf("%s: cave (%d,%d,%d): %v", label, c.Cx, c.Cy, c.Cz, err))
			continue
		}
		if s := fmt.Sprintf("%016x", FNV1a64(b)); s != c.Hash {
			fails = append(fails, fmt.Sprintf("%s: cave (%d,%d,%d) %s %s != %s", label, c.Cx, c.Cy, c.Cz, c.Tag, s, c.Hash))
			continue
		}
		st.cells++
	}
	for _, e := range g.Edited {
		var edits []CaveEdit
		for _, m := range e.RawEdits {
			id, _ := strconv.ParseUint(m["veinId"].(string), 10, 64)
			edits = append(edits, CaveEdit{VeinID: id, X: float32(m["x"].(float64)), Y: float32(m["y"].(float64)), Z: float32(m["z"].(float64)), R: float32(m["r"].(float64))})
		}
		b, err := h.CaveBuild(ctx, atlas, e.Cx, e.Cy, e.Cz, edits)
		if err != nil {
			fails = append(fails, fmt.Sprintf("%s: edited cave: %v", label, err))
			continue
		}
		if s := fmt.Sprintf("%016x", FNV1a64(b)); s != e.Hash {
			fails = append(fails, fmt.Sprintf("%s: edited cave (%d,%d,%d) %s != %s", label, e.Cx, e.Cy, e.Cz, s, e.Hash))
			continue
		}
		st.cells++
	}
	for _, m := range g.Masks {
		b, err := h.CaveMask(ctx, atlas, m.Cx, m.Cz)
		if err != nil {
			fails = append(fails, fmt.Sprintf("%s: cave_mask: %v", label, err))
			continue
		}
		if s := fmt.Sprintf("%016x", FNV1a64(b)); s != m.Hash {
			fails = append(fails, fmt.Sprintf("%s: cave mask (%d,%d) %s != %s", label, m.Cx, m.Cz, s, m.Hash))
			continue
		}
		st.masks++
	}
	return fails
}
