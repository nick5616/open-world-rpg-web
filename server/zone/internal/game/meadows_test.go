package game

// Playtest 2 (new player onboarding): a new character's first quest,
// "Slimes in the meadows", on the official world with the real atlas
// enemies: it starts on the first login (the Ward waits), the giver is a
// townsperson of the spawn town, the markers are Haven packs whose members
// really are slimes, kills reach the quest through combat's OnKill hook,
// the hand-in pays gold, XP, two draughts and a leather cap, and the Ward
// starts and is tracked. Dropping the starter starts the Ward too, and a
// character who already has the Ward never gets the starter.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
)

// meadowsGiverIn is the townsperson resolveMeadows picks.
func meadowsGiverIn(w *npc.World, si int) int {
	st := w.T.Settlements[si]
	for _, role := range meadowsGiverRoles {
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			if w.T.NPCs[i].Role == role && w.T.NPCs[i].Name != "" {
				return i
			}
		}
	}
	return -1
}

func meadowsHarness(t *testing.T) (*harness, *questStore, *npc.World, movement.Ground, int) {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	raw := testTerrain(t).World().Atlas
	a, err := structures.ParseAtlas(raw)
	if err != nil {
		t.Fatal(err)
	}
	store := &questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground, c.Towns, c.Explore, c.Store, c.Queue = g, w, ex, store, q
		c.TimeOffsetS = offsetFor(12)
		ca := combat.ParseAtlas(raw, a)
		c.Combat = &CombatSetup{Atlas: ca}
		// As main.go: the Haven tier makes every pack around the spawn slimes.
		c.Difficulty = &DifficultySetup{Map: difficulty.New(&combatdefs.D.Difficulty, ca.WorldSize, ca.SpawnX, ca.SpawnZ, func(x, z float64) float64 { return ca.Region(ca.RegionAt(x, z)).Danger })}
	})
	si := spawnSettlement(t, w)
	gi := meadowsGiverIn(w, si)
	if gi < 0 {
		t.Fatal("the spawn town has nobody to give the starter")
	}
	return h, store, w, g, gi
}

func TestMeadowsFirstQuestToWard(t *testing.T) {
	h, store, w, g, gi := meadowsHarness(t)
	gd := w.T.NPCs[gi]
	const char = "33333333-4444-5555-6666-777777777777"
	sx, sz := gd.WorkX+1.5*math.Cos(gd.WorkYaw), gd.WorkZ+1.5*math.Sin(gd.WorkYaw)
	store.rows[char] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}

	a := h.dial("")
	wa := a.join(h, char, "Newcomer")
	started := a.take(EventQuestStarted, 3*time.Second)
	if started.TargetID != quests.MeadowsID {
		t.Fatalf("first quest %+v (%s)", started, started.Data)
	}
	l := a.questLog(t)
	mq := l.find(quests.MeadowsID)
	if mq == nil || l.Tracked != quests.MeadowsID || l.find(quests.WardID) != nil || len(l.Quests) != 1 {
		t.Fatalf("log at first login: %+v", l)
	}
	if !strings.Contains(mq.Text, gd.Name) || len(mq.Markers) != 1 || math.Hypot(mq.Markers[0].X-gd.WorkX, mq.Markers[0].Z-gd.WorkZ) > 0.01 {
		t.Fatalf("talk step %+v", mq)
	}
	t.Logf("giver: %s (%s); step 0: %s", gd.Name, mq.Giver, mq.Text)
	gold0 := a.inventory(t).Gold
	draughts0 := 0
	if it := findItem(a.inventory(t), "potion:health"); it != nil {
		draughts0 = it.Qty
	}

	// 1. Talk: the giver's line, then the kill step with the packs marked.
	gid := a.npcEntityID(h, gi)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(gid), Action: ActionTalk})
	if s := a.takeFor(EventQuestStep, quests.MeadowsID, 3*time.Second); s.Value != 1 {
		t.Fatalf("talk step %+v", s)
	}
	said := false
	for _, ev := range a.eventsOf(EventNPCSay) {
		if ev.EntityID == gid && strings.Contains(string(ev.Data), "slimes") {
			said = true
			t.Logf("%s: %s", gd.Name, ev.Data)
		}
	}
	if !said {
		t.Fatal("the giver did not ask about the slimes")
	}
	mq = a.questLog(t).find(quests.MeadowsID)
	if mq.Step != 1 || mq.Need != quests.MeadowsSlimes || mq.Progress != 0 || len(mq.Markers) == 0 {
		t.Fatalf("kill step %+v", mq)
	}
	si := spawnSettlement(t, w)
	st := w.T.Settlements[si]
	cw := h.srv.CombatWorld()
	for _, m := range mq.Markers {
		d := math.Hypot(m.X-st.X, m.Z-st.Z)
		t.Logf("marker %q at %.0f m from %s (r %.0f)", m.Label, d, mq.Giver, m.R)
		if d > meadowsPackRangeM || math.Hypot(m.X-cw.Atlas.SpawnX, m.Z-cw.Atlas.SpawnZ) > combat.D.Difficulty.HavenRadiusM {
			t.Fatalf("marker outside the Haven or far from town: %+v", m)
		}
	}

	// 2. Go to the nearest marked pack: its members are slimes.
	m0 := mq.Markers[0]
	_ = h.srv.Do(context.Background(), func() {
		e := h.srv.byChar[char].ent
		h.srv.Teleport(e, movement.Vec3{X: m0.X + 12, Y: g.HeightAt(m0.X+12, m0.Z) + 0.3, Z: m0.Z})
	})
	var slimes []*combat.Enemy
	deadline := time.Now().Add(8 * time.Second)
	for len(slimes) == 0 && time.Now().Before(deadline) {
		a.sendFrames(0, 0)
		a.drainFor(100 * time.Millisecond)
		_ = h.srv.Do(context.Background(), func() {
			for _, en := range cw.Enemies() {
				if en.Alive() && math.Hypot(en.Pos.X-m0.X, en.Pos.Z-m0.Z) < m0.R+12 {
					if en.Def.Family != quests.MeadowsFamily {
						t.Errorf("a %s (%s) at the slime marker", en.Def.Key, en.Def.Family)
						continue
					}
					slimes = append(slimes, en)
				}
			}
		})
	}
	if len(slimes) == 0 {
		t.Fatal("no slimes spawned at the marked pack")
	}
	t.Logf("%d slimes at the first marker", len(slimes))

	// 3. Kills reach the quest through combat's kill hook (five of them;
	// the pack may be smaller, a respawned slime counts again).
	pid := wa.EntityID
	for i := 0; i < quests.MeadowsSlimes; i++ {
		en := slimes[i%len(slimes)]
		_ = h.srv.Do(context.Background(), func() { cw.OnKill(combat.KillInfo{Enemy: en, Eligible: []uint32{pid}}) })
	}
	if s := a.takeFor(EventQuestStep, quests.MeadowsID, 3*time.Second); s.Value != 2 {
		t.Fatalf("after five slimes %+v", s)
	}
	mq = a.questLog(t).find(quests.MeadowsID)
	if mq.Step != 2 || !strings.Contains(mq.Text, "Return to "+gd.Name) {
		t.Fatalf("return step %+v", mq)
	}

	// 4. Back to the giver: completed, paid, the Ward starts and is tracked.
	_ = h.srv.Do(context.Background(), func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz})
	})
	a.drainFor(300 * time.Millisecond)
	gid = a.npcEntityID(h, gi)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(gid), Action: ActionTalk})
	done := a.takeFor(EventQuestCompleted, quests.MeadowsID, 3*time.Second)
	if done.Value != quests.MeadowsGold {
		t.Fatalf("completed %+v", done)
	}
	ward := a.takeFor(EventQuestStarted, quests.WardID, 3*time.Second)
	var sj struct{ Title, Text string }
	_ = json.Unmarshal(ward.Data, &sj)
	t.Logf("handed off: %s: %s", sj.Title, sj.Text)
	time.Sleep(200 * time.Millisecond)
	inv := a.inventory(t)
	// At least the quest's gold (the first kill also pays CR 023's First Blood feat, when content runs).
	if inv.Gold < gold0+quests.MeadowsGold || inv.Gold > gold0+quests.MeadowsGold+5 {
		t.Fatalf("gold %d -> %d", gold0, inv.Gold)
	}
	if findItem(inv, "armor:leather_cap") == nil {
		t.Fatal("no leather cap")
	}
	if it := findItem(inv, "potion:health"); it == nil || it.Qty != draughts0+2 {
		t.Fatalf("draughts %d -> %+v", draughts0, it)
	}
	l = a.questLog(t)
	if l.find(quests.MeadowsID) != nil || l.find(quests.WardID) == nil || l.Tracked != quests.WardID {
		t.Fatalf("after the hand-in %+v", l)
	}
	saved := quests.Load(store.logs[char])
	deadline = time.Now().Add(2 * time.Second)
	for !saved.IsDone(quests.MeadowsKey) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		store.mu.Lock()
		saved = quests.Load(store.logs[char])
		store.mu.Unlock()
	}
	if !saved.IsDone(quests.MeadowsKey) || saved.ByKey(quests.WardKey) == nil {
		t.Fatalf("saved log: done %v active %d", saved.Done, len(saved.Active))
	}
}

func TestMeadowsDroppedStartsWardAndOldCharactersSkipIt(t *testing.T) {
	h, store, _, _, _ := meadowsHarness(t)
	// A new character drops the starter: the Ward starts at once.
	a := h.dial("")
	a.join(h, "44444444-5555-6666-7777-888888888888", "Quitter")
	if s := a.take(EventQuestStarted, 3*time.Second); s.TargetID != quests.MeadowsID {
		t.Fatalf("first quest %+v", s)
	}
	a.send(&proto.Interact{TargetKind: InteractQuest, TargetID: quests.MeadowsID, Action: QuestActAbandon})
	a.takeFor(EventQuestStarted, quests.WardID, 3*time.Second)
	if l := a.questLog(t); l.find(quests.MeadowsID) != nil || l.Tracked != quests.WardID {
		t.Fatalf("after dropping %+v", l)
	}

	// A character from before playtest 2 (the Ward already started) never
	// gets the starter.
	const old = "55555555-6666-7777-8888-999999999999"
	ol := quests.NewLog()
	ol.Started = []string{quests.WardKey}
	store.logs[old] = ol.JSON()
	b := h.dial("")
	b.join(h, old, "Veteran")
	if l := b.questLog(t); l.find(quests.MeadowsID) != nil {
		t.Fatalf("old character's log %+v", l)
	}
	b.pump(300 * time.Millisecond)
	if evs := b.eventsOf(EventQuestStarted); len(evs) != 0 {
		t.Fatalf("an old character got %+v", evs[0])
	}
}

// Playtest 2 co-op: in a party, the prologue's talk steps are shared like
// the acts': one friend talks to the farmer and the other, beside them, is
// on the slimes too (and hears the farmer's line); handing in for one hands
// in for both, with each one's own reward, and both move on to the Ward.
func TestMeadowsTalksSharedInParty(t *testing.T) {
	h, store, w, g, gi := meadowsHarness(t)
	gd := w.T.NPCs[gi]
	const ca, cb = "66666666-4444-5555-6666-777777777777", "77777777-4444-5555-6666-777777777777"
	sx, sz := gd.WorkX+1.5*math.Cos(gd.WorkYaw), gd.WorkZ+1.5*math.Sin(gd.WorkYaw)
	store.rows[ca] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}
	store.rows[cb] = movement.Vec3{X: sx + 1, Y: g.HeightAt(sx+1, sz) + 0.3, Z: sz}
	a := h.dial("")
	a.join(h, ca, "Nell")
	b := h.dial("")
	b.join(h, cb, "Rook")
	for _, c := range []*client{a, b} {
		if s := c.take(EventQuestStarted, 3*time.Second); s.TargetID != quests.MeadowsID {
			t.Fatalf("first quest %+v", s)
		}
	}
	h.do(func() {
		h.srv.setParty(h.srv.byChar[ca].ent, "party-1")
		h.srv.setParty(h.srv.byChar[cb].ent, "party-1")
	})
	gid := a.npcEntityID(h, gi)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(gid), Action: ActionTalk})
	if s := b.takeFor(EventQuestStep, quests.MeadowsID, 3*time.Second); s.Value != 1 {
		t.Fatalf("the friend's step %+v", s)
	}
	if q := b.questLog(t).find(quests.MeadowsID); q == nil || q.Step != 1 {
		t.Fatalf("the friend is not on the slimes: %+v", q)
	}
	heard := false
	for _, ev := range b.eventsOf(EventStorySay) {
		heard = heard || strings.Contains(string(ev.Data), "slimes")
	}
	if !heard {
		t.Fatal("the friend did not hear the farmer")
	}
	// The slimes (in play a kill counts for the party beside it): both done.
	h.do(func() {
		for _, c := range []string{ca, cb} {
			sess := h.srv.byChar[c]
			sess.quests.log.SetStep(quests.MeadowsKey, 2)
			sess.quests.recheck = true
		}
	})
	gold0 := b.inventory(t).Gold
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(gid), Action: ActionTalk})
	if d := b.takeFor(EventQuestCompleted, quests.MeadowsID, 3*time.Second); d.Value != quests.MeadowsGold {
		t.Fatalf("the friend's hand-in %+v", d)
	}
	b.takeFor(EventQuestStarted, quests.WardID, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	inv := b.inventory(t)
	if inv.Gold < gold0+quests.MeadowsGold || findItem(inv, "armor:leather_cap") == nil {
		t.Fatalf("the friend's reward: gold %d -> %d, cap %v", gold0, inv.Gold, findItem(inv, "armor:leather_cap"))
	}
	if l := b.questLog(t); l.find(quests.MeadowsID) != nil || l.find(quests.WardID) == nil {
		t.Fatalf("the friend's log after the shared hand-in %+v", l)
	}
}
