package game

// Quests in the zone (playtest 1, CR 013): every character's quest log
// (internal/quests) is server-authoritative and persisted. Accepted
// bounties from WP20's board and bounty keeper become quests (they were
// kept in zone memory only before). Playtest 2: a new character's first
// quest is "Slimes in the meadows" (a townsperson of the Haven town, five
// slimes at the marked packs nearby, back for gold, draughts and a cap);
// finishing or dropping it starts the story "Ward against the
// night" (characters who started before playtest 2 got the Ward on their
// first login), which points at the blacksmith,
// a reachable sunlit sunsteel seam, the blueprint, the forge and a Light
// tome, and every step carries the map markers the client draws on the map,
// the compass and in the world. Events 950-959 and Interact 60 are in
// contracts/events.md.
//
// Cost: nothing per tick for players without a reach/clear objective; the
// rest are checked at 2 Hz (staggered), inventory and spell changes only
// set a recheck flag, and kill hooks only queue the groups to look at.
//
// Persistence: accounts in character_quests (migration 0023; one jsonb log
// per character, epoch-fenced like WP16's checkpoints), local profiles in
// their signed save blob (localsave.State.Quests), across a WP16 handoff as
// a HandoffField.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

// Event kinds 950-959 (CR 013).
const (
	EventQuestLog       = 950
	EventQuestOffer     = 951
	EventQuestStep      = 952
	EventQuestCompleted = 953
	EventQuestRefused   = 954
	EventQuestStarted   = 955
)

// Interact 60 `quest`.
const (
	InteractQuest = 60

	QuestActAccept  = 1 // accept the offer targetId (Event 951)
	QuestActAbandon = 2 // drop quest targetId
	QuestActTurnIn  = 3 // hand in quest targetId's items (at its settlement's board/keeper)
	QuestActTrack   = 4 // track quest targetId (0 = none)
)

// Refusal reasons (Event 954 value).
const (
	QuestRefuseUnknown = 1
	QuestRefuseNotHere = 2
	QuestRefuseMissing = 3
	QuestRefuseFull    = 4
	QuestRefuseHave    = 5
	QuestRefuseDone    = 6
)

// SourceQuest is Event 401's source for quest rewards.
const SourceQuest = 9

const (
	questEveryTicks = 15 // reach/clear checks at 2 Hz per player
	turnInReachM    = 10 // from the settlement's board or bounty keeper
)

// questState is one character's quests (tick-owned after join).
type questState struct {
	log     *quests.Log
	recheck bool // inventory or spells changed: re-evaluate held objectives
}

type pendingClear struct {
	g        *combat.Group
	eligible []uint32
	until    uint32
}

// questsGlue is the server-wide part.
type questsGlue struct {
	handed  map[string]*quests.Log
	places  map[int]*quests.WardPlaces
	meadows map[int]*quests.MeadowsPlaces
	clears  []pendingClear
	hap     []quests.Happening
	offered map[string]bool // characters offered the Ward this session by a blacksmith
}

// QuestStore persists quest logs (PGStore implements it).
type QuestStore interface {
	LoadQuests(ctx context.Context, characterID string) ([]byte, bool, error)
	SaveQuests(ctx context.Context, characterID string, log []byte, epoch int64) error
}

// LoadQuests implements QuestStore.
func (p *PGStore) LoadQuests(ctx context.Context, id string) ([]byte, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, false, nil
	}
	var b []byte
	err := p.Pool.QueryRow(ctx, `SELECT log FROM character_quests WHERE character_id = $1::uuid`, id).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return b, err == nil, err
}

// SaveQuests implements QuestStore. epoch > 0 fences the write: an older
// owner's late save never overwrites a newer zone's (WP16).
func (p *PGStore) SaveQuests(ctx context.Context, id string, log []byte, epoch int64) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO character_quests (character_id, log, epoch, updated_at) VALUES ($1::uuid, $2::jsonb, $3, now())
		ON CONFLICT (character_id) DO UPDATE SET log = EXCLUDED.log, epoch = GREATEST(character_quests.epoch, EXCLUDED.epoch), updated_at = now()
		WHERE EXCLUDED.epoch = 0 OR character_quests.epoch <= EXCLUDED.epoch`, id, string(log), epoch)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23503" { // no characters row
		return ErrNoRow
	}
	return err
}

// loadQuests runs on the connection goroutine before join (like loadCombat).
func (s *Server) loadQuests(characterID string, x *exploreState) *questState {
	if x != nil && x.local != nil {
		return &questState{log: quests.Load(x.local.state.Quests)}
	}
	qs, ok := s.cfg.Store.(QuestStore)
	if !ok || s.cfg.Store == nil {
		return &questState{log: quests.NewLog()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	b, found, err := qs.LoadQuests(ctx, characterID)
	if err != nil {
		s.log.Warn("quest log load failed; empty log this session", "character", characterID, "err", err)
	}
	if !found {
		return &questState{log: quests.NewLog()}
	}
	return &questState{log: quests.Load(b)}
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "quests",
		Save: func(s *Server, e *Entity) json.RawMessage {
			if sess := s.byChar[e.CharacterID]; sess != nil && sess.quests != nil {
				return sess.quests.log.JSON()
			}
			return nil
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			if s.qst.handed == nil {
				s.qst.handed = map[string]*quests.Log{}
			}
			s.qst.handed[e.CharacterID] = quests.Load(data)
		},
	})
}

func (s *Server) initQuests() {
	s.qst.places = map[int]*quests.WardPlaces{}
	s.qst.meadows = map[int]*quests.MeadowsPlaces{}
	s.qst.offered = map[string]bool{}
	prev := s.cbt.w.OnKill
	s.cbt.w.OnKill = func(k combat.KillInfo) {
		if prev != nil {
			prev(k)
		}
		s.questsOnKill(k)
	}
}

// questsJoin adopts a handed-over log, sends the log and starts the
// starter quest for a character who never had it (tick goroutine).
func (s *Server) questsJoin(sess *session) {
	e := sess.ent
	if h := s.qst.handed[e.CharacterID]; h != nil {
		delete(s.qst.handed, e.CharacterID)
		sess.quests = &questState{log: h}
	}
	if sess.quests == nil {
		sess.quests = &questState{log: quests.NewLog()}
	}
	l := sess.quests.log
	// A brand-new character starts with the slimes; the Ward follows it
	// (questsWardHandoff), or starts at once where there is no starter.
	if !l.HasStarted(quests.MeadowsKey) && !l.HasStarted(quests.WardKey) && !l.IsDone(quests.WardKey) {
		if q := s.meadowsFor(e.Move.Pos.X, e.Move.Pos.Z); q != nil && l.Add(q) == nil {
			s.log.Info("quest started", "character", e.CharacterID, "quest", q.Key, "settlement", q.Settlement)
			s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: e.ID, TargetID: q.ID, Data: startedJSON(q)})
		}
	}
	s.questsWardHandoff(sess)
	sess.quests.recheck = true
	s.sendQuestLog(sess)
	s.saveQuests(sess)
}

// questsWardHandoff starts "Ward against the night" once the starter quest
// is out of the log (finished, dropped, or never available) for a
// character who never had the Ward, and tracks it.
func (s *Server) questsWardHandoff(sess *session) {
	e, l := sess.ent, sess.quests.log
	if l.HasStarted(quests.WardKey) || l.IsDone(quests.WardKey) || l.ByKey(quests.MeadowsKey) != nil {
		return
	}
	q := s.wardFor(e.Move.Pos.X, e.Move.Pos.Z)
	if q == nil || l.Add(q) != nil {
		return
	}
	l.Track(q.ID)
	s.log.Info("quest started", "character", e.CharacterID, "quest", q.Key, "settlement", q.Settlement)
	s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: e.ID, TargetID: q.ID, Data: startedJSON(q)})
}

func startedJSON(q *quests.Quest) []byte {
	b, _ := json.Marshal(struct {
		Title string `json:"title"`
		Text  string `json:"text"`
		Giver string `json:"giver"`
	}{q.Title, q.Current().Text, q.Giver})
	return b
}

func (s *Server) questsLeave(sess *session) {
	if sess.quests != nil && sess.quests.log.Dirty() {
		s.saveQuests(sess)
	}
}

func (s *Server) sendQuestLog(sess *session) {
	if sess.quests == nil || sess.ent == nil {
		return
	}
	s.sendEvent(sess, &proto.Event{Kind: EventQuestLog, EntityID: sess.ent.ID, Value: int32(len(sess.quests.log.Active)), TargetID: sess.quests.log.Tracked, Data: sess.quests.log.Wire()})
}

// saveQuests persists a changed log: accounts through the write-behind
// queue (coalesced per character), local profiles in the next save blob.
func (s *Server) saveQuests(sess *session) {
	e := sess.ent
	if e == nil || sess.quests == nil || !sess.quests.log.Dirty() || s.cfg.Queue == nil {
		return
	}
	l := sess.quests.log
	if sess.x != nil && sess.x.local != nil {
		sess.x.prog.MarkDirty() // questsIntoLocal copies the log into the blob
		s.saveProgressSoon(sess, false)
		return
	}
	qs, ok := s.cfg.Store.(QuestStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	b, id, epoch, log := l.JSON(), e.CharacterID, e.epoch, s.log
	l.MarkSaved()
	s.cfg.Queue.Enqueue(writebehind.Op{Key: "quests:" + id, Run: func(ctx context.Context) error {
		err := qs.SaveQuests(ctx, id, b, epoch)
		if err != nil && errors.Is(err, writebehind.ErrSkip) {
			if _, seen := loggedMissing.LoadOrStore("quests:"+id, true); !seen {
				log.Info("quest save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

// questsIntoLocal copies the log into a local save's state (localState).
func questsIntoLocal(sess *session, raw *json.RawMessage) {
	if sess.quests == nil {
		return
	}
	*raw = sess.quests.log.JSON()
	sess.quests.log.MarkSaved()
}

// questsChanged marks a re-evaluation for the next tick (inventory, spells).
func (s *Server) questsChanged(sess *session) {
	if sess != nil && sess.quests != nil {
		sess.quests.recheck = true
	}
}

// questsTick: queued group clears, flagged rechecks and the 2 Hz position
// checks (tick goroutine).
func (s *Server) questsTick(tick uint32) {
	if len(s.qst.clears) > 0 {
		s.questsClears(tick)
	}
	for _, sess := range s.sessions {
		q := sess.quests
		e := sess.ent
		if q == nil || e == nil || len(q.log.Active) == 0 {
			continue
		}
		if !q.recheck && ((tick+e.ID)%questEveryTicks != 0 || !q.log.Wants()) {
			continue
		}
		q.recheck = false
		s.questsAdvance(sess, nil)
	}
}

// questFacts answers the rules' questions about one character.
type questFacts struct {
	s    *Server
	sess *session
}

func (f questFacts) Have(item string) int {
	ci := f.sess.items
	if ci == nil {
		return 0
	}
	n := 0
	for _, it := range ci.inv.Items {
		if it.Base == item {
			n += it.Qty
		}
	}
	return n
}

func (f questFacts) Knows(spell string) bool {
	e := f.sess.ent
	return e != nil && e.cbt != nil && e.cbt.Profile.Knows(spell)
}

// Escorted implements quests.Escorter (CR 023 rescue quests).
func (f questFacts) Escorted(qid uint32) bool { return f.s.contentEscorted(f.sess, qid) }

func (f questFacts) Pos() (float64, float64) { return f.sess.ent.Move.Pos.X, f.sess.ent.Move.Pos.Z }

func (f questFacts) Quiet(site int, x, z, r float64) bool {
	for _, en := range f.s.cbt.w.Enemies() {
		if en.Alive() && en.Demon == nil && math.Hypot(en.Pos.X-x, en.Pos.Z-z) <= r {
			return false
		}
		if en.Alive() && en.Demon == nil && site >= 0 && en.Group != nil && en.Group.Site == site {
			return false
		}
	}
	return true
}

// questsAdvance evaluates the log (sig nil: state objectives) and applies
// what happened: rewards, Events, the save.
func (s *Server) questsAdvance(sess *session, sig *quests.Signal) []quests.Happening {
	q := sess.quests
	if q == nil {
		return nil
	}
	s.qst.hap = q.log.Advance(questFacts{s, sess}, sig, s.qst.hap[:0])
	hs := s.qst.hap
	// Read before applying: a reward's item commit issues a local
	// profile's save blob, which copies the log in and marks it saved
	// (questsIntoLocal). Playtest 2: checking Dirty after the rewards meant
	// local profiles (everyone on the live deploy) never got the new log, so
	// the tracker, journal and markers stayed on the step they had finished.
	changed := q.log.Dirty() || len(hs) > 0
	handoff := false
	for _, h := range hs {
		s.questHappened(sess, h)
		handoff = handoff || h.Finished && h.Quest.Key == quests.MeadowsKey
	}
	if handoff {
		s.questsWardHandoff(sess)
	}
	if changed || q.log.Dirty() {
		s.sendQuestLog(sess)
		s.saveQuests(sess)
	}
	return hs
}

func (s *Server) questHappened(sess *session, h quests.Happening) {
	e := sess.ent
	qq := h.Quest
	st := &qq.Steps[h.Step]
	s.contentQuestHappened(sess, h) // CR 023: give steps, followers, rep, rewards, counters (content_quests.go)
	if st.Obj.Kind == quests.ObjTurnIn && sess.items != nil && len(st.Obj.Items) > 0 {
		var d items.Delta
		if sess.items.inv.Spend(st.Obj.Items[0].Item, st.Obj.Items[0].Qty, &d) {
			s.commitItems(sess, &d, nil, "quest turn-in "+qq.Key)
		}
	}
	if len(st.Grant) > 0 {
		s.questGrant(sess, st.Grant, "quest:"+qq.Key+":"+strconv.Itoa(h.Step), qq.Key)
	}
	if h.Finished {
		if qq.Gold > 0 {
			s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: qq.Gold}}, "quest:"+qq.Key+":done", qq.Key)
		}
		if qq.XP > 0 {
			s.grantCombatXP(combat.XPGrant{Player: e.ID, XP: qq.XP, Reason: "quest"})
		}
		b, _ := json.Marshal(struct {
			Title string `json:"title"`
			Gold  int    `json:"gold"`
			XP    int64  `json:"xp"`
			Kind  uint8  `json:"kind"`
		}{qq.Title, qq.Gold, qq.XP, qq.Kind})
		s.sendEvent(sess, &proto.Event{Kind: EventQuestCompleted, EntityID: e.ID, TargetID: qq.ID, Value: int32(qq.Gold), Data: b})
		s.log.Info("quest completed", "character", e.CharacterID, "quest", qq.Key, "gold", qq.Gold, "xp", qq.XP)
		return
	}
	next := ""
	if c := qq.Current(); c != nil {
		next = c.Text
	}
	b, _ := json.Marshal(struct {
		Title string `json:"title"`
		Done  string `json:"done"`
		Next  string `json:"next"`
	}{qq.Title, st.Text, next})
	s.sendEvent(sess, &proto.Event{Kind: EventQuestStep, EntityID: e.ID, TargetID: qq.ID, Value: int32(qq.Step), Data: b})
	s.log.Info("quest step", "character", e.CharacterID, "quest", qq.Key, "step", h.Step, "next", next)
}

// questGrant hands over items (gold, tomes) exactly once per marker.
func (s *Server) questGrant(sess *session, list []quests.ItemQty, marker, src string) {
	ci := sess.items
	if ci == nil || ci.markers[marker] {
		return
	}
	now := s.cfg.Now().UnixMilli()
	var d items.Delta
	var got []*items.Item
	for _, g := range list {
		if items.D.Item(g.Item) == nil || g.Qty <= 0 || !ci.inv.CanFit(g.Item, g.Qty) {
			s.log.Warn("quest grant skipped", "character", sess.ent.CharacterID, "item", g.Item, "qty", g.Qty)
			continue
		}
		it := items.Stack(g.Item, g.Qty)
		it.Prov = []items.Prov{{Ev: "quest", Char: sess.ent.CharacterID, Name: sess.ent.Name, Src: src, At: now, Local: ci.persist == persistLocal}}
		ci.inv.Add(it, &d)
		got = append(got, it)
	}
	ci.markers[marker] = true
	s.commitItems(sess, &d, &GrantMark{Key: marker}, "quest "+src)
	if len(got) > 0 {
		s.sendGranted(sess, SourceQuest, got)
	}
}

// questsTalk: a talk to an NPC (towns.go npcInteract) may complete a talk
// step; the NPC then says the step's line. A blacksmith also offers the
// starter quest to a character who dropped it.
func (s *Server) questsTalk(sess *session, role uint8, settlement int, npcEnt uint32, npcIndex int) int {
	q := sess.quests
	if q == nil {
		return 0
	}
	hs := s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjTalk, Role: int(role), Settlement: settlement, NPC: npcIndex + 1})
	done := len(hs)
	for _, h := range hs {
		if say := h.Quest.Steps[h.Step].Say; say != "" {
			s.townEvent(sess.ent, &proto.Event{Kind: EventNPCSay, EntityID: npcEnt, TargetID: uint32(role), Value: 1, Data: []byte(say)})
		}
	}
	if role == towns.RoleBlacksmith && q.log.ByKey(quests.WardKey) == nil && !q.log.IsDone(quests.WardKey) {
		if wq := s.wardAt(settlement, 0); wq != nil {
			s.qst.offered[sess.ent.CharacterID] = true
			s.sendEvent(sess, &proto.Event{Kind: EventQuestOffer, EntityID: npcEnt, TargetID: wq.ID, Data: quests.OfferWire(wq)})
		}
	}
	return done
}

// questsTurnIn: reading a settlement's board or talking to its bounty
// keeper hands in held deliveries for that settlement (towns.go).
func (s *Server) questsTurnIn(sess *session, settlement int) {
	if sess.quests != nil && sess.quests.log.Needs(quests.ObjTurnIn) {
		s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjTurnIn, Settlement: settlement})
	}
}

// questsOnKill counts kills for kill steps (applied now), applies demon
// kills (now) and queues groups that may have been cleared (checked on the
// next ticks, after combat resets the group).
func (s *Server) questsOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en == nil {
		return
	}
	if en.Def != nil && en.Demon == nil { // kill steps count non-demon enemies (the starter quest, CR 023 side quests and stories)
		for _, id := range k.Eligible {
			if pe := s.entityByID(id); pe != nil {
				if sess := s.byChar[pe.CharacterID]; sess != nil && sess.quests != nil && sess.quests.log.Needs(quests.ObjKill) {
					s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjKill, Family: en.Def.Family, X: en.Pos.X, Z: en.Pos.Z, Site: -1})
				}
			}
		}
	}
	if en.Demon != nil {
		for _, id := range k.Eligible {
			if pe := s.entityByID(id); pe != nil {
				if sess := s.byChar[pe.CharacterID]; sess != nil && sess.quests != nil && sess.quests.log.Needs(quests.ObjSlay) {
					s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjSlay, X: en.Pos.X, Z: en.Pos.Z, Site: -1})
				}
			}
		}
		return
	}
	if en.Group != nil {
		s.qst.clears = append(s.qst.clears, pendingClear{g: en.Group, eligible: append([]uint32(nil), k.Eligible...), until: s.tick + 60})
	}
}

func (s *Server) questsClears(tick uint32) {
	keep := s.qst.clears[:0]
	for _, c := range s.qst.clears {
		cleared := true
		for _, m := range c.g.Members {
			if m.Alive() {
				cleared = false
				break
			}
		}
		if !cleared {
			if tick < c.until {
				keep = append(keep, c)
			}
			continue
		}
		sig := &quests.Signal{Kind: quests.ObjClear, Site: c.g.Site, X: c.g.Anchor.X, Z: c.g.Anchor.Z}
		for _, id := range c.eligible {
			if pe := s.entityByID(id); pe != nil {
				if sess := s.byChar[pe.CharacterID]; sess != nil && sess.quests != nil && sess.quests.log.Needs(quests.ObjClear) {
					s.questsAdvance(sess, sig)
				}
			}
		}
	}
	s.qst.clears = keep
}

// questInteract applies Interact 60 (tick goroutine).
func (s *Server) questInteract(sess *session, m *proto.Interact) {
	e, q := sess.ent, sess.quests
	if e == nil || q == nil {
		return
	}
	id := uint32(m.TargetID)
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventQuestRefused, EntityID: e.ID, TargetID: id, Value: r})
	}
	switch m.Action {
	case QuestActAccept:
		if id != quests.WardID {
			if r := s.contentAccept(sess, id); r != 0 { // CR 023: townsfolk and story offers (content_quests.go)
				refuse(r)
				return
			}
			break
		}
		if !s.qst.offered[e.CharacterID] {
			refuse(QuestRefuseUnknown)
			return
		}
		wq := s.wardFor(e.Move.Pos.X, e.Move.Pos.Z)
		if wq == nil {
			refuse(QuestRefuseUnknown)
			return
		}
		if err := q.log.Add(wq); err != nil {
			refuse(questRefusal(err))
			return
		}
		s.sendEvent(sess, &proto.Event{Kind: EventQuestStarted, EntityID: e.ID, TargetID: wq.ID, Data: startedJSON(wq)})
		q.recheck = true
	case QuestActAbandon:
		qq := q.log.Remove(id)
		if qq == nil {
			refuse(QuestRefuseUnknown)
			return
		}
		s.log.Info("quest abandoned", "character", e.CharacterID, "quest", qq.Key)
		if qq.Key == quests.MeadowsKey {
			s.questsWardHandoff(sess) // dropping the slimes moves the story on
		}
	case QuestActTurnIn:
		qq := q.log.Find(id)
		c := (*quests.Step)(nil)
		if qq != nil {
			c = qq.Current()
		}
		if c == nil || c.Obj.Kind != quests.ObjTurnIn {
			refuse(QuestRefuseUnknown)
			return
		}
		if !s.nearTurnIn(e, c.Obj.Settlement) {
			refuse(QuestRefuseNotHere)
			return
		}
		if len(s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjTurnIn, Settlement: c.Obj.Settlement})) == 0 {
			refuse(QuestRefuseMissing)
		}
		return
	case QuestActTrack:
		if !q.log.Track(id) {
			refuse(QuestRefuseUnknown)
			return
		}
	default:
		return
	}
	s.sendQuestLog(sess)
	s.saveQuests(sess)
}

func questRefusal(err error) int32 {
	switch {
	case errors.Is(err, quests.ErrHave):
		return QuestRefuseHave
	case errors.Is(err, quests.ErrDone):
		return QuestRefuseDone
	case errors.Is(err, quests.ErrTooMany):
		return QuestRefuseFull
	}
	return QuestRefuseUnknown
}

// nearTurnIn: within reach of the settlement's bounty board or its bounty
// keeper (if active).
func (s *Server) nearTurnIn(e *Entity, settlement int) bool {
	w := s.cfg.Towns
	if w == nil || settlement < 0 || settlement >= len(w.T.Settlements) {
		return false
	}
	st := &w.T.Settlements[settlement]
	for i := st.PropFirst; i < st.PropFirst+st.Props; i++ {
		p := &w.T.Props[i]
		if p.Kind == towns.PropBoard && math.Hypot(p.X-e.Move.Pos.X, p.Z-e.Move.Pos.Z) <= turnInReachM {
			return true
		}
	}
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if ne := s.town.active[i]; ne != nil && w.NPCs[i].Def.Role == towns.RoleBounty && math.Hypot(ne.Move.Pos.X-e.Move.Pos.X, ne.Move.Pos.Z-e.Move.Pos.Z) <= turnInReachM {
			return true
		}
	}
	return false
}

// ---- bounties (towns.go keeps the board; held jobs live in the log) ----

// bountyQuest builds the quest for an accepted board job.
func (s *Server) bountyQuest(b bountyJob, nowMs int64) *quests.Quest {
	w := s.cfg.Towns
	st := &w.T.Settlements[b.Settlement]
	info := quests.BountyInfo{ID: b.ID, Kind: b.Kind, Settlement: b.Settlement, Town: s.settlementName(b.Settlement), Text: b.Text,
		Reward: b.Reward, Item: b.Item, Qty: int(b.Qty), Site: b.Site}
	if a := s.atlasSite(b.Site); a != nil {
		info.SiteName = a.Name
		r := math.Max(explore.DiscoverRadius(a), 30)
		info.Target = quests.Place{OK: true, X: a.X, Z: a.Z, R: r, Name: a.Name}
	}
	for i := st.PropFirst; i < st.PropFirst+st.Props; i++ {
		if p := &w.T.Props[i]; p.Kind == towns.PropBoard {
			info.Board = quests.Place{OK: true, X: p.X, Z: p.Z}
			break
		}
	}
	if !info.Board.OK {
		info.Board = quests.Place{OK: true, X: st.X, Z: st.Z}
	}
	return quests.FromBounty(info, nowMs)
}

// bountyJob is the part of a board job the quest needs (npc.Bounty).
type bountyJob struct {
	ID         uint32
	Kind       uint8
	Site       int
	Qty        uint16
	Reward     uint32
	Text       string
	Item       string
	Settlement int
}

func (s *Server) atlasSite(i int) *structures.Site {
	if s.cfg.Explore == nil || i < 0 || i >= len(s.cfg.Explore.Atlas.Sites) {
		return nil
	}
	return &s.cfg.Explore.Atlas.Sites[i]
}

func (s *Server) settlementName(si int) string {
	w := s.cfg.Towns
	if w == nil || si < 0 || si >= len(w.T.Settlements) {
		return "the town"
	}
	if a := s.atlasSite(w.T.Settlements[si].Site); a != nil && a.Name != "" {
		return a.Name
	}
	return "the town"
}

// ---- the first quest: slimes in the meadows ----

// meadowsFor builds "Slimes in the meadows" for the settlement nearest
// (x, z); nil without towns, a townsperson to give it or slimes nearby.
func (s *Server) meadowsFor(x, z float64) *quests.Quest {
	w := s.cfg.Towns
	if w == nil || len(w.T.Settlements) == 0 {
		return nil
	}
	best, bd := -1, math.Inf(1)
	for i := range w.T.Settlements {
		st := &w.T.Settlements[i]
		if d := math.Hypot(st.X-x, st.Z-z); d < bd {
			best, bd = i, d
		}
	}
	p := s.qst.meadows[best]
	if p == nil {
		p = s.resolveMeadows(best)
		if s.qst.meadows == nil {
			s.qst.meadows = map[int]*quests.MeadowsPlaces{}
		}
		s.qst.meadows[best] = p
	}
	return quests.Meadows(*p, s.cfg.Now().UnixMilli())
}

// meadowsGiverRoles: who asks, in order of preference (the slimes eat the
// crops; the blacksmith and the bounty keeper have their own business).
var meadowsGiverRoles = []uint8{towns.RoleFarmer, towns.RoleGuard, towns.RoleInnkeeper, towns.RoleVillager, towns.RoleMerchant}

// meadowsPackRangeM: slime packs this far from the town centre are marked.
const meadowsPackRangeM = 480

// resolveMeadows picks the giver and the nearest slime packs: wild packs in
// the Haven (CR 012: every member there is a beginner creature, i.e. a
// slime), nearest the town first, at most three.
func (s *Server) resolveMeadows(si int) *quests.MeadowsPlaces {
	w := s.cfg.Towns
	st := &w.T.Settlements[si]
	town := s.settlementName(si)
	p := &quests.MeadowsPlaces{Settlement: si, Town: town}
	for _, role := range meadowsGiverRoles {
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			if d := &w.T.NPCs[i]; d.Role == role && d.Name != "" {
				p.Giver, p.GiverRole, p.GiverTitle = d.Name, int(role), towns.RoleNames[role]
				p.GiverAt = quests.Place{OK: true, X: d.WorkX, Z: d.WorkZ}
				break
			}
		}
		if p.Giver != "" {
			break
		}
	}
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if d := &w.T.NPCs[i]; d.Role == towns.RoleBlacksmith {
			p.Smith = d.Name
			break
		}
	}
	cw := s.cbt.w
	hr := combat.D.Difficulty.HavenRadiusM
	if cw == nil || cw.Atlas == nil || hr <= 0 {
		return p
	}
	type cand struct {
		x, z, d float64
	}
	var cs []cand
	for _, g := range cw.Groups {
		if g.Kind != combat.GroupPack || math.Hypot(g.Anchor.X-cw.Atlas.SpawnX, g.Anchor.Z-cw.Atlas.SpawnZ) > hr {
			continue
		}
		if d := math.Hypot(g.Anchor.X-st.X, g.Anchor.Z-st.Z); d <= meadowsPackRangeM {
			cs = append(cs, cand{g.Anchor.X, g.Anchor.Z, d})
		}
	}
	sort.Slice(cs, func(a, b int) bool { return cs[a].d < cs[b].d })
	for _, c := range cs[:min(3, len(cs))] {
		p.Packs = append(p.Packs, quests.Place{OK: true, X: c.x, Z: c.z, R: 18, Name: "Slimes", Where: quests.Where(st.X, st.Z, c.x, c.z, town)})
	}
	s.log.Info("meadows places", "settlement", si, "town", town, "giver", p.Giver, "packs", len(p.Packs))
	return p
}

// ---- the starter quest's places ----

// wardFor builds the Ward for the settlement nearest (x, z); nil without towns.
func (s *Server) wardFor(x, z float64) *quests.Quest {
	w := s.cfg.Towns
	if w == nil || len(w.T.Settlements) == 0 {
		return nil
	}
	best, bd := -1, math.Inf(1)
	for i := range w.T.Settlements {
		st := &w.T.Settlements[i]
		if d := math.Hypot(st.X-x, st.Z-z); d < bd {
			best, bd = i, d
		}
	}
	return s.wardAt(best, s.cfg.Now().UnixMilli())
}

func (s *Server) wardAt(si int, nowMs int64) *quests.Quest {
	w := s.cfg.Towns
	if w == nil || si < 0 || si >= len(w.T.Settlements) {
		return nil
	}
	p := s.qst.places[si]
	if p == nil {
		p = s.resolveWard(si)
		if s.qst.places == nil {
			s.qst.places = map[int]*quests.WardPlaces{}
		}
		s.qst.places[si] = p
	}
	return quests.Ward(*p, nowMs)
}

// resolveWard finds the blacksmith, the forge, the nearest cave whose
// sunlit chambers hold sunsteel, and the nearest shrine (or another
// structure) to hold the Light tome. Once per settlement per process.
func (s *Server) resolveWard(si int) *quests.WardPlaces {
	w := s.cfg.Towns
	st := &w.T.Settlements[si]
	town := s.settlementName(si)
	p := &quests.WardPlaces{Settlement: si, Town: town}
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if d := &w.T.NPCs[i]; d.Role == towns.RoleBlacksmith {
			p.Smith = d.Name
			p.SmithAt = quests.Place{OK: true, X: d.WorkX, Z: d.WorkZ}
			break
		}
	}
	for i := st.PropFirst; i < st.PropFirst+st.Props; i++ {
		if pr := &w.T.Props[i]; pr.Kind == towns.PropForge {
			p.Forge = quests.Place{OK: true, X: pr.X, Z: pr.Z}
			break
		}
	}
	if cw := s.caves(); cw != nil {
		s.resolveOre(cw.CaveGraph(), st, town, p)
	}
	// Light: the nearest shrine within 2.5 km, else a wizard tower, else
	// the nearest structure within 1.5 km.
	if s.cfg.Explore != nil {
		pick := func(kind int, maxD float64) *structures.Site {
			var best *structures.Site
			bd := maxD
			for i := range s.cfg.Explore.Atlas.Sites {
				a := &s.cfg.Explore.Atlas.Sites[i]
				if a.Category != structures.CategoryStructure || (kind >= 0 && int(a.Kind) != kind) || int(a.Kind) == 8 /* demon lair */ {
					continue
				}
				if d := math.Hypot(a.X-st.X, a.Z-st.Z); d < bd {
					best, bd = a, d
				}
			}
			return best
		}
		a := pick(3, 2500) // shrine
		if a == nil {
			a = pick(5, 2500) // wizard tower
		}
		if a == nil {
			a = pick(-1, 1500)
		}
		if a != nil {
			name := a.Name
			if name == "" && int(a.Kind) < len(towns.StructureNames) {
				name = "the " + towns.StructureNames[a.Kind]
			}
			p.Shrine = quests.Place{OK: true, X: a.X, Z: a.Z, R: math.Max(a.Radius, 15) + 5, Name: name, Where: quests.Where(st.X, st.Z, a.X, a.Z, town)}
		}
	}
	s.log.Info("ward places", "settlement", si, "town", town, "smith", p.Smith, "ore", p.Ore.OK, "oreName", p.Ore.Name, "oreWhere", p.Ore.Where, "shrine", p.Shrine.Name)
	return p
}

func (s *Server) resolveOre(g *caves.Graph, st *towns.Settlement, town string, p *quests.WardPlaces) {
	if g == nil {
		return
	}
	type cand struct {
		sys  int
		d    float64
		n    int
		x, z float64
		r    float64
		y    float64 // the deepest vein's height
	}
	var best *cand
	for si := range g.Systems {
		sys := &g.Systems[si]
		var xs, zs []float64
		vy := math.Inf(1)
		for vi := sys.FirstVein; vi < sys.FirstVein+sys.VeinCount && vi < len(g.Veins); vi++ {
			v := &g.Veins[vi]
			if v.Kind == caves.KindGem || v.MaterialName() != "sunsteel" {
				continue
			}
			ci := sys.FirstChamber + int(v.Chamber)
			if ci < len(g.Chambers) && g.Chambers[ci].Flags&caves.ChamberSunlit == 0 && g.Chambers[ci].Flags&caves.ChamberEntrance == 0 {
				continue
			}
			xs, zs = append(xs, v.X), append(zs, v.Z)
			vy = math.Min(vy, v.Y)
		}
		if len(xs) == 0 {
			continue
		}
		var cx, cz float64
		for i := range xs {
			cx, cz = cx+xs[i], cz+zs[i]
		}
		cx, cz = cx/float64(len(xs)), cz/float64(len(xs))
		r := 0.0
		for i := range xs {
			r = math.Max(r, math.Hypot(xs[i]-cx, zs[i]-cz))
		}
		// The nearest seam: one sunsteel vein yields a blade's worth
		// (mining.go sunsteelMinOre), and the official world's seams are all
		// single veins at the bottom of a sunlit shaft.
		score := math.Hypot(cx-st.X, cz-st.Z)
		if best == nil || score < best.d {
			best = &cand{sys: si, d: score, n: len(xs), x: cx, z: cz, r: math.Min(60, r+10), y: vy}
		}
	}
	if best == nil {
		return
	}
	sys := &g.Systems[best.sys]
	name := ""
	mx, mz := best.x, best.z
	if a := s.atlasSite(sys.SiteIndex); a != nil {
		name, mx, mz = a.Name, a.X, a.Z
	}
	if name == "" {
		name = "the cave"
	}
	for oi := sys.FirstOpening; oi < sys.FirstOpening+sys.Openings && oi < len(g.OpeningsList); oi++ {
		if o := &g.OpeningsList[oi]; !o.Sinkhole {
			mx, mz = o.X, o.Z
			break
		}
	}
	p.Ore = quests.Place{OK: true, X: best.x, Z: best.z, R: best.r, Name: name, Where: quests.Where(st.X, st.Z, mx, mz, town)}
	p.Mouth = quests.Place{OK: true, X: mx, Z: mz, Name: "Cave mouth: " + name}
	// Playtest 2: the seam is ~140 m below ground at the bottom of the shaft
	// whose daylight makes the ore; mark the shaft too (glide down it) and
	// say how deep it is, or players search the surface under the marker.
	for oi := sys.FirstOpening; oi < sys.FirstOpening+sys.Openings && oi < len(g.OpeningsList); oi++ {
		o := &g.OpeningsList[oi]
		if !o.Sinkhole || math.Hypot(o.X-best.x, o.Z-best.z) > best.r+30 {
			continue
		}
		if !p.Shaft.OK || math.Hypot(o.X-best.x, o.Z-best.z) < math.Hypot(p.Shaft.X-best.x, p.Shaft.Z-best.z) {
			p.Shaft = quests.Place{OK: true, X: o.X, Z: o.Z, Name: "Sunlit shaft: " + name}
		}
	}
	top := sys.MouthY
	if p.Shaft.OK {
		top = math.Max(top, s.surfaceAt(p.Shaft.X, p.Shaft.Z, top))
	}
	if !math.IsInf(best.y, 0) && top > best.y {
		p.OreDepth = top - best.y
	}
}

// surfaceAt is the overworld height at (x, z), or def without terrain.
func (s *Server) surfaceAt(x, z, def float64) float64 {
	if s.cfg.Ground == nil {
		return def
	}
	return s.cfg.Ground.HeightAt(x, z)
}

// learnedSpellIntoSlot: a spell learned from a tome goes into the first
// empty slot of the active loadout (there is no spellbook screen yet), so
// the Ward's Light step ends with Glint ready to cast.
func learnedSpellIntoSlot(p *combat.Player, key string) {
	if p == nil || combatdefs.D.SpellByKey(key) == nil {
		return
	}
	pr := p.Profile
	lo := pr.Loadouts[pr.Active]
	for i, k := range lo.Spells {
		if k == key {
			return
		}
		if k == "" {
			pr.EquipSpell(pr.Active, i, key)
			return
		}
	}
}

// questsBountyAccepted is towns.go's accept path: the job joins the log.
func (s *Server) questsBountyAccepted(e *Entity, b bountyJob, now time.Time) int32 {
	sess := s.byChar[e.CharacterID]
	if sess == nil || sess.quests == nil {
		return TownRefuseUnknown
	}
	if sess.quests.log.IsDone(quests.BountyKey(b.Settlement, b.ID)) {
		return TownRefuseHave
	}
	if err := sess.quests.log.Add(s.bountyQuest(b, now.UnixMilli())); err != nil {
		if errors.Is(err, quests.ErrTooMany) {
			return TownRefuseTooMany
		}
		return TownRefuseHave
	}
	sess.quests.recheck = true
	s.sendQuestLog(sess)
	s.saveQuests(sess)
	return 0
}

// questsBountyState is Event 802's accepted byte: 1 held, 2 done today.
func (s *Server) questsBountyState(e *Entity, settlement int, id uint32) byte {
	sess := s.byChar[e.CharacterID]
	if sess == nil || sess.quests == nil {
		return 0
	}
	key := quests.BountyKey(settlement, id)
	switch {
	case sess.quests.log.ByKey(key) != nil:
		return 1
	case sess.quests.log.IsDone(key):
		return 2
	}
	return 0
}
