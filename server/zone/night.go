package main

// Night wiring for the zone (WP15): the world's wards, lanterns and lairs
// (towns buffer + atlas), the chemistry engine on the world's materials,
// the ice/pillar overlay on the movement ground, and GET /debug/night. Its
// own file so main.go gains two lines.
//
//	LODESTONE_ZONE_TIME_OFFSET_S   world clock offset (seconds added to the wall clock;
//	                               use the same value on every zone of a world)
//	LODESTONE_ZONE_NO_DEMONS=1     no night spawns (defense events still run)
//	LODESTONE_ZONE_NO_CHEM=1       no chemistry engine
//	LODESTONE_ZONE_DEV_NIGHT       dev Interacts 51/52 (ignite, set time, force a defense, raise demons); default: dev key
//	LODESTONE_ZONE_CHEM_SYNC       events (default) | bitmap: the clients' default chemistry sync path
//	LODESTONE_ZONE_DEBUG_DEFENSE   "<town index>|spawn[,delay s]": force a town defense event

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"time"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/game"
	"lodestone/server/zone/internal/night"
)

// chemTownCaveTerrain keeps every method of the production ground (chunk
// interest, spawns, caves) and puts the chemistry overlay (ice sheets,
// pillars) on its surface and level views.
// inner is the embedded ground as an interface value, made once (G5:
// HeightAt used to convert the struct on every call, a heap allocation per
// ground query, ~2 MB/s of garbage with 300 players and 2,000 enemies).
type chemTownCaveTerrain struct {
	townCaveTerrain
	o     *chem.Overlay
	inner movement.Ground
}

func (t chemTownCaveTerrain) HeightAt(x, z float64) float64 {
	return chem.Ground{Inner: t.inner, O: t.o}.HeightAt(x, z)
}
func (t chemTownCaveTerrain) AtLevel(y float64) movement.Ground {
	return chem.Level(t.townCaveTerrain.AtLevel(y), t.o, y)
}

type chemTownTerrain struct {
	townTerrain
	o     *chem.Overlay
	inner movement.Ground // see chemTownCaveTerrain
}

func (t chemTownTerrain) HeightAt(x, z float64) float64 {
	return chem.Ground{Inner: t.inner, O: t.o}.HeightAt(x, z)
}
func (t chemTownTerrain) AtLevel(y float64) movement.Ground {
	return chem.Level(t.townTerrain.AtLevel(y), t.o, y)
}

// withNight fills cfg.Night and wraps cfg.Ground with the chemistry
// overlay. Call after withTowns and combatSetup.
func withNight(cfg *game.Config, terrain *worldhost.Terrain, specJSON []byte, devKey bool, log *slog.Logger) {
	var spec struct {
		WindDirection  *int     `json:"windDirection"`
		DemonIntensity *float64 `json:"demonIntensity"`
	}
	_ = json.Unmarshal(specJSON, &spec)
	wind, intensity := 0, 0.5
	if spec.WindDirection != nil {
		wind = *spec.WindDirection
	}
	if spec.DemonIntensity != nil {
		intensity = *spec.DemonIntensity
	}
	var atlas *combat.AtlasInfo
	if cfg.Combat != nil {
		atlas = cfg.Combat.Atlas
	}
	if atlas == nil && terrain != nil { // combat may run without atlas groups; wards and lairs still need the sites
		if a, err := structures.ParseAtlas(terrain.World().Atlas); err == nil {
			atlas = combat.ParseAtlas(terrain.World().Atlas, a)
		}
	}
	var tw = cfg.Towns
	names := func(i int) string {
		if tw == nil || atlas == nil {
			return ""
		}
		if si := tw.T.Settlements[i].Site; si >= 0 && si < len(atlas.Sites) {
			return atlas.Sites[si].Name
		}
		return ""
	}
	element := func(x, z float64) int {
		if atlas == nil {
			return 8
		}
		return atlas.Region(atlas.RegionAt(x, z)).Element
	}
	nw := night.New(cfg.Seed, intensity, nil, names, element)
	if tw != nil {
		nw = night.New(cfg.Seed, intensity, tw.T, names, element)
	}
	spawnTown := -1
	if atlas != nil {
		best := math.Inf(1)
		for i, t := range nw.Towns {
			if d := math.Hypot(t.X-atlas.SpawnX, t.Z-atlas.SpawnZ); d < best {
				spawnTown, best = i, d
			}
		}
		for _, s := range atlas.Sites {
			switch {
			case s.Category == structures.CategoryStructure && s.Kind == combat.StructDemonLair:
				nw.Lairs = append(nw.Lairs, night.Point{X: s.X, Z: s.Z})
				nw.Refuges = append(nw.Refuges, night.Point{X: s.X, Z: s.Z})
			case s.Category == structures.CategoryPOI && s.Kind == structures.POICaveMouth:
				nw.Refuges = append(nw.Refuges, night.Point{X: s.X, Z: s.Z})
			}
		}
	}
	force, delay := game.ParseForceDefense(env.Str("LODESTONE_ZONE_DEBUG_DEFENSE", ""), spawnTown)
	setup := &game.NightSetup{World: nw, WindDeg: wind, Dev: env.Bool("LODESTONE_ZONE_DEV_NIGHT", devKey), NoDemons: env.Bool("LODESTONE_ZONE_NO_DEMONS", false), Force: force, ForceAtS: delay, ChemMode: game.ChemModeEvents}
	if env.Str("LODESTONE_ZONE_CHEM_SYNC", "events") == "bitmap" {
		setup.ChemMode = game.ChemModeBitmap
	}
	if terrain != nil && !env.Bool("LODESTONE_ZONE_NO_CHEM", false) {
		src := chem.NewTerrainMaterial(terrain, cfg.Seed, terrain.World().Atlas)
		setup.Chem = chem.NewSim(cfg.Seed, wind, src, weather.Step(float64(time.Now().UnixMilli())/1000+cfg.TimeOffsetS))
		setup.Overlay = &chem.Overlay{}
		setup.Overlay.Sync(setup.Chem)
		switch g := cfg.Ground.(type) {
		case townCaveTerrain:
			cfg.Ground = chemTownCaveTerrain{g, setup.Overlay, g}
		case townTerrain:
			cfg.Ground = chemTownTerrain{g, setup.Overlay, g}
		default:
			cfg.Ground = chem.Ground{Inner: g, O: setup.Overlay}
		}
	}
	cfg.Night = setup
	log.Info("night wiring", "towns", len(nw.Towns), "lairs", len(nw.Lairs), "refuges", len(nw.Refuges), "windDeg", wind, "demonIntensity", intensity,
		"chem", setup.Chem != nil, "chemSync", setup.ChemMode, "dev", setup.Dev, "forceDefense", force, "clockOffsetS", cfg.TimeOffsetS)
}

// serveNightDebug: GET /debug/night (?hashes=1 adds the chemistry digest per step).
func serveNightDebug(mux *http.ServeMux, zone *game.Server) {
	mux.HandleFunc("GET /debug/night", func(w http.ResponseWriter, r *http.Request) {
		var info game.NightDebug
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		q := r.URL.Query()
		if err := zone.Do(ctx, func() {
			info = zone.NightDebugInfo(q.Get("hashes") == "1")
			if q.Get("towns") == "1" {
				info.Towns = zone.NightTowns()
			}
		}); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	})
}
