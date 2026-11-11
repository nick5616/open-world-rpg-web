package main

// Cave wiring for the zone (WP09): wrap the terrain in a cave-aware ground,
// configure mining (respawn window, edit persistence), restore persisted
// edits at startup and expose /debug/caves. Its own file so main.go gains
// a few lines only.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
)

// withCaves wraps the terrain in worldhost.CaveTerrain (cave floors, walls,
// mouth holes, the vein registry). A wasm built before WP09 has no cave
// exports: the zone then keeps the plain heightfield and logs why.
func withCaves(ground movement.Ground, terrain *worldhost.Terrain, log *slog.Logger) (movement.Ground, *worldhost.CaveTerrain) {
	if terrain == nil {
		return ground, nil
	}
	start := time.Now()
	cv, err := worldhost.NewCaves(terrain.World(), worldhost.CaveOptions{
		Capacity: env.Int("LODESTONE_ZONE_CAVE_CACHE", 0),
		Workers:  env.Int("LODESTONE_ZONE_CAVE_WORKERS", 0),
	})
	if err != nil {
		log.Warn("NO CAVES: cave graph unavailable; players walk the heightfield only", "err", err)
		return ground, nil
	}
	ct := worldhost.NewCaveTerrain(terrain, ground, cv) // caves under the surface (terrain + WP12 towers)
	g := cv.Graph
	log.Info("caves ready", "systems", len(g.Systems), "chambers", len(g.Chambers), "openings", len(g.OpeningsList), "veins", len(g.Veins), "ms", time.Since(start).Milliseconds())
	withVertical(ct, terrain, log)
	return ct, ct
}

// miningConfig fills the mining part of game.Config from env:
//
//	LODESTONE_ZONE_VEIN_RESPAWN_MIN / _MAX  respawn window (default 6h / 24h, spec 7)
func miningConfig(cfg *game.Config, pool *pgxpool.Pool) {
	cfg.VeinRespawnMin = env.Duration("LODESTONE_ZONE_VEIN_RESPAWN_MIN", 6*time.Hour)
	cfg.VeinRespawnMax = env.Duration("LODESTONE_ZONE_VEIN_RESPAWN_MAX", 24*time.Hour)
	if pool != nil {
		cfg.EditStore = &game.PGEditStore{Pool: pool}
	}
}

// restoreEdits re-applies persisted vein edits before the zone starts
// ticking, so a restart never respawns a vein early.
func restoreEdits(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := zone.RestoreEdits(rctx)
	if err != nil {
		log.Warn("world edits not restored", "err", err)
		return
	}
	if n > 0 {
		log.Info("world edits restored", "veinsMined", n)
	}
}

// serveCaves: GET /debug/caves (cache counters + mining state) and metrics.
func serveCaves(ctx context.Context, s *svc.Server, ct *worldhost.CaveTerrain, zone *game.Server) {
	s.Mux.HandleFunc("GET /debug/caves", func(w http.ResponseWriter, r *http.Request) {
		mctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		ms, err := zone.MiningStatus(mctx)
		w.Header().Set("Content-Type", "application/json")
		out := map[string]any{"cache": ct.CaveStats(), "mining": ms}
		if err != nil {
			out["error"] = err.Error()
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	go func() {
		tk := time.NewTicker(2 * time.Second)
		defer tk.Stop()
		for {
			st := ct.CaveStats()
			s.Metrics.SetInt("zone_cave_cells", int64(st.Cells))
			s.Metrics.SetInt("zone_cave_edits", int64(st.Edits))
			s.Metrics.SetInt(`zone_cave_builds_total{path="worker"}`, st.Built-st.Sync)
			s.Metrics.SetInt(`zone_cave_builds_total{path="sync"}`, st.Sync)
			s.Metrics.SetFloat("zone_cave_build_ms_mean", st.BuildMeanMs)
			s.Metrics.SetFloat("zone_cave_build_ms_max", st.BuildMaxMs)
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
			}
		}
	}()
}

// withVertical puts the vertical world (genVersion 3, CR 038: sky islands,
// the Underground, the Depths) on the cave terrain. LODESTONE_ZONE_NO_VERTICAL=1
// turns it off; LODESTONE_ZONE_LAYER_CACHE / _LAYER_WORKERS tune the LOD 0
// layer tile cache. A wasm before genVersion 3 has no vertical exports: the
// zone logs NO VERTICAL and keeps the caves.
func withVertical(ct *worldhost.CaveTerrain, terrain *worldhost.Terrain, log *slog.Logger) {
	if env.Bool("LODESTONE_ZONE_NO_VERTICAL", false) {
		log.Warn("vertical world off (LODESTONE_ZONE_NO_VERTICAL)")
		return
	}
	start := time.Now()
	l, err := ct.WithVertical(env.Int("LODESTONE_ZONE_LAYER_CACHE", 0), env.Int("LODESTONE_ZONE_LAYER_WORKERS", 0))
	if err != nil {
		log.Warn("NO VERTICAL: no sky islands, Underground or Depths on this world", "err", err)
		return
	}
	h := terrain.World().Header
	if err := l.Ensure(float64(h.SpawnX), float64(h.SpawnZ), 64); err != nil {
		log.Warn("vertical warm-up failed", "err", err)
	}
	v := l.Vert
	log.Info("vertical ready", "islands", len(v.Islands), "archipelagos", len(v.Archs), "chambers", len(v.Chambers), "corridors", len(v.Corridors),
		"openings", len(v.Openings), "updrafts", len(v.Updrafts), "veins", len(v.Veins), "ms", time.Since(start).Milliseconds())
}

// serveVertical: GET /debug/vertical (layer tile cache + counts).
func serveVertical(s *svc.Server, ct *worldhost.CaveTerrain) {
	s.Mux.HandleFunc("GET /debug/vertical", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		out := map[string]any{"enabled": ct.Layers != nil}
		if ct.Layers != nil {
			v := ct.Layers.Vert
			out["cache"] = ct.Layers.Stats()
			out["counts"] = map[string]int{"islands": len(v.Islands), "archipelagos": len(v.Archs), "chambers": len(v.Chambers), "corridors": len(v.Corridors),
				"openings": len(v.Openings), "shafts": len(v.Shafts), "columns": len(v.Columns), "updrafts": len(v.Updrafts), "veins": len(v.Veins), "decos": len(v.Decos)}
		}
		_ = json.NewEncoder(w).Encode(out)
	})
}
