package game

// Playtest 5 conversations revamp (CR 053): the way out on every node, the
// goodbye that answers and closes the box, walking away with a parting
// call, check answers that pass or fail, a haggled price, and your line as a
// speech bubble for the players near you.

import (
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/dialog"
)

func TestDialogGoodbyeAnswersAndClosesTheBoxItself(t *testing.T) {
	_, a, _, _, _, gid := dialogStart(t)
	a.drainFor(300 * time.Millisecond)
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n := a.dialogNode(t)
	// Whatever is on screen, the exit is the last answer, tagged [Leave].
	ex := n.Choices[len(n.Choices)-1]
	if ex.Kind != "leave" || ex.Tag != "Leave" {
		t.Fatalf("exit %+v", ex)
	}
	start := time.Now()
	a.dialogDo(DialogChoose, uint64(gid), uint32(ex.ID))
	if say := a.take(EventDialogSay, 2*time.Second); string(say.Data) != ex.Text {
		t.Fatalf("what you said is not a bubble: %q vs %q", say.Data, ex.Text)
	}
	bye := a.dialogNode(t)
	if !bye.Bye || len(bye.Choices) != 0 {
		t.Fatalf("farewell %+v", bye)
	}
	end := a.take(EventDialogEnd, 8*time.Second)
	if end.Value != DialogEndGoodbye {
		t.Fatalf("reason %d", end.Value)
	}
	if time.Since(start) < 1500*time.Millisecond {
		t.Fatalf("the box closed before the farewell could be read (%v)", time.Since(start))
	}
	// Pressing on during the farewell closes it at once.
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n = a.dialogNode(t)
	a.dialogDo(DialogChoose, uint64(gid), uint32(n.Choices[len(n.Choices)-1].ID))
	a.dialogNode(t)
	a.dialogDo(DialogClose, uint64(gid), 0)
	if end := a.take(EventDialogEnd, 2*time.Second); end.Value != DialogEndYou {
		t.Fatalf("reason %d", end.Value)
	}
}

func TestDialogCheckAnswerIsTaggedAndItsResultMatchesTheTag(t *testing.T) {
	h, a, _, char, gi, gid := dialogStart(t)
	a.drainFor(300 * time.Millisecond)
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n := a.dialogNode(t)
	for len(n.Choices) == 2 && n.Choices[0].Kind == "more" { // the talk step's line first
		a.dialogDo(DialogChoose, uint64(gid), uint32(n.Choices[0].ID))
		n = a.dialogNode(t)
	}
	var chk *dialog.Choice
	for k := range n.Choices {
		if n.Choices[k].Kind == "check" {
			chk = &n.Choices[k]
		}
	}
	if chk == nil || chk.Tag == "" {
		t.Fatalf("no check answer offered: %+v", n.Choices)
	}
	t.Logf("check: [%s] %s (low %v)", chk.Tag, chk.Text, chk.Low)
	a.dialogDo(DialogChoose, uint64(gid), uint32(chk.ID))
	res := a.dialogNode(t)
	if res.Check == nil || res.Check.Tag != chk.Tag || res.Check.Pass == chk.Low {
		t.Fatalf("result %+v for a check shown low=%v", res.Check, chk.Low)
	}
	t.Logf("result (pass %v): %s", res.Check.Pass, res.Line)

	// The context the server builds says who you are: a level-1 mage-or-not, no sunsteel.
	h.do(func() {
		sess := h.srv.byChar[char]
		tw := h.srv.cfg.Towns
		ctx := h.srv.dialogContext(sess, gi, h.srv.dialogPerson(gi), true, h.srv.cfg.Now())
		if ctx.Level < 1 || ctx.Char.Sunsteel {
			t.Errorf("char %+v level %d", ctx.Char, ctx.Level)
		}
		if want := dialog.ClassOfWeapon(sess.ent.cbt.Profile.Loadouts[sess.ent.cbt.Profile.Active].Weapon); ctx.Char.Class != want {
			t.Errorf("class %q want %q", ctx.Char.Class, want)
		}
		_ = tw
	})
}

func TestDialogHaggleOnAQuestPaysABonusOnAccepting(t *testing.T) {
	h, a, _, char, _, _ := dialogStart(t)
	h.do(func() { h.srv.qst.noErrands = true })
	w := h.srv.cfg.Towns
	si := spawnSettlement(t, w)
	smith := npcOf(w, si, towns.RoleBlacksmith)
	h.do(func() { h.srv.townsInit() })
	sid := a.npcEntityID(h, smith)
	h.standByNPC(char, smith)
	a.drainFor(300 * time.Millisecond)
	var gold0 int
	h.do(func() {
		sess := h.srv.byChar[char]
		sess.x.prog.Level = 12 // the haggle wants level 6
		gold0 = sess.items.inv.Gold()
	})
	a.dialogDo(DialogOpen, uint64(sid), 0)
	n := a.dialogNode(t)
	var hag *dialog.Choice
	for k := range n.Choices {
		if n.Choices[k].Kind == "check" {
			hag = &n.Choices[k]
		}
	}
	if n.Quest == nil || n.Quest.Gold == 0 || hag == nil {
		t.Fatalf("expected a paying offer with a haggle answer: %+v %+v", n.Quest, n.Choices)
	}
	if hag.Low || hag.Tag != "Level 6" {
		t.Fatalf("haggle %+v", hag)
	}
	a.dialogDo(DialogChoose, uint64(sid), uint32(hag.ID))
	res := a.dialogNode(t)
	if res.Check == nil || !res.Check.Pass || res.Quest == nil {
		t.Fatalf("haggle result %+v", res)
	}
	for _, c := range res.Choices {
		if c.Kind == "check" {
			t.Fatal("the haggle is offered twice")
		}
	}
	a.dialogDo(DialogChoose, uint64(sid), uint32(res.choice(t, "quest", "I'll do it")))
	a.takeFor(EventQuestStarted, n.Quest.ID, 3*time.Second)
	a.dialogNode(t)
	h.do(func() {
		got := h.srv.byChar[char].items.inv.Gold() - gold0
		if want := max(5, n.Quest.Gold*dialog.HaggleBonusPct/100); got != want {
			t.Errorf("bonus %d gold, want %d", got, want)
		}
	})
}

func TestDialogWarmthDiscountLowersTheShopPrices(t *testing.T) {
	h, a, _, char, _, _ := dialogStart(t)
	w := h.srv.cfg.Towns
	si := spawnSettlement(t, w)
	smith := npcOf(w, si, towns.RoleBlacksmith)
	h.do(func() { h.srv.townsInit() })
	a.npcEntityID(h, smith)
	h.standByNPC(char, smith)
	a.drainFor(200 * time.Millisecond)
	h.do(func() {
		sess := h.srv.byChar[char]
		full := h.srv.waresFor(sess.ent, smith)
		if len(full) == 0 {
			t.Fatal("the smith has no wares")
		}
		sess.dlgDisc = dlgDiscount{npc: smith + 1, pct: 15, until: h.srv.cfg.Now().Add(time.Minute)}
		cut := h.srv.waresFor(sess.ent, smith)
		if len(cut) != len(full) {
			t.Fatal("stock changed")
		}
		for k := range full {
			if want := uint32(dialog.Discount(int(full[k].Price), 15)); cut[k].Price != want {
				t.Errorf("%s: %d, want %d", full[k].Item, cut[k].Price, want)
			}
		}
		sess.dlgDisc.until = h.srv.cfg.Now().Add(-time.Second)
		if again := h.srv.waresFor(sess.ent, smith); again[0].Price != full[0].Price {
			t.Error("discount outlived its time")
		}
	})
}

func TestDialogYourLineIsABubbleForPlayersNearAndNotForThoseFar(t *testing.T) {
	h, store, w, g, gi := meadowsHarness(t)
	gd := w.T.NPCs[gi]
	const char1, char2, char3 = "33333333-4444-5555-6666-777777777778", "33333333-4444-5555-6666-777777777779", "33333333-4444-5555-6666-77777777777a"
	sx, sz := gd.WorkX+1.5*math.Cos(gd.WorkYaw), gd.WorkZ+1.5*math.Sin(gd.WorkYaw)
	at := func(dx float64) movement.Vec3 {
		return movement.Vec3{X: sx + dx, Y: g.HeightAt(sx+dx, sz) + 0.3, Z: sz}
	}
	store.rows[char1], store.rows[char2], store.rows[char3] = at(0), at(10), at(60)
	a, b, c := h.dial(""), h.dial(""), h.dial("")
	wa := a.join(h, char1, "Nicole")
	wb := b.join(h, char2, "Ada")
	c.join(h, char3, "Far")
	a.take(EventQuestStarted, 3*time.Second)
	a.drainFor(500 * time.Millisecond)
	b.drainFor(200 * time.Millisecond)
	c.drainFor(200 * time.Millisecond)
	_ = wb
	gid := a.npcEntityID(h, gi)
	a.dialogDo(DialogOpen, uint64(gid), 0)
	n := a.dialogNode(t)
	// The person's line is a bubble for the one 10 m away, not for the talker or the far one.
	bk := b.take(EventNPCBark, 2*time.Second)
	if string(bk.Data) != n.Line || bk.EntityID != gid {
		t.Fatalf("bystander saw %q, the talker saw %q", bk.Data, n.Line)
	}
	if len(a.eventsOf(EventNPCBark)) != 0 {
		t.Error("the talker also got a bark of their own box")
	}
	// Your answer is a bubble over you for you and the bystander.
	ch := n.Choices[len(n.Choices)-1]
	a.dialogDo(DialogChoose, uint64(gid), uint32(ch.ID))
	say := b.take(EventDialogSay, 2*time.Second)
	if say.EntityID != wa.EntityID || string(say.Data) != ch.Text {
		t.Fatalf("bystander's bubble %+v %q", say, say.Data)
	}
	if own := a.take(EventDialogSay, 2*time.Second); own.EntityID != wa.EntityID {
		t.Fatalf("own bubble %+v", own)
	}
	c.drainFor(300 * time.Millisecond)
	if len(c.eventsOf(EventDialogSay)) != 0 || len(c.eventsOf(EventNPCBark)) != 0 {
		t.Error("a player 60 m away heard the conversation")
	}
}
