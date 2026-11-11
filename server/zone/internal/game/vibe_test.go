package game

// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md) on the official
// world: the search is deterministic and every filter holds, landings are
// dry, walkable and outside buildings, the area level override respawns the
// area's groups at the new level and clears back to what was there, and a
// zone without dev mode refuses all of it.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/night"
)

// vibeHarness: the official world (towns, map, combat atlas groups,
// discovery-stamped difficulty in memory), noon, demons off; Config.Dev = dev.
func vibeHarness(t *testing.T, dev bool) *harness {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	raw := testTerrain(t).World().Atlas
	sa, err := structures.ParseAtlas(raw)
	if err != nil {
		t.Fatal(err)
	}
	ca := combat.ParseAtlas(raw, sa)
	m := difficulty.New(&combatdefs.D.Difficulty, ca.WorldSize, ca.SpawnX, ca.SpawnZ, func(x, z float64) float64 { return ca.Region(ca.RegionAt(x, z)).Danger })
	store := &mountStore{fakeStore: &fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, steeds: map[string][]SteedRec{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Dev = dev
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Atlas: ca, Config: combat.Config{Seed: 42}}
		c.Difficulty = &DifficultySetup{Map: m}
	})
	h.srv.SetWorldEvents(false)
	return h
}

func vibeLandmark(key string) int { return slices.Index(VibeLandmarks, key) + 1 }

// The filter packing is shared with the client (filters.ts packVibe): the
// same vector on both sides.
func TestVibeFilterPack(t *testing.T) {
	f := VibeFilter{Biome: 1, Landmark: vibeLandmark("shrine"), Region: 3, LevelMin: 4, LevelMax: 8, Stamped: 1, DistMin: 256, DistMax: 2048, Tier: 2, N: 12, Offset: 5, Go: true}
	tg, arg := f.Pack()
	const wantT, wantA = uint64(3659467292938450), uint32(1049868)
	if tg != wantT || arg != wantA {
		t.Fatalf("pack = %d, %d; want %d, %d", tg, arg, wantT, wantA)
	}
	if got := UnpackVibeFilter(tg, arg); !reflect.DeepEqual(got, f) {
		t.Fatalf("round trip %+v != %+v", got, f)
	}
	if got := UnpackVibeFilter(AnyVibe().Pack()); !reflect.DeepEqual(got, AnyVibe()) {
		t.Fatalf("any: %+v", got)
	}
}

// client/src/ui/devconsole/vibe/filters.ts lists the same landmarks and
// biomes in the same order (the ids on the wire are their positions).
func TestVibeListsMatchClient(t *testing.T) {
	b, err := os.ReadFile("../../../../client/src/ui/devconsole/vibe/filters.ts")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	list := func(name string) []string {
		m := regexp.MustCompile(`(?s)export const ` + name + ` = \[(.*?)\]`).FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("no %s in filters.ts", name)
		}
		var out []string
		for _, q := range regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(m[1], -1) {
			out = append(out, q[1])
		}
		return out
	}
	if got := list("VIBE_LANDMARKS"); !slices.Equal(got, VibeLandmarks) {
		t.Fatalf("client landmarks %v\nzone %v", got, VibeLandmarks)
	}
	if got := list("VIBE_BIOMES"); !slices.Equal(got, VibeBiomes) {
		t.Fatalf("client biomes %v", got)
	}
}

func TestVibeSearchFiltersAndLandings(t *testing.T) {
	h := vibeHarness(t, true)
	h.do(func() {
		s := h.srv
		a := s.cbt.w.Atlas
		spawn := movement.Vec3{X: a.SpawnX, Z: a.SpawnZ}
		all := s.VibeSearch(AnyVibe(), spawn, 1)
		if len(all) < 300 {
			t.Fatalf("only %d spots", len(all))
		}
		if again := s.VibeSearch(AnyVibe(), spawn, 1); !reflect.DeepEqual(all, again) {
			t.Fatal("the same search gave a different list")
		}
		kinds := map[string]int{}
		biomes := map[string]int{}
		for i, r := range all {
			kinds[r.Kind]++
			biomes[r.Biome]++
			if r.I != i {
				t.Fatalf("result %d has index %d", i, r.I)
			}
			if i > 0 && r.Dist < all[i-1].Dist {
				t.Fatalf("not sorted by distance from the spawn at %d", i)
			}
		}
		t.Logf("%d spots: %v; biomes %v", len(all), kinds, biomes)
		for _, k := range []string{"hamlet", "village", "town", "tower", "cave", "shrine", "ruin", "watchtower", "vault", "heartfall", "peak", "wilds", "river"} {
			if kinds[k] == 0 {
				t.Errorf("no %s anywhere", k)
			}
		}
		if kinds["lake"]+kinds["coast"] == 0 {
			t.Error("no lake shore or coast anywhere")
		}
		// Every landmark filter returns only its kind.
		for id, key := range VibeLandmarks {
			f := AnyVibe()
			f.Landmark = id + 1
			for _, r := range s.VibeSearch(f, spawn, 1) {
				if !vibeKindMatches(key, r.Kind, slices.Index(VibeBiomes, r.Biome)) {
					t.Fatalf("landmark %s returned a %s (%s)", key, r.Kind, r.Name)
				}
			}
		}
		// Biome, region, distance, tier.
		for b, name := range VibeBiomes {
			f := AnyVibe()
			f.Biome = b
			rs := s.VibeSearch(f, spawn, 1)
			if len(rs) != biomes[name] {
				t.Errorf("biome %s: %d results, %d in the full list", name, len(rs), biomes[name])
			}
			for _, r := range rs {
				if r.Biome != name {
					t.Fatalf("biome %s returned %s", name, r.Biome)
				}
			}
		}
		f := AnyVibe()
		f.Region, f.DistMin, f.DistMax = 5, 640, 1920
		rs := s.VibeSearch(f, spawn, 1)
		if len(rs) == 0 {
			t.Fatal("nothing in region 5 between 640 and 1920 m")
		}
		for _, r := range rs {
			if r.RegI != 5 || r.Dist < 640 || r.Dist > 1920 {
				t.Fatalf("region/distance filter let %+v through", r)
			}
		}
		// The Haven is known (level 1); everything else is unstamped and
		// shows what a level-10 player would stamp it at.
		f = AnyVibe()
		f.Stamped = 1
		for _, r := range s.VibeSearch(f, spawn, 10) {
			if r.State != "haven" || r.Level != 1 || r.Tier != "haven" {
				t.Fatalf("known spot %+v", r)
			}
		}
		f.Stamped = 2
		f.LevelMin, f.LevelMax = 10, 12
		un := s.VibeSearch(f, spawn, 10)
		if len(un) == 0 {
			t.Fatal("no unstamped spot projected at 10-12 for a level-10 player")
		}
		for _, r := range un {
			if r.State != "unstamped" || r.Level < 10 || r.Level > 12 {
				t.Fatalf("unstamped 10-12: %+v", r)
			}
		}
		// An override is a known level: level 9 finds exactly that area.
		c := s.diff.m.Cell(un[0].X, un[0].Z)
		s.diff.m.DevOverride(c, 9)
		f = AnyVibe()
		f.LevelMin, f.LevelMax, f.Stamped = 9, 9, 1
		for _, r := range s.VibeSearch(f, spawn, 1) {
			if r.Cell != c || r.State != "override" || r.Tier != "perilous" {
				t.Fatalf("level 9 known: %+v", r)
			}
		}
		f.Tier = 3
		if len(s.VibeSearch(f, spawn, 1)) == 0 {
			t.Fatal("tier perilous found nothing in the overridden area")
		}
		s.diff.m.DevOverride(c, 0)

		// Safe landings: dry, walkable, outside buildings, near the spot.
		for _, k := range []string{"town", "village", "hamlet", "lake", "coast", "river", "peak", "cave", "shrine", "tower", "heartfall", "bandit_camp"} {
			f := AnyVibe()
			f.Landmark = vibeLandmark(k)
			rs := s.VibeSearch(f, spawn, 1)
			for i := 0; i < len(rs) && i < 3; i++ {
				r := rs[i]
				x, z, ok := s.VibeLanding(r.X, r.Z)
				g := s.cfg.Ground
				hgt := g.HeightAt(x, z)
				if !ok || movement.WaterAt(g, x, z) > hgt-0.3 || s.vibeInBuilding(x, z, 1) || math.Hypot(x-r.X, z-r.Z) > vibeLandingM+1 {
					t.Errorf("%s %q: landing %.1f %.1f ok=%v water %.2f ground %.2f in building %v", k, r.Name, x, z, ok, movement.WaterAt(g, x, z), hgt, s.vibeInBuilding(x, z, 1))
				}
			}
		}
	})
}

// vibeFindAndGo runs Interact 250/29 and reads Event 1403.
func (cl *client) vibeFind(t *testing.T, f VibeFilter) VibeFind {
	t.Helper()
	tg, arg := f.Pack()
	cl.devOK(t, DevActVibeFind, tg, arg)
	ev := cl.take(EventDevVibe, 3*time.Second)
	var out VibeFind
	if err := json.Unmarshal(ev.Data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestVibeCommands(t *testing.T) {
	h := vibeHarness(t, true)
	var sx, sz float64
	h.do(func() { sx, sz = h.srv.cbt.w.Atlas.SpawnX, h.srv.cbt.w.Atlas.SpawnZ })
	a := h.dial(spawnAt(sx+30, sz+30))
	a.join(h, "vibe", "Vibe")
	a.pump(300 * time.Millisecond)
	sess := func() *session { return h.srv.byChar["vibe"] }

	// Find lake shores and go to the first: dry ground, invulnerable.
	f := AnyVibe()
	f.Landmark, f.N, f.Go = vibeLandmark("lake"), 5, true
	res := a.vibeFind(t, f)
	if res.Total == 0 {
		f.Landmark = vibeLandmark("coast")
		res = a.vibeFind(t, f)
	}
	if res.Went != 0 || len(res.Results) == 0 || len(res.Regions) == 0 {
		t.Fatalf("find+go: %+v", res)
	}
	here := a.take(EventDevVibeHere, 3*time.Second)
	var hj vibeHere
	_ = json.Unmarshal(here.Data, &hj)
	h.do(func() {
		e := sess().ent
		g := h.srv.cfg.Ground
		p := e.Move.Pos
		if movement.WaterAt(g, p.X, p.Z) > g.HeightAt(p.X, p.Z)-0.3 || math.Hypot(p.X-res.Results[0].X, p.Z-res.Results[0].Z) > vibeLandingM+1 {
			t.Errorf("landed in water or far: %v vs %+v", p, res.Results[0])
		}
		if !e.cbt.DevGod || sess().dev.invulnUntil == 0 {
			t.Error("not invulnerable after landing")
		}
	})
	if hj.Invuln <= 0 || hj.Spot.Kind != "here" {
		t.Errorf("here after go: %+v", hj)
	}

	// Go with one second of invulnerability: it ends.
	a.devOK(t, DevActVibeGo, uint64(uint32(int32((sx+60)*100)))|uint64(uint32(int32((sz+20)*100)))<<32, 1)
	a.pump(1600 * time.Millisecond)
	h.do(func() {
		if sess().ent.cbt.DevGod {
			t.Error("still invulnerable after 1 s")
		}
	})

	// A random match with a biome filter lands in that biome's list.
	f = AnyVibe()
	f.Biome, f.Random = 1, true
	res = a.vibeFind(t, f)
	if res.Went < 0 || len(res.Results) != 1 || res.Results[0].Biome != "forest" {
		t.Fatalf("random forest: %+v", res)
	}

	// Area level override in the Haven: stand by one of its packs (level
	// 1), override the area to 12: the pack respawns at 12; cleared, the
	// Haven again.
	var cell int
	var anchor movement.Vec3
	h.do(func() {
		m := h.srv.diff.m
		best := math.Inf(1)
		for _, g := range h.srv.cbt.w.Groups {
			c := m.Cell(g.Anchor.X, g.Anchor.Z)
			if d := math.Hypot(g.Anchor.X-sx, g.Anchor.Z-sz); g.AreaLevel && g.Kind != combat.GroupBoss && m.Haven(c) && d < best {
				best, cell, anchor = d, c, g.Anchor
			}
		}
		if math.IsInf(best, 1) {
			t.Fatal("no atlas group in the Haven")
		}
	})
	a.devOK(t, DevActVibeGo, uint64(uint32(int32((anchor.X+8)*100)))|uint64(uint32(int32(anchor.Z*100)))<<32, 30)
	levelsIn := func() (n int, levels []int) {
		h.do(func() {
			x0, z0, x1, z1 := h.srv.diff.m.Square(cell)
			for _, e := range h.srv.cbt.w.Enemies() {
				if g := e.Group; g != nil && g.AreaLevel && e.Alive() && g.Anchor.X >= x0 && g.Anchor.X < x1 && g.Anchor.Z >= z0 && g.Anchor.Z < z1 {
					n++
					levels = append(levels, e.Level)
				}
			}
		})
		return
	}
	a.pump(1500 * time.Millisecond)
	n0, lv0 := levelsIn()
	if n0 == 0 || slices.Max(lv0) != 1 {
		t.Fatalf("before: %d enemies at levels %v", n0, lv0)
	}
	msg := a.devOK(t, DevActVibeLevel, 0, 12)
	if !strings.Contains(msg, "level 12") {
		t.Fatalf("override: %s", msg)
	}
	a.pump(2000 * time.Millisecond)
	h.do(func() {
		m := h.srv.diff.m
		if l, _ := m.Level(cell); l != 12 || m.Haven(cell) {
			t.Fatalf("area %d after override: level %d haven %v", cell, l, m.Haven(cell))
		}
	})
	n1, lv1 := levelsIn()
	t.Logf("area %d: %d enemies at %v before, %d at %v after", cell, n0, lv0, n1, lv1)
	if n1 == 0 || slices.Min(lv1) != 12 || slices.Max(lv1) != 12 {
		t.Fatalf("after the override: %d enemies at levels %v", n1, lv1)
	}
	a.devOK(t, DevActVibeLevel, 0, 0)
	h.do(func() {
		m := h.srv.diff.m
		if l, _ := m.Level(cell); l != 1 || !m.Haven(cell) || m.DevOverridden(cell) != 0 {
			t.Fatalf("cleared: level %d haven %v", l, m.Haven(cell))
		}
	})
	a.devOK(t, DevActVibeLevel, uint64(cell+2), 7)
	a.devOK(t, DevActVibeLevel, 0, 0xffff)
	h.do(func() {
		if n := len(h.srv.diff.m.DevOverrides()); n != 0 {
			t.Fatalf("%d overrides left after clear all", n)
		}
	})

	// Typical enemies, freeze, demons.
	msg = a.devOK(t, DevActVibeSpawn, 0, 3|5<<8)
	if !strings.Contains(msg, "level 5") {
		t.Fatalf("spawn: %s", msg)
	}
	a.devOK(t, DevActVibeFreeze, 0, 1)
	h.do(func() {
		s := h.srv
		if !s.dev.frozen || !s.dev.vibe.frozen || s.cfg.Weather != nil && s.weatherOn() && s.cfg.Weather.Override < 0 {
			t.Fatal("freeze did not hold time and weather")
		}
		for _, g := range s.cbt.w.Groups {
			if !g.Dummy {
				t.Fatal("a group still moves while frozen")
			}
		}
	})
	a.devOK(t, DevActVibeFreeze, 0, 0)
	h.do(func() {
		s := h.srv
		if s.dev.frozen || s.dev.vibe.frozen || len(s.dev.vibe.marked) != 0 || s.cfg.Weather != nil && s.cfg.Weather.Override >= 0 {
			t.Fatal("unfreeze did not restore")
		}
		for _, g := range s.cbt.w.Groups {
			if g.Dummy {
				t.Fatal("a group stays frozen")
			}
		}
	})
	a.devOK(t, DevActVibeDemons, 0, 2)
	h.do(func() {
		if h.srv.night.cfg.NoDemons {
			t.Error("demons still off")
		}
	})
	a.devOK(t, DevActVibeDemons, 0, 1)
	h.do(func() {
		if !h.srv.night.cfg.NoDemons {
			t.Error("demons still on")
		}
	})
}

func TestVibeRefusedWithoutTheFlag(t *testing.T) {
	h := vibeHarness(t, false)
	var sx, sz float64
	h.do(func() { sx, sz = h.srv.cbt.w.Atlas.SpawnX, h.srv.cbt.w.Atlas.SpawnZ })
	a := h.dial(spawnAt(sx, sz))
	a.join(h, "vibe-off", "Plain")
	a.pump(200 * time.Millisecond)
	tg, arg := VibeFilter{Biome: -1, Region: -1, Tier: -1, Go: true}.Pack()
	for _, c := range []struct {
		act uint8
		t   uint64
		a   uint32
	}{{DevActVibeFind, tg, arg}, {DevActVibeGo, 300000 | 300000<<32, 0}, {DevActVibeLevel, 0, 15}, {DevActVibeSpawn, 0, 3}, {DevActVibeFreeze, 0, 1}, {DevActVibeDemons, 0, 2}} {
		a.dev(c.act, c.t, c.a)
		if e := a.devResult(t, c.act); e.Value != DevOff {
			t.Fatalf("%s: value %d, want refused", devName(c.act), e.Value)
		}
	}
	a.dev(DevActVibeHere, 0, 0)
	a.pump(300 * time.Millisecond)
	if n := len(a.eventsOf(EventDevVibe)) + len(a.eventsOf(EventDevVibeHere)); n != 0 {
		t.Fatalf("%d vibe events from a zone without dev mode", n)
	}
	h.do(func() {
		s := h.srv
		c := s.diff.m.Cell(sx, sz)
		if l, _ := s.diff.m.Level(c); l != 1 || len(s.diff.m.DevOverrides()) != 0 || s.dev.vibe.frozen || s.dev.frozen || !s.night.cfg.NoDemons {
			t.Fatalf("state changed without dev mode: level %d", l)
		}
		if p := s.byChar["vibe-off"].ent.Move.Pos; math.Hypot(p.X-sx, p.Z-sz) > 2 {
			t.Fatalf("moved without dev mode: %v", p)
		}
	})
}
