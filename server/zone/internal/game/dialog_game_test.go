package game

// Playtest 4 dialog (CR 049) on the official world with real townsfolk: a
// talk step's line and a quest offer play inside the conversation (the old
// pop-ups are not sent), a rumour points at a real place and "Mark it on my
// map" sets a personal pin, the person stands still while you talk and walks
// on after, and what they remember of you is kept.

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/quests"
)

func (cl *client) dialogNode(t *testing.T) dlgWire {
	t.Helper()
	var w dlgWire
	ev := cl.take(EventDialogNode, 3*time.Second)
	if err := json.Unmarshal(ev.Data, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// choice is the id of the first choice of kind (and text containing sub).
func (w dlgWire) choice(t *testing.T, kind, sub string) uint32 {
	t.Helper()
	for _, c := range w.Choices {
		if c.Kind == kind && strings.Contains(c.Text, sub) {
			return uint32(c.ID)
		}
	}
	t.Fatalf("no %q choice containing %q in %+v", kind, sub, w.Choices)
	return 0
}

func (cl *client) dialogDo(action uint8, target uint64, arg uint32) {
	cl.send(&proto.Interact{TargetKind: InteractDialog, TargetID: target, Action: action, Arg: arg})
}

func dialogStart(t *testing.T) (*harness, *client, *proto.Welcome, string, int, uint32) {
	h, store, w, g, gi := meadowsHarness(t)
	gd := w.T.NPCs[gi]
	const char = "33333333-4444-5555-6666-777777777778"
	sx, sz := gd.WorkX+1.5*math.Cos(gd.WorkYaw), gd.WorkZ+1.5*math.Sin(gd.WorkYaw)
	store.rows[char] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}
	a := h.dial("")
	wa := a.join(h, char, "Nicole")
	a.take(EventQuestStarted, 3*time.Second)
	return h, a, wa, char, gi, a.npcEntityID(h, gi)
}

func TestDialogStepLineAndTopicsInsideTheConversation(t *testing.T) {
	h, a, _, char, gi, gid := dialogStart(t)
	a.drainFor(300 * time.Millisecond)
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n := a.dialogNode(t)
	if n.NPC.Name == "" || n.NPC.ID != gid {
		t.Fatalf("node %+v", n.NPC)
	}
	if !strings.Contains(n.Line, "slimes") || n.Quest != nil {
		t.Fatalf("the talk step's line should be the first thing said: %q", n.Line)
	}
	if len(a.eventsOf(EventNPCSay)) != 0 || len(a.eventsOf(EventQuestOffer)) != 0 {
		t.Fatal("the old pop-up events were sent as well")
	}
	// The quest moved on: kill step.
	if mq := a.questLog(t).find(quests.MeadowsID); mq == nil || mq.Step != 1 {
		t.Fatalf("talk step not completed by the conversation: %+v", mq)
	}
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "more", ""))
	n = a.dialogNode(t)
	for _, k := range []string{"rumour", "topic", "leave"} {
		n.choice(t, k, "")
	}
	// "Who are you?" then "About this place": the town and its neighbours.
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "topic", "Who are you"))
	n = a.dialogNode(t)
	if !strings.Contains(n.Line, "I") || n.Aff < 1 {
		t.Fatalf("who: %+v", n)
	}
	// Memory: met, one talk; kept in the content state.
	h.do(func() {
		sess := h.srv.byChar[char]
		tw := h.srv.cfg.Towns
		m := sess.cnt.st.DlgMem(tw.T.NPCs[gi].ID)
		if !m.Met || m.Talks != 1 || !m.Has("t:who") {
			t.Errorf("memory %+v", m)
		}
	})
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "leave", ""))
	a.take(EventDialogEnd, 3*time.Second)
	// Second visit: met before.
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n = a.dialogNode(t)
	if !n.Met {
		t.Fatalf("second visit not met: %+v", n)
	}
	h.do(func() {
		sess := h.srv.byChar[char]
		m := sess.cnt.st.DlgMem(h.srv.cfg.Towns.T.NPCs[gi].ID)
		if m.Talks != 2 {
			t.Errorf("talks %d", m.Talks)
		}
	})
}

func TestDialogQuestOfferAcceptedThroughTheConversation(t *testing.T) {
	h, a, _, char, _, _ := dialogStart(t)
	w := h.srv.cfg.Towns
	si := spawnSettlement(t, w)
	smith := npcOf(w, si, towns.RoleBlacksmith)
	h.do(func() { h.srv.townsInit() })
	sid := a.npcEntityID(h, smith)
	h.standByNPC(char, smith)
	a.drainFor(300 * time.Millisecond)
	a.dialogDo(DialogOpen, uint64(sid), 0)
	n := a.dialogNode(t)
	if n.Quest == nil || n.Quest.ID != quests.WardID || n.Quest.Title == "" {
		t.Fatalf("the Ward was not offered in the conversation: %+v / %q", n.Quest, n.Line)
	}
	if len(a.eventsOf(EventQuestOffer)) != 0 {
		t.Fatal("the offer card was sent as well")
	}
	t.Logf("offer: %s", n.Line)
	a.dialogDo(DialogChoose, uint64(sid), n.choice(t, "quest", "I'll do it"))
	a.takeFor(EventQuestStarted, quests.WardID, 3*time.Second)
	n = a.dialogNode(t)
	if n.Line == "" || n.Quest != nil {
		t.Fatalf("after accepting: %+v", n)
	}
	if l := a.questLog(t); l.find(quests.WardID) == nil {
		t.Fatalf("the Ward is not in the log: %+v", l)
	}
}

func TestDialogRumourPointsAtARealPlaceAndMarksIt(t *testing.T) {
	h, a, _, char, _, gid := dialogStart(t)
	a.drainFor(300 * time.Millisecond)
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n := a.dialogNode(t)
	if n.Quest == nil {
		a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "more", ""))
		n = a.dialogNode(t)
	}
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "rumour", ""))
	n = a.dialogNode(t)
	if n.Rumour == nil || !n.Rumour.Pos || n.Rumour.Text != n.Line {
		t.Fatalf("no rumour: %+v", n)
	}
	t.Logf("rumour (%s): %s", n.Rumour.Kind, n.Line)
	// A real place: within the world, on the atlas somewhere near this town.
	h.do(func() {
		tw := h.srv.cfg.Towns
		ne := h.srv.NPCEntity(0)
		_ = ne
		st := tw.T.Settlements[spawnSettlement(t, tw)]
		if d := math.Hypot(n.Rumour.X-st.X, n.Rumour.Z-st.Z); d > dialogSiteRangeM+300 {
			t.Errorf("the rumour is %.0f m away", d)
		}
	})
	rum := *n.Rumour
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "mark", ""))
	mk := a.take(EventDialogMark, 3*time.Second)
	if cm(n.Rumour.X) != mk.X || cm(n.Rumour.Z) != mk.Z {
		t.Fatalf("mark %+v for rumour %+v", mk, n.Rumour)
	}
	a.take(EventPins, 3*time.Second)
	h.do(func() {
		pins := h.srv.byChar[char].x.prog.Pins
		if len(pins) != 1 || pins[0].XCm != mk.X || pins[0].ZCm != mk.Z {
			t.Errorf("pins %+v", pins)
		}
	})
	n = a.dialogNode(t)
	if !strings.Contains(n.Note, "Marked") {
		t.Fatalf("note %q", n.Note)
	}
	// Asking again does not repeat it.
	a.dialogDo(DialogChoose, uint64(gid), n.choice(t, "rumour", ""))
	n2 := a.dialogNode(t)
	if n2.Rumour != nil && n2.Rumour.Key == rum.Key {
		t.Fatal("the same rumour twice")
	}
}

func TestDialogHoldsThePersonStillAndReleasesThem(t *testing.T) {
	h, a, _, char, gi, gid := dialogStart(t)
	a.drainFor(300 * time.Millisecond)
	// Knock the giver off their post so that, free, they walk back to it.
	var x0, z0 float64
	h.do(func() {
		w := h.srv.cfg.Towns
		st := &w.NPCs[gi]
		st.X += 1.6
		st.At, st.Goal = false, -1
	})
	a.dialogDo(DialogOpen, uint64(gid), 0)
	a.dialogNode(t)
	h.do(func() { st := &h.srv.cfg.Towns.NPCs[gi]; x0, z0 = st.X, st.Z })
	a.drainFor(1200 * time.Millisecond)
	h.do(func() {
		st := &h.srv.cfg.Towns.NPCs[gi]
		if h.srv.dlg.held[gi] != 1 {
			t.Errorf("not held: %v", h.srv.dlg.held)
		}
		if math.Hypot(st.X-x0, st.Z-z0) > 0.01 || st.VX != 0 || st.VZ != 0 {
			t.Errorf("walked while talked to: moved %.2f m", math.Hypot(st.X-x0, st.Z-z0))
		}
	})
	a.dialogDo(DialogClose, uint64(gid), 0)
	a.take(EventDialogEnd, 3*time.Second)
	a.drainFor(1500 * time.Millisecond)
	h.do(func() {
		st := &h.srv.cfg.Towns.NPCs[gi]
		if len(h.srv.dlg.held) != 0 {
			t.Errorf("still held: %v", h.srv.dlg.held)
		}
		if math.Hypot(st.X-x0, st.Z-z0) < 0.3 {
			t.Errorf("did not walk again after the conversation (moved %.2f m)", math.Hypot(st.X-x0, st.Z-z0))
		}
	})

	// Walking away ends it.
	a.dialogDo(DialogOpen, uint64(gid), 0)
	a.dialogNode(t)
	h.teleport(char, h.srv.cfg.Towns.NPCs[gi].X+30, h.srv.cfg.Towns.NPCs[gi].Z)
	ev := a.take(EventDialogEnd, 3*time.Second)
	if ev.Value != DialogEndWalked {
		t.Fatalf("end reason %d", ev.Value)
	}
	h.do(func() {
		if len(h.srv.dlg.held) != 0 {
			t.Errorf("still held after walking away: %v", h.srv.dlg.held)
		}
	})
}

func TestDialogRefusals(t *testing.T) {
	_, a, _, _, _, gid := dialogStart(t)
	a.dialogDo(DialogChoose, uint64(gid), 1)
	if ev := a.take(EventDialogRefused, 3*time.Second); ev.Value != DialogRefuseNone {
		t.Fatalf("choose with nothing open: %d", ev.Value)
	}
	a.dialogDo(DialogOpen, 99999999, 0)
	if ev := a.take(EventDialogRefused, 3*time.Second); ev.Value != DialogRefuseUnknown {
		t.Fatalf("unknown: %d", ev.Value)
	}
	a.dialogDo(DialogOpen, uint64(gid), 0)
	a.dialogNode(t)
	a.dialogDo(DialogChoose, uint64(gid), 99)
	if ev := a.take(EventDialogRefused, 3*time.Second); ev.Value != DialogRefuseChoice {
		t.Fatalf("bad choice: %d", ev.Value)
	}
	// Interact 30 talk still works for old clients.
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(gid), Action: ActionTalk})
	a.take(EventNPCSay, 3*time.Second)
}
