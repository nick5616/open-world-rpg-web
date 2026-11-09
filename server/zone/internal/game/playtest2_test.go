package game

// Playtest 2 regressions: "You cannot switch back to the default sword
// after equipping something else" and "It says mine ore but you have no
// pickaxe to begin with".

import (
	"context"
	"testing"
	"time"

	"lodestone/server/zone/internal/items"
)

// loadoutWeapon polls the zone until loadout l wields want (or fails).
func loadoutWeapon(t *testing.T, h *harness, cl *client, char string, l int, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	got := ""
	for time.Now().Before(deadline) {
		cl.pump(60 * time.Millisecond)
		_ = h.srv.Do(context.Background(), func() {
			got = h.srv.byChar[char].ent.cbt.Profile.Loadouts[l].Weapon
		})
		if got == want {
			return
		}
	}
	t.Fatalf("loadout %d wields %q, want %q", l, got, want)
}

func TestUnequipFallsBackToTheDefaultWeapon(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(620, 600))
	const char = "swap-sword"
	a.join(h, char, "Swapper")
	a.pump(200 * time.Millisecond)
	if defaultWeapon(0) != "sword" || defaultWeapon(1) != "staff" {
		t.Fatalf("combat.yaml start loadouts changed: %q %q", defaultWeapon(0), defaultWeapon(1))
	}
	loadoutWeapon(t, h, a, char, 0, "sword")
	h.give(t, char, items.Stack("weapon:copper_spear", 1), items.Stack("weapon:copper_sword", 1))

	// Equip a spear in loadout 1: the hand is a spear.
	spear := findItem(a.inventory(t), "weapon:copper_spear")
	a.interact(InteractItem, uint64(spear.H), ItemActEquip, 0)
	loadoutWeapon(t, h, a, char, 0, "spear")

	// Unequip it: back to the starter (training) sword, the spear in the bag.
	a.interact(InteractItem, uint64(spear.H), ItemActUnequip, 0) // arg 0 = eq:main0
	loadoutWeapon(t, h, a, char, 0, "sword")
	if it := findItem(a.inventory(t), "weapon:copper_spear"); it == nil || it.Slot == items.EqMain0 {
		t.Fatalf("spear not back in the bag: %+v", it)
	}

	// Same through the second loadout (its default is the staff).
	a.interact(InteractItem, uint64(spear.H), ItemActEquip, 1)
	loadoutWeapon(t, h, a, char, 1, "spear")
	a.interact(InteractItem, uint64(spear.H), ItemActUnequip, 1) // arg 1 = eq:main1
	loadoutWeapon(t, h, a, char, 1, "staff")

	// Equipping one sword item over another and unequipping still ends on the default.
	sword := findItem(a.inventory(t), "weapon:copper_sword")
	a.interact(InteractItem, uint64(sword.H), ItemActEquip, 0)
	loadoutWeapon(t, h, a, char, 0, "sword")
	a.interact(InteractItem, uint64(sword.H), ItemActUnequip, 0)
	loadoutWeapon(t, h, a, char, 0, "sword")
	var gem int
	_ = h.srv.Do(context.Background(), func() { gem = h.srv.byChar[char].ent.cbt.Profile.Loadouts[0].Gem })
	if gem != -1 {
		t.Fatalf("the default sword kept a gem: %d", gem)
	}
}

func TestStarterPickaxe(t *testing.T) {
	h := newHarness(t, nil)
	a := h.dial(spawnAt(640, 600))
	const char = "pick-new"
	a.join(h, char, "Digger")
	if findItem(a.inventory(t), "tool:pickaxe") == nil {
		t.Fatal("new character without a pickaxe")
	}

	// An older character (kit granted before the pickaxe joined it): one
	// pickaxe, once.
	count := func() (n int, marked bool) {
		_ = h.srv.Do(context.Background(), func() {
			ci := h.srv.byChar[char].items
			n, marked = ci.inv.Count("tool:pickaxe"), ci.markers[starterPickaxeMarker]
		})
		return
	}
	_ = h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		var d items.Delta
		sess.items.inv.Spend("tool:pickaxe", 1, &d)
		delete(sess.items.markers, starterPickaxeMarker)
		h.srv.topUpStarter(sess)
	})
	if n, marked := count(); n != 1 || !marked {
		t.Fatalf("older character: %d pickaxes, marker %v", n, marked)
	}
	_ = h.srv.Do(context.Background(), func() { h.srv.topUpStarter(h.srv.byChar[char]) })
	if n, _ := count(); n != 1 {
		t.Fatalf("pickaxe granted twice: %d", n)
	}
	// One who already bought one gets no second, and is marked.
	_ = h.srv.Do(context.Background(), func() {
		delete(h.srv.byChar[char].items.markers, starterPickaxeMarker)
		h.srv.topUpStarter(h.srv.byChar[char])
	})
	if n, marked := count(); n != 1 || !marked {
		t.Fatalf("already carrying one: %d pickaxes, marker %v", n, marked)
	}
	// Sold or dropped later: not replaced for free.
	_ = h.srv.Do(context.Background(), func() {
		sess := h.srv.byChar[char]
		var d items.Delta
		sess.items.inv.Spend("tool:pickaxe", 1, &d)
		h.srv.topUpStarter(sess)
	})
	if n, _ := count(); n != 0 {
		t.Fatalf("a dropped pickaxe came back: %d", n)
	}
}
