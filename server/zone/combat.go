package main

// Combat wiring for the zone (WP13): camps, packs and boss arenas come from
// the world's atlas sites (worldgen), enemy density from the WorldSpec, and
// a debug endpoint lists the groups and counters. Kept in its own file so
// main.go only gains a few lines.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/game"
)

// combatSetup builds the combat configuration. Without terrain (flat dev
// fallback) there is no atlas: no generated groups, only dev placement.
func combatSetup(t *worldhost.Terrain, seed uint64, specJSON []byte, devKey bool, log *slog.Logger) *game.CombatSetup {
	cs := &game.CombatSetup{
		Config: combat.Config{Seed: seed, EnemyDensity: 0.5,
			CampRespawnS: env.Float("LODESTONE_ZONE_CAMP_RESPAWN_S", 0),
			BossRespawnS: env.Float("LODESTONE_ZONE_BOSS_RESPAWN_S", 0),
			NoWildPacks:  env.Bool("LODESTONE_ZONE_NO_WILD_PACKS", false)},
		Dev: env.Bool("LODESTONE_ZONE_DEV_COMBAT", devKey),
	}
	var spec struct {
		EnemyDensity *float64 `json:"enemyDensity"`
	}
	if len(specJSON) > 0 && json.Unmarshal(specJSON, &spec) == nil && spec.EnemyDensity != nil {
		cs.Config.EnemyDensity = *spec.EnemyDensity
	}
	if t == nil || env.Bool("LODESTONE_ZONE_NO_ATLAS_ENEMIES", false) {
		return cs
	}
	start := time.Now()
	raw := t.World().Atlas
	a, err := structures.ParseAtlas(raw)
	if err != nil {
		log.Error("atlas unreadable: no generated enemies", "err", err)
		return cs
	}
	cs.Atlas = combat.ParseAtlas(raw, a)
	log.Info("combat atlas", "sites", len(cs.Atlas.Sites), "regions", len(cs.Atlas.Regions), "enemyDensity", cs.Config.EnemyDensity, "ms", time.Since(start).Milliseconds())
	return cs
}

// serveCombatDebug: GET /debug/combat lists groups near a point
// (?x=&z=&r=) and the combat counters (dev and evidence runs). The world is
// tick-owned, so this reads a snapshot the tick publishes.
func serveCombatDebug(mux *http.ServeMux, zone *game.Server) {
	mux.HandleFunc("GET /debug/combat", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(zone.CombatDebug())
	})
}
