package game

// The main story, "The Last Song" (playtest 2, CR 035; internal/story has
// the acts, docs/decisions/0024-main-story.md the design). This file is the
// glue: the world-global places the acts point at (resolved once per zone,
// deterministic, so every zone and every party member agrees), starting
// each act when the last one ends (the first after "Ward against the
// night"), the act intro cards, party-shared progress (a step a member
// completes completes for every member beside them at the same step; the
// one behind can catch up to the furthest), the vigil of Act IV (a town
// defense, then the Starless Sovereign), the post-game (calmer nights; the
// Starless Vow), Events 1600-1609 and Interact 140. The finale is
// finale.go, revives revive.go.
//
// Persistence: the acts are quests (character_quests); the post-game flags
// and counters ride in the content state (character_content stats: acts,
// finale, finaleparty, finalehard, finalehardparty, shrouds, revives, vow).
// No migration.

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/story"
)

// Event kinds 1600-1629 (CR 035, contracts/events.md).
const (
	EventStorySync      = 1600
	EventStoryParty     = 1601
	EventStoryIntro     = 1602
	EventFinaleState    = 1603
	EventFinaleIntro    = 1604
	EventStoryEnding    = 1605
	EventStorySay       = 1606
	EventStoryRefused   = 1607
	EventReviveWindow   = 1610
	EventRevived        = 1611
	EventReviveProgress = 1612
)

// Interact 140 `story`.
const (
	InteractStory = 140

	StoryActSync    = 1 // send 1600 (and 1601)
	StoryActCatchUp = 2 // catch up to your party's furthest member
	StoryActRevive  = 3 // targetId = the downed player's entity; arg 1 start holding, 0 let go
	StoryActRespawn = 4 // downed: respawn now instead of waiting for a friend
	StoryActVow     = 5 // arg 1 take the Starless Vow, 0 renounce it (after beating the game)
)

// Refusals (Event 1607 value).
const (
	StoryRefuseUnknown   = 1
	StoryRefuseNotBehind = 2 // catch up: nobody in your party is ahead of you
	StoryRefuseFar       = 3 // revive: too far
	StoryRefuseNotDown   = 4
	StoryRefuseNotYet    = 5 // the vow: beat the game first
	StoryRefuseMain      = 6 // the main story can't be dropped
)

const (
	storyShareM     = 200 // party members this close share a step
	storyEveryTicks = 30  // party progress and vigil checks at 1 Hz
	vigilLeaveS     = 60  // nobody near the vigil town this long: it fails
	vigilSovereignM = 28  // the Sovereign walks out of the dark this far from a defender
)

type storyGlue struct {
	places   *story.Places
	resolved bool
	partyMsg map[uint32]string // entity -> last 1601 sent
	syncMsg  map[uint32]string // entity -> last 1600 sent
	vigil    *vigilRun
	sharing  bool
	fin      finaleState
	rev      reviveState
}

type vigilRun struct {
	town      int
	defense   bool // the defense event is running
	sovereign *combat.Group
	part      map[uint32]bool
	lastNear  uint32
}

// storyInit hooks the kill chain (combat.go's OnKill, after quests and loot).
func (s *Server) storyInit() {
	s.sty.partyMsg = map[uint32]string{}
	s.sty.syncMsg = map[uint32]string{}
	if s.cbt.w == nil {
		return
	}
	prev := s.cbt.w.OnKill
	s.cbt.w.OnKill = func(k combat.KillInfo) {
		if prev != nil {
			prev(k)
		}
		s.storyOnKill(k)
	}
}

// storyPlaces resolves the acts' places once (nil in worlds without towns,
// towers or an atlas: the flat and scale worlds have no main story).
func (s *Server) storyPlaces() *story.Places {
	if s.sty.resolved {
		return s.sty.places
	}
	s.sty.resolved = true
	if s.cfg.Towns == nil || s.cfg.Explore == nil || s.cbt.w == nil || s.cbt.w.Atlas == nil || len(s.cfg.Explore.Towers) < 6 {
		return nil
	}
	p := s.resolveStory()
	if p == nil {
		return nil
	}
	ok := 0
	for n := 1; n <= story.Acts; n++ {
		if story.Act(n, p, 0) != nil {
			ok++
		}
	}
	if ok < story.Acts {
		s.log.Warn("main story: some acts lack their places; the story is off on this world", "acts", ok)
		return nil
	}
	s.sty.places = p
	return p
}

func (s *Server) storyNPC(si int, roles ...uint8) story.NPC {
	w := s.cfg.Towns
	if si < 0 || si >= len(w.T.Settlements) {
		return story.NPC{}
	}
	st := &w.T.Settlements[si]
	for _, role := range roles {
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			if d := &w.T.NPCs[i]; d.Role == role && d.Name != "" {
				return story.NPC{OK: true, Settlement: si, Town: s.settlementName(si), Index: i, Role: int(role), Name: d.Name, Title: towns.RoleNames[role], X: d.WorkX, Z: d.WorkZ}
			}
		}
	}
	return story.NPC{}
}

func (s *Server) storySite(i int) story.Place {
	a := s.atlasSite(i)
	if a == nil {
		return story.Place{}
	}
	name := a.Name
	if name == "" && a.Category == structures.CategoryStructure && int(a.Kind) < len(towns.StructureNames) {
		name = "the " + towns.StructureNames[a.Kind]
	}
	return story.Place{OK: true, Site: i, Name: name, Region: s.regionName(int(a.Region)), X: a.X, Z: a.Z, R: math.Max(a.Radius, 12) + 10}
}

func (s *Server) regionName(r int) string {
	if ex := s.cfg.Explore; ex != nil && r >= 0 && r < len(ex.Atlas.Regions) {
		return ex.Atlas.Regions[r].Name
	}
	return ""
}

// resolveStory picks every place (see internal/story's Places).
func (s *Server) resolveStory() *story.Places {
	ex, tw, ca := s.cfg.Explore, s.cfg.Towns, s.cbt.w.Atlas
	p := &story.Places{}
	// Home: the settlement nearest the world spawn (every new character's).
	home, hd := -1, math.Inf(1)
	for i := range tw.T.Settlements {
		if s.skyTown(i) { // CR 038: the story stays on the ground it was written for
			continue
		}
		if d := math.Hypot(tw.T.Settlements[i].X-ca.SpawnX, tw.T.Settlements[i].Z-ca.SpawnZ); d < hd {
			home, hd = i, d
		}
	}
	if home < 0 {
		return nil
	}
	hs := &tw.T.Settlements[home]
	p.Home, p.HomeX, p.HomeZ = s.settlementName(home), hs.X, hs.Z
	homeRegion := ca.RegionAt(hs.X, hs.Z)
	p.Keeper = s.storyNPC(home, towns.RoleInnkeeper, towns.RoleVillager, towns.RoleMerchant, towns.RoleFarmer, towns.RoleGuard)
	dist := func(x, z float64) float64 { return math.Hypot(x-hs.X, z-hs.Z) }

	// Act I: the Last Keeper's stone (the "last_keeper" tablet nearest home,
	// else the nearest tablet of any kind).
	cw := s.contentWorld()
	lastID := 0
	for i, t := range contentdefs.D.Tablets {
		if t.Key == "last_keeper" {
			lastID = i + 1
		}
	}
	best, bd := -1, math.Inf(1)
	for pass := 0; pass < 2 && best < 0; pass++ {
		for site, id := range s.cnt.tablets {
			if pass == 0 && id != lastID {
				continue
			}
			if a := s.atlasSite(site); a != nil {
				if d := dist(a.X, a.Z); d < bd || (d == bd && site < best) {
					best, bd = site, d
				}
			}
		}
	}
	if best >= 0 {
		p.Tablet = s.storySite(best)
		// Playtest 2 co-op: mark the stone itself, not the ruin's centre (it
		// stands 7 m off it, out of the prompt's 3 m reach).
		if tp, ok := s.tabletPos(best); ok {
			p.Tablet.X, p.Tablet.Z = tp.X, tp.Z
		}
	}
	_ = cw

	// Towers: the nearest is Act I's fork; the next three (one per region,
	// none in the first's) are Act II's, walked nearest-first.
	type tw2 struct {
		site, region int
		d            float64
	}
	var ts []tw2
	for _, t := range ex.Towers {
		a := &ex.Atlas.Sites[t.Site]
		if t.Shape != nil && !s.towerApproachable(t.Shape.CX, t.Shape.CZ, t.Shape.MaxR) {
			continue // playtest 2 co-op: a summit you can't walk up to
		}
		ts = append(ts, tw2{t.Site, int(a.Region), dist(a.X, a.Z)})
	}
	sort.Slice(ts, func(i, j int) bool {
		if ts[i].d != ts[j].d {
			return ts[i].d < ts[j].d
		}
		return ts[i].site < ts[j].site
	})
	// The last region: the most dangerous and remote one with a tower.
	maxD := 1.0
	for _, t := range ts {
		maxD = math.Max(maxD, t.d)
	}
	lastRegion, lastScore := -1, -1.0
	for _, t := range ts {
		sc := ca.Region(t.region).Danger + t.d/maxD
		if sc > lastScore {
			lastRegion, lastScore = t.region, sc
		}
	}
	usedRegion := map[int]bool{lastRegion: true}
	var forks []tw2
	for _, t := range ts {
		if len(forks) == 4 {
			break
		}
		if usedRegion[t.region] {
			continue
		}
		usedRegion[t.region] = true
		forks = append(forks, t)
	}
	if len(forks) < 4 {
		return nil
	}
	p.Forks[0] = s.storySite(forks[0].site)
	rest := forks[1:]
	at := p.Forks[0]
	for i := 0; i < 3; i++ { // nearest neighbour from the last fork woken
		k := 0
		for j := range rest {
			aj, ak := &ex.Atlas.Sites[rest[j].site], &ex.Atlas.Sites[rest[k].site]
			if math.Hypot(aj.X-at.X, aj.Z-at.Z) < math.Hypot(ak.X-at.X, ak.Z-at.Z) {
				k = j
			}
		}
		p.Forks[i+1] = s.storySite(rest[k].site)
		at = p.Forks[i+1]
		rest = append(rest[:k:k], rest[k+1:]...)
	}
	for _, t := range ts {
		if t.region == lastRegion {
			p.LastFork = s.storySite(t.site)
			break
		}
	}

	// Act III: the two nearest vaults whose seals any party can open (the
	// levers or the weighing stones: no element needed), in two regions.
	type vc struct {
		v *content.Vault
		d float64
	}
	var vs []vc
	for _, v := range s.vaultPlans() {
		vs = append(vs, vc{v, dist(v.Site.X, v.Site.Z)})
	}
	sort.Slice(vs, func(i, j int) bool {
		if vs[i].d != vs[j].d {
			return vs[i].d < vs[j].d
		}
		return vs[i].v.Site.Index < vs[j].v.Site.Index
	})
	got := 0
	vr := map[int]bool{lastRegion: true}
	for pass := 0; pass < 2 && got < 2; pass++ {
		for _, c := range vs {
			if got == 2 {
				break
			}
			k := c.v.Puzzle.Key
			if vr[c.v.Site.Region] || (pass == 0 && k != "levers" && k != "plates") {
				continue
			}
			vr[c.v.Site.Region] = true
			p.Vaults[got] = story.Place{OK: true, Site: c.v.Site.Index, Name: c.v.Name, Region: s.regionName(c.v.Site.Region), X: c.v.Site.X, Z: c.v.Site.Z, R: math.Max(c.v.Site.R, 12) + 14,
				Hint: c.v.Puzzle.Name + ": " + c.v.Hint}
			got++
		}
	}

	// Act IV: the vigil town: a town with a guard, 700-1900 m out in
	// another region, nearest 1250 m.
	vt, vscore := -1, math.Inf(1)
	for i := range tw.T.Settlements {
		st := &tw.T.Settlements[i]
		r := ca.RegionAt(st.X, st.Z)
		d := dist(st.X, st.Z)
		if s.skyTown(i) || i == home || r == homeRegion || r == lastRegion || d < 700 || d > 1900 || st.NPCs < 6 {
			continue
		}
		if !s.storyNPC(i, towns.RoleGuard, towns.RoleBounty).OK {
			continue
		}
		sc := math.Abs(d - 1250)
		if !s.storyNPC(i, towns.RoleGuard).OK || st.NPCs < 8 {
			sc += 2000 // a real guard captain and a town worth defending first
		}
		if sc < vscore {
			vt, vscore = i, sc
		}
	}
	if vt >= 0 {
		st := &tw.T.Settlements[vt]
		p.Captain = s.storyNPC(vt, towns.RoleGuard, towns.RoleBounty)
		p.Vigil = story.Place{OK: true, Site: vt, Name: s.settlementName(vt), X: st.X, Z: st.Z, R: math.Max(st.Radius, 30)}
	}

	// Act V: the master smith of the last region's biggest town with a
	// smithy, and the nearest guarded sanctum (a wizard tower first).
	sm, smN := -1, -1
	for i := range tw.T.Settlements {
		st := &tw.T.Settlements[i]
		if s.skyTown(i) || ca.RegionAt(st.X, st.Z) != lastRegion || !s.storyNPC(i, towns.RoleBlacksmith).OK {
			continue
		}
		if st.NPCs > smN {
			sm, smN = i, st.NPCs
		}
	}
	if sm < 0 && p.LastFork.OK { // no smithy in the last region: the nearest one to its tower
		bd := math.Inf(1)
		for i := range tw.T.Settlements {
			st := &tw.T.Settlements[i]
			if d := math.Hypot(st.X-p.LastFork.X, st.Z-p.LastFork.Z); d < bd && !s.skyTown(i) && s.storyNPC(i, towns.RoleBlacksmith).OK {
				sm, bd = i, d
			}
		}
	}
	if sm >= 0 {
		p.Smith = s.storyNPC(sm, towns.RoleBlacksmith)
		st := &tw.T.Settlements[sm]
		bs, bsc := -1, math.Inf(1)
		for i := range ex.Atlas.Sites {
			a := &ex.Atlas.Sites[i]
			if a.Category != structures.CategoryStructure || !a.IsBase() {
				continue
			}
			k := int(a.Kind)
			if !(k == combat.StructWizardTower || k == combat.StructSunken || (k == combat.StructRuin && a.Size >= 2)) {
				continue
			}
			sc := math.Hypot(a.X-st.X, a.Z-st.Z)
			if k != combat.StructWizardTower {
				sc += 600
			}
			if sc < bsc {
				bs, bsc = i, sc
			}
		}
		if bs >= 0 {
			p.Sanctum = s.storySite(bs)
		}
	}

	p.SanctumBoss = s.sanctumHasGuardian(p)

	// Act VI: the Heartfall.
	p.Heartfall = s.heartfallSpot(lastRegion, p.LastFork)
	s.log.Info("main story places", "home", p.Home, "keeper", p.Keeper.Name, "tablet", p.Tablet.Name, "fork1", p.Forks[0].Name,
		"forks", p.Forks[1].Name+", "+p.Forks[2].Name+", "+p.Forks[3].Name, "vaults", p.Vaults[0].Name+", "+p.Vaults[1].Name,
		"vigil", p.Vigil.Name, "captain", p.Captain.Name, "smith", p.Smith.Name+" of "+p.Smith.Town, "sanctum", p.Sanctum.Name,
		"lastFork", p.LastFork.Name, "heartfall", strconv.Itoa(int(p.Heartfall.X))+","+strconv.Itoa(int(p.Heartfall.Z)))
	return p
}

// towerApproachMaxDeg: a story tower needs one way to its foot no steeper
// than this (walking stops at 50; a margin for players who don't find the
// exact line).
const towerApproachMaxDeg = 44.0

// towerApproachable: some straight line from 150 m out to the tower's wall
// climbs no slope steeper than towerApproachMaxDeg (2 m steps). Playtest 2
// co-op: Act II sent a pair to The Forgotten Spire of the Howling Crags,
// a summit tower walkable only up one 46 degree ridge; they fell off its
// cliffs, were downed at its foot and spent half an hour on one step.
func (s *Server) towerApproachable(cx, cz, maxR float64) bool {
	g := s.cfg.Ground
	if g == nil {
		return true
	}
	lim := math.Tan(towerApproachMaxDeg * math.Pi / 180)
	for k := 0; k < 32; k++ {
		a := float64(k) / 32 * 2 * math.Pi
		ux, uz := math.Cos(a), math.Sin(a)
		ok := true
		prev := g.HeightAt(cx+ux*(maxR+2), cz+uz*(maxR+2))
		for d := maxR + 4; d <= maxR+150 && ok; d += 2 {
			h := g.HeightAt(cx+ux*d, cz+uz*d)
			ok = math.Abs(h-prev)/2 <= lim
			prev = h
		}
		if ok {
			return true
		}
	}
	return false
}

// heartfallSpot finds open, level, dry ground in region r, 250-900 m from
// its tower and clear of every site: the arena of the finale.
func (s *Server) heartfallSpot(r int, tower story.Place) story.Place {
	if r < 0 || !tower.OK || s.cfg.Ground == nil {
		return story.Place{}
	}
	g, ca, ex := s.cfg.Ground, s.cbt.w.Atlas, s.cfg.Explore
	clear := func(x, z float64) bool {
		for i := range ex.Atlas.Sites {
			a := &ex.Atlas.Sites[i]
			if !a.IsBase() { // CR 038: the Heartfall stays where it was
				continue
			}
			min := 55.0
			switch a.Category {
			case structures.CategorySettlement:
				min = 260 + a.Radius
			case structures.CategoryStructure:
				min = 80 + a.Radius
			}
			if math.Hypot(a.X-x, a.Z-z) < min {
				return false
			}
		}
		return true
	}
	bestX, bestZ, best := 0.0, 0.0, math.Inf(1)
	for rad := 220.0; rad <= 1300; rad += 30 {
		for k := 0; k < 32; k++ {
			a := float64(k) * 2 * math.Pi / 32
			x, z := tower.X+rad*math.Cos(a), tower.Z+rad*math.Sin(a)
			if x < 60 || z < 60 || x > ca.WorldSize-60 || z > ca.WorldSize-60 || ca.RegionAt(x, z) != r {
				continue
			}
			y := g.HeightAt(x, z)
			if movement.WaterAt(g, x, z) > y-0.5 || !clear(x, z) {
				continue
			}
			lo, hi := y, y
			wet := false
			for _, rr := range []float64{12, 22, 32} {
				for j := 0; j < 8; j++ {
					b := float64(j) * math.Pi / 4
					px, pz := x+rr*math.Cos(b), z+rr*math.Sin(b)
					h := g.HeightAt(px, pz)
					lo, hi = math.Min(lo, h), math.Max(hi, h)
					wet = wet || movement.WaterAt(g, px, pz) > h-0.3
				}
			}
			if wet || hi-lo > 14 {
				continue
			}
			sc := (hi-lo)*20 + math.Abs(rad-450)*0.1
			if sc < best {
				bestX, bestZ, best = x, z, sc
			}
		}
	}
	if math.IsInf(best, 1) {
		return story.Place{}
	}
	return story.Place{OK: true, Site: -1, Name: "the Heartfall", Region: s.regionName(r), X: bestX, Z: bestZ, R: heartfallR}
}

// ---- acts ----

// storyJoin starts the act a character is due (after "Ward against the
// night") and sends the story state (questsJoin ran first).
func (s *Server) storyJoin(sess *session) {
	if sess.quests == nil || s.storyPlaces() == nil {
		return
	}
	s.storyMaybeStart(sess)
	s.sendStorySync(sess)
}

// storyMaybeStart starts the next act when its turn has come: Act I once
// the Ward is done (or for a character past level 4 who dropped it), the
// rest when the act before ends.
func (s *Server) storyMaybeStart(sess *session) {
	p := s.storyPlaces()
	if p == nil || sess.quests == nil || sess.ent == nil {
		return
	}
	l := sess.quests.log
	n := story.Next(l)
	if n == 0 {
		return
	}
	if n == 1 && !l.IsDone(quests.WardKey) && (l.ByKey(quests.WardKey) != nil || l.ByKey(quests.MeadowsKey) != nil || s.storyLevel(sess) < 4) {
		return
	}
	q := story.Act(n, p, s.cfg.Now().UnixMilli())
	if q == nil || l.Add(q) != nil {
		return
	}
	l.Track(q.ID)
	sess.quests.recheck = true
	s.log.Info("story act started", "character", sess.ent.CharacterID, "act", n)
	s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: sess.ent.ID, TargetID: q.ID, Data: startedJSON(q)})
	s.storyIntro(sess, n)
	s.sendQuestLog(sess)
	s.saveQuests(sess)
	s.sendStorySync(sess)
}

// storyIntro sends an act's title card (the discovery intro style).
func (s *Server) storyIntro(sess *session, n int) {
	info := story.ActList[n-1]
	b, _ := json.Marshal(struct {
		Act      int    `json:"act"`
		Eyebrow  string `json:"eyebrow"`
		Title    string `json:"title"`
		Subtitle string `json:"subtitle"`
	}{n, story.Title + " · Act " + story.Roman(n), info.Title, info.Subtitle})
	s.sendEvent(sess, &proto.Event{Kind: EventStoryIntro, EntityID: sess.ent.ID, Value: int32(n), Data: b})
}

func (s *Server) storyLevel(sess *session) int {
	if e := sess.ent; e != nil && e.x != nil && e.x.prog != nil {
		return e.x.prog.Level
	}
	return 1
}

// storyAfter runs after a log advanced (questsAdvance): party sharing, the
// act's special steps, the next act.
func (s *Server) storyAfter(sess *session, hs []quests.Happening) {
	if s.storyPlaces() == nil || len(hs) == 0 {
		return
	}
	var main, prologue []quests.Happening
	for _, h := range hs {
		if story.ActOf(h.Quest.Key) > 0 {
			main = append(main, h)
		} else {
			if prologueShared(h) {
				prologue = append(prologue, h)
			}
			if h.Finished && h.Quest.Key == quests.WardKey {
				s.storyMaybeStart(sess)
			}
		}
	}
	if len(prologue) > 0 && !s.sty.sharing {
		s.sty.sharing = true
		for _, h := range prologue {
			s.storyShare(sess, h)
		}
		s.sty.sharing = false
	}
	if len(main) == 0 {
		return
	}
	for _, h := range main {
		s.storyStep(sess, h)
	}
	if !s.sty.sharing {
		s.sty.sharing = true
		for _, h := range main {
			s.storyShare(sess, h)
		}
		s.sty.sharing = false
	}
	for _, h := range main {
		if h.Finished {
			s.storyActDone(sess, story.ActOf(h.Quest.Key))
		}
	}
}

// storyStep: what a main story step's completion sets in motion.
func (s *Server) storyStep(sess *session, h quests.Happening) {
	q := h.Quest
	if story.ActOf(q.Key) != 4 || h.Step+1 >= len(q.Steps) {
		return
	}
	if next := q.Steps[h.Step+1]; next.Obj.Kind == quests.ObjStory && next.Obj.Family == story.TagVigil {
		s.vigilStart(sess) // the captain lights the beacon
	}
}

// storyActDone: an act finished: its counter, and the next act.
func (s *Server) storyActDone(sess *session, n int) {
	if sess.cnt != nil {
		sess.cnt.st.Add("acts", 1)
		sess.cnt.recheck = true
		s.saveContent(sess)
	}
	s.log.Info("story act done", "character", sess.ent.CharacterID, "act", n)
	s.storyMaybeStart(sess)
	s.sendStorySync(sess)
}

// prologueShared: the prologue's talk steps ("Slimes in the meadows" and
// "Ward against the night": the farmer, the blacksmith) are shared like the
// acts' (playtest 2 co-op: two friends stood in a queue to hear the same
// lines). Their item steps stay personal: each mines, buys and forges.
func prologueShared(h quests.Happening) bool {
	k := h.Quest.Key
	return (k == quests.MeadowsKey || k == quests.WardKey) && h.Step < len(h.Quest.Steps) && h.Quest.Steps[h.Step].Obj.Kind == quests.ObjTalk
}

// storyShare completes the same step for every party member beside the
// one who did it (same zone, within storyShareM, at the same act and step).
func (s *Server) storyShare(sess *session, h quests.Happening) {
	e := sess.ent
	if e == nil || e.PartyID == 0 {
		return
	}
	for _, o := range s.parties[e.PartyID] {
		if o == e || math.Hypot(o.Move.Pos.X-e.Move.Pos.X, o.Move.Pos.Z-e.Move.Pos.Z) > storyShareM {
			continue
		}
		os := s.byChar[o.CharacterID]
		if os == nil || os.quests == nil {
			continue
		}
		hs := os.quests.log.ForceStep(h.Quest.Key, h.Step, nil)
		if len(hs) == 0 {
			continue
		}
		s.log.Info("story step shared", "from", e.CharacterID, "to", o.CharacterID, "quest", h.Quest.Key, "step", h.Step)
		for _, oh := range hs {
			s.questHappened(os, oh)
			if st := &oh.Quest.Steps[oh.Step]; st.Say != "" && (st.Obj.Kind == quests.ObjTalk || st.Obj.Kind == quests.ObjGive) {
				who := s.storyNPCName(st.Obj.NPC)
				if who == "" { // the prologue's talks name a role, not a townsperson: the giver
					who, _, _ = strings.Cut(oh.Quest.Giver, ",")
				}
				s.storySay(os, who, st.Say) // what the NPC said to your friend, you heard too
			}
			if oh.Finished && oh.Quest.Key == quests.MeadowsKey {
				s.questsWardHandoff(os) // the farmer sends you both to the blacksmith
			}
		}
		os.quests.recheck = true
		s.sendQuestLog(os)
		s.saveQuests(os)
		s.storyAfter(os, hs)
	}
}

// storyNeedsNPC: the active act still has a talk (or give) step with this
// townsperson (towns-buffer index).
func (s *Server) storyNeedsNPC(l *quests.Log, npcIndex int) bool {
	for _, q := range l.Active {
		if story.ActOf(q.Key) == 0 {
			continue
		}
		for i := q.Step; i < len(q.Steps); i++ {
			if o := q.Steps[i].Obj; (o.Kind == quests.ObjTalk || o.Kind == quests.ObjGive) && o.NPC == npcIndex+1 {
				return true
			}
		}
	}
	return false
}

// storyNPCName is the name of the townsperson an objective names (NPC is
// the towns-buffer index + 1).
func (s *Server) storyNPCName(npc int) string {
	if w := s.cfg.Towns; w != nil && npc > 0 && npc <= len(w.T.NPCs) {
		return w.T.NPCs[npc-1].Name
	}
	return ""
}

// storySignal sends a story happening to every listed player who waits
// for it.
func (s *Server) storySignal(ids map[uint32]bool, tag string) {
	keys := make([]uint32, 0, len(ids))
	for id := range ids {
		keys = append(keys, id)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	for _, id := range keys {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer {
			continue
		}
		if sess := s.byChar[pe.CharacterID]; sess != nil && sess.quests != nil && sess.quests.log.Needs(quests.ObjStory) {
			s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjStory, Family: tag, Site: -1})
		}
	}
}

// storySay sends a line to one player (speaker "" = the narrator).
func (s *Server) storySay(sess *session, speaker, text string) {
	if sess == nil || sess.ent == nil {
		return
	}
	b, _ := json.Marshal(struct {
		Speaker string `json:"speaker"`
		Text    string `json:"text"`
	}{speaker, text})
	s.sendEvent(sess, &proto.Event{Kind: EventStorySay, EntityID: sess.ent.ID, Data: b})
}

func (s *Server) storySayNear(x, z, r float64, speaker, text string) {
	for _, e := range s.playersNear(x, z, r) {
		s.storySay(s.byChar[e.CharacterID], speaker, text)
	}
}

// ---- sync and party progress ----

type storyMember struct {
	ID    uint32 `json:"id"`
	Name  string `json:"name"`
	Act   int    `json:"act"`
	Step  int    `json:"step"`
	Steps int    `json:"steps"`
	Text  string `json:"text"`
	Title string `json:"title"`
	Dist  int    `json:"dist"`
}

func (s *Server) storyMemberOf(o *Entity, from *Entity) (storyMember, int) {
	m := storyMember{ID: o.ID, Name: o.Name, Dist: int(math.Round(math.Hypot(o.Move.Pos.X-from.Move.Pos.X, o.Move.Pos.Z-from.Move.Pos.Z)))}
	os := s.byChar[o.CharacterID]
	if os == nil || os.quests == nil {
		return m, -1
	}
	act, step := story.Progress(os.quests.log)
	m.Act, m.Step = act, step
	if act >= 1 && act <= story.Acts {
		m.Title = story.ActList[act-1].Title
		if q := os.quests.log.ByKey(story.Key(act)); q != nil {
			m.Steps = len(q.Steps)
			if c := q.Current(); c != nil {
				m.Text = c.Text
			}
		}
	} else if act > story.Acts {
		m.Title, m.Text = "The Last Song", "The dawn came: the game is beaten"
	}
	return m, story.Rank(act, step)
}

// storyLeader is the party member furthest along the main story on this
// zone (ties: the lowest entity id), and their rank.
func (s *Server) storyLeader(e *Entity) (*Entity, int) {
	var lead *Entity
	best := -1
	for _, o := range s.parties[e.PartyID] {
		_, r := s.storyMemberOf(o, e)
		if r > best || (r == best && lead != nil && o.ID < lead.ID) {
			lead, best = o, r
		}
	}
	return lead, best
}

func (s *Server) storyPartyTick(tick uint32) {
	if tick%storyEveryTicks != 7 || s.storyPlaces() == nil {
		return
	}
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || sess.quests == nil {
			continue
		}
		msg := ""
		if e.PartyID != 0 && len(s.parties[e.PartyID]) > 1 {
			lead, lr := s.storyLeader(e)
			me, mr := s.storyMemberOf(e, e)
			out := struct {
				Leader  uint32        `json:"leader"`
				You     storyMember   `json:"you"`
				Members []storyMember `json:"members"`
				Behind  bool          `json:"behind"`
			}{You: me, Members: []storyMember{}}
			if lead != nil {
				out.Leader = lead.ID
			}
			out.Behind = lead != nil && lead != e && lr > mr && lr >= story.Rank(1, 0)
			for _, o := range s.parties[e.PartyID] {
				if o == e {
					continue
				}
				m, _ := s.storyMemberOf(o, e)
				m.Dist = m.Dist / 10 * 10
				out.Members = append(out.Members, m)
			}
			sort.Slice(out.Members, func(i, j int) bool { return out.Members[i].ID < out.Members[j].ID })
			b, _ := json.Marshal(out)
			msg = string(b)
		}
		if s.sty.partyMsg[e.ID] == msg {
			continue
		}
		s.sty.partyMsg[e.ID] = msg
		s.sendEvent(sess, &proto.Event{Kind: EventStoryParty, EntityID: e.ID, Data: []byte(msg)})
	}
}

// sendStorySync sends Event 1600 (when it changed).
func (s *Server) sendStorySync(sess *session) {
	p := s.storyPlaces()
	if p == nil || sess.ent == nil || sess.quests == nil {
		return
	}
	act, step := story.Progress(sess.quests.log)
	type actView struct {
		N     int    `json:"n"`
		Title string `json:"title"`
		Level int    `json:"level"`
		Done  bool   `json:"done"`
	}
	out := struct {
		Title     string    `json:"title"`
		Act       int       `json:"act"`
		Step      int       `json:"step"`
		Acts      []actView `json:"acts"`
		Beaten    int       `json:"beaten"`
		Together  int       `json:"together"`
		Vow       bool      `json:"vow"`
		Heartfall [3]int    `json:"heartfall"` // x, z, r (m)
		Arena     string    `json:"arena"`
	}{Title: story.Title, Act: act, Step: step, Heartfall: [3]int{int(p.Heartfall.X), int(p.Heartfall.Z), int(p.Heartfall.R)}, Arena: p.Heartfall.Region}
	for n := 1; n <= story.Acts; n++ {
		out.Acts = append(out.Acts, actView{n, story.ActList[n-1].Title, story.ActList[n-1].Level, sess.quests.log.IsDone(story.Key(n))})
	}
	if sess.cnt != nil {
		out.Beaten, out.Together, out.Vow = sess.cnt.st.Stat("finale"), sess.cnt.st.Stat("finaleparty"), sess.cnt.st.Stat("vow") > 0
	}
	b, _ := json.Marshal(out)
	if s.sty.syncMsg[sess.ent.ID] == string(b) {
		return
	}
	s.sty.syncMsg[sess.ent.ID] = string(b)
	s.sendEvent(sess, &proto.Event{Kind: EventStorySync, EntityID: sess.ent.ID, Value: int32(act), Data: b})
}

func (s *Server) storyLeave(sess *session) {
	if e := sess.ent; e != nil {
		delete(s.sty.partyMsg, e.ID)
		delete(s.sty.syncMsg, e.ID)
		s.reviveLeave(e)
	}
}

// storyTick: party progress, the vigil, the finale, revives.
func (s *Server) storyTick(tick uint32) {
	if s.storyPlaces() == nil {
		s.reviveTick(tick) // revives work in every world with combat
		return
	}
	s.storyPartyTick(tick)
	if tick%storyEveryTicks == 11 {
		s.vigilTick(tick)
		for _, sess := range s.sessions {
			if sess.ent != nil && sess.quests != nil && story.Next(sess.quests.log) != 0 {
				s.storyMaybeStart(sess) // a character who reached the start (the Ward done on another zone)
			}
		}
	}
	s.finaleTick(tick)
	s.reviveTick(tick)
}

// ---- Interact 140 ----

func (s *Server) storyInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil {
		return
	}
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventStoryRefused, EntityID: e.ID, TargetID: uint32(m.Action), Value: r})
	}
	switch m.Action {
	case StoryActSync:
		delete(s.sty.syncMsg, e.ID)
		delete(s.sty.partyMsg, e.ID)
		s.sendStorySync(sess)
		s.finaleTell(sess)
	case StoryActCatchUp:
		if r := s.storyCatchUp(sess); r != 0 {
			refuse(r)
		}
	case StoryActRevive:
		if r := s.reviveHold(sess, uint32(m.TargetID), m.Arg != 0); r != 0 {
			refuse(r)
		}
	case StoryActRespawn:
		if s.cbt.w == nil || !s.cbt.w.RespawnNow(e.ID) {
			refuse(StoryRefuseNotDown)
		}
	case StoryActVow:
		if sess.cnt == nil || sess.cnt.st.Stat("finale") == 0 {
			refuse(StoryRefuseNotYet)
			return
		}
		want := 0
		if m.Arg != 0 {
			want = 1
		}
		if have := sess.cnt.st.Stat("vow"); have != want {
			sess.cnt.st.Add("vow", want-have)
			s.saveContent(sess)
			line := "You take the Starless Vow. The nights will be crueller, and the Hush will remember you."
			if want == 0 {
				line = "You set the Starless Vow aside. The nights grow gentler."
			}
			s.storySay(sess, "", line)
		}
		s.sendStorySync(sess)
	default:
		refuse(StoryRefuseUnknown)
	}
}

// storyCatchUp moves a character behind their party's furthest member to
// that member's act and step (Interact 140/2).
func (s *Server) storyCatchUp(sess *session) int32 {
	e, p := sess.ent, s.storyPlaces()
	if p == nil || sess.quests == nil || e.PartyID == 0 {
		return StoryRefuseNotBehind
	}
	lead, lr := s.storyLeader(e)
	_, mr := s.storyMemberOf(e, e)
	if lead == nil || lead == e || lr <= mr {
		return StoryRefuseNotBehind
	}
	ls := s.byChar[lead.CharacterID]
	act, step := story.Progress(ls.quests.log)
	if act > story.Acts { // they beat the game: join them at the Hush
		act = story.Acts
		if q := story.Act(act, p, 0); q != nil {
			step = len(q.Steps) - 1
		}
	}
	if step < 0 { // between acts: the start of the next
		step = 0
	}
	sk, ok := story.CatchUp(sess.quests.log, p, act, step, s.cfg.Now().UnixMilli())
	if !ok {
		return StoryRefuseNotBehind
	}
	for _, it := range sk.Items {
		s.questGrant(sess, []quests.ItemQty{it}, "story:catchup:"+it.Item, "story catch-up")
	}
	if sk.XP > 0 {
		s.grantCombatXP(combat.XPGrant{Player: e.ID, XP: sk.XP, Reason: "quest"})
	}
	if sess.cnt != nil && len(sk.Acts) > 0 {
		sess.cnt.st.Add("acts", len(sk.Acts))
		sess.cnt.recheck = true
		s.saveContent(sess)
	}
	s.log.Info("story catch-up", "character", e.CharacterID, "to", lead.CharacterID, "act", act, "step", step, "skipped", len(sk.Acts))
	sess.quests.recheck = true
	s.storySay(sess, "", "You catch up with "+lead.Name+": "+story.ActList[act-1].Title+".")
	s.storyIntro(sess, act)
	s.sendQuestLog(sess)
	s.saveQuests(sess)
	s.sendStorySync(sess)
	delete(s.sty.partyMsg, e.ID)
	return 0
}

// ---- Act IV: the vigil ----

// vigilStart lights the beacon at the vigil town: a town defense (night.go)
// that every player near joins; held, it brings the Starless Sovereign.
func (s *Server) vigilStart(sess *session) {
	p := s.storyPlaces()
	if p == nil || s.sty.vigil != nil {
		return
	}
	town := p.Vigil.Site
	v := &vigilRun{town: town, part: map[uint32]bool{sess.ent.ID: true}, lastNear: s.tick}
	s.sty.vigil = v
	s.nightInit()
	if s.night.defs[town] != nil || s.StartDefense(town) {
		v.defense = true
		s.storySayNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+250, p.Captain.Name, "The beacon is lit! Here they come: hold the garden!")
		s.log.Info("story vigil started", "town", town, "by", sess.ent.CharacterID)
		return
	}
	// No night system on this zone: the Sovereign comes at once.
	s.log.Info("story vigil: no town defense here; the Sovereign comes at once", "town", town)
	s.vigilSovereign(v)
}

// storyDefenseEnded (night.go endDefense): the vigil's waves are over.
func (s *Server) storyDefenseEnded(town, result int, part []uint32) {
	v := s.sty.vigil
	if v == nil || v.town != town || !v.defense {
		return
	}
	v.defense = false
	for _, id := range part {
		v.part[id] = true
	}
	p := s.storyPlaces()
	if result != DefenseHeld {
		s.storySayNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+250, p.Captain.Name, "The ward fell... Fall back! Find me when you're ready, and we light the beacon again.")
		s.vigilFail()
		return
	}
	for _, e := range s.playersNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+200) {
		v.part[e.ID] = true
	}
	s.storySignal(v.part, story.TagVigil)
	s.vigilSovereign(v)
}

// vigilSovereign: the Starless Sovereign walks out of the dark at the
// edge of town.
func (s *Server) vigilSovereign(v *vigilRun) {
	p := s.storyPlaces()
	if s.cbt.w == nil {
		return
	}
	level := 10
	dx, dz := 1.0, 0.0
	var near *Entity // the participant it comes for
	for id := range v.part {
		if pe := s.entityByID(id); pe != nil && pe.Kind == proto.EntityKindPlayer {
			if sess := s.byChar[pe.CharacterID]; sess != nil {
				level = max(level, s.storyLevel(sess)+1)
			}
			if d := math.Hypot(pe.Move.Pos.X-p.Vigil.X, pe.Move.Pos.Z-p.Vigil.Z); d > 1 {
				dx, dz = (pe.Move.Pos.X-p.Vigil.X)/d, (pe.Move.Pos.Z-p.Vigil.Z)/d
			}
			near = pe
		}
	}
	x, z := p.Vigil.X+dx*(p.Vigil.R+30), p.Vigil.Z+dz*(p.Vigil.R+30)
	// Playtest 2 co-op: it walks out of the dark within its aggro (50 m) of
	// the defenders. Spawned at the town's edge it stood 80 m from the pair
	// at the ward garden, outside its aggro and the marker, and they looked
	// for it for eight minutes.
	if near != nil {
		x, z = near.Move.Pos.X+dx*vigilSovereignM, near.Move.Pos.Z+dz*vigilSovereignM
	}
	x, z = s.cbt.w.WalkableNear(x, z, 40, 4)
	g := s.cbt.w.SpawnDemons(movement.Vec3{X: x, Z: z}, []string{combatdefs.D.Demons.Lord}, level)
	for _, e := range g.Members {
		e.Name = "The Starless Sovereign"
	}
	v.sovereign = g
	v.lastNear = s.tick
	s.storySayNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+300, "The Starless Sovereign", "Little lights. You kept your vigil. Now keep still.")
	s.log.Info("story vigil: the Sovereign walks", "town", v.town, "level", level, "x", math.Round(x), "z", math.Round(z))
}

func (s *Server) vigilFail() {
	v := s.sty.vigil
	if v == nil {
		return
	}
	if v.sovereign != nil {
		for _, e := range v.sovereign.Members {
			if e.Alive() {
				s.cbt.w.Despawn(e)
			}
		}
	}
	s.sty.vigil = nil
	// Everyone on the vigil's steps goes back to "light the beacon".
	for _, sess := range s.sessions {
		if sess.quests == nil {
			continue
		}
		q := sess.quests.log.ByKey(story.Key(4))
		if q == nil {
			continue
		}
		for i := range q.Steps {
			if q.Steps[i].Obj.Kind == quests.ObjStory && q.Steps[i].Obj.Family == story.TagVigil && q.Step > i-1 && q.Step <= i+1 {
				sess.quests.log.SetStep(q.Key, i-1)
				s.sendQuestLog(sess)
				s.saveQuests(sess)
			}
		}
	}
	s.log.Info("story vigil failed")
}

// vigilTick (1 Hz): the vigil's players drifting away fails it.
func (s *Server) vigilTick(tick uint32) {
	v, p := s.sty.vigil, s.storyPlaces()
	if v == nil || p == nil {
		return
	}
	if len(s.playersNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+250)) > 0 {
		v.lastNear = tick
		if v.defense && s.night.defs[v.town] == nil { // ended without telling us (a dawn)
			s.storyDefenseEnded(v.town, DefenseHeld, nil)
		}
		return
	}
	if tick-v.lastNear > vigilLeaveS*30 {
		s.vigilFail()
	}
}

// storyOnKill: the Sovereign and the Hush.
func (s *Server) storyOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en == nil {
		return
	}
	if v := s.sty.vigil; v != nil && v.sovereign != nil && en.Group == v.sovereign {
		ids := map[uint32]bool{}
		for _, id := range k.Eligible {
			ids[id] = true
		}
		p := s.storyPlaces()
		for _, e := range s.playersNear(en.Pos.X, en.Pos.Z, 160) {
			ids[e.ID] = true
		}
		for _, e := range s.playersNear(p.Vigil.X, p.Vigil.Z, p.Vigil.R+60) {
			ids[e.ID] = true
		}
		s.storySayNear(en.Pos.X, en.Pos.Z, 200, "The Starless Sovereign", "The Hush... remembers...")
		s.sty.vigil = nil
		s.storySignal(ids, story.TagSovereign)
		s.log.Info("story vigil: the Sovereign fell", "players", len(ids))
		return
	}
	s.sanctumOnKill(k)
	s.finaleOnKill(k)
}

// sanctumOnKill: the sanctum's guardian (its boss) fell: the lens step for
// everyone who fought it and their party beside them. Playtest 2 co-op:
// the step was "the place falls quiet", and a pack of adds dying (or the
// boss resetting after a wipe) handed over the lens with the Archon at
// 99 %.
func (s *Server) sanctumOnKill(k combat.KillInfo) {
	en, p := k.Enemy, s.storyPlaces()
	if en == nil || p == nil || !p.Sanctum.OK || en.Group == nil || en.Group.Kind != combat.GroupBoss {
		return
	}
	if en.Group.Site != p.Sanctum.Site && math.Hypot(en.Group.Anchor.X-p.Sanctum.X, en.Group.Anchor.Z-p.Sanctum.Z) > math.Max(p.Sanctum.R, 30) {
		return
	}
	for _, m := range en.Group.Members {
		if m.Alive() {
			return
		}
	}
	ids := map[uint32]bool{}
	for _, id := range k.Eligible {
		ids[id] = true
	}
	for _, e := range s.playersNear(en.Pos.X, en.Pos.Z, 120) {
		ids[e.ID] = true
	}
	s.storySignal(ids, story.TagSanctum)
	s.log.Info("story sanctum: the guardian fell", "players", len(ids))
}

// sanctumHasGuardian: the sanctum site has a boss to fall (else the act
// keeps the old "place falls quiet" step).
func (s *Server) sanctumHasGuardian(p *story.Places) bool {
	if s.cbt.w == nil || !p.Sanctum.OK {
		return false
	}
	for _, g := range s.cbt.w.Groups {
		if g.Kind == combat.GroupBoss && (g.Site == p.Sanctum.Site || math.Hypot(g.Anchor.X-p.Sanctum.X, g.Anchor.Z-p.Sanctum.Z) <= math.Max(p.Sanctum.R, 30)) {
			return true
		}
	}
	return false
}

// storyHunters scales a player's night hunters by their story: a beaten
// game calms the nights, the Starless Vow makes them crueller.
func (s *Server) storyHunters(e *Entity, want int) int {
	sess := s.byChar[e.CharacterID]
	if sess == nil || sess.cnt == nil || sess.cnt.st.Stat("finale") == 0 {
		return want
	}
	if sess.cnt.st.Stat("vow") > 0 {
		return int(math.Ceil(float64(want) * 1.5))
	}
	return int(math.Floor(float64(want) * 0.6))
}

// storyQuestAbandon: the main story can't be dropped.
func storyQuestKeep(q *quests.Quest) bool { return q != nil && story.ActOf(q.Key) > 0 }
