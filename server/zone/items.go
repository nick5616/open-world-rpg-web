package main

// Items wiring (WP14): Postgres item store, world containers from the
// terrain's chunk records, the world's loot themes, the drop despawn timer,
// the Bitchin' announcement in global chat, and debug endpoints.
//
//	LODESTONE_ZONE_DROP_DESPAWN   dropped items despawn after this (default 10m, spec 8; tests shorten it)
//	LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS / _COMMIT_DELAY_MS  kill-mid-grant test hooks (never in production)

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/svc"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/game"
	"lodestone/server/zone/internal/items"
)

// lootThemeValues is the worldspec lootThemes enum in schema order
// (contracts/worldspec.schema.json; worldgen's LOOT_THEMES_VALUES): a
// container record's variant indexes it.
var lootThemeValues = []string{"ancient", "arcane", "bandit", "celestial", "draconic", "drowned", "feral", "infernal", "royal", "rustic", "sylvan", "voidtouched"}

func itemsSetup(pool *pgxpool.Pool, t *worldhost.Terrain, cs *game.CombatSetup, specJSON []byte, worldID string, log *slog.Logger) *game.ItemsSetup {
	st := &game.ItemsSetup{DropDespawn: env.Duration("LODESTONE_ZONE_DROP_DESPAWN", 0)}
	if pool != nil {
		st.Store = &game.PGStore{Pool: pool}
	}
	var spec struct {
		LootThemes []string `json:"lootThemes"`
	}
	if len(specJSON) > 0 && json.Unmarshal(specJSON, &spec) == nil {
		st.Themes = spec.LootThemes
	}
	if t != nil {
		var atlas *combat.AtlasInfo
		if cs != nil {
			atlas = cs.Atlas
		}
		st.Containers = &terrainContainers{t: t, atlas: atlas}
	}
	if !env.Bool("LODESTONE_ZONE_NO_REDIS", false) {
		rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
		st.Announce = func(text string) { announceGlobal(rdb, worldID, text, log) }
	}
	return st
}

// announceGlobal posts a system line to the world's global chat (spec 8:
// Bitchin' is announced to the whole world) through the social service's
// bus (server/social/internal/social/bus.go envelope, kind "chat").
func announceGlobal(rdb *redis.Client, worldID, text string, log *slog.Logger) {
	env := map[string]any{"k": "chat", "w": worldID, "m": socialproto.ChatMessage{
		ID: "loot-" + strconv.FormatInt(time.Now().UnixNano(), 36), Channel: socialproto.ChannelGlobal, FromName: "Lodestone", Text: text,
		Ts: float64(time.Now().UnixMilli())}}
	b, _ := json.Marshal(env)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := rdb.Publish(ctx, "social:"+worldID, b).Err(); err != nil {
			log.Warn("bitchin' announcement not published", "err", err)
		}
	}()
}

// terrainContainers lists chunk container anchors from the terrain cache
// (chunks near players are always cached: the zone wants them).
type terrainContainers struct {
	t     *worldhost.Terrain
	atlas *combat.AtlasInfo
}

func (c *terrainContainers) ContainersNear(x, z, r float64) []game.ContainerInfo {
	var out []game.ContainerInfo
	cx0, cx1 := int32(math.Floor((x-r)/worldhost.ChunkSize)), int32(math.Floor((x+r)/worldhost.ChunkSize))
	cz0, cz1 := int32(math.Floor((z-r)/worldhost.ChunkSize)), int32(math.Floor((z+r)/worldhost.ChunkSize))
	for cz := cz0; cz <= cz1; cz++ {
		for cx := cx0; cx <= cx1; cx++ {
			ch, ok := c.t.Chunk(cx, cz)
			if !ok {
				continue
			}
			for _, rec := range ch.Containers {
				if math.Hypot(float64(rec.X)-x, float64(rec.Z)-z) > r {
					continue
				}
				ci := game.ContainerInfo{ID: rec.ID, X: float64(rec.X), Y: float64(rec.Y), Z: float64(rec.Z), Kind: int(rec.Kind), Element: -1,
					// Extra is the region's danger x255 (worldgen/README.md "Record"):
					// item level 1 at the spawn, ~15 at the most dangerous edge.
					Level: 1 + int(math.Round(float64(rec.Extra)/255*14))}
				if int(rec.Variant) < len(lootThemeValues) {
					ci.Theme = lootThemeValues[rec.Variant]
				}
				if c.atlas != nil {
					if el := c.atlas.Region(c.atlas.RegionAt(ci.X, ci.Z)).Element; el < 8 {
						ci.Element = el
					}
				}
				out = append(out, ci)
			}
		}
	}
	return out
}

// restoreWorldItems brings back dropped items after a restart.
func restoreWorldItems(ctx context.Context, zone *game.Server, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	n, err := zone.RestoreWorldItems(rctx)
	if err != nil {
		log.Warn("dropped items not restored", "err", err)
		return
	}
	if n > 0 {
		log.Info("dropped items restored", "items", n)
	}
}

// serveItemsDebug: GET /debug/items?char=<id> (inventory, journal depth)
// and GET /debug/containers?x=&z=&r= (container anchors near a point).
func serveItemsDebug(s *svc.Server, zone *game.Server, cs game.ContainerSource) {
	s.Mux.HandleFunc("GET /debug/items", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		info, err := zone.ItemsDebug(ctx, r.URL.Query().Get("char"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	})
	s.Mux.HandleFunc("GET /debug/containers", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		x, _ := strconv.ParseFloat(q.Get("x"), 64)
		z, _ := strconv.ParseFloat(q.Get("z"), 64)
		rad, _ := strconv.ParseFloat(q.Get("r"), 64)
		if rad <= 0 || rad > 512 {
			rad = 96
		}
		var list []game.ContainerInfo
		if cs != nil {
			list = cs.ContainersNear(x, z, rad)
		}
		type row struct {
			ID    string  `json:"id"`
			X     float64 `json:"x"`
			Y     float64 `json:"y"`
			Z     float64 `json:"z"`
			Kind  string  `json:"kind"`
			Theme string  `json:"theme"`
			Level int     `json:"level"`
		}
		out := []row{}
		for _, c := range list {
			out = append(out, row{ID: strconv.FormatUint(c.ID, 10), X: c.X, Y: c.Y, Z: c.Z, Kind: items.ContainerKinds[min(max(c.Kind, 0), 3)], Theme: c.Theme, Level: c.Level})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}
