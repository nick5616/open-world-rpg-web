package game

// Playtest 2 ground loot (loot_ground.go): kill and container loot land on
// the ground as personal pickups; walking over takes gold (and common
// materials with the auto-collect setting), E takes the rest; dropped items
// are public and race-safe; inventory full stays quiet.

import (
	"context"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
)

type dropView struct {
	id    uint32
	item  *items.Item
	pos   movement.Vec3
	ready time.Time
}

// drops lists the pickups owned by entity owner (0 = public), read on the tick goroutine.
func drops(t *testing.T, h *harness, owner uint32) []dropView {
	t.Helper()
	var out []dropView
	if err := h.srv.Do(context.Background(), func() {
		for _, e := range h.srv.ents {
			if e.Kind == proto.EntityKindPickup && e.drop != nil && e.Owner == owner {
				out = append(out, dropView{id: e.ID, item: e.drop.item.Clone(), pos: e.Move.Pos, ready: e.drop.readyAt})
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func ownDrops(t *testing.T, h *harness, owner uint32) []*items.Item {
	t.Helper()
	var out []*items.Item
	for _, d := range drops(t, h, owner) {
		out = append(out, d.item)
	}
	return out
}

// dropAt puts a personal pickup (owner) at (x, z), ready to collect at once.
func dropAt(t *testing.T, h *harness, owner uint32, it *items.Item, x, z float64, key string) uint32 {
	t.Helper()
	var id uint32
	_ = h.srv.Do(context.Background(), func() {
		now := h.srv.cfg.Now()
		p := h.srv.spawnDrop(owner, it, h.srv.groundSpot(x, z, 0), &itemDrop{key: key, source: SourceKill}, now.Add(10*time.Minute))
		id = p.ID
	})
	return id
}

func pickupGone(t *testing.T, h *harness, id uint32) bool {
	t.Helper()
	gone := true
	_ = h.srv.Do(context.Background(), func() { gone = h.srv.entityByID(id) == nil })
	return gone
}

func rare(it *items.Item, r int) *items.Item { it.Rarity = r; return it }

func TestAutoCollectRules(t *testing.T) {
	d := func(base string, rarity, source int, world bool) *itemDrop {
		return &itemDrop{item: rare(items.Stack(base, 1), rarity), source: source, world: world}
	}
	cases := []struct {
		name string
		d    *itemDrop
		auto bool
		want bool
	}{
		{"external granter", nil, false, true},
		{"vein ore, setting off", d("ore:iron", 0, SourceVein, false), false, true},
		{"gold, setting off", d("currency:gold", 0, SourceKill, false), false, true},
		{"gold, public drop", d("currency:gold", 0, SourceDropped, true), true, false},
		{"common meat, setting off", d("meat:raw", 0, SourceKill, false), false, false},
		{"common meat, setting on", d("meat:raw", 0, SourceKill, false), true, true},
		{"uncommon herb", d("herb:heartleaf", 1, SourceContainer, false), true, true},
		{"rare herb", d("herb:heartleaf", 2, SourceKill, false), true, false},
		{"common potion", d("potion:health", 0, SourceKill, false), true, true},
		{"common gem", d("gem:ruby:rough", 0, SourceKill, false), true, true},
		{"common sword", d("weapon:copper_sword", 0, SourceKill, false), true, false},
		{"common armor", d("armor:leather_cap", 0, SourceKill, false), true, false},
		{"tome", d("tome:ember_flick", 0, SourceKill, false), true, false},
		{"blueprint", d("blueprint:sunsteel_blade", 0, SourceKill, false), true, false},
		{"instrument (tool)", d("instrument:lute", 0, SourceKill, false), true, false},
	}
	for _, c := range cases {
		if c.d != nil && c.d.item.Def() == nil {
			t.Fatalf("%s: unknown item %s (renamed?)", c.name, c.d.item.Base)
		}
		if got := autoCollects(c.d, c.auto); got != c.want {
			t.Errorf("%s: autoCollects = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestScatterOffsetSpreadsDrops(t *testing.T) {
	for _, around := range []bool{true, false} {
		var pts [][2]float64
		for i := 0; i < 8; i++ {
			dx, dz := scatterOffset(i, 8, 12345, 1.1, 1.9, math.Pi/2, around)
			r := math.Hypot(dx, dz)
			if r < 1.1-1e-9 || r > 1.9+1e-9 {
				t.Fatalf("around=%v: drop %d at radius %.2f", around, i, r)
			}
			if !around && dz < -0.6 { // the opener is toward +Z: nothing far behind the chest
				t.Fatalf("chest drop %d behind the chest: (%.2f, %.2f)", i, dx, dz)
			}
			for _, p := range pts {
				if math.Hypot(p[0]-dx, p[1]-dz) < 0.25 {
					t.Fatalf("around=%v: drops on top of each other", around)
				}
			}
			pts = append(pts, [2]float64{dx, dz})
		}
	}
}

// Kill loot lands scattered around the corpse as personal pickups: the
// owner sees them, another player nearby does not.
func TestKillLootScattersAsPersonalPickups(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(800, 805))
	wa := a.join(h, "gl-a", "Alpha")
	b := h.dial(spawnAt(802, 805))
	b.join(h, "gl-b", "Beta")
	a.pump(200 * time.Millisecond)
	warden := combatdefs.D.EnemyByKey("warden")
	en := &combat.Enemy{ID: 991001, Def: warden, Level: 4, Element: combatdefs.Physical, Pos: movement.Vec3{X: 800, Y: 0, Z: 800}, Boss: &combat.BossState{}, Group: &combat.Group{ID: 91, Seed: 3}, Name: "Scatter Warden"}
	_ = h.srv.Do(context.Background(), func() {
		h.srv.lootOnKill(combat.KillInfo{Enemy: en, Eligible: []uint32{wa.EntityID}, Tick: 11})
	})
	ds := drops(t, h, wa.EntityID)
	if len(ds) < 3 {
		t.Fatalf("boss kill dropped %d pickups", len(ds))
	}
	for i, d := range ds {
		r := math.Hypot(d.pos.X-800, d.pos.Z-800)
		if r < 0.85 || r > 2.15 {
			t.Fatalf("drop %s at %.2f m from the corpse", d.item.Base, r)
		}
		if !d.ready.After(time.Now().Add(-time.Second)) {
			t.Fatalf("drop %s has no settle time", d.item.Base)
		}
		for _, o := range ds[:i] {
			if math.Hypot(o.pos.X-d.pos.X, o.pos.Z-d.pos.Z) < 0.2 {
				t.Fatal("two drops on the same spot")
			}
		}
	}
	a.pump(400 * time.Millisecond)
	b.pump(400 * time.Millisecond)
	for _, d := range ds {
		if ok, _, _ := b.seePickup(d.id); ok {
			t.Fatalf("B sees A's personal drop %s", d.item.Base)
		}
	}
	seen := 0
	for _, d := range ds {
		if ok, name, _ := a.seePickup(d.id); ok && name == d.item.Base {
			seen++
		}
	}
	if seen == 0 {
		t.Fatal("A sees none of their drops")
	}
}

// Walking over: gold always, common materials only with the setting on,
// never equipment or rare+; E takes those.
func TestWalkOverCollectRulesAndAutoLootSetting(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(600, 600))
	wa := a.join(h, "gl-walk", "Walker")
	a.pump(300 * time.Millisecond)
	gold0 := a.inventory(t).Gold
	if a.inventory(t).Auto {
		t.Fatal("auto-collect should start off until the client asks")
	}
	me := wa.EntityID
	gold := dropAt(t, h, me, items.Stack("currency:gold", 7), 600.3, 600, "t:gold")
	meat := dropAt(t, h, me, items.Stack("meat:raw", 2), 600, 600.3, "t:meat")
	herb := dropAt(t, h, me, rare(items.Stack("herb:heartleaf", 1), 1), 599.7, 600, "t:herb")
	rareHerb := dropAt(t, h, me, rare(items.Stack("herb:emberroot", 1), 2), 600, 599.7, "t:rare")
	sword := dropAt(t, h, me, items.Stack("weapon:copper_sword", 1), 600.2, 600.2, "t:sword")
	a.pump(1200 * time.Millisecond)
	if !pickupGone(t, h, gold) || a.inventory(t).Gold != gold0+7 {
		t.Fatalf("gold not auto-collected: %d -> %d", gold0, a.inventory(t).Gold)
	}
	for _, id := range []uint32{meat, herb, rareHerb, sword} {
		if pickupGone(t, h, id) {
			t.Fatalf("pickup %d auto-collected with the setting off", id)
		}
	}
	// The client turns auto-collect on (Interact 21/10): the zone echoes it.
	a.interact(InteractItem, 0, ItemActAutoLoot, 1)
	deadline := time.Now().Add(2 * time.Second)
	for !a.inventory(t).Auto {
		if time.Now().After(deadline) {
			t.Fatal("Event 400 never echoed auto=true")
		}
	}
	a.pump(1000 * time.Millisecond)
	if !pickupGone(t, h, meat) || !pickupGone(t, h, herb) {
		t.Fatal("common/uncommon materials not auto-collected with the setting on")
	}
	if pickupGone(t, h, rareHerb) || pickupGone(t, h, sword) {
		t.Fatal("rare herb or sword auto-collected: they need E")
	}
	// E takes them.
	a.interact(InteractPickup, uint64(sword), ActionUse, 0)
	a.interact(InteractPickup, uint64(rareHerb), ActionUse, 0)
	a.pump(500 * time.Millisecond)
	if !pickupGone(t, h, sword) || !pickupGone(t, h, rareHerb) {
		t.Fatal("E did not take the sword and the rare herb")
	}
	inv := a.inventory(t)
	if findItem(inv, "weapon:copper_sword") == nil || findItem(inv, "herb:emberroot") == nil || findItem(inv, "meat:raw") == nil {
		t.Fatalf("inventory lacks the taken items: %+v", inv.Items)
	}
	// Off again: the next common stays put.
	a.interact(InteractItem, 0, ItemActAutoLoot, 0)
	a.pump(300 * time.Millisecond)
	meat2 := dropAt(t, h, me, items.Stack("meat:raw", 1), 600, 600.2, "t:meat2")
	a.pump(1000 * time.Millisecond)
	if pickupGone(t, h, meat2) {
		t.Fatal("auto-collect off but the meat was taken")
	}
}

// A fresh kill drop settles before walking over takes it (the pop-out arc).
func TestFreshDropSettlesBeforeAutoCollect(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(640, 640))
	wa := a.join(h, "gl-settle", "Settler")
	a.pump(300 * time.Millisecond)
	var id uint32
	_ = h.srv.Do(context.Background(), func() {
		now := h.srv.cfg.Now()
		p := h.srv.spawnDrop(wa.EntityID, items.Stack("currency:gold", 3), h.srv.groundSpot(640.2, 640, 0), &itemDrop{key: "t:settle", source: SourceKill, readyAt: now.Add(groundSettle)}, now.Add(time.Minute))
		id = p.ID
	})
	a.pump(groundSettle / 3)
	if pickupGone(t, h, id) {
		t.Fatal("collected before it settled")
	}
	a.pump(groundSettle + 500*time.Millisecond)
	if !pickupGone(t, h, id) {
		t.Fatal("never collected after settling")
	}
}

// Containers: gold into the purse with the open, everything else on the
// ground around the chest toward the opener, personal; E takes it.
func TestContainerLootDropsOnTheGround(t *testing.T) {
	src := &fixedContainers{list: []ContainerInfo{{ID: 701, X: 702, Y: 0, Z: 700, Kind: 0, Level: 6, Element: -1}}}
	h := newHarness(t, func(c *Config) { c.Items = &ItemsSetup{Containers: src} })
	a := h.dial(spawnAt(700, 700))
	wa := a.join(h, "gl-chest", "Opener")
	b := h.dial(spawnAt(703, 701))
	b.join(h, "gl-other", "Other")
	a.pump(300 * time.Millisecond)
	gold0 := a.inventory(t).Gold
	inv0 := len(a.inventory(t).Items)
	a.interact(InteractContainer, 701, ActionUse, 0)
	a.lastEvent(EventContainerOpened, 3*time.Second)
	a.pump(200 * time.Millisecond)
	inv := a.inventory(t)
	if inv.Gold <= gold0 {
		t.Fatalf("no gold in the purse: %d -> %d", gold0, inv.Gold)
	}
	if len(inv.Items) != inv0 {
		t.Fatalf("container items went into the bag: %d -> %d", inv0, len(inv.Items))
	}
	ds := drops(t, h, wa.EntityID)
	if len(ds) == 0 {
		t.Fatal("the chest dropped nothing on the ground")
	}
	for _, d := range ds {
		if d.item.Def().Kind == "currency" {
			t.Fatal("gold on the ground")
		}
		dx, dz := d.pos.X-702, d.pos.Z-700
		r := math.Hypot(dx, dz)
		if r < 1.05 || r > 1.95 {
			t.Fatalf("drop %.2f m from the chest", r)
		}
		if dx > 0.7 { // the opener stands at -X: nothing far behind the chest
			t.Fatalf("drop behind the chest at (%.2f, %.2f)", dx, dz)
		}
	}
	b.pump(400 * time.Millisecond)
	for _, d := range ds {
		if ok, _, _ := b.seePickup(d.id); ok {
			t.Fatal("another player sees the opener's chest loot")
		}
	}
	n0 := len(a.eventsOf(EventLootGranted))
	for _, d := range ds {
		a.interact(InteractPickup, uint64(d.id), ActionUse, 0)
	}
	a.pump(600 * time.Millisecond)
	if left := drops(t, h, wa.EntityID); len(left) != 0 {
		t.Fatalf("%d drops left after E on each", len(left))
	}
	got := 0
	for _, e := range a.eventsOf(EventLootGranted)[n0:] {
		if e.TargetID == SourceContainer {
			got += int(e.Value)
		}
	}
	if got != len(ds) {
		t.Fatalf("granted %d of %d chest drops", got, len(ds))
	}
	a.interact(InteractContainer, 701, ActionUse, 0)
	if ref := a.lastEvent(EventItemRefused, 2*time.Second); ref.Value != ItemRefuseOpened {
		t.Fatalf("reopen: refusal %d", ref.Value)
	}
}

// Two players press E on the same dropped item: one gets it, the other is
// told it is gone; nothing duplicates.
func TestDroppedItemRaceOneWins(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(900, 900))
	a.join(h, "race-a", "Dropper")
	b := h.dial(spawnAt(901, 900))
	b.join(h, "race-b", "Bee")
	c := h.dial(spawnAt(899, 900.5))
	c.join(h, "race-c", "Cee")
	pot := findItem(a.inventory(t), "potion:health")
	a.interact(InteractItem, uint64(pot.H), ItemActDrop, 1)
	pid := a.lastEvent(EventDropped, 2*time.Second).EntityID
	deadline := time.Now().Add(2 * time.Second)
	for {
		b.pump(50 * time.Millisecond)
		c.pump(50 * time.Millisecond)
		okB, _, _ := b.seePickup(pid)
		okC, _, _ := c.seePickup(pid)
		if okB && okC {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("B and C never both saw the dropped potion")
		}
	}
	potions := func(cl *client) int {
		if it := findItem(cl.inventory(t), "potion:health"); it != nil {
			return it.Qty
		}
		return 0
	}
	pb, pc := potions(b), potions(c)
	b.interact(InteractPickup, uint64(pid), ActionUse, 0)
	c.interact(InteractPickup, uint64(pid), ActionUse, 0)
	b.pump(600 * time.Millisecond)
	c.pump(600 * time.Millisecond)
	takenB, takenC := len(b.eventsOf(EventItemTaken)), len(c.eventsOf(EventItemTaken))
	if takenB+takenC != 1 {
		t.Fatalf("taken by B %d, C %d: want exactly one", takenB, takenC)
	}
	loser := c
	if takenC == 1 {
		loser = b
	}
	refs := loser.eventsOf(EventItemRefused)
	if len(refs) == 0 || refs[len(refs)-1].Value != ItemRefuseNoItem {
		t.Fatalf("the loser was not told the item is gone: %+v", refs)
	}
	if potions(b)+potions(c) != pb+pc+1 {
		t.Fatalf("potions %d+%d, want %d", potions(b), potions(c), pb+pc+1)
	}
}

// Inventory full: auto-collect leaves the item and says so once (not every
// tick); E says so every time; the item stays on the ground.
func TestInventoryFullAutoCollectStaysQuiet(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(950, 950))
	wa := a.join(h, "full-a", "Packrat")
	a.pump(300 * time.Millisecond)
	var stacks []*items.Item
	for i := 0; i < constants.InventorySlots; i++ {
		stacks = append(stacks, items.Stack("weapon:copper_sword", 1))
	}
	h.give(t, "full-a", stacks...)
	a.interact(InteractItem, 0, ItemActAutoLoot, 1)
	a.pump(300 * time.Millisecond)
	if !a.inventory(t).Auto {
		t.Fatal("auto-collect not on")
	}
	n0 := len(a.eventsOf(EventItemRefused))
	meat := dropAt(t, h, wa.EntityID, items.Stack("meat:raw", 1), 950.2, 950, "t:fullmeat")
	a.pump(3500 * time.Millisecond)
	if pickupGone(t, h, meat) {
		t.Fatal("the meat vanished with a full inventory")
	}
	if n := len(a.eventsOf(EventItemRefused)) - n0; n != 1 {
		t.Fatalf("%d inventory-full refusals in 3.5 s of standing on it, want 1", n)
	}
	a.interact(InteractPickup, uint64(meat), ActionUse, 0)
	ref := a.lastEvent(EventItemRefused, time.Second)
	if n := len(a.eventsOf(EventItemRefused)) - n0; n != 2 || ref.Value != ItemRefuseFull {
		t.Fatalf("E with a full bag: %d refusals, last %d", n, ref.Value)
	}
	if pickupGone(t, h, meat) {
		t.Fatal("the meat vanished on a refused E")
	}
}

// Personal ground loot despawns on the pickup timer like dropped items.
func TestGroundLootDespawns(t *testing.T) {
	clk := &fakeClock{}
	h := newHarness(t, func(c *Config) { c.Now = clk.now })
	a := h.dial(spawnAt(980, 985))
	wa := a.join(h, "gl-despawn", "Late")
	a.pump(200 * time.Millisecond)
	en := &combat.Enemy{ID: 991002, Def: combatdefs.D.EnemyByKey("warden"), Level: 2, Element: combatdefs.Physical, Pos: movement.Vec3{X: 980, Z: 980}}
	_ = h.srv.Do(context.Background(), func() {
		h.srv.lootOnKill(combat.KillInfo{Enemy: en, Eligible: []uint32{wa.EntityID}, Tick: 5})
	})
	if len(drops(t, h, wa.EntityID)) == 0 {
		t.Fatal("no drops")
	}
	clk.advance(9 * time.Minute)
	a.pump(300 * time.Millisecond)
	if len(drops(t, h, wa.EntityID)) == 0 {
		t.Fatal("ground loot gone before its timer")
	}
	clk.advance(2*time.Minute + time.Second)
	a.pump(400 * time.Millisecond)
	if n := len(drops(t, h, wa.EntityID)); n != 0 {
		t.Fatalf("%d drops still there after the timer", n)
	}
}

// Rare+ drops ride the mid ring so their beam is seen from afar; common
// ones stay near-ring only. Everyone sees a public drop in the same place
// with the same item and rarity.
func TestRareDropsSeenAcrossTheMidRing(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(1000, 1000))
	a.join(h, "beam-a", "Near")
	b := h.dial(spawnAt(1000, 1120))
	b.join(h, "beam-b", "Far")
	a.pump(200 * time.Millisecond)
	var rareID, plainID uint32
	_ = h.srv.Do(context.Background(), func() {
		now := h.srv.cfg.Now()
		r := h.srv.spawnDrop(0, rare(items.Stack("weapon:iron_sword", 1), 4), h.srv.groundSpot(1001, 1000, 0), &itemDrop{world: true, source: SourceDropped}, now.Add(time.Minute))
		c := h.srv.spawnDrop(0, items.Stack("meat:raw", 1), h.srv.groundSpot(999, 1000, 0), &itemDrop{world: true, source: SourceDropped}, now.Add(time.Minute))
		rareID, plainID = r.ID, c.ID
	})
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.pump(60 * time.Millisecond)
		b.pump(60 * time.Millisecond)
		okA, _, _ := a.seePickup(rareID)
		okB, _, _ := b.seePickup(rareID)
		if okA && okB {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("rare drop: near sees %v, 120 m away sees %v", okA, okB)
		}
	}
	ea, eb := a.frame.Find(rareID), b.frame.Find(rareID)
	if ea.Name != eb.Name || ea.TypeID != eb.TypeID || ea.X != eb.X || ea.Y != eb.Y || ea.Z != eb.Z || eb.TypeID != 4 || eb.Name != "weapon:iron_sword" {
		t.Fatalf("the two clients disagree about the drop: %+v vs %+v", ea, eb)
	}
	if ok, _, _ := a.seePickup(plainID); !ok {
		t.Fatal("near player does not see the common drop")
	}
	if ok, _, _ := b.seePickup(plainID); ok {
		t.Fatal("a common drop 120 m away is sent (near ring only)")
	}
}
