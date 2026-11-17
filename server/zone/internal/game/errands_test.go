package game

// Playtest 4 (the first hour, CR 051) on the official world: a brand-new
// character is called over by name by their mentor (Event 1930), talks to
// them (the slimes), and then walks the errand chain: the blacksmith's ore
// and the mentor's timber, each started by itself, tracked, counted by its
// deeds and paid by its giver; the Ward waits until the prologue's errands
// are done. A character from before playtest 4 gets no arrival and no chain,
// only offers from the people.

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
)

func npcNamed(w *npc.World, si int, name string) int {
	st := w.T.Settlements[si]
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if w.T.NPCs[i].Name == name {
			return i
		}
	}
	return -1
}

func (cl *client) talkTo(h *harness, char string, i int) {
	cl.t.Helper()
	h.standByNPC(char, i)
	cl.drainFor(150 * time.Millisecond)
	cl.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(cl.npcEntityID(h, i)), Action: ActionTalk})
}

func (cl *client) stepOf(t *testing.T, id uint32) *quests.WireQuest {
	t.Helper()
	return cl.questLog(t).find(id)
}

func TestFirstHourArrivalAndErrands(t *testing.T) {
	h, store, w, g, gi := meadowsHarness(t)
	si := spawnSettlement(t, w)
	var c *errandCtx
	h.do(func() { c = h.srv.errandsAt(si) })
	p := c.p
	if c.mentor != gi || p.Mentor.Name == "" || p.Smith.Name == "" {
		t.Fatalf("mentor %d (giver %d) %+v", c.mentor, gi, p)
	}
	t.Logf("places: mentor %s, smith %s, guard %s, innkeeper %s, merchant %s, keeper %s; forge %v oreMouth %v veins %v darkMouth %v water %v tower %q",
		p.Mentor.Name, p.Smith.Name, p.Guard.Name, p.Innkeeper.Name, p.Merchant.Name, p.Keeper.Name, p.Forge.OK, p.OreMouth.Where, p.OreVeins.OK, p.DarkMouth.Where, p.Water.Where, p.TowerName)
	for _, id := range quests.ErrandChain {
		q, say := quests.Errand(id, p, true, 0)
		if q == nil {
			t.Logf("errand %s: this town cannot give it", id)
			continue
		}
		t.Logf("errand %s %q (%d steps, %d gold, %d xp): %s", id, q.Title, len(q.Steps), q.Gold, q.XP, say)
	}
	for _, id := range []string{quests.ErrandOre, quests.ErrandTimber} {
		if q, _ := quests.Errand(id, p, true, 0); q == nil {
			t.Fatalf("the spawn town cannot give %s", id)
		}
	}

	const char = "88888888-1111-2222-3333-444444444444"
	gd := w.T.NPCs[gi]
	// A newcomer stands in the road, 40 m from the farmer.
	sx, sz := gd.WorkX+40, gd.WorkZ
	store.rows[char] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}
	a := h.dial("")
	wa := a.join(h, char, "Newcomer")
	if s := a.take(EventQuestStarted, 3*time.Second); s.TargetID != quests.MeadowsID {
		t.Fatalf("first quest %+v", s)
	}

	// The arrival: the mentor calls the newcomer by name, for them alone.
	bark := a.take(EventNPCBark, 12*time.Second)
	if bark.TargetID != wa.EntityID || !strings.HasPrefix(string(bark.Data), "Newcomer!") || bark.Value <= 0 {
		t.Fatalf("arrival bark %+v %q", bark, bark.Data)
	}
	var mentorEnt uint32
	h.do(func() { mentorEnt = h.srv.NPCEntity(gi).ID })
	if bark.EntityID != mentorEnt {
		t.Fatalf("the bark came from entity %d, the mentor is %d", bark.EntityID, mentorEnt)
	}
	t.Logf("%s: %s", p.Mentor.Name, bark.Data)

	// They go over and talk: the slimes start.
	a.talkTo(h, char, gi)
	if s := a.takeFor(EventQuestStep, quests.MeadowsID, 3*time.Second); s.Value != 1 {
		t.Fatalf("talk step %+v", s)
	}
	a.pump(300 * time.Millisecond)
	if evs := a.eventsOf(EventNPCBark); len(evs) != 0 {
		t.Fatalf("a second call after they came over: %+v", evs[0])
	}

	// The slimes done (their kills are tested in meadows_test.go): the hand-in starts the first errand, not the Ward.
	h.do(func() {
		sess := h.srv.byChar[char]
		sess.quests.log.SetStep(quests.MeadowsKey, 2)
		sess.quests.recheck = true
	})
	a.talkTo(h, char, gi)
	if d := a.takeFor(EventQuestCompleted, quests.MeadowsID, 3*time.Second); d.Value != quests.MeadowsGold {
		t.Fatalf("completed %+v", d)
	}
	oreID := quests.ErrandID(quests.ErrandOre)
	a.takeFor(EventQuestStarted, oreID, 3*time.Second)
	l := a.questLog(t)
	oq := l.find(oreID)
	if oq == nil || l.Tracked != oreID || l.find(quests.WardID) != nil || oq.Step != 0 || !strings.Contains(oq.Text, p.Smith.Name) {
		t.Fatalf("after the slimes: tracked %d, ore %+v, ward %v", l.Tracked, oq, l.find(quests.WardID))
	}

	// Errand 1, the blacksmith's ore: talk, mine three, smelt one, hand in.
	gold0, xp0 := a.inventory(t).Gold, 0
	_ = xp0
	smith := npcNamed(w, si, p.Smith.Name)
	a.talkTo(h, char, smith)
	a.takeFor(EventQuestStep, oreID, 3*time.Second)
	said := false
	for _, ev := range a.eventsOf(EventNPCSay) {
		said = said || strings.Contains(string(ev.Data), "pickaxe")
	}
	if !said {
		t.Fatal("the smith did not send them to the cave")
	}
	oq = a.stepOf(t, oreID)
	if oq.Step != 1 || oq.Need != 3 || len(oq.Markers) == 0 || oq.Progress != 0 {
		t.Fatalf("mine step %+v", oq)
	}
	deed := func(d string) {
		h.do(func() { h.srv.questsDeed(h.srv.byChar[char], d) })
	}
	deed(quests.DeedFell) // not this step's deed: nothing
	deed(quests.DeedMine)
	deed(quests.DeedMine)
	a.pump(200 * time.Millisecond)
	if oq = a.stepOf(t, oreID); oq.Step != 1 || oq.Progress != 2 {
		t.Fatalf("after two veins %+v", oq)
	}
	deed(quests.DeedMine)
	if s := a.takeFor(EventQuestStep, oreID, 3*time.Second); s.Value != 2 {
		t.Fatalf("smelt step %+v", s)
	}
	deed(quests.DeedSmelt)
	if s := a.takeFor(EventQuestStep, oreID, 3*time.Second); s.Value != 3 {
		t.Fatalf("return step %+v", s)
	}
	a.talkTo(h, char, smith)
	if d := a.takeFor(EventQuestCompleted, oreID, 3*time.Second); d.Value != 15 {
		t.Fatalf("ore completed %+v", d)
	}
	timberID := quests.ErrandID(quests.ErrandTimber)
	a.takeFor(EventQuestStarted, timberID, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	inv := a.inventory(t)
	if inv.Gold < gold0+15 || findItem(inv, "weapon:copper_sword") == nil {
		t.Fatalf("ore reward: gold %d -> %d, sword %v", gold0, inv.Gold, findItem(inv, "weapon:copper_sword"))
	}
	l = a.questLog(t)
	if l.find(oreID) != nil || l.Tracked != timberID || l.find(quests.WardID) != nil {
		t.Fatalf("after the ore errand: tracked %d, ward %v", l.Tracked, l.find(quests.WardID))
	}

	// Errand 2, the mentor's timber: talk, fell three, build, hand in. The smith no longer offers the Ward over it.
	a.talkTo(h, char, gi)
	a.takeFor(EventQuestStep, timberID, 3*time.Second)
	if it := findItem(a.inventory(t), "wood:log"); it == nil || it.Qty < 3 {
		t.Fatalf("the mentor did not hand over logs: %+v", it)
	}
	for i := 0; i < 3; i++ {
		deed(quests.DeedFell)
	}
	if s := a.takeFor(EventQuestStep, timberID, 3*time.Second); s.Value != 2 {
		t.Fatalf("build step %+v", s)
	}
	deed(quests.DeedBuild)
	a.takeFor(EventQuestStep, timberID, 3*time.Second)
	a.talkTo(h, char, gi)
	a.takeFor(EventQuestCompleted, timberID, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	if findItem(a.inventory(t), "camp:bedroll") == nil {
		t.Fatal("no bedroll from the timber errand")
	}

	// Errand 3 (the guard's torch) starts; the torch is lit with the real key (Interact 160), and the cave mouth reached.
	torchID := quests.ErrandID(quests.ErrandTorch)
	if q, _ := quests.Errand(quests.ErrandTorch, p, true, 0); q != nil {
		a.takeFor(EventQuestStarted, torchID, 3*time.Second)
		if l = a.questLog(t); l.Tracked != torchID || l.find(quests.WardID) != nil {
			t.Fatalf("third errand: tracked %d, ward %v", l.Tracked, l.find(quests.WardID))
		}
		guard := npcNamed(w, si, p.Guard.Name)
		a.talkTo(h, char, guard)
		a.takeFor(EventQuestStep, torchID, 3*time.Second)
		a.send(&proto.Interact{TargetKind: InteractLight, Action: LightActTorch})
		if s := a.takeFor(EventQuestStep, torchID, 3*time.Second); s.Value != 2 {
			t.Fatalf("the lit torch did not count: %+v", s)
		}
		h.teleport(char, p.DarkMouth.X, p.DarkMouth.Z)
		if s := a.takeFor(EventQuestStep, torchID, 3*time.Second); s.Value != 3 {
			t.Fatalf("reaching the mouth did not count: %+v", s)
		}
		a.talkTo(h, char, guard)
		a.takeFor(EventQuestCompleted, torchID, 3*time.Second)
		// ... and the Ward follows the prologue.
		ward := a.takeFor(EventQuestStarted, quests.WardID, 3*time.Second)
		var sj struct{ Title string }
		_ = json.Unmarshal(ward.Data, &sj)
		if l = a.questLog(t); l.Tracked != quests.WardID {
			t.Fatalf("after the prologue the Ward is not tracked: %+v", l.Tracked)
		}
	}

	// The saved log remembers it all.
	deadline := time.Now().Add(2 * time.Second)
	saved := quests.Load(store.logs[char])
	for !saved.IsDone(quests.ErrandKey(quests.ErrandTimber)) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		store.mu.Lock()
		saved = quests.Load(store.logs[char])
		store.mu.Unlock()
	}
	if !saved.IsDone(quests.MeadowsKey) || !saved.IsDone(quests.ErrandKey(quests.ErrandOre)) || !saved.IsDone(quests.ErrandKey(quests.ErrandTimber)) {
		t.Fatalf("saved log: done %v", saved.Done)
	}
}

// A character from before playtest 4 gets no arrival call and no chain; the
// people offer their errands when talked to, and an accepted one starts at
// its first deed (no talk step).
func TestFirstHourOldCharacterNoArrivalOffersOnTalk(t *testing.T) {
	h, store, w, g, _ := meadowsHarness(t)
	si := spawnSettlement(t, w)
	var c *errandCtx
	h.do(func() { c = h.srv.errandsAt(si) })
	const old = "99999999-1111-2222-3333-444444444444"
	ol := quests.NewLog()
	ol.Started = []string{quests.WardKey}
	store.logs[old] = ol.JSON()
	sx, sz := w.T.NPCs[c.mentor].WorkX+40, w.T.NPCs[c.mentor].WorkZ
	store.rows[old] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}
	b := h.dial("")
	b.join(h, old, "Veteran")
	b.pump(7 * time.Second) // the arrival call comes 3 s after a join
	if evs := b.eventsOf(EventNPCBark); len(evs) != 0 {
		t.Fatalf("an old character was called over: %+v", evs[0])
	}
	if evs := b.eventsOf(EventQuestStarted); len(evs) != 0 {
		t.Fatalf("an old character got a quest by itself: %+v", evs[0])
	}
	// The smith offers the ore errand on a talk (the card path).
	smith := npcNamed(w, si, c.p.Smith.Name)
	b.talkTo(h, old, smith)
	oreID := quests.ErrandID(quests.ErrandOre)
	offer := b.takeFor(EventQuestOffer, oreID, 3*time.Second)
	var wq quests.WireQuest
	if err := json.Unmarshal(offer.Data, &wq); err != nil || wq.Say == "" || wq.Step != 0 || !strings.HasPrefix(wq.Text, "Mine") {
		t.Fatalf("offer %+v (%v)", wq, err)
	}
	b.send(&proto.Interact{TargetKind: InteractQuest, TargetID: uint64(oreID), Action: QuestActAccept})
	b.takeFor(EventQuestStarted, oreID, 3*time.Second)
	if l := b.questLog(t); l.find(oreID) == nil || math.IsNaN(float64(l.Tracked)) {
		t.Fatalf("log %+v", l)
	}
	_ = towns.RoleBlacksmith
}
