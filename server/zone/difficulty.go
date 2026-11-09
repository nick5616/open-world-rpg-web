package main

// Discovery-stamped difficulty wiring (playtest 1, CR 012, decision 0021):
// the area map from the world's atlas (spawn, region danger), the stamp
// store (Postgres area_difficulty when the zone has a database and a
// uuid world id, else in memory), and GET /debug/difficulty.
//
//	LODESTONE_ZONE_NO_DIFFICULTY=1   the WP13 region danger curve instead (no stamps, no Haven)

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/env"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/game"
)

var worldUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// difficultySetup builds the area map; nil without an atlas or when disabled.
func difficultySetup(cs *game.CombatSetup, pool *pgxpool.Pool, worldID string, log *slog.Logger) *game.DifficultySetup {
	if env.Bool("LODESTONE_ZONE_NO_DIFFICULTY", false) || cs == nil || cs.Atlas == nil {
		return nil
	}
	a := cs.Atlas
	m := difficulty.New(&combatdefs.D.Difficulty, a.WorldSize, a.SpawnX, a.SpawnZ, func(x, z float64) float64 { return a.Region(a.RegionAt(x, z)).Danger })
	ds := &game.DifficultySetup{Map: m}
	if pool != nil && worldUUID.MatchString(worldID) {
		ds.Store = &difficulty.PGStore{Pool: pool}
	}
	haven := 0
	for c := 0; c < m.Cells(); c++ {
		if m.Haven(c) {
			haven++
		}
	}
	log.Info("difficulty setup", "areas", m.Cells(), "haven", haven, "postgres", ds.Store != nil)
	return ds
}

// serveDifficultyDebug: GET /debug/difficulty lists the known areas, the
// claim counters and where each player stands.
func serveDifficultyDebug(mux *http.ServeMux, zone *game.Server) {
	mux.HandleFunc("GET /debug/difficulty", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		d, err := zone.Difficulty(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(d)
	})
}
