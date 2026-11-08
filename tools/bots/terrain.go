package main

// Terrain for bots (WP07): bots predict their own movement with the same
// worldgen.wasm the zone runs, so they walk generated hills and still have
// to match the server to the centimeter. The zone's /debug/zone tells us the
// world (seed, spec, genVersion, atlasHash); we rebuild the atlas and refuse
// to run if it doesn't hash the same, since a different ground would make
// every prediction check meaningless.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sync"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
)

// zoneInfo is the zone's GET /debug/zone.
type zoneInfo struct {
	ZoneID     string          `json:"zoneId"`
	WorldID    string          `json:"worldId"`
	Seed       uint64          `json:"seed"`
	GenVersion string          `json:"genVersion"`
	Spec       json.RawMessage `json:"spec"`
	AtlasHash  string          `json:"atlasHash"`
}

// openTerrain builds the zone's world locally. mode: "auto" (terrain when the
// zone serves one, i.e. reports an atlas hash), "on" (required), "off".
func openTerrain(info zoneInfo, mode string) (*worldhost.Terrain, error) {
	if mode == "off" || (mode == "auto" && info.AtlasHash == "") {
		return nil, nil
	}
	if info.AtlasHash == "" {
		return nil, fmt.Errorf("-terrain on, but the zone reports no terrain (flat fallback, or an old zone)")
	}
	mod, err := worldhost.LoadFromEnv(context.Background())
	if err != nil {
		return nil, err
	}
	spec := []byte(info.Spec)
	if string(spec) == "null" {
		spec = nil
	}
	mt, _, err := mod.OpenRow(worldhost.WorldRow{Seed: info.Seed, Spec: spec, GenVersion: info.GenVersion, AtlasHash: info.AtlasHash}, worldhost.WorldOptions{})
	if err != nil {
		return nil, fmt.Errorf("bots cannot rebuild the zone's world: %w", err)
	}
	return worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{}), nil
}

// caveGrounds: one cave-aware ground per terrain (WP09), built on first use.
// The zone simulates on worldhost.CaveTerrain, so a bot that walks into a
// cave mouth must predict on it too or it reads the hole as a mismatch.
var (
	caveGrounds sync.Map // *worldhost.Terrain -> movement.Ground
	caveMu      sync.Mutex
)

// withStructures puts the atlas towers on the terrain (WP12), as the zone
// does, so a bot walking into a tower climbs it on both sides.
func withStructures(t *worldhost.Terrain) movement.Ground {
	a, err := structures.ParseAtlas(t.World().Atlas)
	if err != nil {
		return t
	}
	o, _ := structures.Towers(a, t)
	return structures.Wrap(t, o)
}

// ground is what prediction steps on: the terrain with the towers (WP12),
// caves under it (WP09) and the towns' buildings on top (WP20), or WP03's
// flat plane.
func (c *botConfig) ground() movement.Ground {
	if c.terrain == nil {
		return movement.Flat{}
	}
	if g, ok := caveGrounds.Load(c.terrain); ok {
		return g.(movement.Ground)
	}
	caveMu.Lock() // one cave cache (and worker) per terrain, not one per racing bot
	defer caveMu.Unlock()
	if g, ok := caveGrounds.Load(c.terrain); ok {
		return g.(movement.Ground)
	}
	var surface movement.Ground = c.terrain
	if c.structures != nil {
		surface = c.structures
	}
	g := surface
	if cv, err := worldhost.NewCaves(c.terrain.World(), worldhost.CaveOptions{Workers: 1}); err == nil {
		g = worldhost.NewCaveTerrain(c.terrain, surface, cv)
	}
	// WP20: buildings, bridges and structures on top, as the zone does
	// (server/zone/towns.go), so a bot walking into a town bumps the same walls.
	if b, err := c.terrain.World().TownsBytes(); err == nil {
		if tw, err := towns.Parse(b); err == nil {
			g = towns.NewGround(g, tw)
		}
	}
	actual, _ := caveGrounds.LoadOrStore(c.terrain, g)
	return actual.(movement.Ground)
}

// landSpawn redraws a spawn until it is a dry cell (bots spawning in the sea
// would walk the sea floor the whole soak). DryPoint snaps to a cell center
// (x.5), which `%.2f` in the spawn query carries exactly, so the bot knows
// its spawn to the bit. Gives up after 200 draws and keeps the last point.
func landSpawn(t *worldhost.Terrain, draw func() (float64, float64)) (float64, float64) {
	var x, z float64
	for i := 0; i < 200; i++ {
		x, z = draw()
		if p, ok := t.DryPoint(x, z); ok && p.Y > float64(t.World().Header.SeaLevel)+0.5 {
			return p.X, p.Z
		}
	}
	return math.Floor(x) + 0.5, math.Floor(z) + 0.5
}

// terrainSummary records which world the soak walked and how much ground
// the bots actually covered (height range of their final positions), plus
// the bots' own cache counters.
func terrainSummary(info zoneInfo, t *worldhost.Terrain, bots []*bot) map[string]any {
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, b := range bots {
		b.mu.Lock()
		y := b.state.Pos.Y
		b.mu.Unlock()
		lo, hi = math.Min(lo, y), math.Max(hi, y)
	}
	h := t.World().Header
	return map[string]any{
		"seed": info.Seed, "genVersion": info.GenVersion, "atlasHash": info.AtlasHash,
		"wasmSha256": t.World().Module().SHA256(), "seaLevel": h.SeaLevel,
		"botHeightMinM": math.Round(lo*100) / 100, "botHeightMaxM": math.Round(hi*100) / 100,
		"botCache": t.Stats(),
	}
}

// avoidWater turns a bot around when the ground 12 m ahead is under the
// sea, so soak bots keep walking terrain instead of the sea floor.
func (b *bot) avoidWater(px, pz float64) {
	t := b.cfg.terrain
	if t == nil {
		return
	}
	ax, az := px-math.Sin(b.yaw)*12, pz-math.Cos(b.yaw)*12 // forward = (-sin, -cos)
	if t.HeightAt(ax, az) < float64(t.World().Header.SeaLevel) {
		b.heading = b.yaw + math.Pi + (b.rng.Float64() - 0.5)
	}
}
