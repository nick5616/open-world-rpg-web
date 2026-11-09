package game

// Playtest 2 ("Questing is bugged"; "it says mine ore but you have no
// pickaxe"): the starter quest played with the real actions instead of
// test hooks for the ore and the blade. On the official world every
// sunsteel seam is a single vein ~140 m down at the bottom of a sunlit
// shaft, which used to give 2-3 ore (the step needs 4) and then stayed
// mined for 6-24 h, so the Ward could not be finished. Here a new character
// has a pickaxe, the step says where (and how deep) the seam is, one vein
// gives a blade's worth, the ore is smelted and the blade forged at the
// town forge, and the quest moves on at each step.

import (
	"context"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
)

func TestWardPlayableMineSmeltForge(t *testing.T) {
	w, g := testTowns(t)
	ex := realExplore(t, g)
	store := &questStore{fakeStore: fakeStore{saves: map[string]movement.Vec3{}, rows: map[string]movement.Vec3{}}, logs: map[string][]byte{}}
	q := writebehind.New(100)
	q.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	qctx, stopQ := context.WithCancel(context.Background())
	defer stopQ()
	go q.Run(qctx)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Explore = ex
		c.Store = store
		c.Queue = q
		c.TimeOffsetS = offsetFor(12)
	})
	si := spawnSettlement(t, w)
	smith := npcOf(w, si, towns.RoleBlacksmith)
	sd := w.T.NPCs[smith]
	const char = "22222222-3333-4444-5555-666666666666"
	sx, sz := sd.WorkX+1.5*math.Cos(sd.WorkYaw), sd.WorkZ+1.5*math.Sin(sd.WorkYaw)
	store.rows[char] = movement.Vec3{X: sx, Y: g.HeightAt(sx, sz) + 0.3, Z: sz}

	a := h.dial("")
	a.join(h, char, "Miner")
	a.take(EventQuestStarted, 3*time.Second)
	if findItem(a.inventory(t), "tool:pickaxe") == nil {
		t.Fatal("a new character has no pickaxe (the Ward's second step is mining)")
	}

	// 1. The blacksmith.
	sid := a.npcEntityID(h, smith)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(sid), Action: ActionTalk})
	if s := a.take(EventQuestStep, 3*time.Second); s.Value != 1 {
		t.Fatalf("talk step %+v", s)
	}
	ward := a.questLog(t).find(quests.WardID)
	t.Logf("step: %s\nnote: %s\nmarkers: %+v", ward.Text, ward.Note, ward.Markers)
	if !strings.Contains(ward.Text, "pickaxe") || !strings.Contains(ward.Note, "pickaxe") || !strings.Contains(ward.Note, " m down") {
		t.Fatalf("the ore step should say how to mine and how deep: %q / %q", ward.Text, ward.Note)
	}
	if len(ward.Markers) < 3 || !strings.HasPrefix(ward.Markers[2].Label, "Sunlit shaft") {
		t.Fatalf("ore markers should include the sunlit shaft: %+v", ward.Markers)
	}

	// 2. Mine the marked seam for real: stand in front of the vein, swing.
	ore := ward.Markers[0]
	var v caves.Vein
	var stand movement.Vec3
	_ = h.srv.Do(context.Background(), func() {
		cg := h.srv.caves().CaveGraph()
		for _, c := range cg.Veins {
			if isSunsteel(c) && math.Hypot(c.X-ore.X, c.Z-ore.Z) <= ore.R {
				v = c
			}
		}
	})
	if v.ID == 0 {
		t.Fatal("no sunsteel vein inside the ore marker")
	}
	ct := g.(townGround).CaveTerrain
	stand = veinStand(t, ct, v)
	_ = h.srv.Do(context.Background(), func() { h.srv.Teleport(h.srv.byChar[char].ent, stand) })
	a.pump(300 * time.Millisecond)
	for i := 0; i < 40 && len(a.eventsOf(EventVeinBreak)) == 0; i++ {
		a.send(&proto.Interact{TargetKind: InteractVein, TargetID: v.ID, Action: ActionUse})
		a.pump(300 * time.Millisecond)
	}
	if len(a.eventsOf(EventVeinBreak)) != 1 {
		t.Fatalf("the seam's vein never broke; refusals %v", a.eventsOf(EventMineRefused))
	}
	drop := a.eventsOf(EventDropSpawned)
	if len(drop) != 1 || string(drop[0].Data) != "ore:sunsteel" || drop[0].Value < 4 {
		t.Fatalf("one sunsteel vein must give a blade's worth (4 ore): %+v", drop)
	}
	// Auto-pickup next to the vein; the quest moves on to the blueprint.
	if s := a.take(EventQuestStep, 5*time.Second); s.Value != 2 {
		t.Fatalf("ore step %+v", s)
	}
	var respawn time.Duration
	_ = h.srv.Do(context.Background(), func() {
		st := h.srv.mine.veins[v.ID]
		respawn = st.respawnAt.Sub(st.minedAt)
	})
	if respawn > sunsteelRespawnMax || respawn < sunsteelRespawnMin {
		t.Fatalf("sunsteel vein respawns after %v (want %v-%v)", respawn, sunsteelRespawnMin, sunsteelRespawnMax)
	}

	// 3. Back to town: the blueprint (the smith's 25 + the 20 starter gold).
	_ = h.srv.Do(context.Background(), func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: sx, Y: g.HeightAt(sx, sz), Z: sz})
	})
	a.pump(300 * time.Millisecond)
	idx := -1
	for i, it := range npc.SmithWares() {
		if it.Item == "blueprint:sunsteel_blade" {
			idx = i
		}
	}
	sid = a.npcEntityID(h, smith)
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(sid), Action: ActionBuy, Arg: uint32(idx)})
	if s := a.take(EventQuestStep, 3*time.Second); s.Value != 3 {
		t.Fatalf("blueprint step %+v (refusals %v %v)", s, a.eventsOf(EventTownRefused), a.eventsOf(EventItemRefused))
	}

	// 4. The forge: open it, smelt twice, forge the blade.
	forge := propOf(w, si, towns.PropForge)
	bd := w.T.Buildings[forge.Building]
	dx, dz := bd.X-forge.X, bd.Z-forge.Z
	l := math.Hypot(dx, dz)
	fx, fz := forge.X+dx/l*1.3, forge.Z+dz/l*1.3
	_ = h.srv.Do(context.Background(), func() {
		h.srv.Teleport(h.srv.byChar[char].ent, movement.Vec3{X: fx, Y: g.HeightAt(fx, fz), Z: fz})
	})
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractStation, TargetID: forge.ID, Action: 1})
	a.nextEvent(EventStationOpened, 3*time.Second)
	smelt, blade := items.D.Recipe("smelt_sunsteel"), items.D.Recipe("forge_sunsteel_blade")
	a.interact(InteractCraft, 0, CraftActCraft, uint32(smelt.ID))
	a.interact(InteractCraft, 0, CraftActCraft, uint32(smelt.ID))
	a.interact(InteractCraft, 0, CraftActCraft, uint32(blade.ID))
	if s := a.take(EventQuestStep, 5*time.Second); s.Value != 4 {
		t.Fatalf("forge step %+v (crafted %d, refusals %v)", s, len(a.eventsOf(EventCrafted)), a.eventsOf(EventItemRefused))
	}
	if findItem(a.inventory(t), "weapon:sunsteel_blade") == nil {
		t.Fatal("no blade")
	}
}
