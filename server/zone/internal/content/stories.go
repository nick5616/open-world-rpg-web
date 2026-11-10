package content

import (
	"fmt"
	"math"
	"sort"
	"strconv"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/zone/internal/quests"
)

// Story quests (CR 022): handcrafted multi-step quests in content.yaml whose
// places are resolved around the town where they are accepted ("home"),
// the nearest other town that has the role a step needs ("next") and the
// nearest such town in another region ("far").

// StoryKey is a story's log key.
func StoryKey(key string) string { return "story:" + key }

// StoryID is a story's wire id.
func StoryID(key string) uint32 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(key); i++ {
		h ^= uint64(key[i])
		h *= 1099511628211
	}
	return uint32(mix(h)>>32)&0x7fffffff | 0x02000000
}

// StoriesFor lists the stories an NPC of role offers.
func StoriesFor(role int) []*contentdefs.Story {
	var out []*contentdefs.Story
	for i := range contentdefs.D.Stories {
		s := &contentdefs.D.Stories[i]
		if s.Role == role || s.AltRole == role {
			out = append(out, s)
		}
	}
	return out
}

// storyRadius is how far a story step's place may be from its town.
const storyRadius = 3200.0

// Story builds def as offered by giver npc of town home (nil when this
// world lacks a place it needs near there).
func Story(w *World, def *contentdefs.Story, home *Town, npc int, nowMs int64) *quests.Quest {
	g := home.NPC(npc)
	if g == nil {
		return nil
	}
	towns := map[string]*Town{"home": home}
	var townFor func(which string, role int) *Town
	townFor = func(which string, role int) *Town {
		if which == "home" || which == "" {
			return home
		}
		if t := towns[which+":"+strconv.Itoa(role)]; t != nil {
			return t
		}
		var pick *Town
		for _, o := range w.nearestTowns(home) {
			if role >= 0 && o.NPCOf(role) == nil {
				continue
			}
			if which == "far" && o.Region == home.Region {
				continue
			}
			pick = o
			break
		}
		if pick == nil && which == "far" {
			return townFor("next", role)
		}
		towns[which+":"+strconv.Itoa(role)] = pick
		return pick
	}
	used := map[int]bool{}
	siteFor := func(kind string, near *Town) (Site, bool) {
		pool := w.Sites
		if kind == SiteDungeon {
			pool = w.Dungeons
		}
		type c struct {
			s Site
			d float64
		}
		var cs []c
		for _, s := range pool {
			if kind != SiteDungeon && s.Kind != kind {
				continue
			}
			if d := math.Hypot(s.X-near.X, s.Z-near.Z); d <= storyRadius {
				cs = append(cs, c{s, d})
			}
		}
		sort.Slice(cs, func(i, j int) bool {
			if cs[i].d != cs[j].d {
				return cs[i].d < cs[j].d
			}
			return cs[i].s.Index < cs[j].s.Index
		})
		if len(cs) == 0 {
			return Site{}, false
		}
		return cs[0].s, true
	}
	q := &quests.Quest{ID: StoryID(def.Key), Key: StoryKey(def.Key), Kind: quests.KindStory, Title: def.Title,
		Giver: fmt.Sprintf("%s, %s of %s", g.Name, RoleNames[g.Role], home.Name), Settlement: home.Index, Accepted: nowMs,
		Gold: def.Gold, XP: def.XP, Rep: def.Rep, RollItems: def.Items, GiverNPC: g.Index + 1}
	for _, st := range def.Steps {
		kv := map[string]string{"giver": g.Name, "town": home.Name, "n": strconv.Itoa(st.N)}
		step := quests.Step{Obj: quests.Objective{Site: -1}}
		ref := townFor(st.Near, -1)
		if ref == nil {
			return nil
		}
		switch st.Kind {
		case "talk", "give":
			t := townFor(st.Town, st.Role)
			if t == nil {
				return nil
			}
			n := t.NPCOf(st.Role)
			if t == home && g.Role == st.Role {
				n = g
			}
			if n == nil {
				return nil
			}
			kv["npc"], kv["other"], kv["where"] = n.Name, t.Name, quests.Where(home.X, home.Z, t.X, t.Z, home.Name)
			kind := quests.ObjTalk
			if st.Kind == "give" {
				kind = quests.ObjGive
				step.Obj.Items = []quests.ItemQty{{Item: st.Item, Qty: 1}}
			}
			step.Obj.Kind, step.Obj.Role, step.Obj.Settlement, step.Obj.NPC = kind, n.Role, t.Index, n.Index+1
			step.Markers = []quests.Marker{marker(n.X, n.Z, 0, n.Name+", "+t.Name)}
			step.Say = st.Say
		case "attune":
			step.Obj.Kind = quests.ObjAttune
			if s, ok := siteFor(SiteTower, home); ok {
				step.Markers = []quests.Marker{marker(s.X, s.Z, 0, placeName(s))}
			}
		default:
			s, ok := siteFor(st.Site, ref)
			if !ok {
				return nil
			}
			used[s.Index] = true
			kv["place"], kv["where"] = placeName(s), quests.Where(ref.X, ref.Z, s.X, s.Z, ref.Name)
			rad := math.Max(s.R, 12) + 12
			step.Obj.Site, step.Obj.X, step.Obj.Z = s.Index, s.X, s.Z
			switch st.Kind {
			case "reach":
				step.Obj.Kind, step.Obj.R = quests.ObjReach, rad
				step.Markers = []quests.Marker{marker(s.X, s.Z, rad, placeName(s))}
			case "read":
				step.Obj.Kind = quests.ObjRead
				step.Markers = []quests.Marker{marker(s.X, s.Z, 0, "Lore tablet: "+placeName(s))}
			case "kill":
				r := math.Max(110, s.R+40)
				step.Obj.Kind, step.Obj.N, step.Obj.R = quests.ObjKill, st.N, r
				step.Markers = []quests.Marker{marker(s.X, s.Z, r, placeName(s))}
			case "clear":
				step.Obj.Kind, step.Obj.R = quests.ObjClear, math.Max(s.R, 30)
				step.Markers = []quests.Marker{marker(s.X, s.Z, math.Max(s.R, 30), placeName(s))}
			case "dungeon":
				step.Obj.Kind = quests.ObjDungeon
				step.Markers = []quests.Marker{marker(s.X, s.Z, rad, placeName(s))}
			}
		}
		if st.Grant != "" {
			step.Grant = []quests.ItemQty{{Item: st.Grant, Qty: 1}}
		}
		step.Text, step.Note = Fill(st.Text, kv), Fill(st.Note, kv)
		q.Steps = append(q.Steps, step)
	}
	return q
}
