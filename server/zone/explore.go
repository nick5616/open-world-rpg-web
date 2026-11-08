package main

// Exploration wiring for the zone (WP12): towers become a structure overlay
// on the terrain ground (so walking, snapping and WP10's climbing treat their
// walls like any cliff), the atlas sites feed the exploration rules, the
// social service's Redis party keys feed the party ring and party pins, and
// local profiles' save blobs are verified and re-issued with progress. Kept
// in its own file so main.go only gains a few lines.

import (
	"crypto/ed25519"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/game"
)

// overlaidTerrain is the terrain with the structure overlay on top. It
// embeds the Terrain so the game's optional ground interfaces (spawner,
// wanter: internal/game/terrain.go) keep working, and overrides only the
// height.
type overlaidTerrain struct {
	*worldhost.Terrain
	g *structures.Ground
}

func (t overlaidTerrain) HeightAt(x, z float64) float64 { return t.g.HeightAt(x, z) }

// withStructures builds the towers from the atlas on the plain terrain and
// returns the overlaid ground plus the exploration world. Without terrain
// (flat dev fallback) there is no atlas: no towers, no exploration.
func withStructures(ground movement.Ground, t *worldhost.Terrain, log *slog.Logger) (movement.Ground, *explore.World) {
	if t == nil {
		log.Warn("no terrain: towers, waypoints and the map are off")
		return ground, nil
	}
	start := time.Now()
	a, err := structures.ParseAtlas(t.World().Atlas)
	if err != nil {
		log.Error("atlas sites unreadable: exploration off", "err", err)
		return ground, nil
	}
	// Towers sample the PLAIN terrain (the TS twin does the same), so both
	// hosts derive identical tower heights.
	o, towerSites := structures.Towers(a, t)
	g := structures.Wrap(t, o)
	w := explore.NewWorld(a, g, towerSites)
	waypoints := 0
	for i := range a.Sites {
		if a.Sites[i].IsWaypoint() {
			waypoints++
		}
	}
	log.Info("exploration ready", "sites", len(a.Sites), "towers", o.Len(), "waypoints", waypoints, "regions", len(a.Regions), "ms", time.Since(start).Milliseconds())
	return overlaidTerrain{Terrain: t, g: g}, w
}

// exploreServices returns the party directory (social service's Redis keys)
// and the local save store, or nils without Redis.
func exploreServices(worldID string, log *slog.Logger) (game.PartyDirectory, *localsave.Store) {
	if env.Bool("LODESTONE_ZONE_NO_REDIS", false) {
		return nil, nil
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	priv, dev, err := localsave.PrivateKeyFromEnv()
	var saves *localsave.Store
	switch {
	case err != nil:
		log.Error("local save key unusable; local profiles' progress will not be saved", "err", err)
	default:
		if dev {
			log.Warn("LODESTONE_SAVE_PRIVATE_KEY unset: signing local saves with the INSECURE development key")
		}
		// AdoptMissing like the account service (decision 0004): local
		// Redis is ephemeral, and refusing every blob after a Redis restart
		// would strand every local character.
		saves = &localsave.Store{RDB: rdb, Priv: priv, Pub: priv.Public().(ed25519.PublicKey), AdoptMissing: true}
	}
	return &game.RedisParties{RDB: rdb, WorldID: worldID}, saves
}
