package main

// WP16 multiple zones: cluster mode wiring (internal/cluster for Redis,
// internal/game handoff.go/ghosts.go for the simulation side).
//
// Off by default: a zone started the way `npm run dev` starts it owns the
// whole world exactly as before. Cluster mode is on when any of these is set:
//
//	LODESTONE_ZONE_CLUSTER=1     join the world's zone cluster (role primary unless below)
//	LODESTONE_ZONE_ROLE          primary (owns what nobody else claims; failover target)
//	                             | pool (owns the regions the director assigns)
//	LODESTONE_ZONE_REGIONS       "x,z;x,z;..." regions pinned by config (role "" with explicit regions)
//	LODESTONE_ZONE_HEARTBEAT_MS  registry heartbeat in cluster mode (default 1000)
//	LODESTONE_ZONE_TTL_MS        staleness other zones/the director apply to us (default 3000)
//	LODESTONE_ZONE_DEBUG_URL     http base announced for tools (default http://127.0.0.1:<port>)
//
// Every zone of a world must run in cluster mode for handoffs to work (a
// legacy zone neither hands players off nor mirrors them).

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/zoneregistry"
	"lodestone/server/zone/internal/cluster"
	"lodestone/server/zone/internal/game"
)

type zoneCluster struct {
	r      *cluster.Redis
	role   string
	static []zoneregistry.Region
}

// clusterFromEnv returns the cluster plumbing (subscribed and running) and
// the zone's local entity id base, or nil when cluster mode is off.
func clusterFromEnv(ctx context.Context, worldID, zoneID string, log *slog.Logger) (*zoneCluster, uint32, error) {
	regions, err := parseRegions(env.Str("LODESTONE_ZONE_REGIONS", ""))
	if err != nil {
		return nil, 0, err
	}
	role := env.Str("LODESTONE_ZONE_ROLE", "")
	on := env.Bool("LODESTONE_ZONE_CLUSTER", false) || role != "" || len(regions) > 0
	if !on {
		return nil, 0, nil
	}
	if env.Bool("LODESTONE_ZONE_NO_REDIS", false) {
		return nil, 0, fmt.Errorf("cluster mode needs Redis (LODESTONE_ZONE_NO_REDIS is set)")
	}
	switch {
	case role == "" && len(regions) == 0:
		role = zoneregistry.RolePrimary
	case role != "" && role != zoneregistry.RolePrimary && role != zoneregistry.RolePool:
		return nil, 0, fmt.Errorf("LODESTONE_ZONE_ROLE must be primary or pool, got %q", role)
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr(), PoolSize: 32})
	r := cluster.New(rdb, worldID, zoneID, log)
	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	base, err := r.Slot(sctx)
	if err != nil {
		return nil, 0, fmt.Errorf("cluster: redis: %w", err)
	}
	r.RefreshOwners(sctx)
	go r.Run(ctx)
	log.Info("cluster mode", "role", role, "regions", regions, "idBase", base)
	return &zoneCluster{r: r, role: role, static: regions}, base, nil
}

// parseRegions reads "x,z;x,z".
func parseRegions(s string) ([]zoneregistry.Region, error) {
	var out []zoneregistry.Region
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		xz := strings.Split(part, ",")
		if len(xz) != 2 {
			return nil, fmt.Errorf("LODESTONE_ZONE_REGIONS: %q is not x,z", part)
		}
		x, err1 := strconv.Atoi(strings.TrimSpace(xz[0]))
		z, err2 := strconv.Atoi(strings.TrimSpace(xz[1]))
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("LODESTONE_ZONE_REGIONS: %q is not x,z", part)
		}
		out = append(out, zoneregistry.Region{X: x, Z: z})
	}
	return out, nil
}

// announce runs the cluster heartbeat (replaces main's legacy announce).
func (c *zoneCluster) announce(ctx context.Context, e zoneregistry.Entry, port int, zone *game.Server) {
	e.Role = c.role
	e.Regions = c.static
	e.TTLMs = int64(env.Int("LODESTONE_ZONE_TTL_MS", 3000))
	e.Debug = env.Str("LODESTONE_ZONE_DEBUG_URL", fmt.Sprintf("http://127.0.0.1:%d", port))
	a := &cluster.Announcer{R: c.r, Entry: e, Static: len(c.static) > 0, Every: time.Duration(env.Int("LODESTONE_ZONE_HEARTBEAT_MS", 1000)) * time.Millisecond, Players: zone.Players, Load: zone.RegionLoad}
	a.Run(ctx)
}

// serveCluster mounts /debug/cluster: ownership as this zone sees it, the
// characters it owns, handoff counters. Bots and the soak checker read it.
func (c *zoneCluster) serveCluster(s *svc.Server, zone *game.Server) {
	s.Mux.HandleFunc("GET /debug/cluster", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		view, err := zone.ClusterView(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		own := c.r.Owners()
		grid := [][]string{}
		zones := map[string]game.ZoneInfo{}
		if own != nil {
			for x := range own.Region {
				grid = append(grid, append([]string(nil), own.Region[x][:]...))
			}
			zones = own.Zones
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"zoneId": c.r.Zone, "worldId": c.r.World, "role": c.role, "owners": grid, "zones": zones,
			"live": c.r.Live(), "stats": zone.ClusterStats(), "view": view,
		})
	})
}

// clusterMetrics adds the handoff counters to /metrics.
func clusterMetrics(m *svc.Metrics, zone *game.Server) {
	for k, v := range zone.ClusterStats() {
		m.SetInt("zone_cluster_"+k, v)
	}
}

// servePprof mounts Go's profiler under /debug/pprof/ when
// LODESTONE_ZONE_PPROF=1 (soaks: where does the tick go?). Off by default:
// profiles expose internals and cost CPU while being taken.
func servePprof(s *svc.Server, log *slog.Logger) {
	if !env.Bool("LODESTONE_ZONE_PPROF", false) {
		return
	}
	s.Mux.HandleFunc("GET /debug/pprof/", pprof.Index)
	s.Mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
	s.Mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	s.Mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
	log.Warn("pprof enabled on /debug/pprof/ (LODESTONE_ZONE_PPROF)")
}
