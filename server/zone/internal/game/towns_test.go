package game

// WP20 in-process zone tests on the official world (real wasm towns layer
// and terrain + caves): NPCs appear as snapshot entities near their town,
// talk/shop/buy, the bounty board (read, accept, accept twice), the inn
// (rest), the forge interaction point, refusals (too far, closed at night)
// and the mineshaft descent into its cave.

import (
	"context"
	"encoding/binary"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/npc"
)

// townGround mirrors server/zone/towns.go's townCaveTerrain: the cave
// terrain's methods promoted, buildings on the level view.
type townGround struct {
	*worldhost.CaveTerrain
	tg *towns.Ground
}

func (t townGround) AtLevel(y float64) movement.Ground { return t.tg.AtLevel(y) }

func (t townGround) TownCollision() *towns.Collision { return t.tg.C }

func testTowns(t *testing.T) (*npc.World, movement.Ground) {
	t.Helper()
	ct := testCaveTerrain(t)
	w := testTerrain(t).World()
	b, err := w.TownsBytes()
	if err != nil {
		t.Fatal(err)
	}
	tw, err := towns.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	var sites []npc.Site
	if a, err := structures.ParseAtlas(w.Atlas); err == nil {
		for _, s := range a.Sites {
			sites = append(sites, npc.Site{Index: s.Index, Category: s.Category, Kind: s.Kind, X: s.X, Z: s.Z, Name: s.Name})
		}
	}
	return npc.New(tw, w.Seed, sites), townGround{CaveTerrain: ct, tg: towns.NewGround(ct, tw)}
}

// offsetFor makes the zone's NPC clock read `hour` now.
func offsetFor(hour float64) float64 {
	now := float64(time.Now().UnixMilli()) / 1000
	return hour/24*npc.DayLengthS - math.Mod(now, npc.DayLengthS)
}

// spawnSettlement is the settlement nearest the world's spawn (every new
// character starts there).
func spawnSettlement(t *testing.T, w *npc.World) int {
	sp := testTerrain(t).World().Header
	best := 0
	for i, s := range w.T.Settlements {
		b := w.T.Settlements[best]
		if math.Hypot(s.X-float64(sp.SpawnX), s.Z-float64(sp.SpawnZ)) < math.Hypot(b.X-float64(sp.SpawnX), b.Z-float64(sp.SpawnZ)) {
			best = i
		}
	}
	return best
}

func npcOf(w *npc.World, si int, role uint8) int {
	st := w.T.Settlements[si]
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if w.T.NPCs[i].Role == role {
			return i
		}
	}
	return -1
}

func propOf(w *npc.World, si int, kind uint8) *towns.Prop {
	st := w.T.Settlements[si]
	for p := st.PropFirst; p < st.PropFirst+st.Props; p++ {
		if w.T.Props[p].Kind == kind {
			return &w.T.Props[p]
		}
	}
	return nil
}

func (cl *client) npcEntityID(h *harness, i int) uint32 {
	var id uint32
	for k := 0; k < 40 && id == 0; k++ {
		cl.pump(50 * time.Millisecond)
		_ = h.srv.Do(context.Background(), func() {
			if e := h.srv.NPCEntity(i); e != nil {
				id = e.ID
			}
		})
	}
	return id
}

func spawnAt(x, z float64) string { return "?spawn=" + ftoa(x) + "," + ftoa(z) }

func TestTownNPCsTalkShopBountiesInnForge(t *testing.T) {
	w, g := testTowns(t)
	grants := &memGrants{}
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Granter = grants
		c.TimeOffsetS = offsetFor(12) // noon: everyone at work
	})
	si := spawnSettlement(t, w)
	merchant := npcOf(w, si, towns.RoleMerchant)
	keeper := npcOf(w, si, towns.RoleBounty)
	inn := npcOf(w, si, towns.RoleInnkeeper)
	if merchant < 0 || keeper < 0 || inn < 0 {
		t.Fatalf("spawn settlement %d lacks a merchant/keeper/innkeeper", si)
	}

	// The merchant: stand 1.5 m in front of the stall NPC.
	md := w.T.NPCs[merchant]
	a := h.dial(spawnAt(md.WorkX+1.5*math.Cos(md.WorkYaw), md.WorkZ+1.5*math.Sin(md.WorkYaw)))
	a.join(h, "town-a", "Trader")
	// Activation runs twice a second (npcEveryTicks): allow a few rounds.
	for k := 0; k < 30 && !a.seesKind(proto.EntityKindNpc); k++ {
		a.pump(100 * time.Millisecond)
	}
	if !a.seesKind(proto.EntityKindNpc) {
		t.Fatal("no npc entities in the snapshot near the spawn settlement")
	}
	mid := a.npcEntityID(h, merchant)
	if mid == 0 {
		t.Fatal("merchant not active")
	}
	var rec *snapshot.EntState
	for k := range a.frame.Ents {
		if a.frame.Ents[k].ID == mid {
			rec = &a.frame.Ents[k]
		}
	}
	if rec == nil || rec.Name != md.Name || rec.TypeID&0xFF != uint16(towns.RoleMerchant) || rec.Level != md.Merchant {
		t.Fatalf("merchant entity record %+v (want name %q role %d kind %d)", rec, md.Name, towns.RoleMerchant, md.Merchant)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionTalk})
	say := a.nextEvent(EventNPCSay, 3*time.Second)
	shop := a.nextEvent(EventShop, 3*time.Second)
	if say.Value != 1 || len(say.Data) == 0 || shop.Data[0] != 1 || shop.Data[1] == 0 {
		t.Fatalf("talk: say %+v shop %v", say, shop.Data)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionBuy, Arg: 0})
	buy := a.nextEvent(EventPurchase, 3*time.Second)
	if want := w.Wares(merchant)[0].Item; string(buy.Data) != want || len(grants.items) != 1 {
		t.Fatalf("purchase %q grants %v (want %s)", buy.Data, grants.items, want)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionBuy, Arg: 99})
	if r := a.nextEvent(EventTownRefused, 3*time.Second); r.Value != TownRefuseNoSuch {
		t.Fatalf("bad item refusal %d", r.Value)
	}

	// The bounty board: read, accept, accept twice.
	board := propOf(w, si, towns.PropBoard)
	b := h.dial(spawnAt(board.X+1.5*math.Cos(board.Yaw), board.Z+1.5*math.Sin(board.Yaw)))
	b.join(h, "town-b", "Hunter")
	b.pump(300 * time.Millisecond)
	b.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 1})
	list := b.nextEvent(EventBounties, 3*time.Second)
	if list.Data[0] != 1 || list.Data[1] < 3 || list.TargetID != uint32(si) {
		t.Fatalf("bounties %v target %d", list.Data[:2], list.TargetID)
	}
	first := binary.LittleEndian.Uint32(list.Data[2:])
	b.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 2, Arg: first})
	acc := b.nextEvent(EventBountyAccepted, 3*time.Second)
	if acc.TargetID != first || acc.Value <= 0 || len(acc.Data) == 0 {
		t.Fatalf("accepted %+v", acc)
	}
	again := b.nextEvent(EventBounties, 3*time.Second)
	if again.Data[2+13] != 1 { // first record's accepted flag
		t.Fatal("board does not mark the accepted bounty")
	}
	b.send(&proto.Interact{TargetKind: InteractBoard, TargetID: board.ID, Action: 2, Arg: first})
	if r := b.nextEvent(EventTownRefused, 3*time.Second); r.Value != TownRefuseHave {
		t.Fatalf("second accept refusal %d", r.Value)
	}
	// Too far from the merchant (the board is elsewhere in the square).
	if math.Hypot(board.X-md.WorkX, board.Z-md.WorkZ) > npcReachM+2 {
		b.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionTalk})
		if r := b.nextEvent(EventTownRefused, 3*time.Second); r.Value != TownRefuseTooFar {
			t.Fatalf("far talk refusal %d", r.Value)
		}
	}

	// The inn: rest only when hurt.
	id := w.T.NPCs[inn]
	c := h.dial(spawnAt(id.WorkX-1.2*math.Cos(id.WorkYaw+math.Pi), id.WorkZ-1.2*math.Sin(id.WorkYaw+math.Pi)))
	c.join(h, "town-c", "Tired")
	iid := c.npcEntityID(h, inn)
	c.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(iid), Action: ActionRest})
	if r := c.nextEvent(EventTownRefused, 3*time.Second); r.Value != TownRefuseRested && r.Value != TownRefuseTooFar {
		t.Fatalf("rest at full health: refusal %d", r.Value)
	}

	// The forge interaction point (WP14 hooks in; default Event 805).
	forge := propOf(w, si, towns.PropForge)
	bd := w.T.Buildings[forge.Building]
	// 1.3 m from the hearth toward the middle of the forge (reach is 4 m from the eye).
	dx, dz := bd.X-forge.X, bd.Z-forge.Z
	l := math.Hypot(dx, dz)
	fx, fz := forge.X+dx/l*1.3, forge.Z+dz/l*1.3
	d := h.dial(spawnAt(fx, fz))
	d.join(h, "town-d", "Smith")
	d.pump(200 * time.Millisecond)
	d.send(&proto.Interact{TargetKind: InteractStation, TargetID: forge.ID, Action: 1})
	st := d.nextEvent(EventStationOpened, 3*time.Second)
	if st.TargetID != 1 || binary.LittleEndian.Uint64(st.Data) != forge.ID {
		t.Fatalf("station %+v", st)
	}
}

func TestTownNightMerchantsClosedInnOpen(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.TimeOffsetS = offsetFor(1) // 01:00
	})
	si := spawnSettlement(t, w)
	merchant := npcOf(w, si, towns.RoleMerchant)
	md := w.T.NPCs[merchant]
	// At night the merchant is at home: stand next to the home spot (indoors).
	a := h.dial(spawnAt(md.HomeX+0.8, md.HomeZ))
	a.join(h, "night-a", "Owl")
	mid := a.npcEntityID(h, merchant)
	var pos movement.Vec3
	_ = h.srv.Do(context.Background(), func() { pos = h.srv.NPCEntity(merchant).Move.Pos })
	if math.Hypot(pos.X-md.HomeX, pos.Z-md.HomeZ) > 0.01 {
		t.Fatalf("merchant at (%.2f, %.2f) at 01:00, home is (%.2f, %.2f)", pos.X, pos.Z, md.HomeX, md.HomeZ)
	}
	home := w.T.Buildings[md.Home]
	if pos.Y < home.FloorY-1e-9 || pos.Y > home.FloorY+0.01 {
		t.Fatalf("merchant y %.3f, home floor %.3f", pos.Y, home.FloorY)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionTalk})
	if say := a.nextEvent(EventNPCSay, 3*time.Second); say.Value != 0 {
		t.Fatalf("merchant open at night: %+v", say)
	}
	a.noEvent(EventShop, 300*time.Millisecond)
	if !w.Open(npcOf(w, si, towns.RoleInnkeeper), npc.TimeOfDay(float64(time.Now().Unix()), h.srv.cfg.TimeOffsetS)) {
		t.Fatal("the inn is closed at night")
	}
}

func TestMineshaftDescendsIntoItsCave(t *testing.T) {
	w, g := testTowns(t)
	h := newHarness(t, func(c *Config) { c.Ground = g; c.Towns = w })
	var shaft *towns.Structure
	for k := range w.T.Structures {
		if s := &w.T.Structures[k]; s.Kind == towns.StructMineshaft && s.Link >= 0 {
			shaft = s
			break
		}
	}
	if shaft == nil {
		t.Skip("no mineshaft linked to a cave on this world")
	}
	a := h.dial(spawnAt(shaft.X+3, shaft.Z+3))
	a.join(h, "shaft-a", "Delver")
	a.pump(300 * time.Millisecond)
	surface := g.HeightAt(shaft.X+3, shaft.Z+3)
	a.send(&proto.Interact{TargetKind: InteractShaft, TargetID: shaft.ID, Action: 1})
	tp := a.nextEvent(EventTeleport, 2*time.Second)
	if y := proto.CmToMeters(tp.Y); y > surface-5 {
		t.Fatalf("descended to y %.1f, surface %.1f", y, surface)
	}
}
