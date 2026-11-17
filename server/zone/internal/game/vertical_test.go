package game

// CR 038 in-process tests on the official world (seed 20261108) with the
// vertical world: layers, interest between layers, sky-town townsfolk and a
// merchant, fall damage, Depths lava, packs in the layers, the vibe
// explorer's layer filters and landings, safe saved positions. Every place
// comes from the descriptor (the generator may still be tuned).

import (
	"fmt"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/palace"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/vertical"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/chem"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/difficulty"
	"lodestone/server/zone/internal/night"
	"lodestone/server/zone/internal/npc"
)

// testVerticalTowns is testTowns with the vertical world on the cave terrain.
func testVerticalTowns(t *testing.T) (*npc.World, movement.Ground, *worldhost.CaveTerrain) {
	t.Helper()
	ct := testCaveTerrain(t)
	l, err := ct.WithVertical(256, 1)
	if err != nil {
		t.Skipf("no vertical world: %v", err)
	}
	t.Cleanup(l.Close)
	w := testTerrain(t).World()
	b, err := w.TownsBytes()
	if err != nil {
		t.Fatal(err)
	}
	tw, err := towns.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	palace.AppendBoxes(tw, palace.SitesOf(ct.Vertical())) // CR 044
	var sites []npc.Site
	if a, err := structures.ParseAtlas(w.Atlas); err == nil {
		for _, s := range a.Sites {
			sites = append(sites, npc.Site{Index: s.Index, Category: s.Category, Kind: s.Kind, X: s.X, Z: s.Z, Name: s.Name})
		}
	}
	return npc.New(tw, w.Seed, sites), townGround{CaveTerrain: ct, tg: towns.NewGround(ct, tw)}, ct
}

// islandTop: a grove/meadow island's top near its core, and the point.
func islandTop(t *testing.T, ct *worldhost.CaveTerrain) (*vertical.Island, movement.Vec3) {
	t.Helper()
	for i := range ct.Vertical().Islands {
		is := &ct.Vertical().Islands[i]
		if is.Kind != vertical.IslandGrove && is.Kind != vertical.IslandMeadow {
			continue
		}
		y := ct.FloorAt(is.X, is.Top+5, is.Z)
		if ct.LayerAt(is.X, y, is.Z) == vertical.LayerSky {
			return is, movement.Vec3{X: is.X, Y: y, Z: is.Z}
		}
	}
	t.Fatal("no island with a top at its core")
	return nil, movement.Vec3{}
}

// chamberFloor: a dry, walkable point on a chamber floor of layer.
func chamberFloor(t *testing.T, ct *worldhost.CaveTerrain, layer int, lake bool) (*vertical.Chamber, movement.Vec3) {
	t.Helper()
	v := ct.Vertical()
	for i := range v.Chambers {
		c := &v.Chambers[i]
		if c.Layer != layer || (lake && c.LakeE <= 0) {
			continue
		}
		for k := 0; k < 24; k++ {
			e := 0.05
			if !lake {
				e = 0.35 + 0.02*float64(k)
			}
			th := float64(k) * 0.9
			u, w := c.Rx*e*math.Cos(th), c.Rz*e*math.Sin(th)
			x, z := c.X+u*c.C-w*c.S, c.Z+u*c.S+w*c.C
			ct.Layers.Ensure(x, z, 2)
			y := ct.FloorAt(x, c.Floor+3, z)
			if ct.LayerAt(x, y, z) != layer {
				continue
			}
			water := movement.WaterAt(ct.AtLevel(y), x, z)
			if lake == (water > y+1) {
				return c, movement.Vec3{X: x, Y: y, Z: z}
			}
		}
	}
	t.Skipf("no chamber of layer %d (lake %v) found", layer, lake)
	return nil, movement.Vec3{}
}

func TestVerticalLayersOnTheOfficialWorld(t *testing.T) {
	_, _, ct := testVerticalTowns(t)
	v := ct.Vertical()
	if len(v.Islands) == 0 || len(v.Chambers) == 0 || len(v.SurfaceOpenings) == 0 || len(v.Updrafts) == 0 {
		t.Fatalf("descriptor: %d islands, %d chambers, %d openings, %d updrafts", len(v.Islands), len(v.Chambers), len(v.SurfaceOpenings), len(v.Updrafts))
	}
	_, top := islandTop(t, ct)
	if ct.LayerAt(top.X, top.Y, top.Z) != vertical.LayerSky {
		t.Fatal("island top is not the sky layer")
	}
	// Under the island, on the terrain: the surface.
	ground := ct.HeightAt(top.X, top.Z)
	if l := ct.LayerAt(top.X, ground, top.Z); l != vertical.LayerSurface {
		t.Fatalf("terrain under the island is layer %d", l)
	}
	_, fl := chamberFloor(t, ct, vertical.LayerUnder, false)
	if !ct.InCave(fl.X, fl.Y, fl.Z) || ct.SystemAt(fl.X, fl.Y, fl.Z) != -1 {
		t.Fatal("a cavern floor is underground and in no cave system")
	}
	if _, dp := chamberFloor(t, ct, vertical.LayerDepths, false); ct.LayerAt(dp.X, dp.Y, dp.Z) != vertical.LayerDepths {
		t.Fatal("depths floor layer")
	}
	// The updraft field: a lift column lifts 18 m/s halfway up, nothing outside.
	up := vertical.Updrafts(v.Updrafts)
	for _, u := range v.Updrafts {
		if u.Kind != vertical.UpdraftLift {
			continue
		}
		if l := up.LiftAt(u.X, (u.Bottom+u.Top)/2, u.Z); l != u.Lift || l > 20 {
			t.Fatalf("lift %v", l)
		}
		if up.LiftAt(u.X+u.R+1, (u.Bottom+u.Top)/2, u.Z) == u.Lift && u.R < 20 {
			t.Fatal("lift outside the column")
		}
		break
	}
	// Interest: different layers only within layerAOIDY vertically.
	if layerVisible(0, 0, &entView{layer: 1, y: 300}) || !layerVisible(2, -100, &entView{layer: 0, y: -40}) || !layerVisible(1, 500, &entView{layer: 1, y: 0}) {
		t.Fatal("layerVisible")
	}
}

func TestSafeSavedPositions(t *testing.T) {
	_, g, ct := testVerticalTowns(t)
	s := &Server{cfg: Config{Ground: g}}
	o := ct.Vertical().SurfaceOpenings[0]
	in := movement.Vec3{X: o.X + 0.5, Y: ct.HeightAt(o.X+0.5, o.Z), Z: o.Z}
	if !ct.Vertical().SurfaceMasked(in.X, in.Z) {
		t.Fatal("not in the hole")
	}
	p := s.safeSaved("c1", in)
	if ct.Vertical().SurfaceMasked(p.X, p.Z) || math.Hypot(p.X-o.X, p.Z-o.Z) < o.R {
		t.Fatalf("still in the hole: %+v", p)
	}
	is, top := islandTop(t, ct)
	inside := movement.Vec3{X: top.X, Y: top.Y - 8, Z: top.Z}
	if p := s.safeSaved("c2", inside); math.Abs(p.Y-top.Y) > 0.5 {
		t.Fatalf("inside island %d: moved to %+v, top %v", is.Index, p, top.Y)
	}
	if p := s.safeSaved("c3", top); p != top {
		t.Fatalf("a position on the top moved: %+v", p)
	}
}

func TestSkyTownTownsfolkWakeIn3DAndTrade(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	si := -1
	for i := range w.T.Settlements {
		if w.SkySettlement(i, ct.HeightAt) {
			si = i
			break
		}
	}
	if si < 0 {
		t.Skip("no sky town")
	}
	grants := &memGrants{}
	h := newHarness(t, func(c *Config) {
		c.Ground = g
		c.Towns = w
		c.Granter = grants
		c.TimeOffsetS = offsetFor(12)
	})
	st := &w.T.Settlements[si]
	merchant := npcOf(w, si, towns.RoleMerchant)
	if merchant < 0 {
		t.Fatal("sky town without a merchant")
	}
	// Someone on the ground right under the town: its townsfolk stay asleep.
	below := h.dial(fmt.Sprintf("?spawn=%v,%v", st.X, st.Z))
	below.join(h, "sky-below", "Below")
	below.pump(1500 * time.Millisecond)
	var active bool
	h.do(func() { active = h.srv.NPCEntity(merchant) != nil })
	if active {
		t.Fatal("a sky-town merchant woke for a player 400 m below")
	}
	md := w.T.NPCs[merchant]
	x, z := md.WorkX+1.5*math.Cos(md.WorkYaw), md.WorkZ+1.5*math.Sin(md.WorkYaw)
	a := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", x, st.Y+4, z))
	wel := a.join(h, "sky-trader", "Trader")
	if y := proto.CmToMeters(wel.Y); y < st.Y-20 {
		t.Fatalf("spawned at y %v, the town is at %v", y, st.Y)
	}
	mid := a.npcEntityID(h, merchant)
	if mid == 0 {
		t.Fatal("the merchant did not wake for a player in the sky town")
	}
	var npcY float64
	h.do(func() { npcY = h.srv.NPCEntity(merchant).Move.Pos.Y })
	if math.Abs(npcY-st.Y) > 15 {
		t.Fatalf("merchant at y %v, town at %v", npcY, st.Y)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionTalk})
	say := a.nextEvent(EventNPCSay, 3*time.Second)
	shop := a.nextEvent(EventShop, 3*time.Second)
	if say.Value != 1 || shop.Data[0] != 1 {
		t.Fatalf("talk: %+v %v", say, shop.Data)
	}
	a.send(&proto.Interact{TargetKind: InteractNPC, TargetID: uint64(mid), Action: ActionBuy, Arg: 0})
	if buy := a.nextEvent(EventPurchase, 3*time.Second); len(buy.Data) == 0 || len(grants.items) != 1 {
		t.Fatalf("purchase %q grants %v", buy.Data, grants.items)
	}
	// The activity spot hook (Interact 151 -> Event 1703).
	if pr := propOf(w, si, 31); pr != nil {
		c := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", pr.X+1, pr.Y+3, pr.Z))
		c.join(h, "sky-player", "Player")
		c.pump(300 * time.Millisecond)
		c.send(&proto.Interact{TargetKind: InteractActivity, TargetID: pr.ID, Action: 1})
		if ev := c.nextEvent(EventRaceState, 3*time.Second); ev.Value != RaceArmed || ev.TargetID != uint32(pr.ID) {
			t.Fatalf("activity event %+v", ev)
		}
	} else {
		t.Error("no activity spot in the sky town's square")
	}
}

func TestFallDamageAndLava(t *testing.T) {
	_, g, ct := testVerticalTowns(t)
	h := newHarness(t, func(c *Config) { c.Ground = g })
	sp := testTerrain(t).World().Header
	a := h.dial(fmt.Sprintf("?spawn=%v,%v", sp.SpawnX, sp.SpawnZ))
	a.join(h, "faller", "Faller")
	a.pump(300 * time.Millisecond)
	var hp0 float64
	h.do(func() {
		e := h.srv.byChar["faller"].ent
		hp0 = e.cbt.HP
		e.Move.Pos.Y += 40 // a 40 m drop: ~38 m/s at the ground
		e.Move.Mode = movement.ModeAir
		e.prevValid = e.Move
	})
	a.walk(240, 0, 0, nil) // (the walk drains the Event 1700 it sent)
	var hp1, hpMax float64
	h.do(func() { e := h.srv.byChar["faller"].ent; hp1, hpMax = e.cbt.HP, e.cbt.HPMax })
	// ~38 m/s at the ground: (38 - 18) x 3.2 = ~64 % of max health.
	if lost := (hp0 - hp1) / hpMax * 100; lost < 50 || lost > 75 {
		t.Fatalf("a 40 m fall cost %.0f %% (health %v -> %v of %v)", lost, hp0, hp1, hpMax)
	}
	if fallDamagePct(17) != 0 || fallDamagePct(50) < 100 {
		t.Fatal("fall damage curve")
	}
	// The Depths' lava: burning on (Event 1701 value 1), health going down.
	_, lp := chamberFloor(t, ct, vertical.LayerDepths, true)
	b := h.dial(fmt.Sprintf("?spawn=%v,%v,%v", lp.X, lp.Y+1, lp.Z))
	b.join(h, "lava", "Ember")
	ev := b.nextEvent(EventLava, 4*time.Second)
	if ev.Value != 1 {
		t.Fatalf("lava event %+v", ev)
	}
}

func TestLayerPacksAndAreas(t *testing.T) {
	_, g, ct := testVerticalTowns(t)
	raw := testTerrain(t).World().Atlas
	sa, err := structures.ParseAtlas(raw)
	if err != nil {
		t.Fatal(err)
	}
	ca := combat.ParseAtlas(raw, sa)
	n := uint32(1)
	w := combat.NewWorld(combat.Config{Seed: 42}, g, func() uint32 { n++; return n })
	w.BuildFromAtlas(ca)
	surface := len(w.Groups)
	s := &Server{cfg: Config{Ground: g}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	s.addLayerGroups(w)
	per := map[int]int{}
	for _, gr := range w.Groups[surface:] {
		per[gr.Layer]++
		if gr.Layer != vertical.LayerSky && ct.LayerAt(gr.Anchor.X, gr.Anchor.Y, gr.Anchor.Z) != gr.Layer {
			t.Fatalf("group in layer %d stands in layer %d", gr.Layer, ct.LayerAt(gr.Anchor.X, gr.Anchor.Y, gr.Anchor.Z))
		}
		for i := range ca.Sites {
			c := &ca.Sites[i]
			if c.Layer >= 2 && c.IsWaypoint() && math.Hypot(c.X-gr.Anchor.X, c.Z-gr.Anchor.Z) < layerSafeM && math.Abs(c.Y-gr.Anchor.Y) < 40 {
				t.Fatalf("a pack by an underground camp")
			}
		}
	}
	if per[vertical.LayerUnder] == 0 || per[vertical.LayerDepths] == 0 || per[vertical.LayerSky] == 0 {
		t.Fatalf("packs per layer %v", per)
	}
	t.Logf("%d surface groups, layer packs %v", surface, per)
	// Areas per layer: the Depths' are stamped at least at its floor (the top tier).
	m := difficulty.New(&combatdefs.D.Difficulty, ca.WorldSize, ca.SpawnX, ca.SpawnZ, nil)
	geo := m.Geometry("w")
	for layer, floor := range difficulty.LayerFloor {
		c := m.LayerCell(layer, 3000, 3000)
		if got := geo.Propose(difficulty.Claim{Cell: c, PlayerLevel: 1}, nil); got < max(1, floor) {
			t.Fatalf("layer %d proposed %d (floor %d)", layer, got, floor)
		}
		if m.LayerOf(c) != layer {
			t.Fatalf("LayerOf %d", m.LayerOf(c))
		}
	}
	if top := m.Def.Tiers[len(m.Def.Tiers)-1]; top.MinLevel > difficulty.LayerFloor[vertical.LayerDepths] {
		t.Fatal("the Depths' floor is below the top tier")
	}
}

func TestVibeLayerFiltersAndLandings(t *testing.T) {
	w, g, ct := testVerticalTowns(t)
	raw := testTerrain(t).World().Atlas
	sa, _ := structures.ParseAtlas(raw)
	ca := combat.ParseAtlas(raw, sa)
	m := difficulty.New(&combatdefs.D.Difficulty, ca.WorldSize, ca.SpawnX, ca.SpawnZ, nil)
	h := newHarness(t, func(c *Config) {
		c.Dev = true
		c.Ground = g
		c.Towns = w
		c.Explore = realExplore(t, g)
		c.TimeOffsetS = offsetFor(12)
		c.Night = &NightSetup{World: &night.World{Seed: 42, Intensity: 0.5}, Overlay: &chem.Overlay{}, WindDeg: 270, NoDemons: true, Force: -1}
		c.Combat = &CombatSetup{Atlas: ca, Config: combat.Config{Seed: 42}}
		c.Difficulty = &DifficultySetup{Map: m}
	})
	h.srv.SetWorldEvents(false)
	var under, towns, caverns []VibeResult
	h.do(func() {
		s := h.srv
		from := movement.Vec3{X: ca.SpawnX, Z: ca.SpawnZ}
		f := AnyVibe()
		f.Layer = 3 // underground
		under = s.VibeSearch(f, from, 1)
		f = AnyVibe()
		f.Landmark = vibeLandmark("sky_town")
		towns = s.VibeSearch(f, from, 1)
		f.Landmark = vibeLandmark("cavern")
		caverns = s.VibeSearch(f, from, 1)
	})
	if len(under) == 0 || len(towns) == 0 || len(caverns) == 0 {
		t.Fatalf("underground %d, sky towns %d, caverns %d", len(under), len(towns), len(caverns))
	}
	for _, r := range under {
		if r.Layer != 2 {
			t.Fatalf("layer filter returned %s in layer %d", r.Kind, r.Layer)
		}
	}
	for _, r := range towns {
		if r.Layer != 1 || r.Y < 300 {
			t.Fatalf("sky town %+v", r)
		}
	}
	a := h.dial("")
	a.join(h, "vibe-sky", "Composer")
	a.pump(300 * time.Millisecond)
	f := AnyVibe()
	f.Landmark, f.Go = vibeLandmark("sky_town"), true
	tg, arg := f.Pack()
	a.send(&proto.Interact{TargetKind: InteractDev, TargetID: tg, Action: DevActVibeFind, Arg: arg})
	a.nextEvent(EventDevVibe, 5*time.Second)
	var p movement.Vec3
	h.do(func() { p = h.srv.byChar["vibe-sky"].ent.Move.Pos })
	if ct.LayerAt(p.X, p.Y+0.1, p.Z) != vertical.LayerSky || p.Y < 300 {
		t.Fatalf("landed at %+v (layer %d), not on the sky town's island", p, ct.LayerAt(p.X, p.Y, p.Z))
	}
	f.Landmark = vibeLandmark("cavern")
	tg, arg = f.Pack()
	a.send(&proto.Interact{TargetKind: InteractDev, TargetID: tg, Action: DevActVibeFind, Arg: arg})
	a.nextEvent(EventDevVibe, 5*time.Second)
	h.do(func() { p = h.srv.byChar["vibe-sky"].ent.Move.Pos })
	if ct.LayerAt(p.X, p.Y+0.1, p.Z) != vertical.LayerUnder || movement.WaterAt(ct.AtLevel(p.Y), p.X, p.Z) > p.Y {
		t.Fatalf("cavern landing %+v layer %d", p, ct.LayerAt(p.X, p.Y, p.Z))
	}
}
