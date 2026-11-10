package main

// Playtest 2 dynamic weather wiring (CR 030): the world's climate per weather
// cell from the atlas biome grid (the grid the chemistry materials read),
// the dev overrides, and rain where each burning cell is for the chemistry
// engine. Its own file so main.go gains one line.
//
//	LODESTONE_ZONE_DEBUG_WEATHER  a state key (clear, cloudy, windy, fog, drizzle, rain,
//	                              thunderstorm, snow, snowstorm, heat_haze, sandstorm):
//	                              that weather everywhere (clients follow via Event 500)
//	LODESTONE_ZONE_DEBUG_RAIN     1 / 0 (WP10) now means rain / clear everywhere
//	LODESTONE_ZONE_NO_WEATHER=1   WP10's global rain stub (no lightning, snow, wind, cold)
//	LODESTONE_ZONE_NO_LIGHTNING=1 weather without bolts
//	LODESTONE_ZONE_NO_COLD=1      weather without the cold

import (
	"encoding/json"
	"log/slog"
	"os"
	"strings"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/game"
)

// withWeather fills cfg.Weather (nil without an atlas: the flat and scale
// worlds keep WP10's global rain). Call after withNight.
func withWeather(cfg *game.Config, terrain *worldhost.Terrain, specJSON []byte, log *slog.Logger) {
	if terrain == nil || len(terrain.World().Atlas) == 0 || env.Bool("LODESTONE_ZONE_NO_WEATHER", false) {
		log.Info("weather: WP10 rain stub (no atlas or LODESTONE_ZONE_NO_WEATHER)")
		return
	}
	m := chem.NewTerrainMaterial(terrain, cfg.Seed, terrain.World().Atlas)
	if m.GridN <= 0 {
		log.Info("weather: no biome grid in the atlas; WP10 rain stub")
		return
	}
	var spec struct {
		WindDirection *int `json:"windDirection"`
	}
	_ = json.Unmarshal(specJSON, &spec)
	w := &game.WeatherSetup{Climate: weather.NewClimate(m.GridN, m.MacroRes, m.Biome), Override: -1,
		NoBolts: env.Bool("LODESTONE_ZONE_NO_LIGHTNING", false), NoCold: env.Bool("LODESTONE_ZONE_NO_COLD", false)}
	if spec.WindDirection != nil {
		w.WindDeg = *spec.WindDirection
	}
	if key := strings.TrimSpace(os.Getenv("LODESTONE_ZONE_DEBUG_WEATHER")); key != "" {
		if st := weather.StateByKey(key); st >= 0 {
			w.Override = st
		} else {
			log.Warn("weather: unknown LODESTONE_ZONE_DEBUG_WEATHER", "key", key)
		}
	}
	if cfg.Rain != nil && w.Override < 0 {
		w.Override = weather.Clear
		if *cfg.Rain {
			w.Override = weather.Rain
		}
	}
	if w.Override >= 0 {
		cfg.Rain = nil // the override is the weather now (Event 500 tells clients)
	}
	cfg.Weather = w
	if n := cfg.Night; n != nil && n.Chem != nil {
		n.Chem.Rain = nil
		n.Chem.Weather = &chem.Weather{Climate: w.Climate, Override: w.Override}
	}
	counts := map[string]int{}
	for _, c := range w.Climate.Cells {
		counts[[]string{"temperate", "wet", "highland", "cold", "arid"}[c]]++
	}
	log.Info("weather wiring", "climates", counts, "override", w.Override, "lightning", !w.NoBolts, "cold", !w.NoCold, "windDeg", w.WindDeg)
}
