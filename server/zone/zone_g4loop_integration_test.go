package main

// The G4 loop's item pieces against the real zone binary (WP14 acceptance,
// spec 15 G4: "fight, loot, mine ore and a gem, forge a sunsteel blade,
// socket the gem"): the default world's real terrain, caves and spawn
// town, Postgres with a real character row, one client over WebSocket that
// only sends what a browser would (input frames with attack flags, hit
// claims, Interacts).
//
//  1. Fight: a camp of boars (dev placement outside the spawn town) dies to
//     the starting sword; their personal loot is picked up by walking over it.
//  2. Loot: the nearest world chests open once for this character.
//  3. Mine: sunsteel veins (only where daylight reaches, spec 7) until there
//     is ore for two ingots, and a gem vein.
//  4. Buy the sunsteel blueprint from the spawn town's blacksmith (gold).
//  5. At the town forge: smelt sunsteel ore into ingots, forge the blade.
//  6. Socket the gem, equip the blade.
//  7. Fight with it: the respawned camp; hits land harder (sunsteel x1.2),
//     combat reports the socketed gem's element for the elemental form.
//
// LODESTONE_EVIDENCE=1 prints the run log (docs/evidence/wp14-g4-loop.txt).

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/itemdefs"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
	"lodestone/server/zone/internal/npc"
)

type loopClient struct {
	*itemClient
	dec   snapshot.Decoder
	frame *snapshot.Frame
	seq   uint32
	ackT  uint32
	hits  []*proto.HitResult
}

func dialLoop(t *testing.T, port int, world, char, name, spawn string) *loopClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=%s", port, spawn))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(transport.CloseNormal, "") })
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{AccountID: "acct-" + char, CharacterID: char, CharacterName: name, WorldID: world, Audience: ticket.AudienceZone(itemsZoneID)})
	_ = c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket}))
	w := &loopClient{itemClient: &itemClient{t: t, c: c, msgs: make(chan proto.Message, 16384), ents: map[uint32]string{}}}
	go func() {
		defer close(w.msgs)
		for {
			b, err := c.Recv(context.Background())
			if err != nil {
				return
			}
			if m, err := proto.DecodeMessage(b); err == nil {
				w.msgs <- m
			}
		}
	}()
	return w
}

// pumpL applies snapshots, keeps events and hit results.
func (w *loopClient) pumpL(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				return
			}
			switch x := m.(type) {
			case *proto.Event:
				w.evs = append(w.evs, x)
			case *proto.Snapshot:
				if f, err := w.dec.Apply(x); err == nil {
					w.frame = f
					w.ackT = x.Tick
				}
			case *proto.HitResult:
				w.hits = append(w.hits, x)
			}
		case <-deadline:
			return
		}
	}
}

func (w *loopClient) pos() (x, y, z float64) {
	if w.frame == nil {
		return 0, 0, 0
	}
	return float64(w.frame.Self.X) / 100, float64(w.frame.Self.Y) / 100, float64(w.frame.Self.Z) / 100
}

// step sends n frames (2 per packet) with flags and yaw.
func (w *loopClient) step(n int, flags uint16, yaw float64) {
	for i := 0; i < n; i += 2 {
		fr := make([]proto.InputFrame, 0, 2)
		for k := 0; k < 2; k++ {
			w.seq++
			f := flags
			if k == 1 {
				f &^= proto.InputFlagAttack | proto.InputFlagInteract
			}
			fr = append(fr, proto.InputFrame{Seq: w.seq, Flags: f, Yaw: proto.YawToU16(yaw)})
		}
		_ = w.c.SendReliable(proto.Encode(&proto.Input{AckTick: w.ackT, Frames: fr}))
		w.pumpL(33 * time.Millisecond)
	}
}

func yawTo(fx, fz, tx, tz float64) float64 { return math.Atan2(-(tx - fx), -(tz - fz)) }

// walkTo walks toward (x, z) until within r (or the time runs out).
func (w *loopClient) walkTo(x, z, r float64, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		px, _, pz := w.pos()
		if math.Hypot(x-px, z-pz) <= r {
			w.step(4, 0, 0)
			return true
		}
		w.step(4, proto.InputFlagForward, yawTo(px, pz, x, z))
	}
	return false
}

func (w *loopClient) enemies() []snapshot.EntState {
	var out []snapshot.EntState
	if w.frame != nil {
		for _, e := range w.frame.Ents {
			if e.Kind == proto.EntityKindEnemy && e.HealthPct > 0 {
				out = append(out, e)
			}
		}
	}
	return out
}

// fight swings the sword at the nearest enemy and claims each swing, until
// no enemy is left within 40 m. Returns the damage of every accepted claim.
func (w *loopClient) fight(d time.Duration) []int {
	sword := combatdefs.D.WeaponByKey("sword")
	var dmg []int
	deadline := time.Now().Add(d)
	combo := 0
	for time.Now().Before(deadline) {
		px, py, pz := w.pos()
		var target *snapshot.EntState
		best := 40.0
		for _, e := range w.enemies() {
			if dd := math.Hypot(float64(e.X)/100-px, float64(e.Z)/100-pz); dd < best {
				ee := e
				target, best = &ee, dd
			}
		}
		if target == nil {
			if w.frame != nil {
				w.t.Logf("fight: no enemy within 40 m (self hp %d/%d, enemies in view %d)", w.frame.Self.Health, w.frame.Self.HealthMax, len(w.enemies()))
			}
			break
		}
		tx, tz := float64(target.X)/100, float64(target.Z)/100
		yaw := yawTo(px, pz, tx, tz)
		if best > 2.2 {
			w.step(2, proto.InputFlagForward, yaw)
			continue
		}
		mv := combatdefs.D.MoveOf(sword, "light", combo%3)
		w.step(2, proto.InputFlagAttack, yaw)
		atk := w.seq - 1
		w.step(int(mv.StartupSteps)+2, 0, yaw)
		_ = w.c.SendReliable(proto.Encode(&proto.HitClaim{AttackSeq: atk, AttackID: uint16(mv.ID), TargetID: target.ID, Tick: w.ackT,
			X: proto.MetersToCm(px), Y: proto.MetersToCm(py), Z: proto.MetersToCm(pz), Yaw: proto.YawToU16(yaw)}))
		w.step(int(mv.RecoverySteps)+4, 0, yaw)
		// The zone decides which combo step the press started (a slow
		// press restarts the combo): on "unknown attack", claim the other
		// steps of the same press.
		for k := 1; k < 3; k++ {
			retry := false
			for _, h := range w.hits {
				retry = retry || (!h.Accepted && h.Flags == 4)
			}
			if !retry {
				break
			}
			w.hits = w.hits[:0]
			alt := combatdefs.D.MoveOf(sword, "light", (combo+k)%3)
			_ = w.c.SendReliable(proto.Encode(&proto.HitClaim{AttackSeq: atk, AttackID: uint16(alt.ID), TargetID: target.ID, Tick: w.ackT,
				X: proto.MetersToCm(px), Y: proto.MetersToCm(py), Z: proto.MetersToCm(pz), Yaw: proto.YawToU16(yaw)}))
			w.pumpL(120 * time.Millisecond)
			for _, h := range w.hits {
				if h.Accepted {
					combo = (combo + k) % 3
				}
			}
		}
		combo++
		for _, h := range w.hits {
			if h.Accepted {
				dmg = append(dmg, int(h.Damage))
			} else {
				w.t.Logf("claim refused: reason %d (target %d hp %d%%, dist %.1f)", h.Flags, target.ID, target.HealthPct, best)
			}
		}
		w.hits = w.hits[:0]
	}
	return dmg
}

func (w *loopClient) inv() invJSON { return w.itemClient.inventory() }

func units(inv invJSON) map[string]int {
	m := map[string]int{}
	for _, it := range inv.Items {
		m[it.B] += it.Q
	}
	return m
}

func TestG4LoopForgeSunsteelBlade(t *testing.T) {
	f := newItemFixture(t)
	mod, _ := terrainWasm(t)
	mt, err := mod.Mint(20261108, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	logf := f.logf
	var port int
	var char string
	leave := func(p *loopClient) {
		p.c.Close(transport.CloseNormal, "")
		p.pumpL(100 * time.Millisecond)
		gone(t, port, char)
	}

	// The spawn town, its forge and blacksmith (the client knows these from
	// its own towns buffer; the test reads the same buffer).
	tb, err := mt.World.TownsBytes()
	if err != nil {
		t.Fatal(err)
	}
	tw, err := towns.Parse(tb)
	if err != nil {
		t.Fatal(err)
	}
	si := 0
	for i, s := range tw.Settlements {
		if math.Hypot(s.X-f.spawnX, s.Z-f.spawnZ) < math.Hypot(tw.Settlements[si].X-f.spawnX, tw.Settlements[si].Z-f.spawnZ) {
			si = i
		}
	}
	st := tw.Settlements[si]
	var forge *towns.Prop
	for i := st.PropFirst; i < st.PropFirst+st.Props; i++ {
		if tw.Props[i].Kind == towns.PropForge {
			forge = &tw.Props[i]
			break
		}
	}
	var smith *towns.NPC
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		if tw.NPCs[i].Role == towns.RoleBlacksmith {
			smith = &tw.NPCs[i]
		}
	}
	if forge == nil || smith == nil {
		t.Fatal("spawn settlement lacks a forge or blacksmith")
	}
	// Inside the smithy: 1.3 m from the forge toward the building's middle
	// (where WP20's own forge test stands).
	bd := tw.Buildings[forge.Building]
	dx, dz := bd.X-forge.X, bd.Z-forge.Z
	inX, inZ := forge.X+dx/math.Hypot(dx, dz)*1.3, forge.Z+dz/math.Hypot(dx, dz)*1.3
	logf("spawn settlement %d at (%.0f, %.0f) r %.0f: forge prop %d at (%.1f, %.1f, %.1f), blacksmith %q", si, st.X, st.Z, st.Radius, forge.ID, forge.X, forge.Y, forge.Z, smith.Name)

	// Caves: sunsteel veins and a gem vein with floor in front of them.
	cv, err := worldhost.NewCaves(mt.World, worldhost.CaveOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer cv.Close()
	tr := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{Workers: 1})
	defer tr.Close()
	ct := worldhost.NewCaveTerrain(tr, nil, cv)
	type spot struct {
		v       caves.Vein
		x, y, z float64
	}
	reach := func(v caves.Vein) (spot, bool) {
		nl := math.Hypot(v.NX, v.NZ)
		if nl < 0.3 || v.NY > 0.5 {
			return spot{}, false
		}
		x, z := v.X+v.NX/nl*1.4, v.Z+v.NZ/nl*1.4
		cv.Ensure(x, v.Y, z, 40)
		y := ct.FloorAt(x, v.Y+0.5, z)
		if v.Y-y < 2.2 && v.Y-y > -0.5 {
			return spot{v, x, y, z}, true
		}
		return spot{}, false
	}
	var sun []spot
	var gem *spot
	var gems []spot
	for _, v := range cv.Graph.Veins {
		if len(gems) < 4 && v.Kind == caves.KindGem && v.MaterialName() != "opal" && v.MaterialName() != "moonstone" {
			if s, ok := reach(v); ok {
				gems = append(gems, s)
			}
		}
		if len(sun) < 4 && v.Kind != caves.KindGem && v.MaterialName() == "sunsteel" {
			if s, ok := reach(v); ok {
				sun = append(sun, s)
			}
		}
		if gem == nil && v.Kind == caves.KindGem && v.MaterialName() != "opal" && v.MaterialName() != "moonstone" {
			if s, ok := reach(v); ok {
				gem = &s
			}
		}
	}
	if len(sun) == 0 || gem == nil {
		t.Fatalf("no reachable sunsteel (%d) or gem vein", len(sun))
	}
	logf("caves: %d reachable sunsteel veins, gem vein %d (%s) at depth band %d", len(sun), gem.v.ID, gem.v.MaterialName(), gem.v.Band)

	// The camp: two level-1 boars on open ground 70 m outside the town.
	ang := math.Atan2(f.spawnZ-st.Z, f.spawnX-st.X) + 0.6
	campX, campZ := st.X+(st.Radius+70)*math.Cos(ang), st.Z+(st.Radius+70)*math.Sin(ang)
	char = f.character("Forgewright")
	port = freePort(t)
	z := startItemZone(t, f.bin, f.wasm, f.dbURL, f.world, port,
		fmt.Sprintf("LODESTONE_ZONE_DEBUG_CAMP=%.1f,%.1f,1,boar boar", campX, campZ),
		"LODESTONE_ZONE_DEV_COMBAT=1", "LODESTONE_ZONE_CAMP_RESPAWN_S=8",
		fmt.Sprintf("LODESTONE_ZONE_TIME_OFFSET_S=%.0f", 12.0/24*npc.DayLengthS-math.Mod(float64(time.Now().Unix()), npc.DayLengthS)),
		"LODESTONE_ZONE_VEIN_RESPAWN_MIN=10m", "LODESTONE_ZONE_VEIN_RESPAWN_MAX=11m")
	z.waitLog(t, "dev camp", 5*time.Second)
	cx, cz := campX, campZ
	if l := lineWith(z.logs.String(), "dev camp"); l != "" {
		var rec struct{ X, Z float64 }
		_ = json.Unmarshal([]byte(l), &rec)
		if rec.X != 0 {
			cx, cz = rec.X, rec.Z
		}
	}
	logf("zone up; dev camp of 2 boars at (%.1f, %.1f); character %s", cx, cz, char)

	// ---- 1. Fight -> loot ----
	p := dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f", cx+14, cz))
	p.pumpL(1500 * time.Millisecond)
	start := units(p.inv())
	logf("joined at (%.1f, %.1f): starter inventory %q", cx+14, cz, fmtUnits(start))
	p.walkTo(cx+3, cz, 2, 10*time.Second)
	before := p.fight(40 * time.Second)
	p.pumpL(500 * time.Millisecond)
	// Walk over the loot (personal pickups, auto-taken on touch).
	for k := 0; k < 3; k++ {
		if p.frame == nil {
			break
		}
		for _, e := range p.frame.Ents {
			if e.Kind == proto.EntityKindPickup {
				p.walkTo(float64(e.X)/100, float64(e.Z)/100, 0.6, 6*time.Second)
			}
		}
		p.pumpL(300 * time.Millisecond)
	}
	kills := 0
	for _, e := range p.evs {
		if e.Kind == 201 {
			kills++
		}
	}
	got := grantedUnits(p.itemClient, game.SourceKill)
	logf("fought the camp with the starting sword: %d kills, %d accepted hits, damage %v; kill loot picked up: %q", kills, len(before), before, fmtUnits(got))
	if kills < 2 || len(got) == 0 {
		t.Fatalf("fight -> loot failed: %d kills, loot %v\n%s", kills, got, tail(z.logs.String(), 30))
	}

	// ---- 2. Loot chests near the town until there is gold for the blueprint ----
	price := 0
	for _, w := range npc.SmithWares() {
		if w.Item == "blueprint:sunsteel_blade" {
			price = int(w.Price)
		}
	}
	cs := f.pickContainers(port, 4, 1)
	for _, c := range cs {
		if p.inv().Gold >= price {
			break
		}
		leave(p)
		p = dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f", c.X+1, c.Z))
		p.pumpL(1000 * time.Millisecond)
		// The zone lists containers from its terrain cache: right after a
		// reconnect far away the chunk may still be generating.
		for k := 0; k < 30 && p.count(game.EventContainerOpened) == 0; k++ {
			p.interact(game.InteractContainer, c.ID, game.ActionUse, 0)
			p.step(10, 0, 0)
		}
		p.pumpL(500 * time.Millisecond)
		logf("opened a container at (%.0f, %.0f): %q; gold now %d", c.X, c.Z, fmtUnits(grantedUnits(p.itemClient, game.SourceContainer)), p.inv().Gold)
	}

	// ---- 3. Mine sunsteel and a gem ----
	// mine reconnects underground at the vein's standing point and swings
	// until it breaks. A dev spawn underground right after a reconnect can
	// land before the cave cells are built (the client then stands
	// elsewhere: "too far" refusals); that spawn is retried.
	mine := func(s spot) map[string]int {
		for attempt := 0; attempt < 3; attempt++ {
			leave(p)
			p = dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f,%.2f", s.x, s.y+0.3, s.z))
			p.pumpL(1500 * time.Millisecond)
			far := 0
			for i := 0; i < 80 && p.count(game.EventVeinBreak) == 0 && far < 12; i++ {
				p.interact(game.InteractVein, s.v.ID, game.ActionUse, 0)
				p.step(10, 0, 0)
				far = 0
				for _, e := range p.evs {
					if e.Kind == game.EventMineRefused && e.Value == game.RefuseFar {
						far++
					}
				}
			}
			if p.count(game.EventVeinBreak) > 0 {
				for i := 0; i < 20 && len(grantedUnits(p.itemClient, game.SourceVein)) == 0; i++ {
					p.step(6, 0, 0)
				}
				return grantedUnits(p.itemClient, game.SourceVein)
			}
			px, py, pz := p.pos()
			t.Logf("vein %d: spawn attempt %d not in reach (%d far refusals; at (%.1f,%.1f,%.1f), stand (%.1f,%.1f,%.1f), vein (%.1f,%.1f,%.1f)); reconnecting", s.v.ID, attempt+1, far, px, py, pz, s.x, s.y, s.z, s.v.X, s.v.Y, s.v.Z)
		}
		return nil
	}
	for _, s := range sun {
		if units(p.inv())["ore:sunsteel"] >= 4 {
			break
		}
		g := mine(s)
		logf("mined sunsteel vein %d (%.0f, %.0f, %.0f): %q", s.v.ID, s.x, s.y, s.z, fmtUnits(g))
	}
	for i := range gems {
		g := mine(gems[i])
		logf("mined %s vein %d: %q", gems[i].v.MaterialName(), gems[i].v.ID, fmtUnits(g))
		if len(g) > 0 {
			gem = &gems[i]
			break
		}
	}
	if gem == nil {
		t.Fatal("no gem mined")
	}
	inv := units(p.inv())
	gemKey := ""
	for k := range inv {
		if strings.HasPrefix(k, "gem:"+gem.v.MaterialName()+":") {
			gemKey = k
		}
	}
	if inv["ore:sunsteel"] < 4 || gemKey == "" {
		t.Fatalf("mining short: %q", fmtUnits(inv))
	}

	// ---- 4. Buy the blueprint at the blacksmith ----
	leave(p)
	// Into the smithy through its door (the smith works inside, between
	// forge and anvil), like a player walks in.
	sb := tw.Buildings[forge.Building]
	if smith.Work >= 0 && smith.Work < len(tw.Buildings) {
		sb = tw.Buildings[smith.Work]
	}
	ox, oz := sb.Door(1.5)
	ix, iz := sb.Door(-1.5)
	p = dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f", ox, oz))
	p.pumpL(1500 * time.Millisecond)
	p.walkTo(ix, iz, 0.5, 5*time.Second)
	var smithEnt uint32
	for k := 0; k < 40 && smithEnt == 0; k++ {
		p.step(4, 0, 0)
		if p.frame != nil {
			for _, e := range p.frame.Ents {
				if e.Kind == proto.EntityKindNpc && e.Name == smith.Name {
					smithEnt = e.ID
				}
			}
		}
	}
	if smithEnt == 0 {
		t.Fatal("blacksmith not active")
	}
	// Stand where WP20's own tests stand (1.5 m in front of the smith's work
	// spot) and talk until it is in reach (it moves between anvil and forge).
	var shop *proto.Event
	for k := 0; k < 50 && shop == nil; k++ {
		p.interact(game.InteractNPC, uint64(smithEnt), game.ActionTalk, 0)
		p.step(10, 0, 0)
		if k%5 == 4 {
			for _, e := range p.frame.Ents {
				if e.ID == smithEnt {
					px, py, pz := p.pos()
					t.Logf("talk attempt %d: me (%.1f,%.1f,%.1f) smith (%.1f,%.1f,%.1f)", k, px, py, pz, float64(e.X)/100, float64(e.Y)/100, float64(e.Z)/100)
					p.walkTo(float64(e.X)/100, float64(e.Z)/100, 1.5, 2*time.Second)
				}
			}
		}
		for _, e := range p.evs {
			if e.Kind == game.EventShop {
				shop = e
			}
		}
	}
	if shop == nil {
		t.Fatal("the blacksmith never showed its wares")
	}
	idx := -1
	for i, w := range decodeShop(shop.Data) {
		if w == "blueprint:sunsteel_blade" {
			idx = i
		}
	}
	gold0 := p.inv().Gold
	p.interact(game.InteractNPC, uint64(smithEnt), game.ActionBuy, uint32(idx))
	p.last(game.EventPurchase, 3*time.Second)
	p.pumpL(300 * time.Millisecond)
	logf("bought blueprint:sunsteel_blade from %s for %d gold (gold %d -> %d)", smith.Name, price, gold0, p.inv().Gold)
	if units(p.inv())["blueprint:sunsteel_blade"] != 1 {
		t.Fatal("no blueprint")
	}

	// ---- 5. Smelt and forge at the town forge ----
	leave(p)
	p = dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f", inX, inZ))
	p.pumpL(1500 * time.Millisecond)
	p.interact(game.InteractStation, forge.ID, 1, 0)
	if ev := p.last(game.EventStationOpened, 3*time.Second); ev.TargetID != game.StationForge {
		t.Fatalf("station %+v", ev)
	}
	smelt, blade := itemdefs.D.Recipe("smelt_sunsteel"), itemdefs.D.Recipe("forge_sunsteel_blade")
	p.interact(game.InteractCraft, 0, game.CraftActCraft, uint32(smelt.ID))
	p.interact(game.InteractCraft, 0, game.CraftActCraft, uint32(smelt.ID))
	p.pumpL(400 * time.Millisecond)
	logf("smelted at the forge: %q", fmtUnits(units(p.inv())))
	p.interact(game.InteractCraft, 0, game.CraftActCraft, uint32(blade.ID))
	var cr *proto.Event
	for k := 0; k < 40 && cr == nil; k++ {
		p.pumpL(100 * time.Millisecond)
		for _, e := range p.evs {
			if e.Kind == game.EventCrafted && e.TargetID == uint32(blade.ID) {
				cr = e
			}
		}
	}
	if cr == nil {
		t.Fatalf("no forge result (refusals %d)", p.count(game.EventItemRefused))
	}
	var made struct {
		H uint32   `json:"h"`
		B string   `json:"b"`
		R int      `json:"r"`
		K []string `json:"k"`
	}
	_ = json.Unmarshal(cr.Data, &made)
	logf("forged %s (rarity %s, %d socket(s))", made.B, itemdefs.D.Rarities[made.R].Name, len(made.K))
	if made.B != "weapon:sunsteel_blade" || len(made.K) < 1 {
		t.Fatalf("forge result %+v (refusals %d)", made, p.count(game.EventItemRefused))
	}

	// ---- 6. Socket the gem, equip ----
	var gemH uint32
	for _, it := range p.inv().Items {
		if it.B == gemKey {
			gemH = it.H
		}
	}
	p.interact(game.InteractItem, uint64(made.H), game.ItemActEquip, 0)
	p.interact(game.InteractItem, uint64(made.H)|uint64(gemH)<<32, game.ItemActSocket, 0)
	p.pumpL(500 * time.Millisecond)
	var eq struct {
		S string
		K []string
	}
	for _, it := range p.inv().Items {
		if it.H == made.H {
			eq.S, eq.K = it.S, it.Sock
		}
	}
	sync := p.last(212, 3*time.Second).Data
	gemEl := int8(sync[2+1+8]) // combat_sync: version, active, loadout 0: weapon id, 4 x u16 spells, i8 gem
	logf("equipped in %s with sockets %v; combat_sync loadout 1: weapon id %d, socketed gem element %d (%s)", eq.S, eq.K, sync[2], gemEl, combatdefs.D.Elements[max(0, int(gemEl))])
	if eq.S != "eq:main0" || len(eq.K) == 0 || eq.K[0] != gemKey || int(gemEl) != itemdefs.D.Gem(gem.v.MaterialName()).Element {
		t.Fatalf("equip/socket: %+v gem el %d", eq, gemEl)
	}

	// ---- 7. Fight with it ----
	leave(p)
	p = dialLoop(t, port, f.world, char, "Forgewright", fmt.Sprintf("%.2f,%.2f", cx+14, cz))
	p.pumpL(1500 * time.Millisecond)
	p.walkTo(cx+3, cz, 2, 15*time.Second)
	for k := 0; k < 20 && len(p.enemies()) == 0; k++ {
		p.step(10, 0, 0) // the camp respawns 8 s after it was cleared
	}
	after := p.fight(40 * time.Second)
	kills2 := 0
	for _, e := range p.evs {
		if e.Kind == 201 {
			kills2++
		}
	}
	avg := func(v []int) float64 {
		s := 0
		for _, x := range v {
			s += x
		}
		return float64(s) / math.Max(1, float64(len(v)))
	}
	logf("fought the respawned camp with the Sunsteel Blade: %d kills, damage %v (mean %.1f vs %.1f with the starting sword)", kills2, after, avg(after), avg(before))
	if kills2 < 1 || avg(after) <= avg(before) {
		t.Fatalf("fight with the blade: kills %d, mean %.1f vs %.1f", kills2, avg(after), avg(before))
	}
	final := f.dbUnits(char)
	logf("Postgres holds: %q", fmtUnits(final))
	if final["weapon:sunsteel_blade"] != 1 || final["blueprint:sunsteel_blade"] != 1 {
		t.Fatal("blade not persisted")
	}
	logf("PASS: fight -> loot -> mine sunsteel + %s -> buy blueprint -> smelt -> forge Sunsteel Blade -> socket -> equip -> fight", gem.v.MaterialName())
	if os.Getenv("LODESTONE_EVIDENCE") == "1" {
		fmt.Print(f.log.String())
	}
}

// gone waits until the zone has let the character go (a new connection
// while the old session is still joined would continue from its position:
// WP03's duplicate-login rule).
func gone(t *testing.T, port int, char string) {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var info struct {
			Online bool `json:"online"`
		}
		_ = json.Unmarshal([]byte(get(t, fmt.Sprintf("http://127.0.0.1:%d/debug/items?char=%s", port, char))), &info)
		if !info.Online {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("character never left the zone")
}

func decodeShop(b []byte) []string {
	if len(b) < 2 {
		return nil
	}
	n := int(b[1])
	o := 2
	var out []string
	for i := 0; i < n && o+2 <= len(b); i++ {
		l := int(binary.LittleEndian.Uint16(b[o:]))
		out = append(out, string(b[o+2:o+2+l]))
		o += 2 + l + 6
	}
	return out
}
