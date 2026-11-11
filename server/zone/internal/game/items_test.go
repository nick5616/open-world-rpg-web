package game

// WP14 in-process tests: the real session/tick/snapshot path over
// WebSocket, memory-only items (Postgres is covered by items_store_test.go
// and the process tests in server/zone).

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
)

type fakeClock struct{ off atomic.Int64 }

func (c *fakeClock) now() time.Time          { return time.Now().Add(time.Duration(c.off.Load())) }
func (c *fakeClock) advance(d time.Duration) { c.off.Add(int64(d)) }

func (cl *client) inventory(t *testing.T) inventoryJSON {
	t.Helper()
	var inv inventoryJSON
	ev := cl.lastEvent(EventInventory, 2*time.Second)
	if err := json.Unmarshal(ev.Data, &inv); err != nil {
		t.Fatal(err)
	}
	return inv
}

// lastEvent pumps briefly and returns the newest Event of kind (waiting up
// to timeout for one).
func (cl *client) lastEvent(kind uint16, timeout time.Duration) *proto.Event {
	cl.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		cl.pump(60 * time.Millisecond)
		if evs := cl.eventsOf(kind); len(evs) > 0 {
			return evs[len(evs)-1]
		}
		if time.Now().After(deadline) {
			cl.t.Fatalf("no event %d", kind)
		}
	}
}

func findItem(inv inventoryJSON, base string) *items.WireItem {
	for i := range inv.Items {
		if inv.Items[i].Base == base {
			return &inv.Items[i]
		}
	}
	return nil
}

func (cl *client) interact(kind uint8, id uint64, action uint8, arg uint32) {
	cl.send(&proto.Interact{TargetKind: kind, TargetID: id, Action: action, Arg: arg})
}

func (cl *client) seePickup(id uint32) (ok bool, name string, owner bool) {
	if cl.frame == nil {
		return false, "", false
	}
	if e := cl.frame.Find(id); e != nil && e.Kind == proto.EntityKindPickup {
		return true, e.Name, true
	}
	return false, "", false
}

func (cl *client) pickups() []uint32 {
	var out []uint32
	if cl.frame != nil {
		for _, e := range cl.frame.Ents {
			if e.Kind == proto.EntityKindPickup {
				out = append(out, e.ID)
			}
		}
	}
	return out
}

// Spec 8 acceptance: a dropped item can be picked up by another player and
// despawns after 10 minutes. The despawn half runs on the zone's injected
// clock with the REAL 10-minute timer (no shortened setting): present at
// 9:59, gone at 10:01.
func TestDropPickupByAnotherPlayerAndTenMinuteDespawn(t *testing.T) {
	clk := &fakeClock{}
	h := newHarness(t, func(c *Config) { c.Now = clk.now })
	a := h.dial(spawnAt(500, 500))
	a.join(h, "drop-a", "Dropper")
	b := h.dial(spawnAt(502, 500))
	b.join(h, "drop-b", "Taker")
	inv := a.inventory(t)
	pot := findItem(inv, "potion:health")
	if pot == nil || pot.Qty != 3 || inv.Gold != 20 {
		t.Fatalf("starter kit: %+v", inv)
	}
	// A drops one potion: a public pickup B sees.
	a.interact(InteractItem, uint64(pot.H), ItemActDrop, 1)
	drop := a.lastEvent(EventDropped, 2*time.Second)
	pid := drop.EntityID
	if pid == 0 || string(drop.Data) != "potion:health" {
		t.Fatalf("dropped %+v", drop)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		b.pump(50 * time.Millisecond)
		if ok, name, _ := b.seePickup(pid); ok && name == "potion:health" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("B never saw the dropped item (pickups %v)", b.pickups())
		}
	}
	if got := findItem(a.inventory(t), "potion:health"); got == nil || got.Qty != 2 {
		t.Fatalf("A after the drop: %+v", got)
	}
	// B takes it.
	b.interact(InteractPickup, uint64(pid), ActionUse, 0)
	taken := b.lastEvent(EventItemTaken, 2*time.Second)
	if string(taken.Data) != "potion:health" || taken.Value != 1 {
		t.Fatalf("taken %+v", taken)
	}
	binv := b.inventory(t)
	var got *items.WireItem
	for i := range binv.Items {
		// Plain stacks merge: B's 3 starter potions + the taken one, the
		// stack's provenance gaining the taken unit's history.
		if binv.Items[i].Base == "potion:health" && binv.Items[i].Qty == 4 && binv.Items[i].Hands >= 4 {
			got = &binv.Items[i]
		}
	}
	if got == nil || !got.Verified || !got.Tradeable {
		t.Fatalf("B's inventory lacks the taken potion with provenance (starter, dropped, picked up): %+v", binv.Items)
	}
	b.pump(200 * time.Millisecond)
	if ok, _, _ := b.seePickup(pid); ok {
		t.Fatal("pickup still visible after it was taken")
	}

	// Despawn: A drops gold; it lies there 10 minutes on the zone clock.
	gold := findItem(a.inventory(t), "currency:gold")
	a.interact(InteractItem, uint64(gold.H), ItemActDrop, 5)
	g := a.lastEvent(EventDropped, 2*time.Second)
	gid := g.EntityID
	clk.advance(9*time.Minute + 59*time.Second)
	b.pump(300 * time.Millisecond)
	if ok, _, _ := b.seePickup(gid); !ok {
		t.Fatal("dropped gold gone before 10 minutes")
	}
	clk.advance(2 * time.Second)
	b.pump(400 * time.Millisecond)
	if ok, _, _ := b.seePickup(gid); ok {
		t.Fatal("dropped gold still there after 10 minutes")
	}
	info, _ := h.srv.ItemsDebug(context.Background(), "drop-a")
	if info.Dropped != 0 || info.Gold != 15 {
		t.Fatalf("after despawn: %+v", info)
	}
}

// Spec 8: items dropped by a local-profile player are unverified and never
// tradeable, whoever picks them up.
func TestLocalProfileDropIsUnverified(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(500, 500))
	a.hello(h.ticket("local-a", "Loco", func(c *ticket.Claims) { c.AccountID = ""; c.ProfileID = "p1"; c.IsLocalProfile = true }), proto.ProtocolVersion)
	a.next(proto.MsgWelcome, 3*time.Second)
	b := h.dial(spawnAt(501, 500))
	b.join(h, "acct-b", "Acct")
	pot := findItem(a.inventory(t), "potion:health")
	a.interact(InteractItem, uint64(pot.H), ItemActDrop, 0)
	pid := a.lastEvent(EventDropped, 2*time.Second).EntityID
	b.pump(300 * time.Millisecond)
	b.interact(InteractPickup, uint64(pid), ActionUse, 0)
	b.lastEvent(EventItemTaken, 2*time.Second)
	for _, it := range b.inventory(t).Items {
		if it.Base == "potion:health" && it.Hands >= 3 {
			if it.Verified || it.Tradeable {
				t.Fatalf("local-profile drop came out verified=%v tradeable=%v", it.Verified, it.Tradeable)
			}
			return
		}
	}
	t.Fatal("B did not get the potion as its own (unverified) stack")
}

func (h *harness) give(t *testing.T, char string, stacks ...*items.Item) {
	t.Helper()
	err := h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		var d items.Delta
		for _, it := range stacks {
			sess.items.inv.Add(it, &d)
		}
		h.srv.commitItems(sess, &d, nil, "test give")
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Personal loot (spec 8): every eligible player rolls their own, logged
// seed, owner-only pickups auto-taken on touch; a boss gives loot once a
// week per character.
func TestPersonalKillLootAndBossLockout(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(800, 800))
	wa := a.join(h, "loot-a", "Alpha")
	b := h.dial(spawnAt(830, 800))
	b.join(h, "loot-b", "Beta")
	a.pump(200 * time.Millisecond)
	gold0 := a.inventory(t).Gold
	boar := combatdefs.D.EnemyByKey("brute")
	if boar == nil {
		boar = combatdefs.D.EnemyByKey("brute")
	}
	en := &combat.Enemy{ID: 990001, Def: boar, Level: 3, Element: combatdefs.Physical, Pos: movement.Vec3{X: 800, Y: 0, Z: 800}}
	_ = h.srv.Do(context.Background(), func() {
		h.srv.lootOnKill(combat.KillInfo{Enemy: en, Eligible: []uint32{wa.EntityID}, Tick: 7})
	})
	a.lastEvent(EventLootGranted, 3*time.Second)
	if g := a.inventory(t).Gold; g <= gold0 {
		t.Fatalf("no gold from the kill: %d -> %d", gold0, g)
	}
	if len(b.eventsOf(EventLootGranted)) != 0 {
		t.Fatal("B (not eligible) got loot")
	}
	// Boss: loot, then the lockout.
	warden := combatdefs.D.EnemyByKey("warden")
	grp := &combat.Group{ID: 77, Seed: 5}
	bossKill := func(id uint32) {
		e := &combat.Enemy{ID: id, Def: warden, Level: 2, Element: combatdefs.Physical, Pos: movement.Vec3{X: 800, Z: 800}, Boss: &combat.BossState{}, Group: grp, Name: "The Test Warden"}
		_ = h.srv.Do(context.Background(), func() {
			h.srv.lootOnKill(combat.KillInfo{Enemy: e, Eligible: []uint32{wa.EntityID}, Tick: id})
		})
	}
	n0 := len(a.eventsOf(EventLootGranted))
	pressed := map[uint32]bool{}
	bossKill(990002)
	deadline := time.Now().Add(3 * time.Second)
	for len(a.eventsOf(EventLootGranted)) < n0+4 && time.Now().Before(deadline) { // gold, 3 equipment, gem, blueprint, potion, tome
		a.pump(100 * time.Millisecond)
		// Playtest 2 ground loot: walking over takes the gold; equipment,
		// tomes and blueprints wait for E (Interact 41).
		for _, id := range a.pickups() {
			if !pressed[id] {
				pressed[id] = true
				a.interact(InteractPickup, uint64(id), ActionUse, 0)
			}
		}
	}
	if len(a.eventsOf(EventLootGranted)) < n0+4 {
		t.Fatalf("boss loot: %d grants", len(a.eventsOf(EventLootGranted))-n0)
	}
	bossKill(990003)
	lock := a.lastEvent(EventBossLockout, 2*time.Second)
	if string(lock.Data) != "The Test Warden" {
		t.Fatalf("lockout %+v", lock)
	}
	info, _ := h.srv.ItemsDebug(context.Background(), "loot-a")
	tome := false
	for _, it := range info.Items {
		tome = tome || strings.HasPrefix(it.Base, "tome:")
	}
	if !tome {
		t.Fatal("boss gave no tome")
	}
}

// The G4 item pieces in process: smelt sunsteel ore, forge the blade with
// the blueprint, socket a topaz, equip: combat sees a sunsteel weapon with
// the lightning form (WP13 forms read the socketed gem), and the drink key
// uses the inventory's potions.
func TestSmeltForgeSocketEquipDrive(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(600, 600))
	a.join(h, "smith", "Smith")
	a.pump(200 * time.Millisecond)
	h.give(t, "smith", items.Stack("ore:sunsteel", 4), items.Stack("gem:topaz:cut", 1), items.Stack("blueprint:sunsteel_blade", 1))
	// No station open: refused.
	smelt := items.D.Recipe("smelt_sunsteel")
	a.interact(InteractCraft, 0, CraftActCraft, uint32(smelt.ID))
	if r := a.lastEvent(EventItemRefused, 2*time.Second); r.Value != ItemRefuseStation {
		t.Fatalf("refusal %d", r.Value)
	}
	_ = h.srv.Do(context.Background(), func() {
		e := h.srv.byChar["smith"].ent
		h.srv.byChar["smith"].items.station = &openStation{kind: StationForge, x: e.Move.Pos.X, y: e.Move.Pos.Y, z: e.Move.Pos.Z}
	})
	for i := 0; i < 2; i++ {
		a.interact(InteractCraft, 0, CraftActCraft, uint32(smelt.ID))
	}
	forge := items.D.Recipe("forge_sunsteel_blade")
	a.interact(InteractCraft, 0, CraftActCraft, uint32(forge.ID))
	deadline := time.Now().Add(3 * time.Second)
	for len(a.eventsOf(EventCrafted)) < 3 && time.Now().Before(deadline) {
		a.pump(50 * time.Millisecond)
	}
	if len(a.eventsOf(EventCrafted)) != 3 {
		t.Fatalf("crafted %d of 3 (refusals %v)", len(a.eventsOf(EventCrafted)), a.eventsOf(EventItemRefused))
	}
	inv := a.inventory(t)
	blade, gem := findItem(inv, "weapon:sunsteel_blade"), findItem(inv, "gem:topaz:cut")
	if blade == nil || gem == nil || len(blade.Sockets) < 1 || findItem(inv, "ore:sunsteel") != nil {
		t.Fatalf("after forging: %+v", inv.Items)
	}
	a.interact(InteractItem, uint64(blade.H), ItemActEquip, 0)
	a.interact(InteractItem, uint64(blade.H)|uint64(gem.H)<<32, ItemActSocket, 0)
	a.pump(300 * time.Millisecond)
	var gear combat.Gear
	var lo combat.Loadout
	var charges int
	_ = h.srv.Do(context.Background(), func() {
		p := h.srv.byChar["smith"].ent.cbt
		gear, lo, charges = p.Gear, p.Profile.Loadouts[0], p.Charges
	})
	if !gear.KillsDemons || gear.WeaponMult < 1.2 || gear.FormMult != 1.25 || lo.Weapon != "sword" || lo.Gem != combatdefs.Lightning {
		t.Fatalf("gear %+v loadout %+v", gear, lo)
	}
	if charges != 3 {
		t.Fatalf("drink charges %d, want the 3 starter potions", charges)
	}
	inv = a.inventory(t)
	if b := findItem(inv, "weapon:sunsteel_blade"); b.Slot != items.EqMain0 || b.Sockets[0] != "gem:topaz:cut" {
		t.Fatalf("blade %+v", b)
	}
	// Drink (input flag): one potion is spent, the heal comes from the item.
	a.sendFrames(proto.InputFlagInteract)
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		a.pump(100 * time.Millisecond)
		if p := findItem(a.inventory(t), "potion:health"); p != nil && p.Qty == 2 {
			return
		}
	}
	t.Fatalf("drinking did not spend a potion: %+v", findItem(a.inventory(t), "potion:health"))
}

// WP20 merchants take gold (CR 010); short of gold is refused.
func TestBuyCostsGold(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(600, 600))
	a.join(h, "buyer", "Buyer")
	a.pump(200 * time.Millisecond)
	var err1, err2 error
	_ = h.srv.Do(context.Background(), func() {
		e := h.srv.byChar["buyer"].ent
		err1 = h.srv.Buy(e, "blueprint:sunsteel_blade", 15)
		err2 = h.srv.Buy(e, "weapon:iron_sword", 90)
	})
	if err1 != nil || err2 == nil {
		t.Fatalf("buy: %v, %v", err1, err2)
	}
	inv := a.inventory(t)
	if inv.Gold != 5 || findItem(inv, "blueprint:sunsteel_blade") == nil || findItem(inv, "weapon:iron_sword") != nil {
		t.Fatalf("after buying: gold %d %+v", inv.Gold, inv.Items)
	}
}

// WP16: the inventory crosses a zone handoff in the handoff state (live,
// not re-read from Postgres): the new owner has every item, socket, slot
// and marker, with the same ids.
func TestItemsSurviveZoneHandoff(t *testing.T) {
	_, a, b := twoZones(t, nil)
	p := newHoClient(t, a, "char-items", "Carrier", 2020, 1000)
	var ids []string
	_ = a.srv.Do(context.Background(), func() {
		sess := a.srv.byChar["char-items"]
		var d items.Delta
		blade := items.RollEquipment(items.NewRNG(1), items.Rolled{Base: "weapon:sunsteel_blade", Level: 10, Luck: 1, MinSock: 1, Element: -1})
		sess.items.inv.Add(blade, &d)
		sess.items.inv.Add(items.Stack("gem:ruby:brilliant", 1), &d)
		_ = sess.items.inv.Equip(blade, items.EqMain0, &d)
		gem := sess.items.inv.Items[len(sess.items.inv.Items)-1]
		_ = sess.items.inv.Socket(blade, gem, 0, &d)
		sess.items.markers["container:12345"] = true
		a.srv.commitItems(sess, &d, nil, "test")
		for _, it := range sess.items.inv.Items {
			ids = append(ids, it.ID)
		}
	})
	for i := 0; i < 14; i++ {
		p.walk(30, proto.InputFlagForward, eastYaw)
	}
	p.settle()
	if p.active != "zone-b" {
		t.Fatalf("no handoff (active %s, log %v)", p.active, p.switchLog)
	}
	info, err := b.srv.ItemsDebug(context.Background(), "char-items")
	if err != nil || !info.Online {
		t.Fatalf("zone-b items: %+v %v", info, err)
	}
	got := map[string]bool{}
	var blade *items.WireItem
	for i, it := range info.Items {
		got[it.Base] = true
		if it.Base == "weapon:sunsteel_blade" {
			blade = &info.Items[i]
		}
	}
	if blade == nil || blade.Slot != items.EqMain0 || len(blade.Sockets) == 0 || blade.Sockets[0] != "gem:ruby:brilliant" || !got["potion:health"] || info.Gold != 20 {
		t.Fatalf("handed inventory: %+v", info.Items)
	}
	if len(info.Markers) == 0 || !strings.Contains(strings.Join(info.Markers, ","), "container:12345") {
		t.Fatalf("markers %v", info.Markers)
	}
	var lo combat.Loadout
	var kills bool
	_ = b.srv.Do(context.Background(), func() {
		pl := b.srv.byChar["char-items"].ent.cbt
		lo, kills = pl.Profile.Loadouts[0], pl.Gear.KillsDemons
	})
	if lo.Gem != combatdefs.Fire || !kills {
		t.Fatalf("gear after handoff: loadout %+v sunsteel %v", lo, kills)
	}
	_ = ids
}
