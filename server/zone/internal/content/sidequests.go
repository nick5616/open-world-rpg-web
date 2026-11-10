package content

import (
	"fmt"
	"math"
	"sort"
	"strconv"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/zone/internal/quests"
)

// Side quests from townsfolk (CR 022). Every settlement has 2-4 givers,
// picked from the world seed and the settlement; each giver offers one
// quest at a time from a sequence (seq 0, 1, 2...) that is a pure function
// of (seed, settlement, giver, seq): two players asking the same farmer
// hear the same request, and a finished one brings the next.

// Parcel is the delivery item (contracts/items.yaml quest:parcel).
const Parcel = "quest:parcel"

// Givers lists t's quest givers (towns-buffer NPC indexes), deterministic.
func Givers(seed uint64, t *Town) []int {
	sq := &contentdefs.D.SideQuests
	type c struct {
		i int
		h uint64
	}
	var cs []c
	for _, n := range t.NPCs {
		for _, r := range sq.Givers.Roles {
			if n.Role == r {
				cs = append(cs, c{n.Index, mix(seed ^ t.ID*0x9e3779b97f4a7c15 ^ uint64(n.Index)*0xc2b2ae3d27d4eb4f)})
				break
			}
		}
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].h != cs[j].h {
			return cs[i].h < cs[j].h
		}
		return cs[i].i < cs[j].i
	})
	n := sq.Givers.Min + int(mix(seed^t.ID^0x51de)%uint64(sq.Givers.Max-sq.Givers.Min+1))
	n = min(n, len(cs))
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = cs[i].i
	}
	sort.Ints(out)
	return out
}

// IsGiver reports whether NPC index npc gives side quests in t.
func IsGiver(seed uint64, t *Town, npc int) bool {
	for _, g := range Givers(seed, t) {
		if g == npc {
			return true
		}
	}
	return false
}

// SideKey is a side quest's log key.
func SideKey(settlement, npc, seq int) string {
	return "side:" + strconv.Itoa(settlement) + ":" + strconv.Itoa(npc) + ":" + strconv.Itoa(seq)
}

// SideID is a side quest's wire id (never 0, never the Ward's).
func SideID(seed uint64, settlement, npc, seq int) uint32 {
	h := mix(seed ^ uint64(settlement)*0x2545f4914f6cdd1d ^ uint64(npc)*0x9e3779b97f4a7c15 ^ uint64(seq)*0xbf58476d1ce4e5b9 ^ 0x51de0001)
	return uint32(h>>32)&0x7fffffff | 0x01000000
}

func sideHash(seed uint64, t *Town, npc, seq int) uint64 {
	return mix(seed ^ t.ID*0xd6e8feb86659fd93 ^ uint64(npc)*0xa0761d6478bd642f ^ uint64(seq+1)*0xe7037ed1a0b428db)
}

// sideKind picks the kind for a giver's seq (weighted, never the same kind
// twice running when another is possible).
func sideKind(seed uint64, w *World, t *Town, npc, seq int, ok func(string) bool) *contentdefs.SideKind {
	pick := func(h uint64, not string) *contentdefs.SideKind {
		tot := 0.0
		for i := range contentdefs.D.SideQuests.Kinds {
			k := &contentdefs.D.SideQuests.Kinds[i]
			if k.Key != not && ok(k.Key) {
				tot += k.Weight
			}
		}
		if tot <= 0 {
			return nil
		}
		u := unit(h) * tot
		var last *contentdefs.SideKind
		for i := range contentdefs.D.SideQuests.Kinds {
			k := &contentdefs.D.SideQuests.Kinds[i]
			if k.Key == not || !ok(k.Key) {
				continue
			}
			last = k
			if u -= k.Weight; u < 0 {
				return k
			}
		}
		return last
	}
	prev := ""
	if seq > 0 {
		if p := pick(mix(sideHash(seed, t, npc, seq-1)^0x6b1d), ""); p != nil {
			prev = p.Key
		}
	}
	k := pick(mix(sideHash(seed, t, npc, seq)^0x6b1d), prev)
	if k == nil {
		k = pick(mix(sideHash(seed, t, npc, seq)^0x6b1d), "")
	}
	return k
}

// Offer is a generated side quest and the giver's offer line.
type Offer struct {
	Quest *quests.Quest
	Say   string
	Kind  string
}

// SideQuest builds giver npc's seq-th request in town t (nil: npc is not a
// giver here, or nothing fits this world).
func SideQuest(w *World, t *Town, npc, seq int, nowMs int64) *Offer {
	g := t.NPC(npc)
	if g == nil || !IsGiver(w.Seed, t, npc) {
		return nil
	}
	sq := &contentdefs.D.SideQuests
	h := sideHash(w.Seed, t, npc, seq)
	r := func(k uint64) uint64 { return mix(h ^ k*0x9e3779b97f4a7c15) }
	near := func(kinds ...string) []Site { return w.sitesNear(t.X, t.Z, sq.Near.Min, sq.Near.Max, kinds...) }
	pickSite := func(cands []Site, salt uint64) (Site, bool) {
		if len(cands) == 0 {
			return Site{}, false
		}
		return cands[int(r(salt)%uint64(min(len(cands), 6)))], true
	}
	huntSites := near(SiteRuin, SiteWatchtower, SiteLandmark, SiteCamp, SiteBanditCamp, SiteShrine)
	exploreSites := near(SiteRuin, SiteShrine, SiteWatchtower, SiteLandmark)
	rescueSites := near(SiteCamp, SiteLandmark, SiteRuin)
	others := w.nearestTowns(t)
	if len(others) > 3 {
		others = others[:3]
	}
	ok := func(k string) bool {
		switch k {
		case "hunt":
			return len(huntSites) > 0
		case "explore":
			return len(exploreSites) > 0
		case "rescue":
			return len(rescueSites) > 0
		case "deliver":
			return len(others) > 0
		}
		return true
	}
	k := sideKind(w.Seed, w, t, npc, seq, ok)
	if k == nil {
		return nil
	}
	giverName := g.Name
	giverLabel := fmt.Sprintf("%s, %s of %s", g.Name, RoleNames[g.Role], t.Name)
	kv := map[string]string{"giver": giverName, "town": t.Name, "creatures": sq.Creatures[max(0, min(5, t.Biome))]}
	giverMarker := []quests.Marker{marker(g.X, g.Z, 0, giverName)}
	back := func(text, say string) quests.Step {
		return quests.Step{Text: Fill(text, kv), Note: Fill("{giver} is in {town}.", kv), Say: say,
			Obj:     quests.Objective{Kind: quests.ObjTalk, Role: g.Role, Settlement: t.Index, NPC: g.Index + 1, Site: -1},
			Markers: giverMarker}
	}
	q := &quests.Quest{ID: SideID(w.Seed, t.Index, npc, seq), Key: SideKey(t.Index, npc, seq), Kind: quests.KindSide, Giver: giverLabel,
		Settlement: t.Index, Accepted: nowMs, Gold: lerpI(k.Gold, r(1)), XP: int64(lerpI(k.XP, r(2))), Rep: k.Rep, GiverNPC: g.Index + 1, Seq: seq}
	thanks := k.Thanks[int(r(3)%uint64(len(k.Thanks)))]
	title := k.Titles[int(r(4)%uint64(len(k.Titles)))]
	offer := k.Offer[int(r(5)%uint64(len(k.Offer)))]
	switch k.Key {
	case "hunt":
		s, _ := pickSite(huntSites, 6)
		n := lerpI(k.N, r(7))
		kv["place"], kv["where"], kv["n"] = placeName(s), quests.Where(t.X, t.Z, s.X, s.Z, t.Name), strconv.Itoa(n)
		rad := math.Max(k.Radius, s.R+40)
		q.Steps = []quests.Step{
			{Text: Fill(k.Step, kv), Note: Fill(k.Note, kv), Obj: quests.Objective{Kind: quests.ObjKill, N: n, X: s.X, Z: s.Z, R: rad, Site: s.Index},
				Markers: []quests.Marker{marker(s.X, s.Z, rad, placeName(s))}},
			back(k.Back, Fill(thanks, kv)),
		}
		q.Gold += int(math.Hypot(s.X-t.X, s.Z-t.Z) / 120)
	case "gather":
		gi := k.Items[int(r(8)%uint64(len(k.Items)))]
		n := lerpI(gi.Qty, r(9))
		name := itemName(gi.Item, n)
		kv["item"], kv["n"] = name, strconv.Itoa(n)
		q.Steps = []quests.Step{{Text: Fill(k.Step, kv), Note: Fill(k.Note, kv), Say: Fill(thanks, kv),
			Obj:     quests.Objective{Kind: quests.ObjGive, Role: g.Role, Settlement: t.Index, NPC: g.Index + 1, Site: -1, Items: []quests.ItemQty{{Item: gi.Item, Qty: n}}},
			Markers: giverMarker}}
	case "deliver":
		o := others[int(r(10)%uint64(len(others)))]
		var dest *NPC
		for _, role := range []int{RoleInnkeeper, RoleMerchant, RoleFarmer, RoleVillager, RoleBounty} {
			if d := o.NPCOf(role); d != nil {
				dest = d
				break
			}
		}
		if dest == nil {
			dest = &o.NPCs[0]
		}
		kv["other"], kv["otherNpc"], kv["where"] = o.Name, dest.Name, quests.Where(t.X, t.Z, o.X, o.Z, t.Name)
		q.Steps = []quests.Step{{Text: Fill(k.Step, kv), Note: Fill(k.Note, kv), Say: Fill(thanks, kv),
			Obj: quests.Objective{Kind: quests.ObjGive, Role: dest.Role, Settlement: o.Index, NPC: dest.Index + 1, Site: -1, Items: []quests.ItemQty{{Item: Parcel, Qty: 1}}},
			Markers: []quests.Marker{marker(dest.X, dest.Z, 0, dest.Name+" in "+o.Name), marker(o.X, o.Z, o.Radius, o.Name)}}}
		q.Start = []quests.ItemQty{{Item: Parcel, Qty: 1}}
		q.Gold += int(math.Hypot(o.X-t.X, o.Z-t.Z) / 80)
	case "explore":
		s, _ := pickSite(exploreSites, 11)
		kv["place"], kv["where"] = placeName(s), quests.Where(t.X, t.Z, s.X, s.Z, t.Name)
		rad := math.Max(s.R, 10) + 12
		q.Steps = []quests.Step{
			{Text: Fill(k.Step, kv), Note: Fill(k.Note, kv), Obj: quests.Objective{Kind: quests.ObjReach, X: s.X, Z: s.Z, R: rad, Site: s.Index},
				Markers: []quests.Marker{marker(s.X, s.Z, rad, placeName(s))}},
			back(k.Back, Fill(thanks, kv)),
		}
		q.Gold += int(math.Hypot(s.X-t.X, s.Z-t.Z) / 120)
	case "rescue":
		s, _ := pickSite(rescueSites, 12)
		v := sq.Villagers[int(r(13)%uint64(len(sq.Villagers)))]
		kv["place"], kv["where"], kv["villager"] = placeName(s), quests.Where(t.X, t.Z, s.X, s.Z, t.Name), v
		rad := math.Max(s.R, 12) + 14
		q.Steps = []quests.Step{
			{Text: Fill(k.Step, kv), Note: Fill(k.Note, kv), Say: Fill(k.Found, kv), Obj: quests.Objective{Kind: quests.ObjReach, X: s.X, Z: s.Z, R: rad, Site: s.Index},
				Markers: []quests.Marker{marker(s.X, s.Z, rad, placeName(s))}},
			{Text: Fill(k.Escort, kv), Note: Fill(k.EscortNote, kv), Obj: quests.Objective{Kind: quests.ObjEscort, X: t.X, Z: t.Z, R: t.Radius + 12, Site: -1},
				Markers: []quests.Marker{marker(t.X, t.Z, t.Radius+12, t.Name)}},
			back(k.Back, Fill(thanks, kv)),
		}
	default:
		return nil
	}
	q.Title = Fill(title, kv)
	return &Offer{Quest: q, Say: Fill(offer, kv), Kind: k.Key}
}

// RescueVillager is the lost villager's name in a rescue quest (its first
// step's "Find X near ..." text carries it; "" for other quests).
func RescueVillager(q *quests.Quest) string {
	if q == nil || q.Kind != quests.KindSide || len(q.Steps) != 3 || q.Steps[1].Obj.Kind != quests.ObjEscort {
		return ""
	}
	for _, v := range contentdefs.D.SideQuests.Villagers {
		if len(q.Steps[0].Text) > 5+len(v) && q.Steps[0].Text[5:5+len(v)] == v {
			return v
		}
	}
	return "the villager"
}
