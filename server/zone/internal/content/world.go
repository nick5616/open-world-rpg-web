// Package content is the playtest 2 content bundle's pure logic (CR 022,
// contracts/content.yaml): the per-town side quest generator, the story
// quest builder, each character's codex / feats / reputation / lore state,
// herb patches, the vaults' puzzles and the world event picks. No I/O,
// clocks or goroutines: everything is a function of the world seed and its
// arguments, so every zone of a world (and every test) agrees. The glue to
// sessions, Events, rewards, persistence and the handoff is
// internal/game/content*.go.
package content

import (
	"math"
	"sort"
	"strings"

	"lodestone/server/pkg/itemdefs"
	"lodestone/server/zone/internal/quests"
)

// Roles (towns buffer; contentdefs.Roles order).
const (
	RoleVillager   = 0
	RoleMerchant   = 1
	RoleBlacksmith = 2
	RoleInnkeeper  = 3
	RoleBounty     = 4
	RoleFarmer     = 5
	RoleGuard      = 6
)

// RoleNames are the words quest text uses for a role.
var RoleNames = [...]string{"villager", "merchant", "blacksmith", "innkeeper", "bounty keeper", "farmer", "guard"}

// NPC is one townsperson.
type NPC struct {
	Index int // towns-buffer NPC index
	Name  string
	Role  int
	X, Z  float64 // their work spot (where markers point)
}

// Town is a settlement with its folk.
type Town struct {
	Index  int // towns-buffer settlement index
	ID     uint64
	Name   string
	X, Z   float64
	Radius float64
	Biome  int
	Region int
	NPCs   []NPC
}

// Site kinds a quest can point at.
const (
	SiteShrine     = "shrine"
	SiteRuin       = "ruin"
	SiteWatchtower = "watchtower"
	SiteTower      = "tower"
	SiteBanditCamp = "banditcamp"
	SiteLandmark   = "landmark"
	SiteCamp       = "camp"
	SiteDungeon    = "dungeon"
)

// Site is a named place (an atlas site).
type Site struct {
	Index  int // atlas site index
	Kind   string
	Name   string
	X, Z   float64
	R      float64
	Region int
	Size   int
}

// World is what the generators need to know about a world.
type World struct {
	Seed     uint64
	Towns    []Town
	Sites    []Site
	Dungeons []Site
}

// mix is SplitMix64.
func mix(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

// Mix is SplitMix64 (exported for the glue's seeded picks).
func Mix(x uint64) uint64 { return mix(x) }

func unit(h uint64) float64 { return float64(h>>11) / float64(1<<53) }

// lerpI picks an int in [r0, r1] from h.
func lerpI(r [2]int, h uint64) int {
	if r[1] <= r[0] {
		return r[0]
	}
	return r[0] + int(h%uint64(r[1]-r[0]+1))
}

// Fill replaces {key} placeholders.
func Fill(s string, kv map[string]string) string {
	if !strings.Contains(s, "{") {
		return s
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			b.WriteString(s)
			break
		}
		j := strings.IndexByte(s[i:], '}')
		if j < 0 {
			b.WriteString(s)
			break
		}
		b.WriteString(s[:i])
		k := s[i+1 : i+j]
		if v, ok := kv[k]; ok {
			b.WriteString(v)
		} else {
			b.WriteString(s[i : i+j+1])
		}
		s = s[i+j+1:]
	}
	return capFirst(b.String())
}

func capFirst(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

// Town returns the town with towns-buffer index i (nil if none).
func (w *World) Town(i int) *Town {
	for k := range w.Towns {
		if w.Towns[k].Index == i {
			return &w.Towns[k]
		}
	}
	return nil
}

// NPCOf is the first NPC of role in t (nil if none).
func (t *Town) NPCOf(role int) *NPC {
	for i := range t.NPCs {
		if t.NPCs[i].Role == role {
			return &t.NPCs[i]
		}
	}
	return nil
}

// NPC returns t's NPC with towns-buffer index i (nil if none).
func (t *Town) NPC(i int) *NPC {
	for k := range t.NPCs {
		if t.NPCs[k].Index == i {
			return &t.NPCs[k]
		}
	}
	return nil
}

// sitesNear lists sites of the given kinds between lo and hi metres of
// (x, z), nearest first (ties by atlas index: deterministic).
func (w *World) sitesNear(x, z, lo, hi float64, kinds ...string) []Site {
	type c struct {
		s Site
		d float64
	}
	var cs []c
	for _, s := range w.Sites {
		ok := false
		for _, k := range kinds {
			ok = ok || s.Kind == k
		}
		if !ok {
			continue
		}
		if d := math.Hypot(s.X-x, s.Z-z); d >= lo && d <= hi {
			cs = append(cs, c{s, d})
		}
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].d != cs[j].d {
			return cs[i].d < cs[j].d
		}
		return cs[i].s.Index < cs[j].s.Index
	})
	out := make([]Site, len(cs))
	for i := range cs {
		out[i] = cs[i].s
	}
	return out
}

// nearestTowns lists other towns by distance from t (with at least one NPC).
func (w *World) nearestTowns(t *Town) []*Town {
	var out []*Town
	for i := range w.Towns {
		o := &w.Towns[i]
		if o.Index != t.Index && len(o.NPCs) > 0 {
			out = append(out, o)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		di, dj := math.Hypot(out[i].X-t.X, out[i].Z-t.Z), math.Hypot(out[j].X-t.X, out[j].Z-t.Z)
		if di != dj {
			return di < dj
		}
		return out[i].Index < out[j].Index
	})
	return out
}

func placeName(s Site) string {
	if s.Name != "" {
		return s.Name
	}
	switch s.Kind {
	case SiteCamp:
		return "the old camp"
	case SiteLandmark:
		return "the standing stones"
	}
	return "the " + s.Kind
}

func marker(x, z, r float64, label string) quests.Marker {
	return quests.Marker{X: math.Round(x*10) / 10, Z: math.Round(z*10) / 10, R: r, Label: label}
}

// itemName is an item's name as quest text uses it ("wolf pelts", "raw
// meat", "Heartleaf" for herbs keep their capital).
func itemName(key string, n int) string {
	it := itemdefs.D.Item(key)
	if it == nil {
		return key
	}
	name := it.Name
	if strings.HasPrefix(key, "herb:") {
		return name
	}
	name = strings.ToLower(name)
	if n > 1 && strings.HasSuffix(name, "pelt") {
		name += "s"
	}
	return name
}
