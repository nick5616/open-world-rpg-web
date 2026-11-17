package main

// Towns wiring for the zone (WP20): build the world's towns layer from the
// wasm, put its buildings, bridges and structures on the movement ground
// (the same collision the client predicts with: server/pkg/towns), and
// hand the townsfolk to the game. Its own file so main.go gains one line.

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/palace"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
	"lodestone/server/zone/internal/npc"
)

// townCaveTerrain is the zone ground with buildings over the cave terrain.
// Embedding promotes every method the game asserts on the ground (chunk
// interest, spawns, caves: wanter, spawner, caveWorld); only the level view
// the movement step stands on changes (floors within a step, walls, ceilings).
type townCaveTerrain struct {
	*worldhost.CaveTerrain
	tg *towns.Ground
}

// AtLevel implements movement.LevelGround: caves under, buildings on top.
func (t townCaveTerrain) AtLevel(y float64) movement.Ground { return t.tg.AtLevel(y) }

// TownCollision hands the box index to the game (enemies respect buildings:
// internal/game/obstacles.go), so it is not built twice.
func (t townCaveTerrain) TownCollision() *towns.Collision { return t.tg.C }

// townTerrain is the same over the surface ground when there are no caves
// (a pre-WP09 wasm): terrain + towers, promoted through overlaidTerrain.
type townTerrain struct {
	overlaidTerrain
	tg *towns.Ground
}

func (t townTerrain) AtLevel(y float64) movement.Ground { return t.tg.AtLevel(y) }

func (t townTerrain) TownCollision() *towns.Collision { return t.tg.C }

// withTowns wraps the ground with the towns' collision and fills the towns
// part of cfg. LODESTONE_ZONE_NO_TOWNS=1 turns it off (A/B checks);
// LODESTONE_ZONE_TIME_OFFSET_S shifts the NPC day (evidence: a night run).
// A wasm built before WP20 has no towns_build: the zone logs NO TOWNS and
// keeps the ground it had.
func withTowns(ground movement.Ground, terrain *worldhost.Terrain, cfg *game.Config, log *slog.Logger) movement.Ground {
	cfg.TimeOffsetS = env.Float("LODESTONE_ZONE_TIME_OFFSET_S", 0)
	if terrain == nil || env.Bool("LODESTONE_ZONE_NO_TOWNS", false) {
		return ground
	}
	start := time.Now()
	b, err := terrain.World().TownsBytes()
	if err != nil {
		log.Warn("NO TOWNS: towns_build unavailable; buildings have no collision and there are no NPCs", "err", err)
		return ground
	}
	tw, err := towns.Parse(b)
	if err != nil {
		log.Error("NO TOWNS: towns buffer unreadable", "err", err)
		return ground
	}
	if g, ok := ground.(*worldhost.CaveTerrain); ok {
		palace.AppendBoxes(tw, palace.SitesOf(g.Vertical())) // CR 044: the sky palaces are buildings
	}
	var sites []npc.Site
	if a, err := structures.ParseAtlas(terrain.World().Atlas); err == nil {
		for _, s := range a.Sites {
			sites = append(sites, npc.Site{Index: s.Index, Category: s.Category, Kind: s.Kind, X: s.X, Z: s.Z, Name: s.Name, Layer: s.Layer, Size: s.Size})
		}
	}
	cfg.Towns = npc.New(tw, terrain.World().Seed, sites)
	var out movement.Ground
	switch g := ground.(type) {
	case *worldhost.CaveTerrain:
		out = townCaveTerrain{CaveTerrain: g, tg: towns.NewGround(g, tw)}
	case overlaidTerrain:
		out = townTerrain{overlaidTerrain: g, tg: towns.NewGround(g, tw)}
	default:
		out = towns.NewGround(ground, tw)
	}
	log.Info("towns ready", "settlements", len(tw.Settlements), "buildings", len(tw.Buildings), "boxes", tw.Boxes.Len(), "npcs", len(tw.NPCs),
		"roads", len(tw.Roads), "bridges", tw.Bridges, "structures", len(tw.Structures), "bytes", len(b), "ms", time.Since(start).Milliseconds())
	return out
}

// doorsConfig persists building door states in Postgres (door_state,
// migration 0024) when the zone has a database and towns.
func doorsConfig(cfg *game.Config, pool *pgxpool.Pool) {
	if pool != nil && cfg.Towns != nil {
		cfg.DoorStore = &game.PGDoorStore{Pool: pool}
	}
}

// racesConfig persists the sky towns' glide ring race best times in
// Postgres (sky_race_times, migration 0034; CR 044) when the zone has a
// database.
func racesConfig(cfg *game.Config, pool *pgxpool.Pool) {
	if pool != nil {
		cfg.RaceStore = &game.PGRaceStore{Pool: pool}
	}
}

// restoreRaces loads the stored best times before the zone ticks.
func restoreRaces(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := zone.RestoreRaces(rctx)
	if err != nil {
		log.Warn("race times not restored", "err", err)
		return
	}
	if n > 0 {
		log.Info("race times restored", "rows", n)
	}
}

// campsConfig persists camp pieces in Postgres (camp_pieces, migration
// 0026; CR 025) when the zone has a database.
func campsConfig(cfg *game.Config, pool *pgxpool.Pool) {
	if pool != nil {
		cfg.CampStore = &game.PGCampStore{Pool: pool}
	}
}

// restoreCamps loads the placed camp pieces (and their chests) before the
// zone ticks.
func restoreCamps(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := zone.RestoreCamps(rctx)
	if err != nil {
		log.Warn("camp pieces not restored", "err", err)
		return
	}
	if n > 0 {
		log.Info("camp pieces restored", "pieces", n)
	}
}

// restoreDoors loads the persisted door states before the zone ticks, so
// a restart (or a zone taking a region over) keeps closed doors closed.
func restoreDoors(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := zone.RestoreDoors(rctx)
	if err != nil {
		log.Warn("door states not restored (doors start open)", "err", err)
		return
	}
	if n > 0 {
		log.Info("door states restored", "closed", n)
	}
}
