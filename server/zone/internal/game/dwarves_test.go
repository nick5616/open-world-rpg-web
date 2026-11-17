package game

// CR 043 in-process tests on the official world (seed 20261108): the
// dwarven halls' townsfolk, shops and boards, no packs in them, the lower
// halls' warden, tunnel packs, cave chests and lore tablets.

import (
	"fmt"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
)

func TestDwarvenHallsAndTheirPacks(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	v := ct.Vertical()
	var halls []int
	for i := range w.T.Settlements {
		if w.Sites[w.T.Settlements[i].Site].Layer == vertical.LayerUnder {
			halls = append(halls, i)
			if !w.SkySettlement(i, ct.HeightAt) {
				t.Fatalf("settlement %d under the rock is not a layered town", i)
			}
		}
	}
	if len(halls) < 3 {
		t.Skipf("only %d dwarven halls (genVersion < 4?)", len(halls))
	}
	// Shops: merchants 4 and 5 sell; boards offer ore and creatures.
	var miners, brokers, holdKills, campKills int
	for _, si := range halls {
		for i := w.T.Settlements[si].NPCFirst; i < w.T.Settlements[si].NPCFirst+w.T.Settlements[si].NPCs; i++ {
			d := w.T.NPCs[i]
			if d.Role == towns.RoleMerchant && len(w.Wares(i)) == 0 {
				t.Fatalf("hall merchant %d (stock %d) sells nothing", i, d.Merchant)
			}
			miners += b2i(d.Role == towns.RoleMerchant && d.Merchant == 4)
			brokers += b2i(d.Role == towns.RoleMerchant && d.Merchant == 5)
		}
		bs := w.Bounties(si, 1)
		if len(bs) < 3 {
			t.Fatalf("hall board has %d jobs", len(bs))
		}
		for _, b := range bs {
			if len(b.Item) > 5 && b.Item[:5] == "kill:" {
				if w.Sites[w.T.Settlements[si].Site].Size >= 2 {
					holdKills++
				} else {
					campKills++
				}
			}
		}
	}
	if miners == 0 || brokers == 0 || holdKills < 2 || campKills == 0 {
		t.Fatalf("miners %d brokers %d stronghold kill jobs %d camp kill jobs %d", miners, brokers, holdKills, campKills)
	}
	// Packs: none in a camp or stronghold; a warden and a dense set in the lower halls; packs along tunnels.
	raw := testTerrain(t).World().Atlas
	sa, err := structures.ParseAtlas(raw)
	if err != nil {
		t.Fatal(err)
	}
	ca := combat.ParseAtlas(raw, sa)
	n := uint32(1)
	cw := combat.NewWorld(combat.Config{Seed: 42}, g, func() uint32 { n++; return n })
	cw.BuildFromAtlas(ca)
	surface := len(cw.Groups)
	s := &Server{cfg: Config{Ground: g}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s.addLayerGroups(cw)
	wardens, lowerPacks, tunnelPacks := 0, 0, 0
	for _, gr := range cw.Groups[surface:] {
		if gr.Layer != vertical.LayerUnder {
			continue
		}
		for i := range v.Chambers {
			c := &v.Chambers[i]
			d := math.Hypot(gr.Anchor.X-c.X, gr.Anchor.Z-c.Z)
			if (c.Kind == vertical.ChamberDwarfCamp || c.Kind == vertical.ChamberStronghold) && d < math.Max(c.Rx, c.Rz) && math.Abs(gr.Anchor.Y-c.Floor) < 60 {
				t.Fatalf("a pack (%s) inside a dwarven hall (chamber %d)", gr.Kind, i)
			}
			if c.Kind == vertical.ChamberLowerHalls && d < math.Max(c.Rx, c.Rz) {
				if gr.Kind == combat.GroupBoss {
					wardens++
				} else {
					lowerPacks++
				}
			}
		}
		if gr.Kind == combat.GroupPack && len(gr.Comp) > 0 && gr.Comp[0] != "" {
			tunnelPacks++
		}
	}
	if wardens == 0 || lowerPacks < 3 || tunnelPacks < 8 {
		t.Fatalf("wardens %d, lower halls packs %d, underground packs %d", wardens, lowerPacks, tunnelPacks)
	}
	t.Logf("%d dwarven halls, %d wardens, %d lower halls packs, %d underground packs", len(halls), wardens, lowerPacks, tunnelPacks)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func TestCaveChestsAndLoreTablets(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	grants := &memGrants{}
	h := newHarness(t, func(c *Config) { c.Ground = g; c.Towns = w; c.Granter = grants })
	v := ct.Vertical()
	chest, tablet := -1, -1
	for i := range v.Decos {
		d := &v.Decos[i]
		if d.Layer != vertical.LayerUnder || d.Flags&vertical.FlagInteract == 0 {
			continue
		}
		ct.Layers.Ensure(d.X, d.Z, 2)
		if y := ct.FloorAt(d.X, d.Y+2, d.Z); ct.LayerAt(d.X, y, d.Z) != vertical.LayerUnder || math.Abs(y-d.Y) > 2 {
			continue
		}
		if d.Kind == vertical.DecoChest && chest < 0 {
			chest = i
		}
		if d.Kind == vertical.DecoTablet && tablet < 0 {
			tablet = i
		}
	}
	if chest < 0 || tablet < 0 {
		t.Skipf("no chest (%d) or tablet (%d) on a floor", chest, tablet)
	}
	cd, td := v.Decos[chest], v.Decos[tablet]
	a := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", cd.X+1.5, cd.Y+1, cd.Z))
	a.join(h, "chester", "Chester")
	a.pump(300 * time.Millisecond)
	a.send(&proto.Interact{TargetKind: InteractCaveChest, TargetID: uint64(chest), Action: 1})
	ev := a.nextEvent(EventChestOpened, 3*time.Second)
	if ev.TargetID != uint32(chest) || ev.Value < 1 || ev.Value > 3 {
		t.Fatalf("chest event %+v", ev)
	}
	a.send(&proto.Interact{TargetKind: InteractCaveChest, TargetID: uint64(chest), Action: 1})
	if ev := a.nextEvent(EventChestOpened, 3*time.Second); ev.Value != 0 {
		t.Fatalf("an opened chest answers %+v", ev)
	}
	b := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", td.X+1.5, td.Y+1, td.Z))
	b.join(h, "reader", "Reader")
	b.pump(300 * time.Millisecond)
	b.send(&proto.Interact{TargetKind: InteractLoreTablet, TargetID: uint64(tablet), Action: 1})
	ev = b.nextEvent(EventLoreTablet, 3*time.Second)
	if len(ev.Data) < 20 || ev.TargetID != uint32(tablet) {
		t.Fatalf("tablet event %+v", ev)
	}
	// Out of reach: nothing.
	b.send(&proto.Interact{TargetKind: InteractCaveChest, TargetID: uint64(chest), Action: 1})
	b.pump(300 * time.Millisecond)
}
