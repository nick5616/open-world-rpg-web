package game

// The first hour (playtest 4, CR 051): a new character arrives at a person
// with a problem, and then walks a chain of short errands, each given by a
// townsperson and sending them to one system near town (internal/quests
// errands.go has the quests; this file resolves their places, signals their
// deeds, chains them and offers them on a talk).
//
//   - Arrival: a brand-new character's mentor (the giver of "Slimes in the
//     meadows") calls them over by name with an NPC bark (Event 1930,
//     npc_bark.go), once when the world is up and again if they have not
//     come over. Old characters never see it.
//   - Chain: for a character who started the slimes, finishing (or dropping)
//     the slimes and each of the first ErrandPrologue errands starts the next
//     one by itself, tracked; then the Ward follows. The giver of the later
//     errands (fish, steed, tower) offers them on a talk, in order.
//   - Everyone else (a character from before playtest 4): nothing starts by
//     itself; the people offer their errands when talked to (Event 951, the
//     same card as every side quest), in any order.
//   - Deeds: ObjDo steps count mining, felling, smelting, building, lighting
//     the torch, a landed fish, a whistled steed and a mount (questsDeed,
//     signalled from the systems themselves, event-driven).
//
// Cost: places are resolved once per settlement; deeds only call the quest
// log when a step wants one; the arrival check runs only while a new
// character waits for it.

import (
	"math"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/quests"
)

// errandCtx is a settlement's resolved errands and its mentor's NPC index.
type errandCtx struct {
	p      *quests.ErrandPlaces
	mentor int // towns NPC index of the slimes' giver (-1 none)
}

// arrival is a new character waiting for their mentor's call.
type arrival struct {
	at    uint32 // tick to try next
	stage int    // 0: first call, 1: second call, then done
	tries int
}

const (
	arriveFirstTicks  = constants.TickRateHz * 3  // the world is up and drawn
	arriveRetryTicks  = constants.TickRateHz      // the mentor is not close enough to be in the world yet
	arriveAgainTicks  = constants.TickRateHz * 40 // still standing around
	arriveMaxTries    = 25
	arriveAgainWithin = 90.0 // m: the second call is for someone still near
)

// homeTown is the non-sky settlement nearest (x, z), -1 without towns.
func (s *Server) homeTown(x, z float64) int {
	w := s.cfg.Towns
	if w == nil {
		return -1
	}
	best, bd := -1, math.Inf(1)
	for i := range w.T.Settlements {
		if s.skyTown(i) {
			continue
		}
		if d := math.Hypot(w.T.Settlements[i].X-x, w.T.Settlements[i].Z-z); d < bd {
			best, bd = i, d
		}
	}
	return best
}

// personOf is the first named NPC of role in settlement si.
func (s *Server) personOf(si int, role uint8) (quests.Person, int) {
	w := s.cfg.Towns
	st := &w.T.Settlements[si]
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if d := &w.T.NPCs[i]; d.Role == role && d.Name != "" {
			return quests.Person{Name: d.Name, Role: int(role), Title: towns.RoleNames[role], At: quests.Place{OK: true, X: d.WorkX, Z: d.WorkZ}}, i
		}
	}
	return quests.Person{}, -1
}

// errandsAt resolves (once) the errands' places around settlement si.
func (s *Server) errandsAt(si int) *errandCtx {
	w := s.cfg.Towns
	if w == nil || si < 0 || si >= len(w.T.Settlements) {
		return nil
	}
	if c := s.qst.errands[si]; c != nil {
		return c
	}
	if s.qst.errands == nil {
		s.qst.errands = map[int]*errandCtx{}
	}
	st := &w.T.Settlements[si]
	town := s.settlementName(si)
	p := &quests.ErrandPlaces{Settlement: si, Town: town, TowerSite: -1}
	c := &errandCtx{p: p, mentor: -1}
	for _, role := range meadowsGiverRoles {
		if g, i := s.personOf(si, role); g.Name != "" {
			p.Mentor, c.mentor = g, i
			break
		}
	}
	p.Smith, _ = s.personOf(si, towns.RoleBlacksmith)
	p.Guard, _ = s.personOf(si, towns.RoleGuard)
	p.Innkeeper, _ = s.personOf(si, towns.RoleInnkeeper)
	p.Merchant, _ = s.personOf(si, towns.RoleMerchant)
	p.Keeper, _ = s.personOf(si, towns.RoleBounty)
	for i := st.PropFirst; i < st.PropFirst+st.Props; i++ {
		if pr := &w.T.Props[i]; pr.Kind == towns.PropForge {
			p.Forge = quests.Place{OK: true, X: pr.X, Z: pr.Z}
			break
		}
	}
	s.resolveErrandCaves(st, town, p)
	s.resolveErrandWater(st, town, p)
	s.resolveErrandTower(st, town, p)
	s.log.Info("errand places", "settlement", si, "town", town, "mentor", p.Mentor.Name, "smith", p.Smith.Name, "guard", p.Guard.Name, "innkeeper", p.Innkeeper.Name,
		"merchant", p.Merchant.Name, "keeper", p.Keeper.Name, "forge", p.Forge.OK, "oreMouth", p.OreMouth.OK, "darkMouth", p.DarkMouth.OK, "water", p.Water.OK, "tower", p.TowerName)
	s.qst.errands[si] = c
	return c
}

// errandCaveRangeM: a cave mouth farther from the town centre than this is
// not "near town".
const errandCaveRangeM = 900

// resolveErrandCaves picks the nearest cave mouth (the torch's) and the
// nearest with copper or iron in its walls (the ore's).
func (s *Server) resolveErrandCaves(st *towns.Settlement, town string, p *quests.ErrandPlaces) {
	cw := s.caves()
	if cw == nil {
		return
	}
	g := cw.CaveGraph()
	if g == nil {
		return
	}
	darkD, oreD := math.Inf(1), math.Inf(1)
	for si := range g.Systems {
		sys := &g.Systems[si]
		mx, mz, md := 0.0, 0.0, math.Inf(1)
		for oi := sys.FirstOpening; oi < sys.FirstOpening+sys.Openings && oi < len(g.OpeningsList); oi++ {
			o := &g.OpeningsList[oi]
			if o.Sinkhole {
				continue
			}
			if d := math.Hypot(o.X-st.X, o.Z-st.Z); d < md {
				mx, mz, md = o.X, o.Z, d
			}
		}
		if md > errandCaveRangeM {
			continue
		}
		name := ""
		if a := s.atlasSite(sys.SiteIndex); a != nil {
			name = a.Name
		}
		label := "Cave mouth"
		if name != "" {
			label = "Cave mouth: " + name
		}
		mouth := quests.Place{OK: true, X: mx, Z: mz, Name: label, Where: quests.Where(st.X, st.Z, mx, mz, town)}
		if md < darkD {
			darkD, p.DarkMouth = md, mouth
		}
		if md >= oreD {
			continue
		}
		var cx, cz float64
		n := 0
		var xs, zs []float64
		for vi := sys.FirstVein; vi < sys.FirstVein+sys.VeinCount && vi < len(g.Veins); vi++ {
			v := &g.Veins[vi]
			if m := v.MaterialName(); v.Kind == caves.KindGem || (m != "copper" && m != "iron") {
				continue
			}
			xs, zs = append(xs, v.X), append(zs, v.Z)
			cx, cz, n = cx+v.X, cz+v.Z, n+1
		}
		if n == 0 {
			continue
		}
		cx, cz = cx/float64(n), cz/float64(n)
		r := 0.0
		for i := range xs {
			r = math.Max(r, math.Hypot(xs[i]-cx, zs[i]-cz))
		}
		oreD, p.OreMouth = md, mouth
		p.OreVeins = quests.Place{OK: true, X: cx, Z: cz, R: math.Min(60, r+10), Name: name}
	}
}

// resolveErrandWater finds the nearest water deep enough to fish within
// 500 m of the town centre (rings of samples, nearest first).
func (s *Server) resolveErrandWater(st *towns.Settlement, town string, p *quests.ErrandPlaces) {
	g := s.cfg.Ground
	if g == nil {
		return
	}
	minDepth := math.Max(1, contentdefs.D.Fishing.MinDepthM)
	for r := 40.0; r <= 500; r += 20 {
		for k := 0; k < 24; k++ {
			a := float64(k) * math.Pi / 12
			x, z := st.X+r*math.Cos(a), st.Z+r*math.Sin(a)
			if x < 2 || z < 2 || x > constants.WorldSizeM-2 || z > constants.WorldSizeM-2 {
				continue
			}
			w := movement.WaterAt(g, x, z)
			if math.IsInf(w, 0) || math.IsNaN(w) || w-g.HeightAt(x, z) < minDepth {
				continue
			}
			p.Water = quests.Place{OK: true, X: x, Z: z, R: 25, Name: "Fishing water", Where: quests.Where(st.X, st.Z, x, z, town)}
			return
		}
	}
}

// resolveErrandTower finds the nearest tower a player can walk up to.
func (s *Server) resolveErrandTower(st *towns.Settlement, town string, p *quests.ErrandPlaces) {
	ex := s.cfg.Explore
	if ex == nil {
		return
	}
	bd := math.Inf(1)
	for _, t := range ex.Towers {
		if t.Site < 0 || t.Site >= len(ex.Atlas.Sites) {
			continue
		}
		if t.Shape != nil && !s.towerApproachable(t.Shape.CX, t.Shape.CZ, t.Shape.MaxR) {
			continue
		}
		a := &ex.Atlas.Sites[t.Site]
		if d := math.Hypot(a.X-st.X, a.Z-st.Z); d < bd {
			bd = d
			p.TowerSite, p.TowerName = t.Site, a.Name
			p.Tower = quests.Place{OK: true, X: a.X, Z: a.Z, R: math.Max(a.Radius, 12) + 10, Name: a.Name, Where: quests.Where(st.X, st.Z, a.X, a.Z, town)}
		}
	}
}

// ---- deeds ----

// questsDeed tells the quest log the player did something an errand counts
// (mine, fell, smelt, build, torch, fish, steed, ride). Nothing happens
// unless a current step wants that deed.
func (s *Server) questsDeed(sess *session, deed string) {
	if sess == nil || sess.quests == nil || !sess.quests.log.Needs(quests.ObjDo) {
		return
	}
	s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjDo, Family: deed, Site: -1})
}

// ---- the chain ----

// errandChain is a new character's line: the slimes, then the prologue's
// errands one at a time. It starts the next errand (true: one is running or
// was just started, so the Ward waits) or reports nothing left (false).
func (s *Server) errandChain(sess *session) bool {
	e, l := sess.ent, sess.quests.log
	if !l.HasStarted(quests.MeadowsKey) || l.HasStarted(quests.WardKey) || l.IsDone(quests.WardKey) {
		return false // a character from before playtest 4 gets offers on talk, never a chain
	}
	for _, id := range quests.ErrandChain[:quests.ErrandPrologue] {
		if l.ByKey(quests.ErrandKey(id)) != nil {
			return true
		}
	}
	c := s.errandsAt(s.homeTown(e.Move.Pos.X, e.Move.Pos.Z))
	if c == nil {
		return false
	}
	for {
		id := quests.NextErrand(l, quests.ErrandPrologue)
		if id == "" {
			return false
		}
		q, _ := quests.Errand(id, c.p, true, s.cfg.Now().UnixMilli())
		if q == nil {
			l.MarkDone(quests.ErrandKey(id)) // this town cannot give it: skip
			continue
		}
		s.errandBegin(sess, q, "chain")
		return true
	}
}

// errandBegin puts an errand in the log (the chain, or an accepted offer),
// hands over what its giver gives at the start, tracks it and says so.
func (s *Server) errandBegin(sess *session, q *quests.Quest, how string) bool {
	e, l := sess.ent, sess.quests.log
	if l.Add(q) != nil {
		return false
	}
	l.Track(q.ID)
	if len(q.Start) > 0 {
		s.questGrant(sess, q.Start, "quest:"+q.Key+":start", q.Key)
	}
	s.log.Info("quest started", "character", e.CharacterID, "quest", q.Key, "how", how, "settlement", q.Settlement)
	s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: e.ID, TargetID: q.ID, Data: startedJSON(q)})
	sess.quests.recheck = true
	return true
}

// errandsTalk: a talk to a townsperson who gives an errand offers it, the
// first one of the chain they give that this character has not started
// (a new character: in order; an older one: any). Reports whether an offer
// was sent (then no side quest is offered over it).
func (s *Server) errandsTalk(sess *session, npcIndex int, npcEnt uint32, done int) bool {
	if done > 0 || sess.quests == nil || sess.cnt == nil || s.qst.noErrands {
		return false
	}
	w := s.cfg.Towns
	if w == nil || npcIndex < 0 || npcIndex >= len(w.T.NPCs) {
		return false
	}
	d := &w.T.NPCs[npcIndex]
	if d.Name == "" || s.skyTown(d.Settlement) {
		return false
	}
	c := s.errandsAt(d.Settlement)
	if c == nil {
		return false
	}
	l := sess.quests.log
	chain := l.HasStarted(quests.MeadowsKey) // a new character walks the chain in order
	now := s.cfg.Now().UnixMilli()
	for i, id := range quests.ErrandChain {
		g := c.p.ErrandGiver(id)
		if g.Name != d.Name || g.Role != int(d.Role) {
			continue
		}
		k := quests.ErrandKey(id)
		if l.ByKey(k) != nil || l.IsDone(k) {
			continue
		}
		if chain && i > 0 && !l.IsDone(quests.ErrandKey(quests.ErrandChain[i-1])) {
			continue
		}
		if chain && i < quests.ErrandPrologue {
			continue // the chain starts these itself
		}
		q, say := quests.Errand(id, c.p, false, now)
		if q == nil {
			continue
		}
		m := s.cnt.offers[sess.ent.CharacterID]
		if m == nil || len(m) > offerKeep {
			m = map[uint32]*content.Offer{}
			s.cnt.offers[sess.ent.CharacterID] = m
		}
		m[q.ID] = &content.Offer{Quest: q, Say: say, Kind: "errand"}
		s.sendEvent(sess, &proto.Event{Kind: EventQuestOffer, EntityID: npcEnt, TargetID: q.ID, Data: quests.OfferWireSay(q, say, c.p.Town)})
		return true
	}
	return false
}

// errandAbandoned: a new character who drops a chain errand skips it (the
// chain moves on); anyone else just drops it and can take it again.
func (s *Server) errandAbandoned(sess *session, qq *quests.Quest) {
	l := sess.quests.log
	if !quests.IsErrand(qq.Key) {
		return
	}
	if l.HasStarted(quests.MeadowsKey) && !l.HasStarted(quests.WardKey) {
		l.MarkDone(qq.Key)
	}
	s.questsWardHandoff(sess)
}

// wardWaitsForErrands: a new character's blacksmith offers the Ward only
// once the prologue's errands are done (one thing at a time).
func (s *Server) wardWaitsForErrands(l *quests.Log) bool {
	return !s.qst.noErrands && l.HasStarted(quests.MeadowsKey) && quests.NextErrand(l, quests.ErrandPrologue) != ""
}

// ---- the arrival ----

// arrivalLine is what the mentor calls across the road.
func arrivalLine(name string, second bool) string {
	if second {
		return name + "! Over here! Walk up close and press E to talk. I won't bite, I only complain."
	}
	return name + "! Over here! Yes, you, the one standing about looking lost. I have a job, and it's sort of an emergency."
}

// fhArrive registers a brand-new character for the mentor's call (the slimes
// were just started for them).
func (s *Server) fhArrive(sess *session) {
	if s.qst.arrive == nil {
		s.qst.arrive = map[string]*arrival{}
	}
	s.qst.arrive[sess.ent.CharacterID] = &arrival{at: s.tick + arriveFirstTicks}
}

// errandsTick makes the calls (tick goroutine; costs nothing while nobody
// is waiting for one).
func (s *Server) errandsTick(tick uint32) {
	for id, a := range s.qst.arrive {
		if tick < a.at {
			continue
		}
		sess := s.byChar[id]
		if sess == nil || sess.ent == nil || sess.quests == nil {
			delete(s.qst.arrive, id)
			continue
		}
		q := sess.quests.log.ByKey(quests.MeadowsKey)
		if q == nil || q.Step != 0 { // they went and talked to them: done
			delete(s.qst.arrive, id)
			continue
		}
		e := sess.ent
		c := s.errandsAt(s.homeTown(e.Move.Pos.X, e.Move.Pos.Z))
		if c == nil || c.mentor < 0 {
			delete(s.qst.arrive, id)
			continue
		}
		if a.stage == 1 {
			ne := s.town.active[c.mentor]
			if ne == nil || math.Hypot(ne.Move.Pos.X-e.Move.Pos.X, ne.Move.Pos.Z-e.Move.Pos.Z) > arriveAgainWithin {
				delete(s.qst.arrive, id)
				continue
			}
		}
		if !s.npcBark(c.mentor, arrivalLine(e.Name, a.stage == 1), e, 7500) {
			if a.tries++; a.tries >= arriveMaxTries {
				delete(s.qst.arrive, id)
			} else {
				a.at = tick + arriveRetryTicks
			}
			continue
		}
		s.log.Info("arrival call", "character", id, "mentor", c.p.Mentor.Name, "stage", a.stage)
		if a.stage++; a.stage > 1 {
			delete(s.qst.arrive, id)
			continue
		}
		a.at = tick + arriveAgainTicks
	}
}
