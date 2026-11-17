package main

// World edits wiring for the zone (playtest 3, CR 040): the terrain edit
// overlay on the terrain every ground query goes through, the scatter record
// lookup, the dig planner's world (protected ground mask) and persistence.
// Its own file so main.go gains a few lines.
//
//	LODESTONE_ZONE_NO_WORLD_EDITS=1   turn chopping, breaking and digging off
//	LODESTONE_ZONE_REGROW_SCALE       multiplies regrow times (default 1; evidence runs shorten it)

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldedit"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
)

// terrainScatter answers scatter record lookups from the terrain cache
// (chunks near players are cached: the zone wants them).
type terrainScatter struct{ t *worldhost.Terrain }

func (s terrainScatter) ScatterRecord(id uint64) (game.ScatterRec, bool) {
	_, cx, cz, _ := worldedit.ScatterID(id)
	if cx < 0 || cz < 0 || cx > 63 || cz > 63 {
		return game.ScatterRec{}, false
	}
	ch, ok := s.t.Chunk(cx, cz)
	if !ok {
		return game.ScatterRec{}, false
	}
	for _, r := range ch.Scatter {
		if r.ID == id {
			layer, _, _, _ := worldedit.ScatterID(id)
			return game.ScatterRec{ID: id, X: float64(r.X), Y: float64(r.Y), Z: float64(r.Z), Layer: layer, Kind: r.Kind, Variant: r.Variant, Scale: r.Extra, Yaw: r.Yaw}, true
		}
	}
	return game.ScatterRec{}, false
}

// protectMask is a bit grid of 4 m cells over the world: set where terrain
// must not be edited (settlements and their roads, sites, structures, cave
// roofs and mouths, tunnel and cenote openings).
type protectMask struct{ bits []uint64 }

const (
	maskCell  = 4
	maskCells = 4096 / maskCell
)

func newProtectMask() *protectMask { return &protectMask{bits: make([]uint64, maskCells*maskCells/64)} }

func (m *protectMask) set(cx, cz int) {
	if cx < 0 || cz < 0 || cx >= maskCells || cz >= maskCells {
		return
	}
	i := cz*maskCells + cx
	m.bits[i>>6] |= 1 << (uint(i) & 63)
}

func (m *protectMask) disc(x, z, r float64) {
	x0, x1 := int(math.Floor((x-r)/maskCell)), int(math.Floor((x+r)/maskCell))
	z0, z1 := int(math.Floor((z-r)/maskCell)), int(math.Floor((z+r)/maskCell))
	for cz := z0; cz <= z1; cz++ {
		for cx := x0; cx <= x1; cx++ {
			// nearest point of the cell to the centre
			nx := math.Max(float64(cx*maskCell), math.Min(x, float64((cx+1)*maskCell)))
			nz := math.Max(float64(cz*maskCell), math.Min(z, float64((cz+1)*maskCell)))
			if math.Hypot(nx-x, nz-z) <= r {
				m.set(cx, cz)
			}
		}
	}
}

func (m *protectMask) line(x0, z0, x1, z1, r float64) {
	n := int(math.Ceil(math.Hypot(x1-x0, z1-z0) / 2))
	for i := 0; i <= max(n, 1); i++ {
		t := float64(i) / float64(max(n, 1))
		m.disc(x0+(x1-x0)*t, z0+(z1-z0)*t, r)
	}
}

func (m *protectMask) blocked(x, z int32) bool {
	cx, cz := int(x)>>2, int(z)>>2
	if cx < 0 || cz < 0 || cx >= maskCells || cz >= maskCells {
		return true // outside the world
	}
	i := cz*maskCells + cx
	return m.bits[i>>6]&(1<<(uint(i)&63)) != 0
}

// roofM: a cave whose ceiling is within this of the surface protects the
// ground above it (a dig lowers up to 6 m, its slope cascade a few more).
const roofM = 24

// editWorld is the dig planner's view of the generated world.
type editWorld struct {
	t    *worldhost.Terrain
	mask *protectMask
}

func (w *editWorld) Base(x, z int32) float32  { return w.t.BaseLattice(x, z) }
func (w *editWorld) Water(x, z int32) float64 { return w.t.WaterAt(float64(x), float64(z)) }
func (w *editWorld) Allowed(x, z int32) bool  { return !w.mask.blocked(x, z) }

// buildProtectMask rasterizes what must not be edited. Anything that cannot
// be read (an old wasm without towns or caves) just protects less.
func buildProtectMask(terrain *worldhost.Terrain, ct *worldhost.CaveTerrain, log *slog.Logger) *protectMask {
	m := newProtectMask()
	wd := terrain.World()
	if a, err := structures.ParseAtlas(wd.Atlas); err == nil {
		for _, s := range a.Sites {
			if s.Layer != 0 {
				continue
			}
			m.disc(s.X, s.Z, math.Max(s.Radius, 6)+6)
		}
	}
	if b, err := wd.TownsBytes(); err == nil {
		if tw, err := towns.Parse(b); err == nil {
			for _, s := range tw.Settlements {
				m.disc(s.X, s.Z, math.Max(s.Radius, s.WallR)+12)
			}
			for _, r := range tw.Roads {
				for i := 0; i+1 < len(r.Points); i++ {
					p, q := r.Points[i], r.Points[i+1]
					m.line(p[0], p[2], q[0], q[2], r.Width/2+5)
				}
			}
			for _, st := range tw.Structures {
				m.disc(st.X, st.Z, st.Radius+8)
			}
		}
	}
	if ct != nil && ct.Caves != nil && ct.Caves.Graph != nil {
		g := ct.Caves.Graph
		surf := func(x, z float64) float64 { return terrain.HeightAt(x, z) }
		for _, c := range g.Chambers {
			if surf(c.X, c.Z)-(c.Y+c.RY) < roofM {
				m.disc(c.X, c.Z, c.RX+6)
			}
		}
		for _, t := range g.TunnelsList {
			for sg := 0; sg < 3; sg++ {
				p := &t.Pts
				ay, by := p[sg*3+1]/t.Stretch, p[sg*3+4]/t.Stretch
				if surf(p[sg*3], p[sg*3+2])-(math.Max(ay, by)+t.R) < roofM {
					m.line(p[sg*3], p[sg*3+2], p[sg*3+3], p[sg*3+5], t.R+6)
				}
			}
		}
		for _, o := range g.OpeningsList {
			m.disc(o.X, o.Z, math.Max(o.RMask, o.RZone)+8)
		}
		if ct.Layers != nil && ct.Layers.Vert != nil {
			for _, o := range ct.Layers.Vert.SurfaceOpenings {
				m.disc(o.X, o.Z, o.R+8)
			}
		}
	}
	return m
}

// withWorldEdits fills cfg.WorldEdit and installs the overlay on the terrain.
func withWorldEdits(cfg *game.Config, terrain *worldhost.Terrain, ct *worldhost.CaveTerrain, pool *pgxpool.Pool, log *slog.Logger) {
	if terrain == nil || env.Bool("LODESTONE_ZONE_NO_WORLD_EDITS", false) {
		return
	}
	start := time.Now()
	ov := worldedit.New()
	terrain.SetEdits(ov)
	setup := &game.WorldEditSetup{
		Overlay:     ov,
		Scatter:     terrainScatter{terrain},
		Plan:        &editWorld{t: terrain, mask: buildProtectMask(terrain, ct, log)},
		RegrowScale: env.Float("LODESTONE_ZONE_REGROW_SCALE", 1),
	}
	if pool != nil {
		setup.Store = &game.PGEditStore{Pool: pool}
	}
	cfg.WorldEdit = setup
	log.Info("world edits ready", "ms", time.Since(start).Milliseconds())
}

// restoreWorldEdits brings removed objects and dug terrain back before the zone ticks.
func restoreWorldEdits(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	objs, blocks, err := zone.RestoreWorldEdits(rctx)
	if err != nil {
		log.Warn("world edits not restored", "err", err)
		return
	}
	if objs+blocks > 0 {
		log.Info("world edits restored", "objects", objs, "terrainChunks", blocks)
	}
}

// serveWorldEdits: GET /debug/worldedits (counters).
func serveWorldEdits(s *svc.Server, zone *game.Server) {
	s.Mux.HandleFunc("GET /debug/worldedits", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		st, err := zone.WorldEditStatus(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(st)
	})
}
