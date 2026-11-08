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
//	LODESTONE_ZONE_WT_ADDR       WebTransport UDP listen address (default :<port>; "off" disables)
//	LODESTONE_ZONE_WT_PUBLIC_URL https://localhost:<udp port>/wt (announced as wtEndpoint)
//	LODESTONE_ZONE_WT_CERT/_KEY  PEM files; unset: self-signed 10-day ECDSA cert, hash in #certHash=
//	LODESTONE_ZONE_DOWN_BUDGET_KBPS  per-client snapshot byte budget (decision 0005), default 150, 0 = off
//	LODESTONE_ZONE_NO_DB / _NO_REDIS  1 to run without Postgres / Redis
//	LODESTONE_ZONE_EARSHOT       0 to stop publishing proximity-voice earshot sets (WP11, voice.go)
//	LODESTONE_TICKET_PUBLIC_KEY  base64 Ed25519 key (dev key + warning when unset)
//	LODESTONE_WORLDGEN_WASM      worldgen/pkg/worldgen.wasm (WP07 terrain; see terrain.go for the rest)
//	LODESTONE_ZONE_REQUIRE_TERRAIN 1 to refuse flat ground when the wasm is missing (implied by LODESTONE_ENV=production)
//	LODESTONE_ZONE_CHUNK_CACHE / _CHUNK_WORKERS / _WASM_INSTANCES  terrain cache size (3072 chunks), generators, query instances
//	LODESTONE_ZONE_DEBUG_UPDRAFTS  WP10: "x,z,radius,top,lift[;...]" debug updraft columns (client: ?updraft=...)
//	LODESTONE_ZONE_DEBUG_RAIN      WP10: 1 = always rain, 0 = never (default: the seeded weather stub)
//	LODESTONE_PG_URL, LODESTONE_REDIS_ADDR
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
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
	ground, exploreWorld := withStructures(ground, terrain, log) // WP12: towers on the ground, exploration (explore.go)
	parties, saves := exploreServices(world.ID, log)
	updraft, rain := game.DebugEnvFromEnv() // WP10 dev overrides of the movement env
	if updraft != nil || rain != nil {
		log.Warn("debug movement env active", "updrafts", os.Getenv("LODESTONE_ZONE_DEBUG_UPDRAFTS"), "rain", os.Getenv("LODESTONE_ZONE_DEBUG_RAIN"))
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
		Updraft:    updraft,
		Rain:       rain,
		SpinTail:   gameloop.DefaultSpinTail(),
		// Decision 0005: 150 kbps leaves headroom under the 160 kbps budget
		// for reliable traffic. 0 restores WP03's unlimited ring table.
		DownBudgetKbps: env.Float("LODESTONE_ZONE_DOWN_BUDGET_KBPS", 150),
		Store:          store,
		Explore:        exploreWorld,
		Parties:        parties,
		Saves:          saves,
		Queue:          queue,
		Metrics:        s.Metrics,
		Log:            log,
	}
	if r := startEarshot(ctx, cfg.WorldID, cfg.ZoneID, s.Metrics, log); r != nil {
		cfg.Earshot = r // WP11 proximity voice (voice.go)
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

	// WebTransport gets its own context, cancelled only after the shutdown
	// kicks have drained (see WebTransport.Drain).
	wtCtx, stopWT := context.WithCancel(context.Background())
	defer stopWT()
	wt, wtEndpoint, certHash := startWebTransport(wtCtx, port, zone, log)
	s.Mux.HandleFunc("GET /debug/wt", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"wtEndpoint": wtEndpoint, "certHash": certHash})
	})

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
			ZoneID:     cfg.ZoneID,
			Endpoint:   env.Str("LODESTONE_ZONE_PUBLIC_URL", fmt.Sprintf("ws://localhost:%d/ws", port)),
			WTEndpoint: wtEndpoint,
		}
		go announce(ctx, rdb, cfg.WorldID, entry, zone, log)
	}

	log.Info("zone config", "zone", cfg.ZoneID, "world", cfg.WorldID, "seed", cfg.Seed, "genVersion", cfg.GenVersion, "devSpawn", cfg.DevSpawn)
	runErr := s.RunContext(ctx, svc.CORS(env.Str("LODESTONE_CORS_ORIGIN", "*"), s.Mux), func(sctx context.Context) {
		// Order: stop admitting and ticking, kick everyone, checkpoint, flush
		// the queue, then leave the registry so the director stops routing here.
		stopQueue()
		zone.Stop(sctx)
		if wt != nil {
			wt.Drain(2 * time.Second)
			// Closing the listener sends CONNECTION_CLOSE, which discards
			// anything not yet on the wire; give the close capsules a beat.
			time.Sleep(100 * time.Millisecond)
			stopWT()
		}
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

// startWebTransport serves WebTransport over HTTP/3 on UDP (by default the
// same port number as the HTTP/WebSocket listener) and returns the endpoint
// to announce, or "" when it is off or failed (clients then use WebSocket).
//
// Certificates: with LODESTONE_ZONE_WT_CERT/_KEY (PEM) the zone uses a real
// certificate and announces a plain https URL. Otherwise (local dev) it mints
// a short-lived self-signed ECDSA cert and appends its SHA-256 as a
// #certHash= fragment: the registry and director carry the URL verbatim, and
// the browser pins the cert with serverCertificateHashes. Browsers accept
// such a cert for at most 14 days; a zone runs on one cert for 10 days, so a
// dev zone left up longer needs a restart (see STATUS).
func startWebTransport(ctx context.Context, port int, zone *game.Server, log *slog.Logger) (wt *transport.WebTransport, endpoint, certHash string) {
	addr := env.Str("LODESTONE_ZONE_WT_ADDR", fmt.Sprintf(":%d", port))
	if addr == "" || addr == "off" || addr == "0" {
		log.Info("webtransport disabled (LODESTONE_ZONE_WT_ADDR)")
		return nil, "", ""
	}
	_, udpPort, err := net.SplitHostPort(addr)
	if err != nil {
		log.Warn("bad LODESTONE_ZONE_WT_ADDR; webtransport disabled", "addr", addr, "err", err)
		return nil, "", ""
	}
	public := env.Str("LODESTONE_ZONE_WT_PUBLIC_URL", fmt.Sprintf("https://localhost:%s/wt", udpPort))
	var tlsConf *tls.Config
	if certFile, keyFile := env.Str("LODESTONE_ZONE_WT_CERT", ""), env.Str("LODESTONE_ZONE_WT_KEY", ""); certFile != "" && keyFile != "" {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			log.Warn("webtransport certificate unreadable; webtransport disabled", "err", err)
			return nil, "", ""
		}
		tlsConf = &tls.Config{Certificates: []tls.Certificate{cert}}
	} else {
		hosts := []string{"localhost", "127.0.0.1", "::1"}
		if u, err := url.Parse(public); err == nil && u.Hostname() != "" && u.Hostname() != "localhost" {
			hosts = append(hosts, u.Hostname())
		}
		dc, err := transport.NewDevCert(10*24*time.Hour, hosts...)
		if err != nil {
			log.Warn("dev certificate failed; webtransport disabled", "err", err)
			return nil, "", ""
		}
		tlsConf, certHash = dc.TLS, dc.Hash
		log.Info("webtransport dev certificate", "sha256", dc.Hash, "notAfter", dc.NotAfter.Format(time.RFC3339))
	}
	wt = &transport.WebTransport{Addr: addr, Path: "/wt", TLS: tlsConf}
	go func() {
		if err := wt.ServeRequests(ctx, zone.AcceptWebTransport); err != nil {
			log.Warn("webtransport stopped; clients use the WebSocket fallback", "err", err)
		}
	}()
	if wt.LocalAddr(2*time.Second) == nil {
		log.Warn("webtransport did not start listening; not announcing it", "addr", addr)
		return nil, "", ""
	}
	endpoint = transport.WithCertHash(public, certHash)
	log.Info("webtransport listening", "udp", addr, "endpoint", endpoint)
	return wt, endpoint, certHash
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
