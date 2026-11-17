package game

// CR 023 content in-process on the official world (real towns, atlas,
// terrain): a townsperson's gathering request offered on talk, accepted,
// handed in for gold, XP and reputation, and the giver's next request; the
// content state surviving a logout through the store; a delivery's parcel
// carried to another town; world events (dev-started: the Glintfox won,
// the Starfall's personal rewards, an expiry); a sealed vault (levers in
// the inscription's order, the keeper, the chest's guaranteed rare once);
// lore tablets, herb patches, feats and a title seen by another player;
// the handoff field.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/quests"
)

type contentStore struct {
	questStore
	data map[string][]byte
}

func (c *contentStore) LoadContent(_ context.Context, id string) ([]byte, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.data[id]
	return b, ok, nil
}

func (c *contentStore) SaveContent(_ context.Context, id string, b []byte, _ int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.rows[id]; !ok {
		return ErrNoRow
	}
	c.data[id] = append([]byte(nil), b...)
	return nil
}

func (c *contentStore) saved(id string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.data[id]
}

func contentHarness(t *testing.T, withCombat bool) (*harness, *contentStore) {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &contentStore{questStore: questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}, data: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
		if withCombat {
			raw := testTerrain(t).World().Atlas
			a, err := structures.ParseAtlas(raw)
			if err != nil {
				t.Fatal(err)
			}
			c.Combat = &CombatSetup{Atlas: combat.ParseAtlas(raw, a), Config: combat.Config{Seed: 42, NoWildPacks: true}}
		}
	})
	h.srv.SetWorldEvents(false) // tests start events themselves (dev Interact)
	h.do(func() { h.srv.qst.noErrands = true }) // CR 051: the first-hour errands would offer over these side quests
	return h, store
}

func (h *harness) do(f func()) {
	h.t.Helper()
	if err := h.srv.Do(context.Background(), f); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) contentWorld() *content.World {
	var cw *content.World
	h.do(func() { cw = h.srv.contentWorld() })
	return cw
}

// findSide finds a giver whose first request is of kind.
func findSide(t *testing.T, cw *content.World, kind string) (*content.Town, int, *content.Offer) {
	t.Helper()
	for i := range cw.Towns {
		tw := &cw.Towns[i]
		for _, g := range content.Givers(cw.Seed, tw) {
			if o := content.SideQuest(cw, tw, g, 0, 0); o != nil && o.Kind == kind {
				return tw, g, o
			}
		}
	}
	t.Fatalf("no %s quest in this world", kind)
	return nil, 0, nil
}

func (h *harness) teleport(char string, x, z float64) {
	h.do(func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: x, Y: h.srv.cfg.Ground.HeightAt(x, z) + 0.05, Z: z})
	})
}

// standByNPC puts the player 1.5 m from NPC i (wherever it walks).
func (h *harness) standByNPC(char string, i int) {
	h.do(func() {
		ne := h.srv.NPCEntity(i)
		p := ne.Move.Pos
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: p.X + 1.2, Y: p.Y + 0.05, Z: p.Z + 0.9})
	})
}

func npcStand(cw *content.World, tw *content.Town, npc int) (float64, float64) {
	n := tw.NPC(npc)
	return n.X + 1.2, n.Z + 0.8
}

func TestSideQuestGatherRepNextOfferAndPersistence(t *testing.T) {
	h, store := contentHarness(t, false)
	cw := h.contentWorld()
	tw, giver, o := findSide(t, cw, "gather")
	item, qty := o.Quest.Steps[0].Obj.Items[0].Item, o.Quest.Steps[0].Obj.Items[0].Qty
	const char = "33333333-4444-5555-6666-777777777777"
	sx, sz := npcStand(cw, tw, giver)
	store.rows[char] = movement.Vec3{X: sx, Y: h.srv.cfg.Ground.HeightAt(sx, sz) + 0.3, Z: sz}

	a := h.dial("")
	a.join(h, char, "Gatherer")
	a.take(EventContentSync, 3*time.Second)
	nid := a.npcEntityID(h, giver)
	h.standByNPC(char, giver)
	if nid == 0 {
		t.Fatal("giver not active")
	}
	// Talk: the giver offers their request with a line.
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	off := a.takeFor(EventQuestOffer, o.Quest.ID, 3*time.Second)
	var wq quests.WireQuest
	if err := json.Unmarshal(off.Data, &wq); err != nil || wq.Say == "" || wq.Kind != quests.KindSide || wq.Rep <= 0 || wq.RepTown != tw.Name {
		t.Fatalf("offer %s (%v)", off.Data, err)
	}
	t.Logf("%s offers %q: %q", tw.NPC(giver).Name, wq.Title, wq.Say)
	a.send(&proto.Interact{TargetKind: InteractQuest, TargetID: uint64(o.Quest.ID), Action: QuestActAccept})
	a.takeFor(EventQuestStarted, o.Quest.ID, 3*time.Second)
	if q := a.questLog(t).find(o.Quest.ID); q == nil || q.Need != qty && qty > 1 {
		t.Fatalf("log %+v", a.questLog(t))
	}
	// Talking without the items does nothing; with them, they're handed in.
	time.Sleep(250 * time.Millisecond)
	addItems(t, h, char, item, qty)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	done := a.takeFor(EventQuestCompleted, o.Quest.ID, 3*time.Second)
	if done.Value <= 0 {
		t.Fatalf("no gold: %+v", done)
	}
	rep := a.take(EventRepChanged, 2*time.Second)
	if rep.TargetID != uint32(tw.Index) || rep.Value != int32(o.Quest.Rep) {
		t.Fatalf("rep %+v", rep)
	}
	if it := findItem(a.inventory(t), item); it != nil && it.Qty > 0 {
		t.Fatalf("items not taken: %+v", it)
	}
	// The giver's next request.
	time.Sleep(250 * time.Millisecond)
	next := content.SideQuest(cw, tw, giver, 1, 0)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	a.takeFor(EventQuestOffer, next.Quest.ID, 3*time.Second)

	// Persisted: a new session reads the reputation and the giver's progress.
	deadline := time.Now().Add(3 * time.Second)
	for len(store.saved(char)) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	st := content.LoadState(store.saved(char))
	if st.RepOf(tw.Index) != o.Quest.Rep || st.GiverSeq(tw.Index, giver) != 1 || st.Stat("side") != 1 {
		t.Fatalf("saved %s", store.saved(char))
	}
	a.c.Close(1000, "")
	time.Sleep(300 * time.Millisecond)
	b := h.dial("")
	b.join(h, char, "Gatherer")
	var sync struct {
		Rep []syncRep `json:"rep"`
	}
	if err := json.Unmarshal(b.take(EventContentSync, 3*time.Second).Data, &sync); err != nil || len(sync.Rep) != 1 || sync.Rep[0].Rep != o.Quest.Rep {
		t.Fatalf("sync after reconnect %+v %v", sync, err)
	}
}

func TestSideQuestDeliveryParcel(t *testing.T) {
	h, store := contentHarness(t, false)
	cw := h.contentWorld()
	tw, giver, o := findSide(t, cw, "deliver")
	dest := o.Quest.Steps[0].Obj
	const char = "33333333-4444-5555-6666-777777777778"
	sx, sz := npcStand(cw, tw, giver)
	store.rows[char] = movement.Vec3{X: sx, Y: h.srv.cfg.Ground.HeightAt(sx, sz) + 0.3, Z: sz}
	a := h.dial("")
	a.join(h, char, "Courier")
	nid := a.npcEntityID(h, giver)
	h.standByNPC(char, giver)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(nid), Action: ActionTalk})
	a.takeFor(EventQuestOffer, o.Quest.ID, 3*time.Second)
	a.send(&proto.Interact{TargetKind: InteractQuest, TargetID: uint64(o.Quest.ID), Action: QuestActAccept})
	a.takeFor(EventQuestStarted, o.Quest.ID, 3*time.Second)
	if p := findItem(a.inventory(t), content.Parcel); p == nil {
		t.Fatal("no parcel on accept")
	}
	ot := cw.Town(dest.Settlement)
	dx, dz := npcStand(cw, ot, dest.NPC-1)
	h.teleport(char, dx, dz)
	did := a.npcEntityID(h, dest.NPC-1)
	h.standByNPC(char, dest.NPC-1)
	if did == 0 {
		t.Fatal("recipient not active")
	}
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(did), Action: ActionTalk})
	a.takeFor(EventQuestCompleted, o.Quest.ID, 3*time.Second)
	if p := findItem(a.inventory(t), content.Parcel); p != nil && p.Qty > 0 {
		t.Fatal("parcel not handed over")
	}
}

func eventOf(t *testing.T, ev *proto.Event) map[string]any {
	t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal(ev.Data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestWorldEventsGlintfoxStarfallExpiry(t *testing.T) {
	h, store := contentHarness(t, true)
	cw := h.contentWorld()
	// Open ground well away from towns (the event needs room).
	var x, z float64
	found := false
	for i := 0; i < 400 && !found; i++ {
		x, z = 600+float64(i%20)*150, 600+float64(i/20)*150
		ok := true
		for _, tw := range cw.Towns {
			ok = ok && math.Hypot(tw.X-x, tw.Z-z) > 300
		}
		h.do(func() {
			found = ok && h.srv.eventSpotOK(x, z) && h.srv.eventSpotOK(x+60, z) && h.srv.eventSpotOK(x, z+60) && h.srv.eventSpotOK(x-60, z) && h.srv.eventSpotOK(x, z-60)
		})
	}
	if !found {
		t.Fatal("no open ground")
	}
	const char = "44444444-4444-5555-6666-777777777777"
	store.rows[char] = movement.Vec3{X: x, Y: h.srv.cfg.Ground.HeightAt(x, z) + 0.3, Z: z}
	a := h.dial("")
	a.join(h, char, "Hunter")
	a.take(EventContentSync, 3*time.Second)
	var me uint32
	h.do(func() { me = h.srv.byChar[char].ent.ID })
	kind := func(key string) uint32 { return uint32(contentdefs.D.EventKind(key).ID) }

	start := func(key string) (*proto.Event, *worldEvent) {
		a.send(&proto.Interact{TargetKind: InteractContent, Action: ContentActEvent, Arg: kind(key)})
		ev := a.take(EventWorldEvent, 3*time.Second)
		if ev.Value != EventPhaseActive || eventOf(t, ev)["kind"] != key {
			t.Fatalf("start %s: %s", key, ev.Data)
		}
		var w *worldEvent
		h.do(func() {
			for _, x := range h.srv.cnt.ev.active {
				if x.id == ev.TargetID {
					w = x
				}
			}
		})
		return ev, w
	}
	slayAll := func(w *worldEvent) {
		deadline := time.Now().Add(5 * time.Second)
		for {
			n := 0
			h.do(func() {
				for _, g := range w.groups {
					for _, m := range g.Members {
						if m.Alive() {
							h.srv.cbt.w.Slay(m, me)
							n++
						}
					}
				}
			})
			if n > 0 || time.Now().After(deadline) {
				return
			}
			a.pump(100 * time.Millisecond)
		}
	}
	gold := func() int {
		if g := findItem(a.inventory(t), "currency:gold"); g != nil {
			return g.Qty
		}
		return 0
	}

	// The Glintfox: caught.
	ev, w := start("glintfox")
	t.Logf("glintfox: %s", ev.Data)
	slayAll(w)
	won := a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second)
	for won.Value != EventPhaseWon {
		won = a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second)
	}
	prize := a.take(EventWorldEventPrize, 3*time.Second)
	if prize.Value <= 0 {
		t.Fatalf("prize %s", prize.Data)
	}
	h.do(func() {
		for _, g := range w.groups {
			if !g.Retired {
				t.Error("event group not retired")
			}
		}
	})

	// The Starfall: guardians slain, starmetal ore and an item for the helper.
	g0 := gold()
	ev, w = start("starfall")
	slayAll(w)
	for e := a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second); e.Value != EventPhaseWon; e = a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second) {
	}
	a.take(EventWorldEventPrize, 3*time.Second)
	inv := a.inventory(t)
	if findItem(inv, "ore:starmetal") == nil || gold() <= g0 {
		t.Fatalf("starfall rewards missing (gold %d -> %d)", g0, gold())
	}

	// The Wild Hunt runs out of time: failed, nothing paid, groups retired.
	ev, w = start("wildhunt")
	h.do(func() { w.endTick = h.srv.tick })
	for e := a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second); e.Value != EventPhaseFailed; e = a.takeFor(EventWorldEvent, ev.TargetID, 3*time.Second) {
	}
	h.do(func() {
		if !w.groups[0].Retired || len(h.srv.cnt.ev.active) != 0 {
			t.Error("expired event still active")
		}
	})
	var st *content.State
	h.do(func() { st = h.srv.byChar[char].cnt.st })
	if st.Stat("events") != 2 {
		t.Fatalf("events won %d", st.Stat("events"))
	}
}

func TestSealedVaultLeversKeeperChest(t *testing.T) {
	h, store := contentHarness(t, true)
	var v *content.Vault
	h.do(func() {
		for _, p := range h.srv.vaultPlans() {
			if p.Puzzle.Key == "levers" && (v == nil || p.Site.Index < v.Site.Index) {
				v = p
			}
		}
	})
	if v == nil {
		t.Skip("no lever vault on this world")
	}
	const char = "55555555-4444-5555-6666-777777777777"
	sx, sz := v.Site.X+v.Site.R+30, v.Site.Z
	store.rows[char] = movement.Vec3{X: sx, Y: h.srv.cfg.Ground.HeightAt(sx, sz) + 0.3, Z: sz}
	a := h.dial("")
	a.join(h, char, "Delver")
	found := a.take(EventVaultFound, 4*time.Second)
	if found.TargetID != uint32(v.Site.Index) {
		t.Fatalf("found %+v", found)
	}
	st := a.take(EventVaultState, 4*time.Second)
	data := eventOf(t, st)
	t.Logf("%s: %s / %s", v.Name, data["title"], data["hint"])
	if st.Value&0xf != VaultSealed {
		t.Fatal("not sealed")
	}
	var me uint32
	h.do(func() {
		me = h.srv.byChar[char].ent.ID
		// The yard's elite packs would interrupt; clear them.
		for _, g := range h.srv.cnt.vault.live[v.Site.Index].packs {
			h.srv.cbt.w.RetireGroup(g)
		}
	})
	use := func(p content.Part) {
		h.teleport(char, p.X+0.8, p.Z+0.8)
		a.pump(150 * time.Millisecond)
		a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(v.Site.Index)<<8 | uint64(p.ID), Action: ContentActVault})
		a.pump(250 * time.Millisecond)
	}
	glyph := func(g int) content.Part {
		for _, p := range v.Parts {
			if p.Glyph == g {
				return p
			}
		}
		return content.Part{}
	}
	// Wrong first lever: the vault says so and resets.
	use(glyph(v.Order[1]))
	if n := a.take(EventVaultNote, 2*time.Second); string(n.Data) != v.Puzzle.Wrong {
		t.Fatalf("note %q", n.Data)
	}
	for _, g := range v.Order {
		use(glyph(g))
	}
	var lv *liveVault
	deadline := time.Now().Add(4 * time.Second)
	for {
		h.do(func() { lv = h.srv.cnt.vault.live[v.Site.Index] })
		if lv.phase == VaultOpen || time.Now().After(deadline) {
			break
		}
		a.pump(100 * time.Millisecond)
	}
	if lv.phase != VaultOpen {
		t.Fatal("the seal did not open")
	}
	// The keeper rises at the door; slay it.
	h.teleport(char, v.Door.X+3, v.Door.Z)
	deadline = time.Now().Add(5 * time.Second)
	for {
		killed := false
		h.do(func() {
			if g := lv.keeper; g != nil && g.Spawned {
				for _, m := range g.Members {
					if m.Boss != nil {
						t.Logf("keeper %q hp %.0f level %d", m.Name, m.HPMax, m.Level)
					}
					h.srv.cbt.w.Slay(m, me)
					killed = true
				}
			}
		})
		if killed || time.Now().After(deadline) {
			break
		}
		a.pump(100 * time.Millisecond)
	}
	for n := a.take(EventVaultNote, 4*time.Second); n.Value != 2; n = a.take(EventVaultNote, 4*time.Second) {
	}
	// The chest: a guaranteed rare, once.
	use(v.Chest)
	for n := a.take(EventVaultNote, 3*time.Second); n.Value != 3; n = a.take(EventVaultNote, 3*time.Second) {
	}
	a.pump(200 * time.Millisecond)
	inv := a.inventory(t)
	rare := false
	for _, it := range inv.Items {
		if bd := items.D.Item(it.Base); bd != nil && (bd.Kind == "weapon" || bd.Kind == "armor") && it.Rarity >= items.D.RarityByKey("rare") {
			rare = true
		}
	}
	if !rare {
		t.Fatal("no rare from the vault chest")
	}
	use(v.Chest)
	if r := a.take(EventContentRefused, 2*time.Second); r.Value != ContentRefuseOpened {
		t.Fatalf("second chest %+v", r)
	}
	var cs *content.State
	h.do(func() { cs = h.srv.byChar[char].cnt.st })
	if cs.Stat("dungeons") != 1 || !cs.Has("vault_breaker") || !cs.VaultKnown(v.Site.Index) {
		t.Fatalf("state %s", cs.JSON())
	}
}

func TestTabletsHerbsFeatsTitleSeenByOthers(t *testing.T) {
	h, store := contentHarness(t, true)
	h.contentWorld()
	var site int
	var tab movement.Vec3
	h.do(func() {
		site = h.srv.cnt.tabSite[0]
		tab, _ = h.srv.tabletPos(site)
	})
	const char = "66666666-4444-5555-6666-777777777777"
	const other = "66666666-4444-5555-6666-777777777778"
	store.rows[char] = movement.Vec3{X: tab.X + 1, Y: tab.Y + 0.3, Z: tab.Z + 1}
	store.rows[other] = movement.Vec3{X: tab.X + 4, Y: tab.Y + 0.3, Z: tab.Z + 3}
	a := h.dial("")
	a.join(h, char, "Reader")
	places := a.take(EventContentPlaces, 3*time.Second)
	if len(places.Data) < 7 {
		t.Fatal("places")
	}
	// The tablet.
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(site), Action: ContentActRead})
	r := a.take(EventTabletRead, 2*time.Second)
	if m := eventOf(t, r); m["new"] != true || m["text"] == "" {
		t.Fatalf("tablet %s", r.Data)
	}
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(site), Action: ContentActRead})
	if m := eventOf(t, a.take(EventTabletRead, 2*time.Second)); m["new"] != false {
		t.Fatal("second read is new")
	}
	// A herb patch somewhere near: pick it, then it's picked.
	var p content.Patch
	ok := false
	h.do(func() {
		for ax := 0; ax < 16 && !ok; ax++ {
			for az := 0; az < 16 && !ok; az++ {
				if ps := content.PatchesIn(h.srv.cfg.Seed, ax, az, h.srv.biomeAt, h.srv.patchOK); len(ps) > 0 {
					p, ok = ps[0], true
				}
			}
		}
	})
	if !ok {
		t.Fatal("no herb patch in this world")
	}
	h.teleport(char, p.X+0.5, p.Z+0.5)
	a.pump(200 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(p.ID), Action: ContentActForage})
	picked := a.take(EventForagePicked, 2*time.Second)
	if herb := content.HerbByID(p.Herb); string(picked.Data) != herb.Item || findItem(a.inventory(t), herb.Item) == nil {
		t.Fatalf("picked %s", picked.Data)
	}
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: uint64(p.ID), Action: ContentActForage})
	if r := a.take(EventContentRefused, 2*time.Second); r.Value != ContentRefusePicked {
		t.Fatalf("second pick %+v", r)
	}
	// A duel won earns the Duelist achievement and its title, which a player
	// nearby sees on the nameplate.
	h.teleport(char, tab.X+1, tab.Z+1)
	b := h.dial("")
	b.join(h, other, "Onlooker")
	var me uint32
	h.do(func() {
		me = h.srv.byChar[char].ent.ID
		h.srv.contentDuelWon(h.srv.byChar[char].ent)
	})
	f := a.takeFor(EventFeatEarned, achID("duelist"), 3*time.Second) // CR 031: other unlocks (a tablet read, a herb, a vault found) may come first
	if eventOf(t, f)["key"] != "duelist" {
		t.Fatalf("feat %s", f.Data)
	}
	deadline := time.Now().Add(4 * time.Second)
	for {
		seen := false
		for _, e := range b.eventsOf(EventPlayerTitle) {
			if e.EntityID == me && string(e.Data) == "the Duelist" {
				seen = true
			}
		}
		if seen {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the other player never saw the title")
		}
		b.pump(100 * time.Millisecond)
	}
	// Choose no title: everyone near hears it.
	a.send(&proto.Interact{TargetKind: InteractContent, TargetID: 0, Action: ContentActTitle})
	deadline = time.Now().Add(3 * time.Second)
	for {
		evs := b.eventsOf(EventPlayerTitle)
		if len(evs) > 0 && evs[len(evs)-1].EntityID == me && len(evs[len(evs)-1].Data) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("title cleared not seen")
		}
		b.pump(100 * time.Millisecond)
	}
}

func TestContentHandoffField(t *testing.T) {
	var f *HandoffField
	for i := range handoffFields {
		if handoffFields[i].Name == "content" {
			f = &handoffFields[i]
		}
	}
	if f == nil {
		t.Fatal("no content handoff field")
	}
	s := New(Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	st := content.NewState()
	st.AddRep(4, 30)
	st.ReadTablet(2)
	e := &Entity{CharacterID: "c1"}
	s.byChar["c1"] = &session{ent: e, cnt: &contentSess{st: st}}
	raw := f.Save(s, e)
	s2 := New(Config{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	f.Load(s2, e, raw)
	if got := s2.cnt.handed["c1"]; got == nil || got.RepOf(4) != 30 || len(got.Tablets) != 1 {
		t.Fatalf("handed %+v", got)
	}
}
