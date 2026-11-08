// Command zone is the authoritative simulation for a set of regions (spec 4,
// WP03): 30 Hz tick, WebSocket transport at /ws, ticket-checked sessions,
// AOI rings, delta snapshots, write-behind persistence, Redis zone registry.
//
// Configuration is environment only (spec 13: containers configured by env):
//
//	LODESTONE_ZONE_PORT          8092
//	LODESTONE_ZONE_ID            zone-dev-1   (tickets must name this audience)
//	LODESTONE_WORLD_ID           unset: the official world row (WP04), else 00000000-0000-0000-0000-000000000001
//	LODESTONE_WORLD_SEED         1     (only used with LODESTONE_WORLD_ID or the dev fallback)
//	LODESTONE_GEN_VERSION        dev   (same; "dev" = derive the spec from the seed with the loaded wasm)
//	LODESTONE_ZONE_PUBLIC_URL    ws://localhost:<port>/ws (announced to the director)
//	LODESTONE_ZONE_MAX_PLAYERS   400
//	LODESTONE_ZONE_DEV_SPAWN     1 to honor /ws?spawn=x,z (default: on only with the dev ticket key)
//	LODESTONE_SPIN_MS            scheduler spin tail (default 2 on Windows, 1 elsewhere)
//	LODESTONE_ZONE_EXIT_AFTER    e.g. 90s: shut down gracefully after this long (soaks, CI)
//	LODESTONE_ZONE_WT_ADDR       WebTransport UDP address (stub: logs "not implemented")
//	LODESTONE_ZONE_NO_DB / _NO_REDIS  1 to run without Postgres / Redis
//	LODESTONE_TICKET_PUBLIC_KEY  base64 Ed25519 key (dev key + warning when unset)
//	LODESTONE_WORLDGEN_WASM      worldgen/pkg/worldgen.wasm (WP07 terrain; see terrain.go for the rest)
//	LODESTONE_ZONE_REQUIRE_TERRAIN 1 to refuse flat ground when the wasm is missing (implied by LODESTONE_ENV=production)
//	LODESTONE_ZONE_CHUNK_CACHE / _CHUNK_WORKERS / _WASM_INSTANCES  terrain cache size (3072 chunks), generators, query instances
//	LODESTONE_PG_URL, LODESTONE_REDIS_ADDR
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/gameloop"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/pkg/zoneregistry"
	"lodestone/server/zone/internal/game"
)

// Dev defaults. WP04 mints real world rows (uuid ids); this one is
// uuid-shaped so it can be inserted into `worlds` for local testing.
const (
	defaultZoneID  = "zone-dev-1"
	defaultWorldID = "00000000-0000-0000-0000-000000000001"
)

func main() {
	port := env.Int("LODESTONE_ZONE_PORT", env.DefaultZonePort)
	s := svc.New("zone", fmt.Sprintf(":%d", port))
	log := s.Log

	pub, devKey, err := ticket.PublicKeyFromEnv()
	if err != nil {
		log.Error("ticket key", "err", err)
		os.Exit(1)
	}
	if devKey {
		log.Warn("LODESTONE_TICKET_PUBLIC_KEY unset: accepting tickets signed with the INSECURE development key")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if d := env.Duration("LODESTONE_ZONE_EXIT_AFTER", 0); d > 0 {
		log.Info("will exit after", "d", d.String())
		time.AfterFunc(d, cancel)
	}

	var store game.CharacterStore
	var pool *pgxpool.Pool
	if !env.Bool("LODESTONE_ZONE_NO_DB", false) {
		// pgxpool connects lazily, so a down database never delays startup;
		// reads fall back to the default spawn and writes retry in the queue.
		if pool, err = pgxpool.New(ctx, env.PostgresURL()); err != nil {
			log.Warn("postgres config invalid; persistence disabled", "err", err)
		} else {
			store = &game.PGStore{Pool: pool}
		}
	}
	queue := writebehind.New(env.Int("LODESTONE_WRITEBEHIND_MAX", 10000))
	queue.Log = log

	world := resolveWorld(ctx, pool, log)
	ground, terrain, world, err := loadTerrain(ctx, world, log)
	if err != nil {
		log.Error("terrain: refusing to serve this world", "world", world.ID, "err", err)
		os.Exit(1)
	}
	cfg := game.Config{
		ZoneID:     env.Str("LODESTONE_ZONE_ID", defaultZoneID),
		WorldID:    world.ID,
		Seed:       world.Seed,
		GenVersion: world.GenVersion,
		MaxPlayers: env.Int("LODESTONE_ZONE_MAX_PLAYERS", 400),
		DevSpawn:   env.Bool("LODESTONE_ZONE_DEV_SPAWN", devKey),
		TicketKey:  pub,
		Ground:     ground, // WP07: wasm terrain (terrain.go), flat only without worldgen.wasm
		SpinTail:   gameloop.DefaultSpinTail(),
		Store:      store,
		Queue:      queue,
		Metrics:    s.Metrics,
		Log:        log,
	}
	zone := game.New(cfg)

	origins := strings.Split(env.Str("LODESTONE_CORS_ORIGIN", "*"), ",")
	ws := &transport.WebSocket{OriginPatterns: origins}
	s.Mux.Handle("GET /ws", zone.Handler(ws))
	// Identity for tools: bots read it so their self-signed dev tickets name
	// the right audience and world without flags.
	s.Mux.HandleFunc("GET /debug/zone", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"zoneId": cfg.ZoneID, "worldId": cfg.WorldID, "seed": cfg.Seed, "genVersion": cfg.GenVersion, "spec": json.RawMessage(nonEmptyJSON(world.Spec)), "atlasHash": world.AtlasHash, "players": zone.Players()})
	})
	s.Mux.HandleFunc("GET /debug/tickstats", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"players": zone.Players(), "tick": zone.TickStats(), "clock": gameloop.PreciseClock})
	})

	if addr := env.Str("LODESTONE_ZONE_WT_ADDR", ""); addr != "" {
		wt := &transport.WebTransport{Addr: addr, Path: "/wt"}
		go func() {
			if err := wt.Serve(ctx, nil); err != nil {
				log.Warn("webtransport unavailable; clients use the WebSocket fallback", "err", err)
			}
		}()
	}

	queueCtx, stopQueue := context.WithCancel(context.Background())
	go queue.Run(queueCtx)
	zone.Start()
	if terrain != nil {
		defer terrain.Close()
		serveTerrain(ctx, s, terrain)
	}
	go zone.RunMetrics(ctx, queue.Depth, func(m *svc.Metrics) {
		st := &queue.Stats
		m.SetInt("zone_writebehind_enqueued_total", st.Enqueued.Load())
		m.SetInt("zone_writebehind_coalesced_total", st.Coalesced.Load())
		m.SetInt("zone_writebehind_dropped_total", st.Dropped.Load())
		m.SetInt("zone_writebehind_done_total", st.Done.Load())
		m.SetInt("zone_writebehind_retries_total", st.Retries.Load())
		m.SetInt("zone_writebehind_failed_total", st.Failed.Load())
		m.SetInt("zone_writebehind_skipped_total", st.Skipped.Load())
	})

	var rdb *redis.Client
	if !env.Bool("LODESTONE_ZONE_NO_REDIS", false) {
		rdb = redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
		entry := zoneregistry.Entry{
			ZoneID:   cfg.ZoneID,
			Endpoint: env.Str("LODESTONE_ZONE_PUBLIC_URL", fmt.Sprintf("ws://localhost:%d/ws", port)),
		}
		go announce(ctx, rdb, cfg.WorldID, entry, zone, log)
	}

	log.Info("zone config", "zone", cfg.ZoneID, "world", cfg.WorldID, "seed", cfg.Seed, "genVersion", cfg.GenVersion, "devSpawn", cfg.DevSpawn)
	runErr := s.RunContext(ctx, svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), func(sctx context.Context) {
		// Order: stop admitting and ticking, kick everyone, checkpoint, flush
		// the queue, then leave the registry so the director stops routing here.
		stopQueue()
		zone.Stop(sctx)
		if rdb != nil {
			if err := zoneregistry.Remove(sctx, rdb, cfg.WorldID, cfg.ZoneID); err != nil {
				log.Warn("zone registry remove", "err", err)
			}
			_ = rdb.Close()
		}
		if pool != nil {
			pool.Close()
		}
		log.Info("zone stopped", "writebehindLeft", queue.Depth())
	})
	if runErr != nil {
		log.Error("exit", "err", runErr)
		os.Exit(1)
	}
}

// resolveWorld picks the world this zone serves. Precedence:
//  1. LODESTONE_WORLD_ID set: env for id, seed and genVersion.
//  2. Otherwise the official world row WP04's account service seeds
//     (`worlds.official`): the director routes players to zones announced
//     under that id, so a bare `go run ./server/zone` next to `npm run dev`
//     just works. Its seed and gen_version are authoritative.
//  3. No database or no official row: the dev defaults.
func resolveWorld(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) game.World {
	seed, err := strconv.ParseUint(env.Str("LODESTONE_WORLD_SEED", "1"), 10, 64)
	if err != nil {
		log.Warn("LODESTONE_WORLD_SEED is not a uint64; using 1", "err", err)
		seed = 1
	}
	w := game.World{ID: env.Str("LODESTONE_WORLD_ID", ""), Seed: seed, GenVersion: env.Str("LODESTONE_GEN_VERSION", "dev")}
	if w.ID != "" {
		return w
	}
	w.ID = defaultWorldID
	if pool == nil {
		return w
	}
	qctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ow, ok, err := (&game.PGStore{Pool: pool}).OfficialWorld(qctx)
	switch {
	case err != nil:
		log.Warn("official world lookup failed; using the dev world id", "err", err, "world", w.ID)
	case !ok:
		log.Info("no official world row; using the dev world id", "world", w.ID)
	default:
		log.Info("serving the official world", "world", ow.ID, "seed", ow.Seed, "genVersion", ow.GenVersion)
		return ow
	}
	return w
}

// announce heartbeats the zone registry (zones:{worldId}) every
// HeartbeatEvery with the live player count. Redis being down only costs
// director routing, never the simulation, so failures are logged and retried.
func announce(ctx context.Context, rdb *redis.Client, worldID string, e zoneregistry.Entry, zone *game.Server, log *slog.Logger) {
	t := time.NewTicker(zoneregistry.HeartbeatEvery)
	defer t.Stop()
	failing := false
	for {
		e.Players = zone.Players()
		actx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := zoneregistry.Announce(actx, rdb, worldID, e)
		cancel()
		switch {
		case err != nil && !failing:
			log.Warn("zone registry announce failing", "err", err)
			failing = true
		case err == nil && failing:
			log.Info("zone registry announce recovered")
			failing = false
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
