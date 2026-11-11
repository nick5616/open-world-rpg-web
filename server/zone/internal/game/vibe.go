package game

// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md). Nicole, who
// composes the game's music: "i wanna build a local dev thing where I can
// teleport to a new chunk with specified params like what is in that chunk
// like landmarks, what level it is, and the biome. I want to assess vibe and
// difficulty. also let me change my level too. this will be used to compose
// new music."
//
// Dev console commands (Interact 250 actions 29-35, the same gate as the
// rest of devconsole.go: LODESTONE_ZONE_DEV=1 and the development ticket
// key; refused with 1401 value 1 otherwise):
//
//   - find: an exact search over the world's atlas (every site, vault, the
//     Heartfall, live world events), the macro terrain (peaks, lake shores,
//     river banks, coasts) and one "wilds" spot per 256 m area, filtered by
//     biome, landmark, region, area level and tier (stamped, or what an
//     unstamped area would be stamped at for you), stamped or not and the
//     distance from the spawn; Event 1403 lists the matches (sorted by the
//     distance from the spawn, so the same query always gives the same
//     list), optionally teleporting to one (the offset-th, or a random one).
//   - go: teleport near a point onto dry, walkable ground outside buildings,
//     with a few seconds of invulnerability.
//   - level: a dev override of an area's level (difficulty/dev.go): never
//     stored, reversible, logged; the area's atlas groups respawn at once at
//     the new level.
//   - spawn: the area's typical enemies (its biome's camp table, its region
//     element, its tier's beginner share) at a level.
//   - freeze: time, weather and enemies hold still (listening while
//     composing); demons: night demons off or on (zone-wide).
//   - here: Event 1404, the area you stand in and the vibe state.

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/combat"
)

// Interact 250 actions of the vibe explorer.
const (
	DevActVibeFind   = 29 // targetId/arg: VibeFilter.Pack
	DevActVibeGo     = 30 // targetId: x cm | z cm << 32; arg: invulnerable seconds (0 = 5)
	DevActVibeLevel  = 31 // targetId: area cell + 1 (0 = yours); arg: level (0 = clear, 0xffff = clear every override)
	DevActVibeSpawn  = 32 // arg: count | level << 8 (0 = the camp's count / the area's level)
	DevActVibeFreeze = 33 // arg: 1 on, 0 off
	DevActVibeDemons = 34 // arg: 1 off, 2 on
	DevActVibeHere   = 35 // send 1404
)

// Events of the vibe explorer (in the dev console's 1400-1419).
const (
	EventDevVibe     = 1403
	EventDevVibeHere = 1404
)

// VibeLandmarks are the landmark filter's keys; a filter's id is index + 1.
// client/src/ui/devconsole/vibe/filters.ts has the same list in the same
// order (vibe_test.go reads it).
var VibeLandmarks = []string{
	"settlement", "hamlet", "village", "town", "tower", "waypoint", "cave", "landmark", "enemy_camp",
	"ruin", "watchtower", "mineshaft", "shrine", "bandit_camp", "wizard_tower", "meteor_crater", "sunken_temple", "demon_lair",
	"vault", "heartfall", "event", "lake", "river", "coast", "peak", "forest", "wilds",
	"standing_stones", "great_tree", "stone_arch", "monolith", "giant_bones", "crystal_outcrop", "statue", "hot_spring",
}

// VibeBiomes are the atlas biomes by id (worldgen/README.md BIOME).
var VibeBiomes = []string{"meadow", "forest", "highlands", "snowpeak", "badlands", "wetland"}

var (
	vibeStructKinds = []string{"ruin", "watchtower", "mineshaft", "shrine", "bandit_camp", "wizard_tower", "meteor_crater", "sunken_temple", "demon_lair"}
	vibeVariants    = []string{"standing_stones", "great_tree", "stone_arch", "monolith", "giant_bones", "crystal_outcrop", "statue", "hot_spring"}
	vibeTownSizes   = []string{"hamlet", "village", "town"}
)

// Vibe search limits.
const (
	vibeMaxResults = 60
	vibeDefaultN   = 20
	vibeNearM      = 250.0 // "what's there": other places within this
	vibeLandingM   = 120.0 // a safe landing is searched this far
	vibeInvulnS    = 5
)

// VibeFilter is one search (Interact 250/29).
type VibeFilter struct {
	Biome    int // -1 any, else VibeBiomes index
	Landmark int // 0 any, else VibeLandmarks index + 1
	Region   int // -1 any
	LevelMin int // 0 open
	LevelMax int // 0 open
	Stamped  int // 0 any, 1 known (stamped, the Haven, an override), 2 unstamped
	DistMin  int // m from the spawn (64 m steps)
	DistMax  int // 0 open
	Tier     int // -1 any, else combat.yaml difficulty tier index
	N        int // results (0 = 20, at most 60)
	Offset   int // first match to list
	Go       bool
	Random   bool // a random match (then N = 1, Go)
}

// AnyVibe is the filter that matches everything.
func AnyVibe() VibeFilter { return VibeFilter{Biome: -1, Region: -1, Tier: -1} }

// Pack is the filter as Interact 250/29's targetId and arg:
// targetId = biome+1 | landmark << 4 | region+1 << 10 | levelMin << 18 |
// levelMax << 26 | stamped << 34 | distMin/64 << 36 | distMax/64 << 43 |
// tier+1 << 50; arg = n | offset << 8 | go << 20 | random << 21.
func (f VibeFilter) Pack() (uint64, uint32) {
	c := func(v, lo, hi int) uint64 { return uint64(max(lo, min(hi, v))) }
	t := c(f.Biome+1, 0, 15) | c(f.Landmark, 0, 63)<<4 | c(f.Region+1, 0, 255)<<10 | c(f.LevelMin, 0, 255)<<18 | c(f.LevelMax, 0, 255)<<26 |
		c(f.Stamped, 0, 3)<<34 | c(f.DistMin/64, 0, 127)<<36 | c(f.DistMax/64, 0, 127)<<43 | c(f.Tier+1, 0, 15)<<50
	a := uint32(c(f.N, 0, 255)) | uint32(c(f.Offset, 0, 4095))<<8
	if f.Go {
		a |= 1 << 20
	}
	if f.Random {
		a |= 1 << 21
	}
	return t, a
}

// UnpackVibeFilter reads Interact 250/29.
func UnpackVibeFilter(t uint64, a uint32) VibeFilter {
	return VibeFilter{
		Biome: int(t&0xf) - 1, Landmark: int(t >> 4 & 0x3f), Region: int(t>>10&0xff) - 1, LevelMin: int(t >> 18 & 0xff), LevelMax: int(t >> 26 & 0xff),
		Stamped: int(t >> 34 & 0x3), DistMin: int(t>>36&0x7f) * 64, DistMax: int(t>>43&0x7f) * 64, Tier: int(t>>50&0xf) - 1,
		N: int(a & 0xff), Offset: int(a >> 8 & 0xfff), Go: a>>20&1 != 0, Random: a>>21&1 != 0,
	}
}

// vibeSpot is one place the search can return.
type vibeSpot struct {
	kind string // a VibeLandmarks key
	name string
	x, z float64
	near bool // shown in other spots' "what's there"
}

// vibeGlue is the zone's vibe explorer state (inside devGlue).
type vibeGlue struct {
	spots   []vibeSpot // static (built once)
	built   bool
	rng     uint64
	frozen  bool                   // freeze vibe on
	wasTime bool                   // the clock was already frozen before
	wasWx   int                    // the weather override before
	marked  map[*combat.Group]bool // groups the freeze stopped
	was     map[int]string         // overridden areas: what they showed before (log)
}

// ---- the index ----

func (s *Server) vibeAtlas() *combat.AtlasInfo {
	if s.cbt.w == nil {
		return nil
	}
	return s.cbt.w.Atlas
}

func vibeName(name, kind string) string {
	if name != "" {
		return name
	}
	return "a " + strings.ReplaceAll(kind, "_", " ")
}

// vibeIndex builds the static spots once: the atlas sites, the vaults, the
// Heartfall, the terrain features and one wilds spot per area.
func (s *Server) vibeIndex() []vibeSpot {
	v := &s.dev.vibe
	if v.built {
		return v.spots
	}
	v.built = true
	a := s.vibeAtlas()
	if a == nil {
		return nil
	}
	add := func(kind, name string, x, z float64, near bool) {
		v.spots = append(v.spots, vibeSpot{kind: kind, name: vibeName(name, kind), x: x, z: z, near: near})
	}
	for i := range a.Sites {
		st := &a.Sites[i].Site
		switch st.Category {
		case structures.CategorySettlement:
			add(vibeTownSizes[min(int(st.Size), 2)], st.Name, st.X, st.Z, true)
		case structures.CategoryStructure:
			if int(st.Kind) < len(vibeStructKinds) {
				add(vibeStructKinds[st.Kind], st.Name, st.X, st.Z, true)
			}
		case structures.CategoryPOI:
			switch st.Kind {
			case structures.POITower:
				add("tower", s.regionName(int(st.Region))+" tower", st.X, st.Z, true)
			case structures.POICaveMouth:
				add("cave", st.Name, st.X, st.Z, true)
			case structures.POIWaypoint:
				if st.Size == 0 { // wilderness waypoints (a settlement's is the settlement)
					add("waypoint", st.Name, st.X, st.Z, false)
				}
			case structures.POILandmark:
				add(vibeVariants[min(int(st.Size), len(vibeVariants)-1)], st.Name, st.X, st.Z, true)
			case structures.POIEnemyCamp:
				add("enemy_camp", st.Name, st.X, st.Z, true)
			}
		}
	}
	if s.cfg.Explore != nil {
		vs := s.vaultPlans()
		keys := make([]int, 0, len(vs))
		for k := range vs {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			add("vault", vs[k].Name, vs[k].Door.X, vs[k].Door.Z, true)
		}
	}
	if p := s.storyPlaces(); p != nil && p.Heartfall.OK {
		add("heartfall", "the Heartfall", p.Heartfall.X, p.Heartfall.Z, true)
	}
	mg, mok := s.vibeMacro(a)
	if mok {
		s.vibeTerrain(a, mg, add)
	}
	cellM := combatdefs.D.Difficulty.CellM
	per := max(1, int(math.Round(a.WorldSize/cellM)))
	for c := 0; c < per*per; c++ {
		x, z := (float64(c%per)+0.5)*cellM, (float64(c/per)+0.5)*cellM
		if mok && mg.wet(x, z) {
			continue // open water: no wilds to stand in
		}
		add("wilds", "the wilds of "+s.regionName(a.RegionAt(x, z)), x, z, false)
	}
	return v.spots
}

// vibeMacroGrid wraps the atlas macro grid with the lookups the features need.
type vibeMacroGrid struct {
	combat.MacroGrid
	sea float32
}

func (g vibeMacroGrid) node(x, z float64) int {
	i := min(g.N-1, max(0, int(math.Round(x/g.Res))))
	j := min(g.N-1, max(0, int(math.Round(z/g.Res))))
	return j*g.N + i
}

// wet: the node nearest (x, z) is under water (sea or lake).
func (g vibeMacroGrid) wet(x, z float64) bool {
	k := g.node(x, z)
	return g.Water[k] > g.Height[k]+0.3 || g.Flags[k]&(combat.NodeSea|combat.NodeLake) != 0
}

func (s *Server) vibeMacro(a *combat.AtlasInfo) (vibeMacroGrid, bool) {
	mg, ok := a.Macro()
	return vibeMacroGrid{MacroGrid: mg, sea: float32(a.SeaLevel)}, ok
}

// vibeTerrain adds the macro terrain's features: per 256 m area at most one
// peak (the highest summit standing 30 m over its surroundings in the top
// quarter of the land), one lake shore, one river bank and one coast (the
// dry node nearest the area's centre beside that water).
func (s *Server) vibeTerrain(a *combat.AtlasInfo, g vibeMacroGrid, add func(kind, name string, x, z float64, near bool)) {
	n := g.N
	dry := func(k int) bool {
		return g.Flags[k]&(combat.NodeSea|combat.NodeLake) == 0 && g.Water[k] <= g.Height[k]+0.3
	}
	var land []float32
	for k := range g.Height {
		if dry(k) {
			land = append(land, g.Height[k])
		}
	}
	if len(land) == 0 {
		return
	}
	slices.Sort(land)
	high := land[len(land)*3/4]
	cellM := combatdefs.D.Difficulty.CellM
	per := max(1, int(math.Round(a.WorldSize/cellM)))
	type best struct {
		k   int
		v   float64
		set bool
	}
	peaks := make([]best, per*per)
	shores := map[string][]best{"lake": make([]best, per*per), "river": make([]best, per*per), "coast": make([]best, per*per)}
	rad := max(2, int(math.Round(160/g.Res)))
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			k := j*n + i
			if !dry(k) {
				continue
			}
			x, z := float64(i)*g.Res, float64(j)*g.Res
			if x < 8 || z < 8 || x > a.WorldSize-8 || z > a.WorldSize-8 {
				continue
			}
			c := min(per-1, int(z/cellM))*per + min(per-1, int(x/cellM))
			h := g.Height[k]
			// A peak: the highest node around and 30 m over the lowest.
			if h >= high {
				top, lo := true, h
				for dj := -rad; dj <= rad && top; dj++ {
					for di := -rad; di <= rad; di++ {
						ii, jj := i+di, j+dj
						if ii < 0 || jj < 0 || ii >= n || jj >= n || (di == 0 && dj == 0) {
							continue
						}
						o := g.Height[jj*n+ii]
						if o > h || (o == h && jj*n+ii < k) {
							top = false
							break
						}
						lo = min(lo, o)
					}
				}
				if top && h-lo >= 30 && (!peaks[c].set || float64(h) > peaks[c].v) {
					peaks[c] = best{k, float64(h), true}
				}
			}
			// Shores: a dry node beside sea, lake or river nodes.
			var f uint8
			for dj := -1; dj <= 1; dj++ {
				for di := -1; di <= 1; di++ {
					ii, jj := i+di, j+dj
					if ii >= 0 && jj >= 0 && ii < n && jj < n {
						f |= g.Flags[jj*n+ii]
					}
				}
			}
			cx, cz := (float64(c%per)+0.5)*cellM, (float64(c/per)+0.5)*cellM
			d := math.Hypot(x-cx, z-cz)
			for kind, bit := range map[string]uint8{"lake": combat.NodeLake, "river": combat.NodeRiver, "coast": combat.NodeSea} {
				if f&bit != 0 && (!shores[kind][c].set || d < shores[kind][c].v) {
					shores[kind][c] = best{k, d, true}
				}
			}
		}
	}
	pos := func(k int) (float64, float64) { return float64(k%n) * g.Res, float64(k/n) * g.Res }
	for c := range peaks {
		if peaks[c].set {
			x, z := pos(peaks[c].k)
			add("peak", fmt.Sprintf("a peak in %s (%.0f m)", s.regionName(a.RegionAt(x, z)), peaks[c].v-float64(g.sea)), x, z, true)
		}
		for _, kind := range []string{"lake", "river", "coast"} {
			if b := shores[kind][c]; b.set {
				x, z := pos(b.k)
				label := map[string]string{"lake": "a lake shore", "river": "a river bank", "coast": "the coast"}[kind]
				add(kind, label+" in "+s.regionName(a.RegionAt(x, z)), x, z, false)
			}
		}
	}
}

// vibeSpots is the index plus what lives now (world events).
func (s *Server) vibeSpots() []vibeSpot {
	out := slices.Clip(s.vibeIndex())
	for _, w := range s.cnt.ev.active {
		if !w.done {
			out = append(out, vibeSpot{kind: "event", name: w.kind.Name, x: w.pos.X, z: w.pos.Z, near: true})
		}
	}
	return out
}

// ---- matching ----

// vibeArea is what the difficulty map says of a spot: its area cell, level,
// tier index and state (haven, stamped, provisional, override, unstamped:
// then the level a player of playerLevel would stamp it at now; off: no
// difficulty on this zone).
func (s *Server) vibeArea(x, z float64, playerLevel int) (cell, level, tier int, state string) {
	if !s.diff.on {
		return -1, 0, -1, "off"
	}
	m := s.diff.m
	c := m.Cell(x, z)
	def := &combatdefs.D.Difficulty
	switch {
	case m.DevOverridden(c) > 0:
		state = "override"
	case m.Haven(c):
		state = "haven"
	case m.Stamped(c):
		state = "stamped"
	default:
		if _, ok := m.Level(c); ok {
			state = "provisional"
		} else {
			state = "unstamped"
		}
	}
	if state == "unstamped" {
		l := m.Projected(c, playerLevel)
		_, ti := def.TierFor(l)
		return c, l, ti, state
	}
	l, _ := m.Level(c)
	_, ti, _ := m.Tier(c)
	return c, l, ti, state
}

func vibeKindMatches(want, kind string, biome int) bool {
	switch want {
	case "settlement":
		return slices.Contains(vibeTownSizes, kind)
	case "landmark":
		return slices.Contains(vibeVariants, kind)
	case "forest":
		return kind == "wilds" && biome == 1
	}
	return want == kind
}

// VibeResult is one match (Event 1403/1404 JSON).
type VibeResult struct {
	I      int      `json:"i"` // index in the sorted match list
	Name   string   `json:"n"`
	Kind   string   `json:"k"`
	X      float64  `json:"x"`
	Z      float64  `json:"z"`
	Biome  string   `json:"b"`
	Region string   `json:"r"`
	RegI   int      `json:"ri"`
	Cell   int      `json:"c"`
	Level  int      `json:"lv"`
	Tier   string   `json:"t"`
	State  string   `json:"st"`
	Dist   int      `json:"d"`  // m from the spawn
	You    int      `json:"dy"` // m from you
	Near   []string `json:"near"`
}

// VibeFind is Event 1403's data.
type VibeFind struct {
	Total   int          `json:"total"`
	Offset  int          `json:"offset"`
	Results []VibeResult `json:"results"`
	Regions []string     `json:"regions"`
	Went    int          `json:"went"` // the match teleported to (-1 none)
	Landed  [3]float64   `json:"landed"`
}

func (s *Server) vibeResult(sp vibeSpot, i int, from movement.Vec3, playerLevel int, spots []vibeSpot) VibeResult {
	a := s.vibeAtlas()
	b := a.BiomeAt(sp.x, sp.z)
	r := a.RegionAt(sp.x, sp.z)
	c, lv, ti, st := s.vibeArea(sp.x, sp.z, playerLevel)
	tier := ""
	if ti >= 0 && ti < len(combatdefs.D.Difficulty.Tiers) {
		tier = combatdefs.D.Difficulty.Tiers[ti].Key
	}
	type nd struct {
		s string
		d float64
	}
	var near []nd
	for _, o := range spots {
		if !o.near || (o.x == sp.x && o.z == sp.z) {
			continue
		}
		if d := math.Hypot(o.x-sp.x, o.z-sp.z); d <= vibeNearM {
			near = append(near, nd{fmt.Sprintf("%s (%s) %.0f m", o.name, strings.ReplaceAll(o.kind, "_", " "), d), d})
		}
	}
	slices.SortFunc(near, func(p, q nd) int {
		if p.d != q.d {
			return cmpF(p.d, q.d)
		}
		return strings.Compare(p.s, q.s)
	})
	res := VibeResult{I: i, Name: sp.name, Kind: sp.kind, X: math.Round(sp.x*10) / 10, Z: math.Round(sp.z*10) / 10, Biome: VibeBiomes[min(5, max(0, b))], Region: s.regionName(r), RegI: r,
		Cell: c, Level: lv, Tier: tier, State: st, Dist: int(math.Round(math.Hypot(sp.x-a.SpawnX, sp.z-a.SpawnZ))), You: int(math.Round(math.Hypot(sp.x-from.X, sp.z-from.Z)))}
	for k := 0; k < len(near) && k < 4; k++ {
		res.Near = append(res.Near, near[k].s)
	}
	return res
}

func cmpF(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// VibeSearch returns the sorted matches of f (every one, full records) for
// a player of playerLevel at from. Deterministic: sorted by the distance
// from the spawn, then kind, name and position.
func (s *Server) VibeSearch(f VibeFilter, from movement.Vec3, playerLevel int) []VibeResult {
	a := s.vibeAtlas()
	if a == nil {
		return nil
	}
	spots := s.vibeSpots()
	want := ""
	if f.Landmark >= 1 && f.Landmark <= len(VibeLandmarks) {
		want = VibeLandmarks[f.Landmark-1]
	}
	type m struct {
		sp vibeSpot
		d  float64
	}
	var ms []m
	for _, sp := range spots {
		b := a.BiomeAt(sp.x, sp.z)
		if f.Biome >= 0 && b != f.Biome {
			continue
		}
		if want != "" && !vibeKindMatches(want, sp.kind, b) {
			continue
		}
		if f.Region >= 0 && a.RegionAt(sp.x, sp.z) != f.Region {
			continue
		}
		d := math.Hypot(sp.x-a.SpawnX, sp.z-a.SpawnZ)
		if d < float64(f.DistMin) || (f.DistMax > 0 && d > float64(f.DistMax)) {
			continue
		}
		if f.LevelMin > 0 || f.LevelMax > 0 || f.Stamped != 0 || f.Tier >= 0 {
			_, lv, ti, st := s.vibeArea(sp.x, sp.z, playerLevel)
			if st == "off" {
				continue
			}
			if (f.LevelMin > 0 && lv < f.LevelMin) || (f.LevelMax > 0 && lv > f.LevelMax) || (f.Tier >= 0 && ti != f.Tier) {
				continue
			}
			if (f.Stamped == 1 && st == "unstamped") || (f.Stamped == 2 && st != "unstamped") {
				continue
			}
		}
		ms = append(ms, m{sp, d})
	}
	slices.SortStableFunc(ms, func(p, q m) int {
		if c := cmpF(p.d, q.d); c != 0 {
			return c
		}
		if c := strings.Compare(p.sp.kind, q.sp.kind); c != 0 {
			return c
		}
		if c := strings.Compare(p.sp.name, q.sp.name); c != 0 {
			return c
		}
		return cmpF(p.sp.x, q.sp.x)
	})
	out := make([]VibeResult, len(ms))
	for i := range ms {
		out[i] = s.vibeResult(ms[i].sp, i, from, playerLevel, spots)
	}
	return out
}

// ---- landing ----

// vibeInBuilding: (x, z) is inside (or within margin of) a town building.
func (s *Server) vibeInBuilding(x, z, margin float64) bool {
	tw := s.cfg.Towns
	if tw == nil {
		return false
	}
	for si := range tw.T.Settlements {
		st := &tw.T.Settlements[si]
		if math.Hypot(x-st.X, z-st.Z) > st.Radius+60 {
			continue
		}
		for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
			bd := &tw.T.Buildings[b]
			dx, dz := x-bd.X, z-bd.Z
			u := dx*bd.C + dz*bd.S
			v := dz*bd.C - dx*bd.S
			if math.Abs(u) < bd.HX+margin && math.Abs(v) < bd.HZ+margin {
				return true
			}
		}
	}
	return false
}

// VibeLandingOK: a body can stand at (x, z): inside the world, dry, a
// walkable slope with level room around, clear of buildings, camp pieces
// and solid town boxes.
func (s *Server) VibeLandingOK(x, z float64) bool {
	g := s.cfg.Ground
	const edge = 6.0
	if x < edge || z < edge || x > constants.WorldSizeM-edge || z > constants.WorldSizeM-edge {
		return false
	}
	h := g.HeightAt(x, z)
	if movement.WaterAt(g, x, z) > h-0.3 || movement.SlopeAt(g, x, z).T2 > constants.WalkableTanSq*0.6 {
		return false
	}
	for k := 0; k < 6; k++ {
		a := float64(k) * math.Pi / 3
		qx, qz := x+1.6*math.Cos(a), z+1.6*math.Sin(a)
		qh := g.HeightAt(qx, qz)
		if movement.WaterAt(g, qx, qz) > qh-0.3 || math.Abs(qh-h) > 1.0 {
			return false
		}
	}
	if s.vibeInBuilding(x, z, 1.5) {
		return false
	}
	if s.obst.b != nil && s.obst.b.Blocked(x, h, z, 0.9, 1.8) {
		return false
	}
	return !s.camp.set.Blocked(x, h, z, 0.9, 1.8)
}

// VibeLanding is the nearest safe standing spot to (x, z) within
// vibeLandingM (rings outward); ok=false: none (the point itself).
func (s *Server) VibeLanding(x, z float64) (float64, float64, bool) {
	for r := 0.0; r <= vibeLandingM; r += 3 {
		n := max(1, int(r*2*math.Pi/3))
		for i := 0; i < n; i++ {
			a := float64(i) / float64(n) * 2 * math.Pi
			if px, pz := x+r*math.Cos(a), z+r*math.Sin(a); s.VibeLandingOK(px, pz) {
				return px, pz, true
			}
		}
	}
	return x, z, false
}

// vibeGo teleports onto safe ground near (x, z) with invulnerability.
func (s *Server) vibeGo(sess *session, x, z float64, secs int) (movement.Vec3, bool) {
	e := sess.ent
	lx, lz, ok := s.VibeLanding(x, z)
	pos := movement.Vec3{X: lx, Y: s.cfg.Ground.HeightAt(lx, lz), Z: lz}
	s.Teleport(e, pos)
	if secs <= 0 {
		secs = vibeInvulnS
	}
	sess.dev.invulnUntil = s.tick + uint32(secs*constants.TickRateHz)
	if e.cbt != nil {
		e.cbt.DevGod = true
	}
	return e.Move.Pos, ok
}

// ---- the commands ----

func (s *Server) vibeApply(sess *session, m *proto.Interact) (int32, string) {
	switch m.Action {
	case DevActVibeFind:
		return s.vibeFind(sess, UnpackVibeFilter(m.TargetID, m.Arg))
	case DevActVibeGo:
		x := proto.CmToMeters(int32(uint32(m.TargetID)))
		z := proto.CmToMeters(int32(uint32(m.TargetID >> 32)))
		if x < 0 || z < 0 || x >= constants.WorldSizeM || z >= constants.WorldSizeM {
			return devBad("outside the world (0-%d m)", constants.WorldSizeM)
		}
		secs := int(min(m.Arg, 600))
		if secs <= 0 {
			secs = vibeInvulnS
		}
		p, ok := s.vibeGo(sess, x, z, secs)
		note := ""
		if !ok {
			note = " (no dry, level ground within 120 m: as close as it gets)"
		}
		return devOK("landed at %.0f %.0f %.0f, %.0f m from the target, invulnerable %ds%s", p.X, p.Y, p.Z, math.Hypot(p.X-x, p.Z-z), secs, note)
	case DevActVibeLevel:
		return s.vibeLevel(sess, int(m.TargetID), int(m.Arg))
	case DevActVibeSpawn:
		return s.vibeSpawn(sess, int(m.Arg&0xff), int(m.Arg>>8&0xff))
	case DevActVibeFreeze:
		return s.vibeFreeze(sess, m.Arg != 0)
	case DevActVibeDemons:
		return s.vibeDemons(m.Arg)
	}
	return DevUnknown, "unknown vibe command"
}

func (s *Server) vibeFind(sess *session, f VibeFilter) (int32, string) {
	a := s.vibeAtlas()
	if a == nil {
		return devFailed("no world atlas on this zone")
	}
	e := sess.ent
	all := s.VibeSearch(f, e.Move.Pos, sess.x.levelOr(1))
	total := len(all)
	if f.Random && total > 0 {
		v := &s.dev.vibe
		v.rng = vibeMix(v.rng + uint64(s.tick) + 0x9e3779b97f4a7c15)
		f.Offset, f.N, f.Go = int(v.rng%uint64(total)), 1, true
	}
	n := f.N
	if n <= 0 {
		n = vibeDefaultN
	}
	n = min(n, vibeMaxResults)
	off := min(f.Offset, total)
	page := all[off:min(total, off+n)]
	out := VibeFind{Total: total, Offset: off, Results: page, Went: -1}
	if out.Results == nil {
		out.Results = []VibeResult{}
	}
	for r := range a.Regions {
		out.Regions = append(out.Regions, s.regionName(r))
	}
	msg := fmt.Sprintf("%d matches", total)
	if f.Go && len(page) > 0 {
		p, ok := s.vibeGo(sess, page[0].X, page[0].Z, 0)
		out.Went, out.Landed = page[0].I, [3]float64{math.Round(p.X*10) / 10, math.Round(p.Y*10) / 10, math.Round(p.Z*10) / 10}
		msg += fmt.Sprintf("; went to #%d %s (%s, %s, level %d %s)", page[0].I+1, page[0].Name, page[0].Kind, page[0].Biome, page[0].Level, page[0].State)
		if !ok {
			msg += " (no safe ground within 120 m: as close as it gets)"
		}
	} else if f.Go {
		msg += "; nowhere to go"
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventDevVibe, EntityID: e.ID, Value: int32(total), TargetID: uint32(off), Data: b})
	if total == 0 && !f.Go {
		return devOK("no matches")
	}
	return devOK("%s", msg)
}

func vibeMix(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	return x ^ x>>31
}

// vibeLevel overrides (level > 0) or clears (0) the level of an area (cell
// + 1, 0 = the player's), or clears every override (0xffff), and respawns
// the area's groups at once.
func (s *Server) vibeLevel(sess *session, cell1, level int) (int32, string) {
	if !s.diff.on {
		return devFailed("no area difficulty on this zone")
	}
	m := s.diff.m
	v := &s.dev.vibe
	if v.was == nil {
		v.was = map[int]string{}
	}
	if level == 0xffff {
		cells := m.DevOverrides()
		for _, c := range cells {
			s.vibeSetLevel(sess, c, 0)
		}
		return devOK("cleared %d area override(s)", len(cells))
	}
	if level < 0 || level > combatdefs.D.Difficulty.MaxLevel {
		return devBad("area level 1-%d (0 clears)", combatdefs.D.Difficulty.MaxLevel)
	}
	c := cell1 - 1
	if cell1 == 0 {
		c = m.Cell(sess.ent.Move.Pos.X, sess.ent.Move.Pos.Z)
	}
	if c < 0 || c >= m.Cells() {
		return devBad("no area %d", c)
	}
	return s.vibeSetLevel(sess, c, level)
}

func (s *Server) vibeSetLevel(sess *session, c, level int) (int32, string) {
	m := s.diff.m
	v := &s.dev.vibe
	cx0, cz0 := m.Center(c)
	_, _, _, before := s.vibeArea(cx0, cz0, sess.x.levelOr(1))
	prev, known := m.DevOverride(c, level)
	was := "unknown"
	if known {
		was = fmt.Sprintf("level %d (%s)", prev, before)
	}
	if level > 0 {
		if _, ok := v.was[c]; !ok {
			v.was[c] = was
		}
	} else {
		delete(v.was, c)
	}
	groups, removed := 0, 0
	if s.cbt.w != nil {
		x0, z0, x1, z1 := m.Square(c)
		groups, removed = s.cbt.w.DevRespawnArea(x0, z0, x1, z1)
	}
	now := "cleared"
	l, ok := m.Level(c)
	if ok {
		t, _, _ := m.Tier(c)
		now = fmt.Sprintf("level %d (%s)", l, t.Name)
	}
	s.log.Info("dev vibe area level", "character", sess.ent.CharacterID, "cell", c, "was", was, "override", level, "now", now, "groups", groups, "removed", removed)
	for _, o := range s.sessions {
		if e := o.ent; e != nil && m.Cell(e.Move.Pos.X, e.Move.Pos.Z) == c {
			if ok {
				s.sendArea(o, c, false)
			}
			if o.dev != nil {
				s.sendVibeHere(o)
			}
		}
	}
	cx, cz := m.XZ(c)
	if level == 0 {
		return devOK("area %d (%d,%d) back to %s; %d group(s) respawn", c, cx, cz, now, groups)
	}
	return devOK("area %d (%d,%d) now %s (was %s); %d group(s) respawn (%d enemies removed)", c, cx, cz, now, was, groups, removed)
}

func (s *Server) vibeSpawn(sess *session, n, level int) (int32, string) {
	w, a, e := s.cbt.w, s.vibeAtlas(), sess.ent
	if w == nil || a == nil {
		return devFailed("no combat or atlas on this zone")
	}
	x, z := ahead(e, 14)
	x, z = w.WalkableNear(x, z, 40, 3)
	biome := a.BiomeAt(x, z)
	el := a.Region(a.RegionAt(x, z)).Element
	var tier *combatdefs.DifficultyTier
	if t, l, ok := s.AreaTier(x, z); ok {
		tier = t
		if level == 0 {
			level = l
		}
	}
	if level == 0 {
		level = max(1, sess.x.levelOr(1))
	}
	if n > 20 {
		return devBad("count 0-20 (0 = a camp's own)")
	}
	v := &s.dev.vibe
	v.rng = vibeMix(v.rng + uint64(s.tick))
	g := w.DevTypical(movement.Vec3{X: x, Z: z}, biome, el, level, tier, n, v.rng)
	if g == nil {
		return devFailed("nothing typical to spawn here")
	}
	if v.frozen {
		g.Dummy = true
		v.marked[g] = true
	}
	s.dev.groups = append(s.dev.groups, g)
	tn := "no tier"
	if tier != nil {
		tn = tier.Name
	}
	return devOK("%d typical %s enemies (level %d, %s): %s", len(g.Comp), VibeBiomes[min(5, max(0, biome))], level, tn, strings.Join(g.Comp, ", "))
}

// vibeFreeze holds time, weather and enemies (on) or lets them go (off).
func (s *Server) vibeFreeze(sess *session, on bool) (int32, string) {
	v := &s.dev.vibe
	if on == v.frozen {
		if on {
			return devOK("the vibe is already frozen")
		}
		return devOK("the vibe is not frozen")
	}
	v.frozen = on
	e := sess.ent
	wx := "seeded weather"
	if on {
		v.wasTime = s.dev.frozen
		if !s.dev.frozen {
			s.dev.frozen = true
			s.dev.frozenS = weather.TimeOfDayS(s.worldTimeS())
		}
		v.wasWx = -1
		if s.cfg.Weather != nil {
			v.wasWx = s.cfg.Weather.Override
		}
		if s.weatherOn() && v.wasWx < 0 {
			st := s.weatherStateAt(e.Move.Pos.X, e.Move.Pos.Z)
			s.devWeather(st)
			wx = weather.StateKeys[st]
		} else if v.wasWx >= 0 {
			wx = weather.StateKeys[v.wasWx]
		}
		if v.marked == nil {
			v.marked = map[*combat.Group]bool{}
		}
		if s.cbt.w != nil {
			s.cbt.w.DevFreeze(true, v.marked)
		}
	} else {
		if !v.wasTime {
			s.dev.frozen = false
		}
		if s.weatherOn() {
			s.devWeather(v.wasWx)
		}
		if s.cbt.w != nil {
			s.cbt.w.DevFreeze(false, v.marked)
		}
	}
	for _, o := range s.sessions {
		if o.dev != nil && o.ent != nil {
			s.sendDevStatus(o)
		}
	}
	s.log.Info("dev vibe freeze", "character", e.CharacterID, "on", on)
	if on {
		return devOK("vibe frozen: time %s, %s, enemies stand still (zone-wide)", hhmm(weather.Hour(s.worldTimeS())), wx)
	}
	return devOK("vibe unfrozen: time, weather and enemies move again")
}

func hhmm(h float64) string {
	return fmt.Sprintf("%02d:%02d", int(h)%24, int(math.Round((h-math.Floor(h))*60))%60)
}

// vibeDemons switches night demons off (1: the ones up now go too) or on (2).
func (s *Server) vibeDemons(mode uint32) (int32, string) {
	n := &s.night
	if !n.on {
		return devFailed("no night on this zone")
	}
	switch mode {
	case 1:
		n.cfg.NoDemons = true
		gone := 0
		for _, dg := range n.groups {
			for _, e := range dg.g.Members {
				if e.Alive() {
					gone++
				}
			}
			s.cbt.w.RemoveGroup(dg.g)
		}
		n.groups = nil
		return devOK("night demons off (%d removed; zone-wide)", gone)
	case 2:
		n.cfg.NoDemons = false
		return devOK("night demons on (they rise at night by the area's tier)")
	}
	return devBad("1 off, 2 on")
}

// vibeHere is Event 1404's data.
type vibeHere struct {
	Spot      VibeResult      `json:"spot"`
	Weather   string          `json:"weather"`
	Hour      float64         `json:"hour"`
	Frozen    bool            `json:"frozen"`
	Demons    bool            `json:"demons"`
	Invuln    float64         `json:"invuln"`
	Overrides []vibeOverrideJ `json:"overrides"`
}

type vibeOverrideJ struct {
	Cell  int     `json:"c"`
	Level int     `json:"lv"`
	Was   string  `json:"was"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
}

func (s *Server) sendVibeHere(sess *session) {
	e := sess.ent
	if e == nil || s.vibeAtlas() == nil {
		return
	}
	spots := s.vibeSpots()
	here := s.vibeResult(vibeSpot{kind: "here", name: "here", x: e.Move.Pos.X, z: e.Move.Pos.Z}, -1, e.Move.Pos, sess.x.levelOr(1), spots)
	out := vibeHere{Spot: here, Hour: math.Round(weather.Hour(s.worldTimeS())*100) / 100, Frozen: s.dev.vibe.frozen, Demons: s.night.on && !s.night.cfg.NoDemons, Overrides: []vibeOverrideJ{}}
	if s.weatherOn() {
		out.Weather = weather.StateKeys[s.weatherStateAt(e.Move.Pos.X, e.Move.Pos.Z)]
	}
	if d := sess.dev; d != nil && d.invulnUntil > s.tick {
		out.Invuln = float64(d.invulnUntil-s.tick) / constants.TickRateHz
	}
	if s.diff.on {
		for _, c := range s.diff.m.DevOverrides() {
			x, z := s.diff.m.Center(c)
			out.Overrides = append(out.Overrides, vibeOverrideJ{Cell: c, Level: s.diff.m.DevOverridden(c), Was: s.dev.vibe.was[c], X: x, Z: z})
		}
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventDevVibeHere, EntityID: e.ID, Value: int32(here.Level), TargetID: uint32(max(0, here.Cell)), Data: b})
}

// vibeTick keeps the freeze (every second: groups added since stand still
// too) and ends invulnerability (devTick).
func (s *Server) vibeTick(tick uint32, sess *session) {
	d, e := sess.dev, sess.ent
	if d.invulnUntil != 0 && e.cbt != nil {
		if tick < d.invulnUntil {
			e.cbt.DevGod = true
		} else {
			d.invulnUntil = 0
			e.cbt.DevGod = d.flags&DevFlagGod != 0
		}
	}
}

func (s *Server) vibeZoneTick(tick uint32) {
	v := &s.dev.vibe
	if v.frozen && s.cbt.w != nil && tick%constants.TickRateHz == 0 {
		s.cbt.w.DevFreeze(true, v.marked)
	}
}
