package game

// CR 035, the main story in process on the official world: two players in
// a party play "The Last Song" from Act I to the ending. Travel is by
// teleport, levels by the dev console's XP, a few steps by their signal
// (a vault cleared, a tablet read: the systems behind them have their own
// tests); everything else is the real path: talking to the NPCs, attuning
// on a tower top, the vigil's town defense and the Starless Sovereign, the
// archon's sanctum, the Heartfall's arming, the Hush's phases (the shroud,
// the choir of bells, the endless night and its wells), a revive, the
// ending, the achievements, the post-game, and the state after a
// reconnect. Party sharing (both advance on the steps done together; the
// one left behind catches up) and scaling with two players are checked on
// the way.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/night"
	"lodestone/server/zone/internal/quests"
	"lodestone/server/zone/internal/story"
)

func storyHarness(t *testing.T) (*harness, *contentStore) {
	t.Helper()
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &contentStore{questStore: questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}, data: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	t.Cleanup(stopQ)
	go q.Run(qctx)
	raw := testTerrain(t).World().Atlas
	a, err := structures.ParseAtlas(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(c *Config) {
		c.Ground, c.Towns, c.Explore, c.Store, c.Queue = g, w, ex, store, q
		c.TimeOffsetS = offsetFor(12)
		c.Combat = &CombatSetup{Atlas: combat.ParseAtlas(raw, a), Config: combat.Config{Seed: 42, NoWildPacks: true}}
		names := func(i int) string {
			if n := w.T.Settlements[i].Site; n >= 0 && n < len(a.Sites) {
				return a.Sites[n].Name
			}
			return ""
		}
		c.Night = &NightSetup{World: night.New(42, 0.5, w.T, names, nil), Overlay: &chem.Overlay{}, WindDeg: 270, NoDemons: true, Force: -1}
	})
	h.srv.SetWorldEvents(false)
	return h, store
}

// storyAt is a character's main story progress on the zone.
func (h *harness) storyAt(char string) (act, step int) {
	h.do(func() {
		if sess := h.srv.byChar[char]; sess != nil && sess.quests != nil {
			act, step = story.Progress(sess.quests.log)
		}
	})
	return
}

// waitStory pumps both clients until char is at act, step.
func waitStory(t *testing.T, h *harness, char string, act, step int, cls ...*client) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		a, s := h.storyAt(char)
		if a == act && s == step {
			return
		}
		if time.Now().After(deadline) {
			var cur string
			h.do(func() {
				if q := h.srv.byChar[char].quests.log.ByKey(story.Key(a)); q != nil && q.Current() != nil {
					cur = q.Current().Text
				}
			})
			t.Fatalf("%s: at act %d step %d (%q), want act %d step %d", char, a, s, cur, act, step)
		}
		for _, c := range cls {
			c.pump(30 * time.Millisecond)
		}
	}
}

func (h *harness) has(char, item string) int {
	n := 0
	h.do(func() { n = questFacts{h.srv, h.srv.byChar[char]}.Have(item) })
	return n
}

func TestMainStoryTwoPlayersEndToEnd(t *testing.T) {
	h, store := storyHarness(t)
	var p *story.Places
	h.do(func() { p = h.srv.storyPlaces() })
	if p == nil {
		t.Fatal("no main story on the official world")
	}
	t.Logf("places: keeper %s of %s; stone %s; forks %s / %s / %s / %s; vaults %s / %s; vigil %s (%s); smith %s of %s; sanctum %s; last fork %s; Heartfall (%.0f, %.0f) in %s",
		p.Keeper.Name, p.Home, p.Tablet.Name, p.Forks[0].Name, p.Forks[1].Name, p.Forks[2].Name, p.Forks[3].Name, p.Vaults[0].Name, p.Vaults[1].Name,
		p.Vigil.Name, p.Captain.Name, p.Smith.Name, p.Smith.Town, p.Sanctum.Name, p.LastFork.Name, p.Heartfall.X, p.Heartfall.Z, p.Heartfall.Region)
	// Playtest 2 co-op: every story tower can be walked up to.
	for _, f := range append(p.Forks[:], p.LastFork) {
		if tw, ok := h.srv.cfg.Explore.TowerOfSite(f.Site); ok && !h.srv.towerApproachable(tw.Shape.CX, tw.Shape.CZ, tw.Shape.MaxR) {
			t.Fatalf("story tower %s has no walkable approach", f.Name)
		}
	}
	sawCrags := false
	for _, tw := range h.srv.cfg.Explore.Towers {
		if a := h.srv.cfg.Explore.Atlas.Sites[tw.Site]; a.Name == "The Forgotten Spire" && tw.Shape.TopY > 400 {
			sawCrags = !h.srv.towerApproachable(tw.Shape.CX, tw.Shape.CZ, tw.Shape.MaxR)
		}
	}
	if !sawCrags {
		t.Fatal("the Howling Crags' summit tower (one 46 degree ridge) should count as unapproachable")
	}

	const A, B = "a1111111-2222-3333-4444-555555555555", "b1111111-2222-3333-4444-555555555555"
	for i, c := range []string{A, B} {
		l := quests.NewLog() // both played the prologue: the Ward is done
		l.MarkDone(quests.MeadowsKey)
		l.MarkDone(quests.WardKey)
		store.logs[c] = l.JSON()
		x, z := p.Keeper.X+2+float64(i), p.Keeper.Z+2
		store.rows[c] = movement.Vec3{X: x, Y: h.srv.cfg.Ground.HeightAt(x, z) + 0.3, Z: z}
	}
	a, b := h.dial(""), h.dial("")
	a.join(h, A, "Nicole")
	b.join(h, B, "Friend")
	for _, c := range []*client{a, b} {
		if in := c.take(EventStoryIntro, 4*time.Second); in.Value != 1 || !strings.Contains(string(in.Data), "The Fading Hum") {
			t.Fatalf("act 1 intro %+v %s", in, in.Data)
		}
		if st := c.takeFor(EventQuestStarted, story.ID(1), 2*time.Second); st == nil {
			t.Fatal("act 1 not started")
		}
	}
	var ea, eb *Entity
	h.do(func() {
		ea, eb = h.srv.byChar[A].ent, h.srv.byChar[B].ent
		h.srv.setParty(ea, "party-1")
		h.srv.setParty(eb, "party-1")
	})
	pe := a.take(EventStoryParty, 3*time.Second)
	var party struct {
		Leader  uint32        `json:"leader"`
		Members []storyMember `json:"members"`
		Behind  bool          `json:"behind"`
	}
	if err := json.Unmarshal(pe.Data, &party); err != nil || len(party.Members) != 1 || party.Members[0].ID != eb.ID || party.Members[0].Act != 1 {
		t.Fatalf("party event %s", pe.Data)
	}
	both := []*client{a, b}
	near := func(x, z float64) { // A at (x, z), B beside A
		h.teleport(A, x, z)
		h.teleport(B, x+2, z+1)
		a.pump(60 * time.Millisecond)
	}
	talk := func(n story.NPC) {
		h.teleport(A, n.X+1.5, n.Z+1) // the townsfolk come to life near players
		h.teleport(B, n.X+2.5, n.Z+2)
		id := a.npcEntityID(h, n.Index)
		if id == 0 {
			t.Fatalf("%s of %s never appeared", n.Name, n.Town)
		}
		h.standByNPC(A, n.Index)
		var ap movement.Vec3
		h.do(func() { ap = h.srv.byChar[A].ent.Move.Pos })
		h.teleport(B, ap.X+1.5, ap.Z+1)
		a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(id), Action: ActionTalk})
	}
	signal := func(sig quests.Signal) {
		h.do(func() { h.srv.questsAdvance(h.srv.byChar[A], &sig) })
	}

	// ---- Act I: the keeper, the Last Keeper's stone, the first fork ----
	talk(p.Keeper)
	waitStory(t, h, A, 1, 1, both...)
	waitStory(t, h, B, 1, 1, both...) // shared: B stood beside A
	// Playtest 2 co-op: B talks to the keeper too (nothing left to do with
	// him now): no side quest card pops up ("The Lodestone's Hum" is this
	// story told again, and the keeper keeps to the story he still needs).
	if id := b.npcEntityID(h, p.Keeper.Index); id != 0 {
		b.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(id), Action: ActionTalk})
		b.pump(400 * time.Millisecond)
		if offers := b.eventsOf(EventQuestOffer); len(offers) != 0 {
			t.Fatalf("the keeper offered a side quest during the story: %s", offers[0].Data)
		}
	}
	if tp, ok := h.srv.tabletPos(p.Tablet.Site); !ok || math.Hypot(tp.X-p.Tablet.X, tp.Z-p.Tablet.Z) > 0.01 {
		t.Fatalf("the stone's marker (%.1f, %.1f) is not on the stone %+v", p.Tablet.X, p.Tablet.Z, tp)
	}
	near(p.Tablet.X, p.Tablet.Z+8)
	signal(quests.Signal{Kind: quests.ObjRead, Site: p.Tablet.Site})
	waitStory(t, h, B, 1, 2, both...)
	// A real attunement on the tower top.
	h.do(func() {
		tw, _ := h.srv.cfg.Explore.TowerOfSite(p.Forks[0].Site)
		top := movement.Vec3{X: tw.Shape.CX, Y: tw.Shape.TopY + 0.05, Z: tw.Shape.CZ}
		h.srv.Teleport(ea, top)
		h.srv.Teleport(eb, movement.Vec3{X: top.X + 1, Y: top.Y, Z: top.Z})
	})
	a.pump(150 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractSite, TargetID: uint64(p.Forks[0].Site), Action: 2})
	waitStory(t, h, A, 1, 3, both...)
	waitStory(t, h, B, 1, 3, both...)
	talk(p.Keeper)
	if in := b.take(EventStoryIntro, 3*time.Second); in.Value != 2 {
		t.Fatalf("act 2 intro %+v", in)
	}
	if h.has(A, story.ItemFork) != 1 || h.has(B, story.ItemFork) != 1 {
		t.Fatal("the keeper's fork was not handed to both")
	}

	// ---- Act II: the gate (level 6: Act I's rewards may already be enough), three forks ----
	// A grows to level 24 here; B keeps its own pace and passes the later
	// gates beside A.
	h.do(func() { h.srv.devSetXP(h.srv.byChar[A], explore.XPForLevel(24)) })
	h.do(func() { h.srv.byChar[A].quests.recheck = true })
	waitStory(t, h, A, 2, 1, both...)
	waitStory(t, h, B, 2, 1, both...)
	var lvA, lvB int
	h.do(func() { lvA, lvB = h.srv.storyLevel(h.srv.byChar[A]), h.srv.storyLevel(h.srv.byChar[B]) })
	t.Logf("levels after Act I: A %d (dev XP), B %d", lvA, lvB)
	if lvA < 23 {
		t.Fatalf("level A %d", lvA)
	}
	for i := 1; i <= 3; i++ {
		near(p.Forks[i].X+30, p.Forks[i].Z)
		h.do(func() { h.srv.contentAttuned(h.srv.byChar[A], p.Forks[i].Site) })
		waitStory(t, h, B, 2, i+1, both...)
	}
	talk(p.Keeper)
	waitStory(t, h, A, 3, 1, both...) // Act III's gate (8) opens at once for A, and for B beside A
	waitStory(t, h, B, 3, 1, both...)

	// ---- Act III: two vaults; B wanders off before the second and catches up ----
	near(p.Vaults[0].X+20, p.Vaults[0].Z)
	signal(quests.Signal{Kind: quests.ObjDungeon, Site: p.Vaults[0].Site})
	waitStory(t, h, B, 3, 2, both...)
	h.teleport(B, p.HomeX, p.HomeZ+900)
	h.teleport(A, p.Vaults[1].X+20, p.Vaults[1].Z)
	signal(quests.Signal{Kind: quests.ObjDungeon, Site: p.Vaults[1].Site})
	waitStory(t, h, A, 3, 3, both...)
	if act, step := h.storyAt(B); act != 3 || step != 2 {
		t.Fatalf("B far away advanced: %d %d", act, step)
	}
	h.teleport(A, p.Keeper.X+1.5, p.Keeper.Z+1)
	kid := a.npcEntityID(h, p.Keeper.Index)
	h.standByNPC(A, p.Keeper.Index)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(kid), Action: ActionTalk})
	waitStory(t, h, A, 4, 1, both...)
	if h.has(B, story.ItemVerseDusk) != 0 || h.has(A, story.ItemVerseDusk) != 1 {
		t.Fatal("verses")
	}
	// B's party event says B is behind; catch up.
	deadline := time.Now().Add(4 * time.Second)
	for {
		var msg string
		h.do(func() { msg = h.srv.sty.partyMsg[eb.ID] })
		if strings.Contains(msg, `"behind":true`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("B not told it is behind: %s", msg)
		}
		b.pump(50 * time.Millisecond)
	}
	b.send(&proto.Interact{TargetKind: InteractStory, Action: StoryActCatchUp})
	waitStory(t, h, B, 4, 1, both...)
	b.pump(150 * time.Millisecond)
	if h.has(B, story.ItemVerseDusk) != 1 || h.has(B, story.ItemVerseDawn) != 1 {
		t.Fatal("the catch-up did not hand over the verses")
	}
	var bActs int
	h.do(func() { bActs = h.srv.byChar[B].cnt.st.Stat("acts") })
	if bActs != 3 {
		t.Fatalf("B acts %d", bActs)
	}

	// ---- Act IV: the vigil and the Starless Sovereign ----
	talk(p.Captain)
	waitStory(t, h, B, 4, 2, both...)
	talk(p.Captain) // light the beacon: the town defense begins
	waitStory(t, h, A, 4, 3, both...)
	waitStory(t, h, B, 4, 3, both...)
	var defenseOn bool
	h.do(func() { defenseOn = h.srv.sty.vigil != nil && h.srv.night.defs[p.Vigil.Site] != nil })
	if !defenseOn {
		t.Fatal("the vigil did not start a town defense")
	}
	h.do(func() { h.srv.devStory(h.srv.byChar[A], DevStoryVigil, 0) }) // the waves broken
	waitStory(t, h, A, 4, 4, both...)
	waitStory(t, h, B, 4, 4, both...)
	var sov *combat.Enemy
	h.do(func() { sov = h.srv.sty.vigil.sovereign.Members[0] })
	if sov.Demon == nil || sov.Def.Key != "starless_sovereign" || sov.Name != "The Starless Sovereign" {
		t.Fatalf("sovereign %+v", sov.Def.Key)
	}
	// Playtest 2 co-op: it comes out within its aggro of the defenders.
	var nearest float64 = math.Inf(1)
	h.do(func() {
		for _, e := range []*Entity{ea, eb} {
			nearest = math.Min(nearest, math.Hypot(e.Move.Pos.X-sov.Pos.X, e.Move.Pos.Z-sov.Pos.Z))
		}
	})
	if nearest > sov.Def.Aggro {
		t.Fatalf("the Sovereign walked out %.0f m from the nearest defender (aggro %.0f)", nearest, sov.Def.Aggro)
	}
	h.do(func() { h.srv.cbt.w.Slay(sov, ea.ID) })
	waitStory(t, h, B, 4, 5, both...)
	talk(p.Captain)
	waitStory(t, h, A, 5, 1, both...)
	waitStory(t, h, B, 5, 1, both...) // Act V's gate (18) opened for B beside A
	h.do(func() { lvB = h.srv.storyLevel(h.srv.byChar[B]) })
	t.Logf("B is level %d at Act V", lvB)

	// ---- Act V: the master smith, the sanctum's lens, the Dawnheart ----
	talk(p.Smith)
	waitStory(t, h, B, 5, 2, both...)
	near(p.Sanctum.X+6, p.Sanctum.Z+6)
	if !p.SanctumBoss {
		t.Fatal("the official world's sanctum should have a guardian")
	}
	// Playtest 2 co-op: the packs around it falling is not the guardian.
	deadline = time.Now().Add(6 * time.Second)
	for adds := false; !adds && time.Now().Before(deadline); {
		h.do(func() {
			for _, g := range h.srv.cbt.w.Groups {
				if g.Kind != combat.GroupBoss && g.Spawned && math.Hypot(g.Anchor.X-p.Sanctum.X, g.Anchor.Z-p.Sanctum.Z) < 60 {
					for _, m := range g.Members {
						h.srv.cbt.w.Slay(m, ea.ID)
						adds = true
					}
				}
			}
		})
		a.pump(100 * time.Millisecond)
	}
	a.pump(500 * time.Millisecond)
	if _, st := h.storyAt(A); st != 2 {
		t.Fatalf("the lens step finished without its guardian (step %d)", st)
	}
	deadline = time.Now().Add(6 * time.Second)
	for slain := false; !slain; {
		h.do(func() {
			for _, g := range h.srv.cbt.w.Groups {
				if g.Site == p.Sanctum.Site && g.Spawned {
					for _, m := range g.Members {
						h.srv.cbt.w.Slay(m, ea.ID)
						slain = true
					}
				}
			}
		})
		if time.Now().After(deadline) {
			t.Fatal("the sanctum's guardian never spawned")
		}
		a.pump(100 * time.Millisecond)
	}
	waitStory(t, h, A, 5, 3, both...)
	waitStory(t, h, B, 5, 3, both...)
	if h.has(B, story.ItemLens) != 1 {
		t.Fatal("B has no lens")
	}
	talk(p.Smith)
	waitStory(t, h, A, 6, 1, both...)
	waitStory(t, h, B, 6, 1, both...)
	if h.has(A, story.ItemLens) != 0 || h.has(A, story.ItemDawnheart) != 1 || h.has(B, story.ItemDawnheart) != 1 {
		t.Fatal("the Dawnheart")
	}

	// ---- Act VI: the last fork, the Heartfall, the Hush ----
	near(p.LastFork.X+30, p.LastFork.Z)
	h.do(func() { h.srv.contentAttuned(h.srv.byChar[A], p.LastFork.Site) })
	waitStory(t, h, B, 6, 2, both...)
	hf := p.Heartfall
	near(hf.X+8, hf.Z) // the reach step (2 Hz) and the arming
	waitStory(t, h, A, 6, 3, both...)
	waitStory(t, h, B, 6, 3, both...)
	intro := b.take(EventFinaleIntro, 4*time.Second)
	if !strings.Contains(string(intro.Data), "The Hush") || intro.Value != int32(finaleIntroS*1000) {
		t.Fatalf("intro %s", intro.Data)
	}
	var r *finaleRun
	h.do(func() { r = h.srv.sty.fin.run })
	if r == nil || r.hush.Name != "The Hush" || r.level < lvA+1 || r.hard {
		t.Fatalf("finale run %+v", r)
	}
	// Skip the intro's wait; both engage: the Hush scales for two.
	base := 0.0
	h.do(func() {
		r.introUntil = h.srv.tick
		r.hush.HeldUntil = 0
		base = r.hush.HPMax
		w := h.srv.cbt.w
		w.ApplyDevDamage(r.hush, ea.ID, 1)
		w.ApplyDevDamage(r.hush, eb.ID, 1)
		w.Hold(r.hush, 600) // it stands still for the checks below
	})
	if math.Abs(r.hush.HPMax-base*1.75) > 1 || r.hush.ScaleN() != 2 {
		t.Fatalf("scaled %v -> %v (n %d)", base, r.hush.HPMax, r.hush.ScaleN())
	}
	// The shroud: ordinary hits do nothing, sunsteel / Light breaks it.
	h.do(func() { r.nextShroud = h.srv.tick })
	a.pump(200 * time.Millisecond)
	var hp0, shroud float64
	var blocked, depleted float64
	var afterOne float64
	h.do(func() {
		hp0, shroud = r.hush.HP, r.shroud
		blocked = h.srv.finaleGuard(r.hush, ea.ID, 200, false)
		// Playtest 2 co-op: a count of sunsteel / Light hits, not 8 % of a
		// level- and party-scaled health pool (12 for two in the arena).
		depleted = h.srv.finaleGuard(r.hush, ea.ID, 1e6, true)
		afterOne = r.shroud
		for i := 0; i < 20 && r.shroud > 0; i++ {
			depleted += h.srv.finaleGuard(r.hush, ea.ID, 50, true)
		}
	})
	if shroud != finaleShroudHits(2, false) || afterOne != shroud-1 {
		t.Fatalf("shroud %v hits, %v left after one huge hit", shroud, afterOne)
	}
	if shroud <= 0 || blocked != 0 || depleted != 0 || r.shroud != 0 || r.hush.HP != hp0 {
		t.Fatalf("shroud %v blocked %v depleted %v left %v", shroud, blocked, depleted, r.shroud)
	}
	var shrouds int
	h.do(func() { shrouds = h.srv.byChar[A].cnt.st.Stat("shrouds") })
	if shrouds != 1 {
		t.Fatal("the shroud breaker's counter")
	}
	clearAdds := func() {
		h.do(func() {
			for _, m := range r.g.Members {
				if m != r.hush && m.Alive() {
					h.srv.cbt.w.Despawn(m)
				}
			}
		})
	}
	// Phase 2: the choir. Three bells for two players; the Hush is untouchable.
	h.do(func() { h.srv.devStory(h.srv.byChar[A], DevStoryHush, 69) })
	a.pump(200 * time.Millisecond)
	clearAdds()
	var bells int
	var choir float64
	h.do(func() {
		for _, g := range r.bells {
			bells += len(g.Members)
		}
		choir = h.srv.finaleGuard(r.hush, ea.ID, 100, true)
	})
	if bells != 3 || choir != 0 {
		t.Fatalf("bells %d choir %v", bells, choir)
	}
	h.do(func() {
		for _, g := range r.bells {
			for _, m := range g.Members {
				if m.Demon == nil {
					t.Error("a bell is not an Unsung thing")
				}
				h.srv.cbt.w.Slay(m, eb.ID)
			}
		}
	})
	a.pump(200 * time.Millisecond)
	var stagger float64
	h.do(func() { stagger = h.srv.finaleGuard(r.hush, ea.ID, 100, false) })
	if len(r.bells) != 0 || stagger != 200 {
		t.Fatalf("after the bells: %d left, a hit deals %v", len(r.bells), stagger)
	}
	// Phase 3: the endless night. One well each: spared.
	h.do(func() { h.srv.devStory(h.srv.byChar[A], DevStoryHush, 34) })
	a.pump(200 * time.Millisecond)
	clearAdds()
	night := func(sameWell bool) (hurtA, hurtB bool) {
		h.do(func() {
			r.nextNight, r.nightAt = h.srv.tick, 0
			r.shroud, r.nextShroud = 0, h.srv.tick+9000
			h.srv.cbt.w.Hold(r.hush, 600)
		})
		deadline := time.Now().Add(3 * time.Second)
		for len(r.wells) == 0 {
			if time.Now().After(deadline) {
				t.Fatalf("no wells: phase %d (boss %d) nightAt %d next %d tick %d hp %.2f", r.phase, r.hush.Boss.Phase, r.nightAt, r.nextNight, h.srv.tick, r.hush.HP/r.hush.HPMax)
			}
			a.pump(50 * time.Millisecond)
		}
		var wa, wb [2]float64
		var ha, hb float64
		h.do(func() {
			wa, wb = r.wells[0], r.wells[1]
			if sameWell {
				wb = wa
			}
			h.srv.Teleport(ea, movement.Vec3{X: wa[0], Y: h.srv.cfg.Ground.HeightAt(wa[0], wa[1]) + 0.05, Z: wa[1]})
			h.srv.Teleport(eb, movement.Vec3{X: wb[0] + 0.5, Y: h.srv.cfg.Ground.HeightAt(wb[0], wb[1]) + 0.05, Z: wb[1]})
			for _, e := range []*Entity{ea, eb} {
				e.cbt.HP = e.cbt.HPMax
			}
			ha, hb = ea.cbt.HP, eb.cbt.HP
			r.nightAt = h.srv.tick + 2
		})
		a.pump(400 * time.Millisecond)
		h.do(func() { hurtA, hurtB = ea.cbt.HP < ha, eb.cbt.HP < hb })
		return
	}
	if ha, hb := night(false); ha || hb {
		t.Fatalf("one well each, yet hurt: %v %v", ha, hb)
	}
	if ha, hb := night(true); !ha || !hb {
		t.Fatalf("two in one well, spared: %v %v", ha, hb)
	}
	// A revive: B goes down beside A, A holds E for 3 s.
	h.do(func() {
		h.srv.Teleport(eb, movement.Vec3{X: ea.Move.Pos.X + 1.5, Y: ea.Move.Pos.Y, Z: ea.Move.Pos.Z})
		ea.cbt.HP = ea.cbt.HPMax
		h.srv.cbt.w.HurtPlayerBy(eb.ID, r.hush, "hush_night", 1e6)
	})
	if w := b.take(EventReviveWindow, 3*time.Second); w.EntityID != eb.ID || w.Value != reviveWindowS*1000 {
		t.Fatalf("revive window %+v", w)
	}
	if w := a.take(EventReviveWindow, 3*time.Second); w.EntityID != eb.ID {
		t.Fatalf("helper's revive window %+v", w)
	}
	a.send(&proto.Interact{TargetKind: InteractStory, TargetID: uint64(eb.ID), Action: StoryActRevive, Arg: 1})
	if pr := a.take(EventReviveProgress, 2*time.Second); pr.Value != reviveHoldS*1000 || pr.TargetID != eb.ID {
		t.Fatalf("progress %+v", pr)
	}
	rv := b.take(EventRevived, 6*time.Second)
	var downed bool
	var bhp, bmax float64
	h.do(func() { downed, bhp, bmax = eb.cbt.Downed, eb.cbt.HP, eb.cbt.HPMax })
	if rv.TargetID != ea.ID || downed || bhp != math.Round(bmax*reviveHealth) {
		t.Fatalf("revived %+v downed %v hp %v/%v", rv, downed, bhp, bmax)
	}
	// Victory.
	h.do(func() { h.srv.devStory(h.srv.byChar[A], DevStoryWin, 0) })
	for _, c := range both {
		end := c.take(EventStoryEnding, 4*time.Second)
		var ending struct {
			Lines    []string `json:"lines"`
			Together bool     `json:"together"`
			Names    []string `json:"names"`
			First    bool     `json:"first"`
		}
		if err := json.Unmarshal(end.Data, &ending); err != nil || !ending.Together || !ending.First || len(ending.Names) != 2 || len(ending.Lines) < 5 {
			t.Fatalf("ending %s", end.Data)
		}
		if done := c.takeFor(EventQuestCompleted, story.ID(6), 3*time.Second); done == nil {
			t.Fatal("act 6 not completed")
		}
	}
	t.Logf("ending: %s", strings.Join(endingLines([]string{"Nicole", "Friend"}, true, false), " / "))
	a.pump(1200 * time.Millisecond) // achievements are checked at most once a second
	for _, c := range []string{A, B} {
		h.do(func() {
			st := h.srv.byChar[c].cnt.st
			if st.Stat("finale") != 1 || st.Stat("finaleparty") != 1 || st.Stat("acts") != 6 {
				t.Errorf("%s stats %v", c, st.Stats)
			}
			for _, k := range []string{"last_song", "dawn_together", "song_vigil"} {
				if !st.Has(k) {
					t.Errorf("%s lacks %s", c, k)
				}
			}
			if c == A && !st.Has("not_today") {
				t.Error("A revived B: not_today")
			}
		})
	}
	if a, s := h.storyAt(A); a != story.Acts+1 || s != 0 {
		t.Fatalf("after the ending: %d %d", a, s)
	}
	// Post-game: calmer nights; the Starless Vow makes them crueller and the Hush harder.
	var calm, cruel int
	h.do(func() { calm = h.srv.storyHunters(ea, 10) })
	a.send(&proto.Interact{TargetKind: InteractStory, Action: StoryActVow, Arg: 1})
	a.pump(200 * time.Millisecond)
	h.do(func() { cruel = h.srv.storyHunters(ea, 10) })
	if calm != 6 || cruel != 15 {
		t.Fatalf("hunters calm %d vow %d", calm, cruel)
	}
	b.send(&proto.Interact{TargetKind: InteractStory, Action: StoryActVow, Arg: 0})
	// The rematch under the vow: a harder Hush.
	h.do(func() {
		h.srv.sty.fin.rearmAt = 0
		h.srv.finaleArm([]*session{h.srv.byChar[A]})
		r = h.srv.sty.fin.run
	})
	if r == nil || !r.hard || r.level < lvA+5 {
		t.Fatalf("rematch %+v", r)
	}
	h.do(func() { h.srv.finaleReset("test") })

	// Saved: A comes back to a beaten game.
	a.c.Close(1000, "")
	time.Sleep(300 * time.Millisecond)
	a2 := h.dial("")
	a2.join(h, A, "Nicole")
	sync := a2.take(EventStorySync, 4*time.Second)
	var sy struct {
		Act    int  `json:"act"`
		Beaten int  `json:"beaten"`
		Vow    bool `json:"vow"`
	}
	if err := json.Unmarshal(sync.Data, &sy); err != nil || sy.Act != story.Acts+1 || sy.Beaten != 1 || !sy.Vow {
		t.Fatalf("sync after a reconnect %s", sync.Data)
	}
	l := quests.Load(store.logs[A])
	for n := 1; n <= story.Acts; n++ {
		if !l.IsDone(story.Key(n)) {
			t.Fatalf("saved log lacks act %d", n)
		}
	}
}
