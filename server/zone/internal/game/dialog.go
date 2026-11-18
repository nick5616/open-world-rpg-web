package game

// Conversations with townsfolk (playtest 4, CR 049). Interact 180 `dialog`
// opens, answers and closes a conversation with a townsperson; the zone
// answers with Events 1910-1913 (contracts/events.md). The words come from
// the pure internal/dialog package; this file feeds it the world (weather,
// time, your level and gear, your deeds, the real places nearby, what you
// remember of this person), runs the services and quest offers a talk used
// to pop up as separate cards inside the conversation, sets map pins for
// rumours, and holds the NPC still and facing you while you talk.
//
// Cost: everything here is event driven (an Interact) except one cheap check
// per second over the sessions that have a conversation open (walked away,
// idle) and a hold test per active NPC only while someone is talking
// (towns.go townsTick: a map length check when nobody is).

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/weather"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/dialog"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/story"
)

// Interact 180 `dialog`; targetId = the NPC's entity id (open), arg = the
// choice id (choose).
const (
	InteractDialog = 180

	DialogOpen   = 1
	DialogChoose = 2
	DialogClose  = 3
)

// Event kinds 1910-1929 (CR 049).
const (
	EventDialogNode    = 1910
	EventDialogEnd     = 1911
	EventDialogRefused = 1912
	EventDialogMark    = 1913
)

// Dialog refusals (Event 1912 value).
const (
	DialogRefuseUnknown = 1
	DialogRefuseTooFar  = 2
	DialogRefuseNone    = 3 // no conversation is open
	DialogRefuseChoice  = 4
	DialogRefuseBusy    = 5 // the person is not here any more
)

// Dialog end reasons (Event 1911 value).
const (
	DialogEndYou     = 0
	DialogEndWalked  = 1
	DialogEndIdle    = 2
	DialogEndGone    = 3
	DialogEndGoodbye = 4
)

const (
	dialogMarginM    = 3.0              // you may drift this far past the reach before it ends
	dialogIdle       = 90 * time.Second // the NPC waits this long for you
	dialogEveryTicks = 15               // the walked-away / idle check, twice a second
	dialogSiteRangeM = 3200.0           // rumours reach this far from the person
	dialogPinColor   = 4                // the personal pin colour a rumour uses
)

type dialogState struct {
	open   map[*session]bool // conversations running
	held   map[int]int       // towns NPC index -> conversations holding it still
	talker map[int]*Entity   // ... and who it faces
	home   int               // the settlement nearest the world spawn (-2 unknown)
}

// dlgSess is one open conversation.
type dlgSess struct {
	npc     int
	ent     uint32
	last    time.Time
	seq     uint32
	choices []dialog.Choice
	queue   []dlgQueued // quest lines and offers to play before the topics
	cap     *dlgCapture
	person  dialog.Person
	pinned  map[string]bool
}

type dlgQueued struct {
	line  string
	quest *dlgQuest
}

// dlgCapture collects the talk's old pop-ups (Event 800 lines, 951 offers)
// so they can play inside the conversation.
type dlgCapture struct {
	says   []string
	offers []quests.WireQuest
}

// capture swallows Events 800 and 951 while a conversation opens.
func (d *dlgSess) capture(ev *proto.Event) bool {
	switch ev.Kind {
	case EventNPCSay:
		if len(ev.Data) > 0 {
			d.cap.says = append(d.cap.says, string(ev.Data))
		}
		return true
	case EventQuestOffer:
		var q quests.WireQuest
		if json.Unmarshal(ev.Data, &q) == nil {
			d.cap.offers = append(d.cap.offers, q)
		}
		return true
	}
	return false
}

type dlgQuest struct {
	ID      uint32 `json:"id"`
	Title   string `json:"title"`
	Gold    int    `json:"gold,omitempty"`
	XP      int64  `json:"xp,omitempty"`
	Rep     int    `json:"rep,omitempty"`
	RepTown string `json:"repTown,omitempty"`
	Items   int    `json:"items,omitempty"`
}

type dlgWho struct {
	ID    uint32 `json:"id"`
	Name  string `json:"name"`
	Role  uint8  `json:"role"`
	Title string `json:"title"`
	Town  string `json:"town,omitempty"`
}

// dlgWire is Event 1910's JSON.
type dlgWire struct {
	NPC   dlgWho    `json:"npc"`
	Seq   uint32    `json:"seq"`
	Note  string    `json:"note,omitempty"`
	Quest *dlgQuest `json:"quest,omitempty"`
	Aff   int       `json:"aff"`
	Met   bool      `json:"met"`
	dialog.Node
}

func (s *Server) dialogInit() {
	if s.dlg.open == nil {
		s.dlg.open = map[*session]bool{}
		s.dlg.held = map[int]int{}
		s.dlg.talker = map[int]*Entity{}
		s.dlg.home = -2
	}
}

func (s *Server) dialogRefuse(sess *session, id uint64, why int32) {
	s.sendEvent(sess, &proto.Event{Kind: EventDialogRefused, EntityID: sess.ent.ID, TargetID: uint32(id), Value: why})
}

// dialogInteract applies Interact 180 (tick goroutine).
func (s *Server) dialogInteract(sess *session, m *proto.Interact, now time.Time) {
	if sess.ent == nil || s.cfg.Towns == nil {
		return
	}
	s.townsInit()
	s.dialogInit()
	switch m.Action {
	case DialogOpen:
		s.dialogOpen(sess, uint32(m.TargetID), now)
	case DialogChoose:
		s.dialogChoose(sess, int(m.Arg), now)
	case DialogClose:
		s.dialogClose(sess, DialogEndYou)
	}
}

func (s *Server) dialogOpen(sess *session, entID uint32, now time.Time) {
	e, w := sess.ent, s.cfg.Towns
	i, ok := s.town.byEnt[entID]
	if !ok {
		s.dialogRefuse(sess, uint64(entID), DialogRefuseUnknown)
		return
	}
	ne := s.town.active[i]
	if eyeDist(e, ne.Move.Pos.X, ne.Move.Pos.Y+1.0, ne.Move.Pos.Z) > npcReachM {
		s.dialogRefuse(sess, uint64(entID), DialogRefuseTooFar)
		return
	}
	if sess.dlg != nil {
		s.dialogClose(sess, DialogEndYou)
	}
	d := &dlgSess{npc: i, ent: ne.ID, last: now, pinned: map[string]bool{}}
	sess.dlg = d
	s.dlg.open[sess] = true
	s.dlg.held[i]++
	s.dlg.talker[i] = e

	nd := &w.T.NPCs[i]
	tod := s.timeOfDay(now)
	open := w.Open(i, tod)
	// The old talk, inside the conversation: step lines, the starter
	// quest's offer, townsfolk and story offers (any quest offer a talk
	// makes arrives here, whichever system makes it).
	done := 0
	d.cap = &dlgCapture{}
	done = s.questsTalk(sess, nd.Role, nd.Settlement, ne.ID, i)
	s.contentTalk(sess, i, ne.ID, done)
	cap := d.cap
	d.cap = nil
	for _, say := range cap.says {
		d.queue = append(d.queue, dlgQueued{line: say})
	}
	for _, o := range cap.offers {
		line := o.Say
		if line == "" && len(o.Steps) > 0 {
			line = o.Title + ": " + o.Steps[0].Text
		}
		d.queue = append(d.queue, dlgQueued{line: line, quest: &dlgQuest{ID: o.ID, Title: o.Title, Gold: o.Gold, XP: o.XP, Rep: o.Rep, RepTown: o.RepTown, Items: len(o.Items) + o.RollItems}})
	}

	d.person = s.dialogPerson(i)
	mem := s.dialogMem(sess, d.person.ID)
	ctx := s.dialogContext(sess, i, d.person, open, now)
	node := dialog.Open(d.person, mem, ctx)
	if !open && nd.Role != towns.RoleVillager && nd.Role != towns.RoleGuard && nd.Role != towns.RoleFarmer {
		node.Line = dialog.ClosedLine(d.person, dialog.PersonaOf(d.person))
	}
	mem.Talked(s.gameDay(now))
	s.dialogSetMem(sess, d.person.ID, mem)
	if len(d.queue) > 0 {
		s.dialogSendQueued(sess, d, mem)
		return
	}
	s.dialogSend(sess, d, node, mem, "", nil)
}

// dialogSendQueued plays the first waiting quest line.
func (s *Server) dialogSendQueued(sess *session, d *dlgSess, mem dialog.Memory) {
	q := d.queue[0]
	d.queue = d.queue[1:]
	ps := dialog.PersonaOf(d.person)
	n := dialog.Node{Line: q.line, Mood: ps.Temper.Mood()}
	if q.quest != nil {
		n.Choices = []dialog.Choice{
			{Text: "I'll do it.", Kind: "quest", Act: "accept:" + strconv.FormatUint(uint64(q.quest.ID), 10)},
			{Text: "Not now.", Kind: "quest", Act: "decline"},
		}
	} else {
		n.Choices = []dialog.Choice{{Text: "Go on.", Kind: "more", Act: "next"}}
	}
	s.dialogSend(sess, d, n, mem, "", q.quest)
}

// dialogSend numbers the choices and sends Event 1910.
func (s *Server) dialogSend(sess *session, d *dlgSess, n dialog.Node, mem dialog.Memory, note string, q *dlgQuest) {
	for k := range n.Choices {
		n.Choices[k].ID = k + 1
	}
	d.choices = n.Choices
	d.seq++
	tw := s.cfg.Towns
	nd := &tw.T.NPCs[d.npc]
	wire := dlgWire{NPC: dlgWho{ID: d.ent, Name: nd.Name, Role: nd.Role, Title: dialog.RoleWord(nd.Role), Town: d.person.Town}, Seq: d.seq, Note: note, Quest: q, Aff: mem.Affinity, Met: mem.Talks > 1, Node: n}
	b, _ := json.Marshal(wire)
	s.sendEvent(sess, &proto.Event{Kind: EventDialogNode, EntityID: d.ent, TargetID: d.seq, Data: b})
}

func (s *Server) dialogChoose(sess *session, id int, now time.Time) {
	d := sess.dlg
	if d == nil {
		s.dialogRefuse(sess, 0, DialogRefuseNone)
		return
	}
	var ch *dialog.Choice
	for k := range d.choices {
		if d.choices[k].ID == id {
			ch = &d.choices[k]
		}
	}
	ne := s.town.active[d.npc]
	if ne == nil {
		s.dialogClose(sess, DialogEndGone)
		return
	}
	if ch == nil {
		s.dialogRefuse(sess, uint64(d.ent), DialogRefuseChoice)
		return
	}
	d.last = now
	e, w := sess.ent, s.cfg.Towns
	nd := &w.T.NPCs[d.npc]
	mem := s.dialogMem(sess, d.person.ID)
	tod := s.timeOfDay(now)
	open := w.Open(d.npc, tod)
	ctx := s.dialogContext(sess, d.npc, d.person, open, now)
	ps := dialog.PersonaOf(d.person)
	act, arg, _ := strings.Cut(ch.Act, ":")
	menu := func(line, note string) {
		s.dialogSend(sess, d, dialog.Node{Line: line, Mood: ps.Temper.Mood(), Choices: dialog.Menu(d.person, ps, mem, ctx)}, mem, note, nil)
	}
	switch act {
	case "topic":
		n := dialog.Reply(d.person, &mem, ctx, arg)
		s.dialogSetMem(sess, d.person.ID, mem)
		s.dialogSend(sess, d, n, mem, "", nil)
	case "menu":
		menu(dialogMenuLine(d.person, mem), "")
	case "next":
		if len(d.queue) > 0 {
			s.dialogSendQueued(sess, d, mem)
		} else {
			menu(dialogMenuLine(d.person, mem), "")
		}
	case "mark":
		note := ""
		for _, st := range ctx.Sites {
			if st.Key == arg && !st.NoPos {
				note = s.dialogMark(sess, st)
			}
		}
		menu(dialogMenuLine(d.person, mem), note)
	case "work":
		s.dialogWork(sess, d, arg, ne, now)
		// The shop, board or forge opens in its panel; the person waits.
		menu(dialogWorkLine(arg, ps.Temper), "")
	case "accept":
		qid, _ := strconv.ParseUint(arg, 10, 32)
		s.questInteract(sess, &proto.Interact{TargetKind: InteractQuest, TargetID: qid, Action: QuestActAccept})
		line := "Good. I'll be here."
		if sess.quests == nil || sess.quests.log.Find(uint32(qid)) == nil {
			line = "Hm. Looks like your hands are full. Come back when you've room."
		} else {
			mem.Add(1)
			s.dialogSetMem(sess, d.person.ID, mem)
			line = dialogAcceptLine(ps.Temper)
		}
		if len(d.queue) > 0 {
			s.dialogSendQueued(sess, d, mem)
			return
		}
		menu(line, "")
	case "decline":
		if len(d.queue) > 0 {
			s.dialogSendQueued(sess, d, mem)
			return
		}
		menu("Another time, then. The offer stands.", "")
	case "bye":
		line := dialog.Farewell(d.person, ps, mem, e.Name)
		s.dialogClose(sess, DialogEndGoodbye)
		s.npcBark(d.npc, line, e, 0)
	}
	_ = nd
}

func dialogMenuLine(p dialog.Person, m dialog.Memory) string {
	return []string{"Anything else?", "What else is on your mind?", "Go on, ask."}[(p.ID+uint64(m.Talks))%3]
}

func dialogWorkLine(kind string, t dialog.Temper) string {
	switch kind {
	case "shop":
		return "Take a look. Take your time."
	case "bounty":
		return "There. Pick something that won't kill you."
	case "rest":
		return "Sit, breathe, mend."
	}
	return "Mind the sparks."
}

func dialogAcceptLine(t dialog.Temper) string {
	switch t {
	case dialog.Gruff:
		return "Good. Don't make me regret it."
	case dialog.Nervous:
		return "Oh, thank goodness. You will be careful, won't you?"
	case dialog.Cheerful:
		return "Wonderful! I knew you were the type!"
	case dialog.Weary:
		return "Bless you. I'd go myself, but my feet disagree."
	case dialog.Gossipy:
		return "Splendid! I'll tell everyone you took it."
	case dialog.Wry:
		return "Excellent. Try to survive it. I'd hate to explain."
	case dialog.Proud:
		return "A wise choice. The town will remember it."
	}
	return "Thank you. I mean it. Come back and tell me how it went."
}

// dialogWork opens one of the person's services in its usual panel.
func (s *Server) dialogWork(sess *session, d *dlgSess, kind string, ne *Entity, now time.Time) {
	e, w := sess.ent, s.cfg.Towns
	nd := &w.T.NPCs[d.npc]
	if !w.Open(d.npc, s.timeOfDay(now)) {
		s.refuseTown(e, uint64(ne.ID), TownRefuseClosed)
		return
	}
	switch kind {
	case "shop":
		if ws := s.waresFor(e, d.npc); ws != nil {
			s.townEvent(e, &proto.Event{Kind: EventShop, EntityID: ne.ID, Value: int32(nd.Merchant), Data: npc.EncodeShop(ws)})
		}
	case "bounty":
		if nd.Role == towns.RoleBounty {
			s.sendBounties(e, nd.Settlement, ne.ID, now)
		}
	case "rest":
		s.npcInteract(e, &proto.Interact{TargetKind: InteractNPC, TargetID: uint64(ne.ID), Action: ActionRest}, now)
	case "forge":
		if p := s.forgeNear(e, nd.Settlement); p != nil {
			s.stationInteract(e, &proto.Interact{TargetKind: InteractStation, TargetID: p.ID, Action: 1})
			return
		}
		s.townEvent(e, &proto.Event{Kind: EventNPCSay, EntityID: ne.ID, TargetID: uint32(nd.Role), Value: 1, Data: []byte("The forge is just there. Walk right up to it.")})
	}
}

// forgeNear is a forge or anvil of the settlement within reach of e.
func (s *Server) forgeNear(e *Entity, si int) *towns.Prop {
	tw := s.cfg.Towns.T
	st := &tw.Settlements[si]
	for k := st.PropFirst; k < st.PropFirst+st.Props; k++ {
		p := &tw.Props[k]
		if (p.Kind == towns.PropForge || p.Kind == towns.PropAnvil) && eyeDist(e, p.X, p.Y+1.0, p.Z) <= townReachM {
			return p
		}
	}
	return nil
}

// dialogMark puts a rumour's place on the player's map and compass as a
// personal pin (the pins Event 605 and the ordinary pin UI); returns the
// note the dialog shows.
func (s *Server) dialogMark(sess *session, st dialog.Site) string {
	x := sess.x
	if x == nil || s.cfg.Explore == nil {
		return ""
	}
	xc, zc := cm(st.X), cm(st.Z)
	for _, p := range x.prog.Pins {
		if p.XCm == xc && p.ZCm == zc {
			return "Already on your map."
		}
	}
	used := map[uint8]bool{}
	for _, p := range x.prog.Pins {
		used[p.Slot] = true
	}
	slot := uint8(explore.MaxPersonalPins - 1) // all taken: replace the last
	for k := 0; k < explore.MaxPersonalPins; k++ {
		if !used[uint8(k)] {
			slot = uint8(k)
			break
		}
	}
	name := st.Name
	if name == "" {
		name = "the place"
	}
	label := dialogPinLabel(st, name)
	if !x.prog.SetLabeledPin(slot, dialogPinColor, xc, zc, label) {
		return ""
	}
	s.sendPins(sess)
	s.saveProgressSoon(sess, false)
	s.sendEvent(sess, &proto.Event{Kind: EventDialogMark, EntityID: sess.ent.ID, TargetID: uint32(slot), X: xc, Z: zc, Data: []byte(label)})
	return "Marked on your map: " + label + "."
}

// dialogPinLabel is the name a marked place carries on the map and the
// compass (CR 055): "Stables, Kudrogair", "Tower, The Spire", "Fishing spot".
func dialogPinLabel(st dialog.Site, name string) string {
	switch st.Kind {
	case dialog.KindStable:
		return "Stables, " + name
	case dialog.KindFish:
		return "Fishing spot"
	case dialog.KindTower:
		return "Tower, " + name
	}
	return name
}

// dialogClose ends the conversation and lets the person walk on.
func (s *Server) dialogClose(sess *session, why int32) {
	d := sess.dlg
	if d == nil {
		return
	}
	sess.dlg = nil
	s.dialogInit()
	delete(s.dlg.open, sess)
	if s.dlg.held[d.npc]--; s.dlg.held[d.npc] <= 0 {
		delete(s.dlg.held, d.npc)
		delete(s.dlg.talker, d.npc)
	} else if s.dlg.talker[d.npc] == sess.ent {
		for o := range s.dlg.open {
			if o.dlg != nil && o.dlg.npc == d.npc {
				s.dlg.talker[d.npc] = o.ent
			}
		}
	}
	if !sess.left && sess.ent != nil {
		s.sendEvent(sess, &proto.Event{Kind: EventDialogEnd, EntityID: d.ent, Value: why})
	}
	if sess.cnt != nil {
		s.saveContent(sess)
	}
}

func (s *Server) dialogLeave(sess *session) {
	if sess.dlg != nil {
		s.dialogClose(sess, DialogEndGone)
	}
}

// dialogTick ends conversations whose player walked away, whose person is
// gone or who has been quiet too long, and keeps the held people turned to
// the player (2 Hz, only while someone is talking).
func (s *Server) dialogTick(tick uint32, now time.Time) {
	if len(s.dlg.open) == 0 || tick%dialogEveryTicks != 0 {
		return
	}
	var end []*session
	var why []int32
	for sess := range s.dlg.open {
		d, e := sess.dlg, sess.ent
		ne := s.town.active[d.npc]
		switch {
		case e == nil || ne == nil:
			end, why = append(end, sess), append(why, DialogEndGone)
		case math.Hypot(e.Move.Pos.X-ne.Move.Pos.X, e.Move.Pos.Z-ne.Move.Pos.Z) > npcReachM+dialogMarginM:
			end, why = append(end, sess), append(why, DialogEndWalked)
		case now.Sub(d.last) > dialogIdle:
			end, why = append(end, sess), append(why, DialogEndIdle)
		}
	}
	for k, sess := range end {
		s.dialogClose(sess, why[k])
	}
}

// ---- who, what they remember, what the world looks like ----

func (s *Server) dialogMem(sess *session, id uint64) dialog.Memory {
	if sess.cnt == nil {
		return dialog.Memory{}
	}
	return sess.cnt.st.DlgMem(id)
}

func (s *Server) dialogSetMem(sess *session, id uint64, m dialog.Memory) {
	if sess.cnt != nil {
		sess.cnt.st.SetDlgMem(id, m)
	}
}

// dialogQuestDone: a townsperson's request was finished: they like you more.
func (s *Server) dialogQuestDone(sess *session, q *quests.Quest) {
	tw := s.cfg.Towns
	if sess.cnt == nil || tw == nil || q.GiverNPC <= 0 || q.GiverNPC > len(tw.T.NPCs) {
		return
	}
	id := tw.T.NPCs[q.GiverNPC-1].ID
	m := sess.cnt.st.DlgMem(id)
	m.Add(3)
	sess.cnt.st.SetDlgMem(id, m)
}

// dialogHome is the settlement nearest the world spawn (the Haven).
func (s *Server) dialogHome() int {
	if s.dlg.home != -2 {
		return s.dlg.home
	}
	s.dlg.home = -1
	tw := s.cfg.Towns
	if tw == nil || s.cbt.w == nil || s.cbt.w.Atlas == nil {
		return -1
	}
	ca, hd := s.cbt.w.Atlas, math.Inf(1)
	for i := range tw.T.Settlements {
		if s.skyTown(i) {
			continue
		}
		if d := math.Hypot(tw.T.Settlements[i].X-ca.SpawnX, tw.T.Settlements[i].Z-ca.SpawnZ); d < hd {
			s.dlg.home, hd = i, d
		}
	}
	return s.dlg.home
}

// dialogKey: which hand-written character NPC i is, from the quests and the
// story that already name them.
func (s *Server) dialogKey(i int) string {
	tw := s.cfg.Towns
	d := &tw.T.NPCs[i]
	if sp := s.storyPlaces(); sp != nil {
		switch {
		case sp.Keeper.OK && sp.Keeper.Index == i:
			return dialog.KeyKeeper
		case sp.Captain.OK && sp.Captain.Index == i:
			return dialog.KeyCaptain
		case sp.Smith.OK && sp.Smith.Index == i:
			return dialog.KeyMasterSmith
		}
	}
	home := s.dialogHome()
	if home < 0 || d.Settlement != home {
		return ""
	}
	if mp := s.qst.meadows[home]; mp != nil || s.cbt.w != nil {
		if mp == nil {
			mp = s.resolveMeadows(home)
			if s.qst.meadows == nil {
				s.qst.meadows = map[int]*quests.MeadowsPlaces{}
			}
			s.qst.meadows[home] = mp
		}
		if mp.Giver != "" && d.Name == mp.Giver && int(d.Role) == mp.GiverRole {
			return dialog.KeyMeadows
		}
	}
	switch d.Role {
	case towns.RoleBlacksmith:
		return dialog.KeySmith
	case towns.RoleBounty:
		return dialog.KeyBounty
	}
	return ""
}

func (s *Server) dialogPerson(i int) dialog.Person {
	tw := s.cfg.Towns
	d := &tw.T.NPCs[i]
	p := dialog.Person{ID: d.ID, Name: d.Name, Role: d.Role, Key: s.dialogKey(i)}
	if d.Settlement >= 0 && d.Settlement < len(tw.T.Settlements) {
		st := &tw.T.Settlements[d.Settlement]
		p.Town = s.settlementName(d.Settlement)
		if s.cbt.w != nil && s.cbt.w.Atlas != nil {
			p.Region = s.regionName(s.cbt.w.Atlas.RegionAt(st.X, st.Z))
		}
		if si := st.Site; si >= 0 && si < len(tw.Sites) && tw.Sites[si].Layer == 2 {
			p.Dwarven = true
		}
		type nb struct {
			dx, dz, d float64
			name      string
		}
		var ns []nb
		for k := range tw.T.Settlements {
			o := &tw.T.Settlements[k]
			if k == d.Settlement || s.skyTown(k) {
				continue
			}
			dx, dz := o.X-st.X, o.Z-st.Z
			ns = append(ns, nb{dx, dz, math.Hypot(dx, dz), s.settlementName(k)})
		}
		sort.Slice(ns, func(a, b int) bool { return ns[a].d < ns[b].d })
		for k := 0; k < len(ns) && k < 3; k++ {
			if ns[k].name != "" {
				p.Neighbours = append(p.Neighbours, dialog.Near{Name: ns[k].name, DX: ns[k].dx, DZ: ns[k].dz})
			}
		}
	}
	return p
}

func (s *Server) dialogContext(sess *session, i int, p dialog.Person, open bool, now time.Time) dialog.Context {
	e, w := sess.ent, s.cfg.Towns
	ne := s.town.active[i]
	nd := &w.T.NPCs[i]
	t := s.worldTimeS()
	ctx := dialog.Context{Player: e.Name, Level: 1, Hour: weather.Hour(t), Day: s.gameDay(now), Night: s.isNightNow(), Open: open, Weather: "clear"}
	if sess.x != nil {
		ctx.Level = max(1, sess.x.prog.Level)
	}
	px, pz := ne.Move.Pos.X, ne.Move.Pos.Z
	if s.weatherOn() {
		if st := s.weatherStateAt(px, pz); st >= 0 && st < weather.NumStates {
			ctx.Weather = weather.StateKeys[st]
		}
	} else if s.rainingAt(px, pz, t) {
		ctx.Weather = "rain"
	}
	if ci := sess.items; ci != nil {
		if wp := ci.inv.InSlot("eq:main0"); wp != nil {
			ctx.Gear = 1
			r := wp.Rarity
			for _, sl := range []string{"eq:head", "eq:body", "eq:legs"} {
				if a := ci.inv.InSlot(sl); a != nil {
					r = max(r, a.Rarity)
				}
			}
			switch {
			case r >= 4:
				ctx.Gear = 3
			case r >= 2:
				ctx.Gear = 2
			}
		}
	} else {
		ctx.Gear = 1
	}
	if n := s.night.defs[nd.Settlement]; n != nil && s.night.on {
		ctx.Defense = true
	}
	if open {
		if s.waresFor(e, i) != nil {
			ctx.Work.Shop = true
		}
		ctx.Work.Bounty = nd.Role == towns.RoleBounty
		ctx.Work.Rest = nd.Role == towns.RoleInnkeeper
		ctx.Work.Forge = nd.Role == towns.RoleBlacksmith
	}
	if sess.quests != nil {
		for _, q := range sess.quests.log.Active {
			ctx.Act = max(ctx.Act, story.ActOf(q.Key))
		}
	}
	if sess.cnt != nil {
		st := sess.cnt.st
		if st.Stat("finale") > 0 {
			ctx.Act = 7
			ctx.Deeds = append(ctx.Deeds, dialog.Deed{Kind: "beaten"})
		}
		if st.Kills["deep_warden"] > 0 {
			ctx.Deeds = append(ctx.Deeds, dialog.Deed{Kind: "warden"})
		}
	}
	for _, we := range s.cnt.ev.active {
		if !we.done && math.Hypot(we.pos.X-px, we.pos.Z-pz) < 1500 {
			ctx.Event = "word is about " + strings.ToLower(we.kind.Name)
			break
		}
	}
	ctx.Sites = s.dialogSites(sess, i, &ctx)
	return ctx
}

// dialogSites lists the real places around person i for rumours (and the
// deeds of yours near them). Everything comes from the atlas and the zone's
// own state.
func (s *Server) dialogSites(sess *session, i int, ctx *dialog.Context) []dialog.Site {
	ex := s.cfg.Explore
	ne := s.town.active[i]
	if ex == nil || ne == nil || sess.x == nil {
		return nil
	}
	px, pz := ne.Move.Pos.X, ne.Move.Pos.Z
	prog := sess.x.prog
	var out []dialog.Site
	var cs *content.State
	if sess.cnt != nil {
		cs = sess.cnt.st
	}
	add := func(kind string, a *structures.Site, done bool) {
		d := math.Hypot(a.X-px, a.Z-pz)
		if d > dialogSiteRangeM || d < 12 {
			return
		}
		out = append(out, dialog.Site{Kind: kind, Key: "site:" + strconv.Itoa(a.Index), Name: a.Name, X: a.X, Z: a.Z, DX: a.X - px, DZ: a.Z - pz, Done: done})
	}
	own := -1
	if nd := &s.cfg.Towns.T.NPCs[i]; nd.Settlement >= 0 {
		own = s.cfg.Towns.T.Settlements[nd.Settlement].Site
	}
	for k := range ex.Atlas.Sites {
		a := &ex.Atlas.Sites[k]
		if math.Abs(a.X-px) > dialogSiteRangeM || math.Abs(a.Z-pz) > dialogSiteRangeM || k == own {
			continue
		}
		seen := prog.Discoveries.Has(k)
		switch a.Category {
		case structures.CategorySettlement:
			if a.Layer == 2 {
				add(dialog.KindDwarf, a, seen)
			}
		case structures.CategoryStructure:
			switch int(a.Kind) {
			case combat.StructMineshaft:
				add(dialog.KindShaft, a, seen)
			case combat.StructBanditCamp:
				add(dialog.KindBandit, a, s.dialogCampDown(a))
			}
		case structures.CategoryPOI:
			switch a.Kind {
			case structures.POITower:
				add(dialog.KindTower, a, prog.Attuned.Has(k))
			case structures.POICaveMouth:
				if a.Layer == 0 {
					add(dialog.KindCave, a, seen)
				}
			case structures.POIEnemyCamp:
				add(dialog.KindBandit, a, s.dialogCampDown(a))
			case structures.POISkyLift, structures.POIArchipelago:
				add(dialog.KindSky, a, seen)
			case structures.POIDepths, structures.POIDepthsGate:
				add(dialog.KindShrine, a, seen)
			case structures.POIDwarfDoor:
				add(dialog.KindDwarf, a, seen)
			case structures.POILandmark:
				add(dialog.KindLandmark, a, seen)
			}
		}
	}
	// Sky palaces, sealed vaults.
	for _, ps := range s.palaceSites() {
		if ps.Index >= 0 && ps.Index < len(ex.Atlas.Sites) {
			a := &ex.Atlas.Sites[ps.Index]
			add(dialog.KindPalace, a, prog.Discoveries.Has(ps.Index))
		}
	}
	if cw := s.contentWorld(); cw != nil {
		for _, v := range cw.Dungeons {
			if math.Abs(v.X-px) > dialogSiteRangeM || math.Abs(v.Z-pz) > dialogSiteRangeM {
				continue
			}
			a := &structures.Site{Index: v.Index, Name: v.Name, X: v.X, Z: v.Z}
			add(dialog.KindVault, a, cs != nil && cs.VaultKnown(v.Index))
		}
	}
	// A herb patch or two around the person.
	if s.cnt.built || s.contentWorld() != nil {
		ax, az := int(math.Floor(px/content.AreaM)), int(math.Floor(pz/content.AreaM))
		nowMs := s.cfg.Now().UnixMilli()
		var patches []dialog.Site
		for dx := -1; dx <= 1; dx++ {
			for dz := -1; dz <= 1; dz++ {
				if ax+dx < 0 || az+dz < 0 {
					continue
				}
				for _, p := range content.PatchesIn(s.cfg.Seed, ax+dx, az+dz, s.biomeAt, s.patchOK) {
					name := ""
					if h := content.HerbByID(p.Herb); h != nil {
						name = h.Name
					}
					done := cs != nil && cs.Picked(p.ID, nowMs)
					patches = append(patches, dialog.Site{Kind: dialog.KindHerb, Key: "herb:" + strconv.FormatUint(uint64(p.ID), 10), Name: name, X: p.X, Z: p.Z, DX: p.X - px, DZ: p.Z - pz, Done: done})
				}
			}
		}
		sort.Slice(patches, func(a, b int) bool { return patches[a].Dist() < patches[b].Dist() })
		if len(patches) > 3 {
			patches = patches[:3]
		}
		out = append(out, patches...)
	}
	if fs, ok := s.dialogFishSpot(px, pz); ok {
		fs.Done = cs != nil && len(cs.Fish) > 0
		out = append(out, fs)
	}
	// A steed merchant: the nearest other town that sells the spirit whistle.
	if st, ok := s.dialogStable(sess, i, px, pz); ok {
		out = append(out, st)
	}
	for _, we := range s.cnt.ev.active {
		if !we.done && math.Hypot(we.pos.X-px, we.pos.Z-pz) < 1500 {
			out = append(out, dialog.Site{Kind: dialog.KindEvent, Key: "event:" + strconv.FormatUint(uint64(we.id), 10), Name: we.kind.Name, X: we.pos.X, Z: we.pos.Z, DX: we.pos.X - px, DZ: we.pos.Z - pz, Detail: we.kind.Announce})
		}
	}
	// Your deeds that the person has heard of: a tower you attuned, a camp
	// that has gone quiet, a vault you opened.
	nt, nc, nv := 0, 0, 0
	for _, st := range out {
		switch {
		case st.Kind == dialog.KindTower && st.Done && nt == 0:
			ctx.Deeds, nt = append(ctx.Deeds, dialog.Deed{Kind: "tower", Name: st.Name}), 1
		case st.Kind == dialog.KindBandit && st.Done && nc == 0:
			ctx.Deeds, nc = append(ctx.Deeds, dialog.Deed{Kind: "camp", Name: st.Name}), 1
		case st.Kind == dialog.KindVault && st.Done && nv == 0:
			ctx.Deeds, nv = append(ctx.Deeds, dialog.Deed{Kind: "vault", Name: st.Name}), 1
		}
	}
	return out
}

// dialogCampDown: a camp whose fighters are all down right now (someone
// cleared it).
func (s *Server) dialogCampDown(a *structures.Site) bool {
	if s.cbt.w == nil {
		return false
	}
	r := a.Radius + 40
	found := false
	for _, g := range s.cbt.w.Groups {
		if math.Abs(g.Anchor.X-a.X) > r || math.Abs(g.Anchor.Z-a.Z) > r {
			continue
		}
		if math.Hypot(g.Anchor.X-a.X, g.Anchor.Z-a.Z) <= r {
			found = true
			if !g.Cleared() {
				return false
			}
		}
	}
	return found
}

// dialogFishSpot finds water near (x, z): the nearest lake, river or sea
// within 700 m on a ring walk.
func (s *Server) dialogFishSpot(x, z float64) (dialog.Site, bool) {
	if s.cbt.w == nil || s.cbt.w.Atlas == nil {
		return dialog.Site{}, false
	}
	a := s.cbt.w.Atlas
	for r := 80.0; r <= 700; r += 60 {
		for k := 0; k < 16; k++ {
			ang := float64(k) * math.Pi / 8
			wx, wz := x+math.Cos(ang)*r, z+math.Sin(ang)*r
			f := a.NodeFlagsNear(wx, wz)
			if f&(combat.NodeRiver|combat.NodeLake|combat.NodeSea) != 0 && s.surfaceAt(wx, wz, 0) > a.SeaLevel-0.5 {
				return dialog.Site{Kind: dialog.KindFish, Key: "fish:" + strconv.Itoa(int(wx/40)) + ":" + strconv.Itoa(int(wz/40)), X: wx, Z: wz, DX: wx - x, DZ: wz - z}, true
			}
		}
	}
	return dialog.Site{}, false
}

func (s *Server) dialogStable(sess *session, i int, px, pz float64) (dialog.Site, bool) {
	tw := s.cfg.Towns
	own := tw.T.NPCs[i].Settlement
	best, bd := -1, dialogSiteRangeM
	for k := range tw.T.Settlements {
		if k == own || s.skyTown(k) || tw.T.Settlements[k].Site >= 0 && tw.Sites[tw.T.Settlements[k].Site].Layer == 2 {
			continue
		}
		st := &tw.T.Settlements[k]
		general := false
		for n := st.NPCFirst; n < st.NPCFirst+st.NPCs; n++ {
			if d := &tw.T.NPCs[n]; d.Role == towns.RoleMerchant && d.Merchant == 0 {
				general = true
			}
		}
		if d := math.Hypot(st.X-px, st.Z-pz); general && d < bd {
			best, bd = k, d
		}
	}
	if best < 0 {
		return dialog.Site{}, false
	}
	st := &tw.T.Settlements[best]
	have := sess.items != nil && sess.items.inv.Count("tool:spirit_whistle") > 0
	return dialog.Site{Kind: dialog.KindStable, Key: "stable:" + strconv.Itoa(best), Name: s.settlementName(best), X: st.X, Z: st.Z, DX: st.X - px, DZ: st.Z - pz, Done: have}, true
}
