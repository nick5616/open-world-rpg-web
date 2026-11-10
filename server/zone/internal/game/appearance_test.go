package game

// Visible armor (CR 034): the appearance's encoding, and its replication:
// sent on equip and unequip, on first sight to a late joiner, never again
// while it stays the same, across a zone handoff and in ghost frames.

import (
	"context"
	"math/rand"
	"testing"
	"time"

	"lodestone/server/pkg/itemdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/zone/internal/items"
)

func TestAppearancePackRoundTrip(t *testing.T) {
	n := 0
	for i := range itemdefs.D.Items {
		it := &itemdefs.D.Items[i]
		if it.Kind != "armor" {
			if ArmorVisualID(it.Key) != 0 {
				t.Fatalf("%s is not armor but has a visual id", it.Key)
			}
			continue
		}
		n++
		if got := ArmorVisualID(it.Key); got != n {
			t.Fatalf("%s: visual id %d, want %d (items.yaml armor order)", it.Key, got, n)
		}
		if it.Style == "" || LookMaterialCode(it.Material) == 0 {
			t.Fatalf("%s: style %q material %q", it.Key, it.Style, it.Material)
		}
	}
	if n == 0 || n > 63 {
		t.Fatalf("%d armor pieces: the visual id has 6 bits", n)
	}
	r := rand.New(rand.NewSource(7))
	for k := 0; k < 2000; k++ {
		var s [3]ArmorLook
		for i := range s {
			if r.Intn(4) == 0 {
				continue
			}
			s[i] = ArmorLook{Visual: 1 + r.Intn(n), Material: uint8(1 + r.Intn(9)), Rarity: r.Intn(8), Gem: r.Intn(11)}
		}
		v := PackAppearance(s)
		if v >= 1<<53 {
			t.Fatalf("appearance %d is not exact in JSON / JS numbers", v)
		}
		if got := UnpackAppearance(v); got != s {
			t.Fatalf("round trip %+v -> %d -> %+v", s, v, got)
		}
	}
	if PackAppearance([3]ArmorLook{}) != 0 {
		t.Fatal("nothing worn must be 0 (costs nothing on the wire)")
	}
	// A fixed vector the client's twin checks too (client/src/combat/armor/appearance.test.ts).
	inv := &items.Inventory{}
	var d items.Delta
	helm := &items.Item{Base: "armor:iron_helm", Qty: 1, Level: 4, Rarity: 3, Sockets: []string{"gem:ruby:cut"}}
	robe := &items.Item{Base: "armor:cloth_robe", Qty: 1, Level: 1, Rarity: 7}
	inv.Add(helm, &d)
	inv.Add(robe, &d)
	if err := inv.Equip(helm, items.EqHead, &d); err != nil {
		t.Fatal(err)
	}
	if err := inv.Equip(robe, items.EqBody, &d); err != nil {
		t.Fatal(err)
	}
	got := AppearanceOf(inv)
	want := PackAppearance([3]ArmorLook{
		{Visual: ArmorVisualID("armor:iron_helm"), Material: LookMaterialCode("iron"), Rarity: 3, Gem: 1},
		{Visual: ArmorVisualID("armor:cloth_robe"), Material: LookMaterialCode("cloth"), Rarity: 7},
	})
	if got != want || got != 1017261316 {
		t.Fatalf("iron helm (relic, ruby) + cloth robe (Bitchin'): %d, want %d (and the shared vector 1017261316)", got, want)
	}
}

// devWear gives and equips an armor piece through the dev console.
func (cl *client) devWear(t *testing.T, key string, rarity, gem int) {
	t.Helper()
	cl.devOK(t, DevActGive, devGiveTarget(key, 0, rarity, gem, 1, -1), 1|1<<16)
}

// seenAppearance pumps until the client's view of id has want (or fails).
func (cl *client) seenAppearance(t *testing.T, id uint32, want uint64, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		cl.walk(2, 0, 0, nil)
		if cl.frame != nil {
			if e := cl.frame.Find(id); e != nil && e.Appearance == want {
				return
			}
		}
		if time.Now().After(deadline) {
			var got any = "not seen"
			if cl.frame != nil {
				if e := cl.frame.Find(id); e != nil {
					got = e.Appearance
				}
			}
			t.Fatalf("%s: appearance %v, want %d", what, got, want)
		}
	}
}

func TestAppearanceReplicatesOnEquipUnequipAndToLateJoiners(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Dev = true })
	a := h.dial(spawnAt(600, 600))
	wa := a.join(h, "ap-a", "Armored")
	b := h.dial(spawnAt(604, 600))
	b.join(h, "ap-b", "Watcher")
	a.pump(200 * time.Millisecond)
	b.seenAppearance(t, wa.EntityID, 0, "before: nothing worn")

	a.devWear(t, "armor:iron_helm", 3, 0) // relic, a ruby inlay
	a.devWear(t, "armor:silver_cuirass", 4, -1)
	a.devWear(t, "armor:iron_greaves", 0, -1)
	var want uint64
	h.do(func() { want = h.srv.byChar["ap-a"].ent.Appearance })
	sl := UnpackAppearance(want)
	if sl[0].Visual != ArmorVisualID("armor:iron_helm") || sl[0].Rarity != 3 || sl[0].Gem != 1 ||
		sl[1].Visual != ArmorVisualID("armor:silver_cuirass") || sl[1].Rarity != 4 || sl[2].Visual != ArmorVisualID("armor:iron_greaves") {
		t.Fatalf("zone appearance %+v", sl)
	}
	// The owner's inventory carries the same number (your own body draws it).
	if inv := a.inventory(t); inv.Ap != want {
		t.Fatalf("inventory ap %d, entity %d", inv.Ap, want)
	}
	b.seenAppearance(t, wa.EntityID, want, "after equipping three pieces")

	// Unchanged: no record carries it again.
	for i := 0; i < 15; i++ {
		b.walk(2, 0, 0, nil)
		for _, r := range b.snap.Entities {
			if r.ID == wa.EntityID && r.Mask&proto.EntityRecordHasAppearance != 0 {
				t.Fatalf("appearance re-sent while unchanged (snapshot %d)", b.snap.Tick)
			}
		}
	}

	// A late joiner gets it on first sight.
	c := h.dial(spawnAt(598, 600))
	c.join(h, "ap-c", "Latecomer")
	c.seenAppearance(t, wa.EntityID, want, "late joiner's first sight")

	// Unequipping the helm clears the head slot for everyone.
	a.interact(InteractItem, 0, ItemActUnequip, 2) // slots: main0, main1, head, body, legs
	after := want
	deadline := time.Now().Add(2 * time.Second)
	for after == want && time.Now().Before(deadline) {
		a.pump(50 * time.Millisecond)
		h.do(func() { after = h.srv.byChar["ap-a"].ent.Appearance })
	}
	if s := UnpackAppearance(after); s[0] != (ArmorLook{}) || s[1] != sl[1] || s[2] != sl[2] {
		t.Fatalf("after unequipping the helm: %+v", s)
	}
	b.seenAppearance(t, wa.EntityID, after, "observer after the unequip")
	c.seenAppearance(t, wa.EntityID, after, "late joiner after the unequip")
}

func TestGhostFramesCarryAppearance(t *testing.T) {
	recs := []ghostRec{
		{EntState: snapshot.EntState{ID: 7, Kind: proto.EntityKindPlayer, Name: "Plain"}},
		{EntState: snapshot.EntState{ID: 9, Kind: proto.EntityKindPlayer, Name: "Knight", Appearance: 123456789}},
		{EntState: snapshot.EntState{ID: 11, Kind: proto.EntityKindEnemy, Name: "wolf"}},
	}
	var w proto.Writer
	b := encodeGhosts(&w, &ghostFrame{Zone: "zone-a", Recs: recs, Gone: []uint32{3}})
	f, err := decodeGhosts(b)
	if err != nil || len(f.Recs) != 3 || f.Recs[1].Appearance != 123456789 || f.Recs[0].Appearance != 0 || f.Recs[2].Appearance != 0 || len(f.Gone) != 1 {
		t.Fatalf("ghost frame: %+v %v", f, err)
	}
	// Nobody armored: byte-identical to the frame before CR 034 (no section).
	var w2 proto.Writer
	plain := encodeGhosts(&w2, &ghostFrame{Zone: "zone-a", Recs: recs[:1]})
	var w3 proto.Writer
	w3.U8(ghostVersion)
	w3.Str("zone-a")
	w3.U16(1)
	writeEnt(&w3, &recs[0])
	w3.U16(0)
	if string(plain) != string(w3.B) {
		t.Fatal("a frame with nobody armored changed")
	}
	zone, g, err := decodePresence(encodePresence("zone-b", &recs[1]))
	if err != nil || zone != "zone-b" || g.Appearance != 123456789 {
		t.Fatalf("presence: %s %+v %v", zone, g, err)
	}
}

func TestAppearanceCrossesHandoffAndGhosts(t *testing.T) {
	_, a, b := twoZones(t, nil)
	p := newHoClient(t, a, "char-ap", "Plated", 2030, 1500)
	o := newHoClient(t, a, "char-apo", "Obs", 2020, 1500) // stays on A, watching P walk east
	id := p.welc.EntityID
	var want uint64
	_ = a.srv.Do(context.Background(), func() {
		sess := a.srv.byChar["char-ap"]
		var d items.Delta
		for _, k := range []string{"armor:starmetal_helm", "armor:sunsteel_mail", "armor:leather_boots"} {
			it := items.DevRoll(items.NewRNG(5), items.DevGear{Base: k, Rarity: 5})
			sess.items.inv.Add(it, &d)
			_ = sess.items.inv.Equip(it, items.ArmorSlot(it.Def()), &d)
		}
		a.srv.commitItems(sess, &d, nil, "test")
		want = AppearanceOf(&sess.items.inv)
	})
	if want == 0 {
		t.Fatal("nothing worn")
	}
	seen := false
	for i := 0; i < 20; i++ {
		p.walk(20, proto.InputFlagForward, eastYaw)
		o.walk(2, 0, 0)
		if o.frame != nil {
			if e := o.frame.Find(id); e != nil && e.Appearance == want {
				seen = true
			}
		}
	}
	if p.active != "zone-b" {
		t.Fatalf("P was not handed off: %v", p.switchLog)
	}
	var onB, ghostOnA uint64
	_ = b.srv.Do(context.Background(), func() {
		if sess := b.srv.byChar["char-ap"]; sess != nil {
			onB = sess.ent.Appearance
		}
	})
	_ = a.srv.Do(context.Background(), func() {
		if r := a.srv.cl.remoteByID[id]; r != nil {
			ghostOnA = r.q.Appearance
		}
	})
	if onB != want {
		t.Fatalf("after the handoff zone-b wears %d, want %d", onB, want)
	}
	if ghostOnA != want {
		t.Fatalf("zone-a's ghost of P wears %d, want %d", ghostOnA, want)
	}
	for i := 0; i < 10; i++ {
		o.walk(2, 0, 0)
	}
	if e := o.frame.Find(id); !seen || e == nil || e.Appearance != want {
		t.Fatalf("observer on zone-a: seen %v, now %+v, want %d", seen, e, want)
	}
}
