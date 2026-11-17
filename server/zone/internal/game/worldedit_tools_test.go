package game

// CR 040: the tools and the dirt economy (items system on).

import (
	"context"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/items"
)

func TestStarterWorkTools(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(640, 600))
	const char = "tools-new"
	a.join(h, char, "Handy")
	inv := a.inventory(t)
	if findItem(inv, "tool:axe") == nil || findItem(inv, "tool:shovel") == nil {
		t.Fatal("a new character starts without an axe and a shovel")
	}
	count := func(base string) (n int) {
		_ = h.srv.Do(context.Background(), func() { n = h.srv.byChar[char].items.inv.Count(base) })
		return
	}
	// An older character (kit granted before world edits): the missing tool, once, never doubled.
	_ = h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		var d items.Delta
		sess.items.inv.Spend("tool:axe", 1, &d)
		delete(sess.items.markers, starterWorkToolsMarker)
		h.srv.topUpStarter(sess)
	})
	if count("tool:axe") != 1 || count("tool:shovel") != 1 {
		t.Fatalf("older character: %d axes, %d shovels", count("tool:axe"), count("tool:shovel"))
	}
	_ = h.srv.Do(context.Background(), func() { h.srv.topUpStarter(h.srv.byChar[char]) })
	if count("tool:axe") != 1 || count("tool:shovel") != 1 {
		t.Fatal("tools granted twice")
	}
}

func TestToolsAndDirtEconomy(t *testing.T) {
	tr := testTerrain(t)
	rec, gy := treeNear(t, tr)
	px, pz := rec.X+4.5, rec.Z+0.5
	gy = tr.HeightAt(px, pz)
	h, _, _ := startEdits(t, tr, &memEdits{rows: map[int64]StoredEdit{}}, &memTerrain{blocks: map[[2]int32][]byte{}}, 1, false)
	a := h.dial(spawnXYZ(px-1.2, gy+0.2, pz))
	const char = "economist"
	a.join(h, char, "Econ")
	a.pump(400 * time.Millisecond)
	count := func(base string) (n int) {
		_ = h.srv.Do(context.Background(), func() { n = h.srv.byChar[char].items.inv.Count(base) })
		return
	}
	spend := func(base string) {
		_ = h.srv.Do(context.Background(), func() {
			var d items.Delta
			ci := h.srv.byChar[char].items
			ci.inv.Spend(base, ci.inv.Count(base), &d)
		})
	}
	target := uint64(uint32(math.Round(px*100))) | uint64(uint32(math.Round(pz*100)))<<32
	// No shovel: refused. No axe: a tree is refused too.
	spend("tool:shovel")
	spend("tool:axe")
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target, Action: 1})
	a.pump(250 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractHarvest, TargetID: rec.ID, Action: ActionUse})
	a.pump(250 * time.Millisecond)
	if r := a.eventsOf(EventEarthRefused); len(r) != 1 || r[0].Value != EarthNeedTool {
		t.Fatalf("dig without a shovel: %v", r)
	}
	if r := a.eventsOf(EventHarvestRefused); len(r) != 1 || r[0].Value != HarvestNeedTool || string(r[0].Data[8:]) != "tool:axe" {
		t.Fatalf("chop without an axe: %v", r)
	}
	// Give the shovel back through the starter path; digging pays dirt (batched, then granted).
	_ = h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		delete(sess.items.markers, starterWorkToolsMarker)
		h.srv.topUpStarter(sess)
	})
	if count("earth:dirt") != 0 {
		t.Fatal("started with dirt")
	}
	for i := 0; i < 8; i++ {
		a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target, Action: 1})
		a.pump(230 * time.Millisecond)
	}
	a.pump(1800 * time.Millisecond) // the batched grant lands
	dirt := count("earth:dirt") + count("stone:block")
	if dirt < 6 || len(a.eventsOf(EventEarthGrant)) == 0 {
		t.Fatalf("digging paid %d dirt+stone, grants %d", dirt, len(a.eventsOf(EventEarthGrant)))
	}
	// Filling spends it; with none left it is refused.
	before := count("earth:dirt") + count("stone:block")
	for i := 0; i < 3; i++ {
		a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target, Action: 2})
		a.pump(230 * time.Millisecond)
	}
	a.pump(1800 * time.Millisecond)
	if after := count("earth:dirt") + count("stone:block"); after >= before {
		t.Fatalf("filling did not cost dirt: %d -> %d", before, after)
	}
	spend("earth:dirt")
	spend("stone:block")
	a.pump(1800 * time.Millisecond)
	n := len(a.eventsOf(EventEarthRefused))
	a.send(&proto.Interact{TargetKind: InteractEarth, TargetID: target, Action: 2})
	a.pump(250 * time.Millisecond)
	if r := a.eventsOf(EventEarthRefused); len(r) != n+1 || r[n].Value != EarthNoDirt {
		t.Fatalf("fill with an empty bag: %v", r)
	}
}
