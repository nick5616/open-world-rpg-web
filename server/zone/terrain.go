package main

// Terrain wiring for the zone (WP07): load worldgen.wasm, open the world the
// zone serves with its genVersion pin, and hand the game a ground backed by
// the chunk cache. Kept in its own file so main.go only gains a few lines.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
)

// loadTerrain returns the ground the zone simulates on and the world as it
// will be announced (Welcome carries its seed and genVersion).
//
//   - worldgen.wasm missing: flat ground (WP03 behavior) with a loud warning,
//     unless LODESTONE_ZONE_REQUIRE_TERRAIN=1 or LODESTONE_ENV=production,
//     where it is fatal. A client would render hills the server doesn't
//     have, so this is a dev-only fallback.
//   - placeholder world row (seeded before minting existed): opened from
//     spec_from_seed(seed), exactly what minting stores; the account service
//     mints the row on its next start (or run server/pkg/cmd/mintworld).
//   - minted row: gen_version must match the wasm and the rebuilt atlas must
//     match atlas_hash, else the zone refuses to start (spec 5 rule 6: a
//     world never shifts under its players).
func loadTerrain(ctx context.Context, w game.World, log *slog.Logger) (movement.Ground, *worldhost.Terrain, game.World, error) {
	require := env.Bool("LODESTONE_ZONE_REQUIRE_TERRAIN", false) || env.Str("LODESTONE_ENV", "development") == "production"
	start := time.Now()
	mod, err := worldhost.LoadFromEnv(ctx)
	if err != nil {
		if errors.Is(err, worldhost.ErrNoWasm) && !require {
			log.Warn("NO TERRAIN: worldgen.wasm not found; simulating on flat ground (dev only). Run `npm run build:wasm`.", "err", err)
			return movement.Flat{}, nil, w, nil
		}
		return nil, nil, w, err
	}
	mt, placeholder, err := mod.OpenRow(worldhost.WorldRow{Seed: w.Seed, Spec: w.Spec, GenVersion: w.GenVersion, AtlasHash: w.AtlasHash},
		worldhost.WorldOptions{MaxInstances: env.Int("LODESTONE_ZONE_WASM_INSTANCES", 0)})
	if err != nil {
		return nil, nil, w, err
	}
	if placeholder {
		log.Warn("world row is not minted (placeholder gen_version); serving spec_from_seed(seed). The account service mints it on start, or run `go run ./server/pkg/cmd/mintworld -official`.",
			"world", w.ID, "seed", w.Seed, "rowGenVersion", w.GenVersion)
	}
	w.GenVersion = mt.GenVersion
	w.Spec = mt.Spec
	w.AtlasHash = mt.AtlasHash
	t := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{
		Capacity: env.Int("LODESTONE_ZONE_CHUNK_CACHE", 0),
		Workers:  env.Int("LODESTONE_ZONE_CHUNK_WORKERS", 0),
	})
	// Warm the spawn settlement, where every new character appears.
	h := mt.World.Header
	if err := t.Ensure(float64(h.SpawnX), float64(h.SpawnZ), 96); err != nil {
		log.Warn("terrain warm-up failed", "err", err)
	}
	log.Info("terrain ready", "wasm", mod.Path(), "wasmSha256", mod.SHA256(), "genVersion", mt.GenVersion, "atlasHash", mt.AtlasHash,
		"world", mt.Name, "spawnX", h.SpawnX, "spawnZ", h.SpawnZ, "seaLevel", h.SeaLevel, "ms", time.Since(start).Milliseconds())
	return t, t, w, nil
}

// serveTerrain exposes the cache: Prometheus gauges and GET /debug/terrain
// (counters as JSON; soak evidence reads it).
func serveTerrain(ctx context.Context, s *svc.Server, t *worldhost.Terrain) {
	go terrainMetrics(ctx, t, s.Metrics)
	s.Mux.HandleFunc("GET /debug/terrain", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		h := t.World().Header
		_ = json.NewEncoder(w).Encode(map[string]any{"cache": t.Stats(), "atlasHash": worldhost.Hex64(t.World().AtlasHash),
			"genVersion": t.World().Module().GenVersionString(), "wasmSha256": t.World().Module().SHA256(),
			"spawn": [2]float32{h.SpawnX, h.SpawnZ}, "seaLevel": h.SeaLevel})
	})
}

// nonEmptyJSON keeps /debug/zone valid JSON when there is no spec (flat
// fallback without worldgen.wasm).
func nonEmptyJSON(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}

// terrainMetrics publishes the chunk cache counters every few seconds.
func terrainMetrics(ctx context.Context, t *worldhost.Terrain, m *svc.Metrics) {
	m.Help("zone_terrain_chunks", "Chunks in the terrain cache (LOD 0 heights + records).")
	m.Help("zone_terrain_queries_total", "Ground queries by path: cache (pure Go from chunk heights) or wasm (direct collision_height on a miss).")
	tk := time.NewTicker(2 * time.Second)
	defer tk.Stop()
	for {
		st := t.Stats()
		m.SetInt("zone_terrain_chunks", int64(st.Chunks))
		m.SetInt("zone_terrain_pending", int64(st.Pending))
		m.SetInt(`zone_terrain_queries_total{path="cache"}`, st.Hits)
		m.SetInt(`zone_terrain_queries_total{path="wasm"}`, st.Misses)
		m.SetInt("zone_terrain_generated_total", st.Generated)
		m.SetInt("zone_terrain_evicted_total", st.Evicted)
		m.SetInt("zone_terrain_dropped_total", st.Dropped)
		m.SetInt("zone_terrain_gen_errors_total", st.GenErrors)
		m.SetFloat("zone_terrain_gen_ms_mean", st.GenMeanMs)
		m.SetFloat("zone_terrain_gen_ms_max", st.GenMaxMs)
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
		}
	}
}
