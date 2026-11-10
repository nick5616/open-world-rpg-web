package game

// Townsfolk side quests and story quests (CR 023): talking to a quest
// giver (content.Givers: 2-4 per settlement) offers their current request
// as an ordinary quest offer (Event 951 with the giver's line in `say`); an
// innkeeper, guard, bounty keeper or farmer may first offer a story
// (content.yaml stories). Accepting goes through Interact 60 action 1 like
// the Ward. Finishing one pays gold, XP, items and reputation with the
// giver's town and brings the giver's next request. Rescue quests spawn the
// lost villager as an NPC entity that follows its rescuer home.

import (
	"math"
	"strconv"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

const (
	followNearM   = 20  // a follower counts as escorted within this
	followLeaveM  = 45  // beyond this it walks... or catches up (teleports)
	followSpeed   = 6.2 // m/s, a little faster than a walk
	offerKeep     = 64  // offers remembered per character (accepting refers back)
	followBehindM = 2.4
)

// follower is a rescued villager walking behind their rescuer.
type follower struct {
	ent  *Entity
	qid  uint32
	name string
}

// contentTalk: after a talk (towns.go), a quest giver offers their request
// or a story. done = quest steps the talk just completed (no new offer
// then: the NPC is thanking you).
func (s *Server) contentTalk(sess *session, npcIndex int, npcEnt uint32, done int) {
	if sess.cnt == nil || sess.quests == nil || done > 0 {
		return
	}
	cw := s.contentWorld()
	tw := s.cfg.Towns
	if cw == nil || tw == nil || npcIndex < 0 || npcIndex >= len(tw.T.NPCs) {
		return
	}
	d := &tw.T.NPCs[npcIndex]
	t := cw.Town(d.Settlement)
	if t == nil {
		return
	}
	l := sess.quests.log
	now := s.cfg.Now().UnixMilli()
	var offer *content.Offer
	giver := content.IsGiver(cw.Seed, t, npcIndex)
	if giver {
		seq := sess.cnt.st.GiverSeq(t.Index, npcIndex)
		for l.IsDone(content.SideKey(t.Index, npcIndex, seq)) {
			sess.cnt.st.GiverDone(t.Index, npcIndex, seq)
			seq++
		}
		if l.ByKey(content.SideKey(t.Index, npcIndex, seq)) == nil {
			offer = content.SideQuest(cw, t, npcIndex, seq, now)
		}
	}
	// A story (once per character, by its role, anywhere): from a giver
	// only once their own request is in your log.
	for _, def := range content.StoriesFor(int(d.Role)) {
		if offer != nil {
			break
		}
		key := content.StoryKey(def.Key)
		if l.HasStarted(key) || l.IsDone(key) || l.ByKey(key) != nil {
			continue
		}
		if q := content.Story(cw, def, t, npcIndex, now); q != nil {
			offer = &content.Offer{Quest: q, Say: def.Offer, Kind: "story"}
			break
		}
	}
	if offer == nil {
		return
	}
	m := s.cnt.offers[sess.ent.CharacterID]
	if m == nil || len(m) > offerKeep {
		m = map[uint32]*content.Offer{}
		s.cnt.offers[sess.ent.CharacterID] = m
	}
	m[offer.Quest.ID] = offer
	s.sendEvent(sess, &proto.Event{Kind: EventQuestOffer, EntityID: npcEnt, TargetID: offer.Quest.ID, Data: quests.OfferWireSay(offer.Quest, offer.Say, t.Name)})
}

// contentAccept is Interact 60/1 for a content offer: 0 accepted, else a
// quest refusal (QuestRefuse*).
func (s *Server) contentAccept(sess *session, id uint32) int32 {
	off := s.cnt.offers[sess.ent.CharacterID][id]
	if off == nil {
		return QuestRefuseUnknown
	}
	q := off.Quest
	if err := sess.quests.log.Add(q); err != nil {
		return questRefusal(err)
	}
	delete(s.cnt.offers[sess.ent.CharacterID], id)
	if len(q.Start) > 0 {
		s.questGrant(sess, q.Start, "quest:"+q.Key+":start", q.Key)
	}
	s.log.Info("quest accepted", "character", sess.ent.CharacterID, "quest", q.Key, "kind", off.Kind)
	s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: sess.ent.ID, TargetID: q.ID, Data: startedJSON(q)})
	sess.quests.recheck = true
	return 0
}

// contentQuestHappened (questHappened): rescue followers, give steps, and a
// finished quest's reputation, items, counters and the giver's next request.
func (s *Server) contentQuestHappened(sess *session, h quests.Happening) {
	q := h.Quest
	st := &q.Steps[h.Step]
	if st.Obj.Kind == quests.ObjGive && sess.items != nil && len(st.Obj.Items) > 0 {
		var d items.Delta
		if sess.items.inv.Spend(st.Obj.Items[0].Item, st.Obj.Items[0].Qty, &d) {
			s.commitItems(sess, &d, nil, "quest give "+q.Key)
		}
	}
	// A rescue's "find" step: the villager says hello and starts following.
	if !h.Finished && q.Kind == quests.KindSide && h.Step+1 < len(q.Steps) && q.Steps[h.Step+1].Obj.Kind == quests.ObjEscort {
		f := s.spawnFollower(sess, q)
		if f != nil && st.Say != "" {
			s.sendEvent(sess, &proto.Event{Kind: EventContentSay, EntityID: f.ent.ID, TargetID: q.ID, Data: []byte(st.Say)})
		}
	}
	if !h.Finished || sess.cnt == nil {
		return
	}
	switch q.Kind {
	case quests.KindSide:
		sess.cnt.st.Add("side", 1)
		if q.GiverNPC > 0 {
			sess.cnt.st.GiverDone(q.Settlement, q.GiverNPC-1, q.Seq)
		}
	case quests.KindStory:
		if q.Key != quests.WardKey {
			sess.cnt.st.Add("stories", 1)
		}
	case quests.KindBounty:
		sess.cnt.st.Add("bounties", 1)
	}
	if q.Rep > 0 {
		s.contentRep(sess, q.Settlement, q.Rep)
	}
	if len(q.Items) > 0 {
		s.questGrant(sess, q.Items, "quest:"+q.Key+":items", q.Key)
	}
	if q.RollItems > 0 {
		s.rollRewards(sess, q.RollItems, 2.5, 2, "quest:"+q.Key+":roll", q.Key)
	}
	if f := s.cnt.follow[sess.ent.CharacterID]; f != nil && f.qid == q.ID {
		s.dismissFollower(sess.ent)
	}
	sess.cnt.recheck = true
	s.saveContent(sess)
}

// rollRewards grants n rolled equipment pieces (at least rarity minRar)
// exactly once per marker.
func (s *Server) rollRewards(sess *session, n int, luck float64, minRar int, marker, src string) []*items.Item {
	ci, e := sess.items, sess.ent
	if ci == nil || e == nil || ci.markers[marker] || n <= 0 {
		return nil
	}
	now := s.cfg.Now()
	level := 1
	if e.x != nil && e.x.prog != nil {
		level = max(1, e.x.prog.Level)
	}
	seed := items.Mix64(s.cfg.Seed ^ hashString(marker) ^ hashString(e.CharacterID))
	r := items.NewRNG(seed)
	var d items.Delta
	var got []*items.Item
	for i := 0; i < n; i++ {
		it := items.RollEquipment(r, items.Rolled{Level: level, Element: -1, Luck: luck, MinRarity: minRar})
		it.Seed = int64(seed)
		it.Prov = []items.Prov{{Ev: "rolled", Char: e.CharacterID, Name: e.Name, Src: src, At: now.UnixMilli(), Local: ci.persist == persistLocal}}
		if !ci.inv.CanFit(it.Base, 1) {
			pos := e.Move.Pos
			s.spawnDrop(e.ID, it, movement.Vec3{X: pos.X + 0.6, Y: pos.Y + 0.3, Z: pos.Z}, &itemDrop{key: marker + ":" + strconv.Itoa(i), source: SourceContent}, now.Add(600e9))
			continue
		}
		ci.inv.Add(it, &d)
		got = append(got, it)
		s.announceIfBitchin(sess, it)
	}
	ci.markers[marker] = true
	s.commitItems(sess, &d, &GrantMark{Key: marker, Seed: int64(seed)}, src)
	if len(got) > 0 {
		s.sendGranted(sess, SourceContent, got)
	}
	return got
}

// ---- rescued villagers ----

// contentEscorted is quests.Escorter for questFacts.
func (s *Server) contentEscorted(sess *session, qid uint32) bool {
	f := s.cnt.follow[sess.ent.CharacterID]
	return f != nil && f.qid == qid && math.Hypot(f.ent.Move.Pos.X-sess.ent.Move.Pos.X, f.ent.Move.Pos.Z-sess.ent.Move.Pos.Z) <= followNearM
}

func (s *Server) spawnFollower(sess *session, q *quests.Quest) *follower {
	e := sess.ent
	if f := s.cnt.follow[e.CharacterID]; f != nil {
		if f.qid == q.ID {
			return f
		}
		s.dismissFollower(e)
	}
	name := content.RescueVillager(q)
	p := e.Move.Pos
	x, z := p.X+1.8, p.Z+1.2
	fe := &Entity{ID: s.nextID, Kind: proto.EntityKindNpc, Name: name, Level: 255, TypeID: uint16(content.RoleVillager) | uint16(q.ID%4)<<8, Health: 100, HealthMax: 100}
	s.nextID++
	fe.Move = movement.State{Pos: movement.Vec3{X: x, Y: movement.GroundAt(s.cfg.Ground, x, p.Y+1.5, z), Z: z}}
	fe.prevValid = fe.Move
	fe.view = fe.Move
	s.insertEntity(fe)
	f := &follower{ent: fe, qid: q.ID, name: name}
	s.cnt.follow[e.CharacterID] = f
	return f
}

func (s *Server) dismissFollower(e *Entity) {
	if e == nil {
		return
	}
	if f := s.cnt.follow[e.CharacterID]; f != nil {
		s.removeEntity(f.ent)
		delete(s.cnt.follow, e.CharacterID)
	}
}

// followersTick walks each rescued villager behind its rescuer (and makes
// sure a rescuer whose quest is on its escort step has one, e.g. after a
// reconnect or a zone handoff).
func (s *Server) followersTick() {
	for _, sess := range s.sessions {
		e := sess.ent
		if e == nil || sess.quests == nil {
			continue
		}
		var esc *quests.Quest
		for _, q := range sess.quests.log.Active {
			if c := q.Current(); c != nil && c.Obj.Kind == quests.ObjEscort {
				esc = q
				break
			}
		}
		f := s.cnt.follow[e.CharacterID]
		if esc == nil {
			if f != nil {
				s.dismissFollower(e)
			}
			continue
		}
		if f == nil || f.qid != esc.ID {
			f = s.spawnFollower(sess, esc)
		}
		fe := f.ent
		p := e.Move.Pos
		dx, dz := p.X-fe.Move.Pos.X, p.Z-fe.Move.Pos.Z
		d := math.Hypot(dx, dz)
		const dt = 1.0 / 30
		switch {
		case d > followLeaveM:
			x, z := p.X-dx/d*followBehindM, p.Z-dz/d*followBehindM
			fe.Move.Pos = movement.Vec3{X: x, Y: movement.GroundAt(s.cfg.Ground, x, p.Y+1.5, z), Z: z}
			fe.Move.Vel = movement.Vec3{}
		case d > followBehindM:
			sp := followSpeed
			if d > 10 {
				sp *= 1.5
			}
			step := math.Min(d-followBehindM, sp*dt)
			x, z := fe.Move.Pos.X+dx/d*step, fe.Move.Pos.Z+dz/d*step
			y := movement.GroundAt(s.cfg.Ground, x, fe.Move.Pos.Y+1.0, z)
			fe.Move.Vel = movement.Vec3{X: dx / d * sp, Z: dz / d * sp}
			fe.Move.Pos = movement.Vec3{X: x, Y: y, Z: z}
			fe.Yaw = math.Atan2(-dx, -dz)
		default:
			fe.Move.Vel = movement.Vec3{}
		}
		fe.prevValid = fe.Move
	}
}
