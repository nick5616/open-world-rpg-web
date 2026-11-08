package main

// Towers across a process boundary (WP12): the real zone binary builds the
// structure overlay from its atlas; a client in this test process builds its
// own overlay from its own worldhost instance of the same wasm, predicts a
// walk up a tower wall on it, and must agree with the server to the
// centimeter (the climb is the steepest ground in the world, so any
// disagreement between the hosts' overlays shows up here first). Standing
// on the top unlocks the tower (Event 600, progress 603); a fast-travel
// Interact then brings the player back to the top (teleport, Event 2).

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/explore"
	"lodestone/server/zone/internal/game"
)

func TestZoneProcessTowerClimbAndFastTravel(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	mod, wasmPath := terrainWasm(t)
	const seed = 4242
	mt, err := mod.Mint(seed, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	local := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{Workers: 1})
	defer local.Close()
	atlas, err := structures.ParseAtlas(mt.World.Atlas)
	if err != nil {
		t.Fatal(err)
	}
	overlay, towerSites := structures.Towers(atlas, local)
	ground := structures.Wrap(local, overlay)
	tw := overlay.At(0).(*structures.Radial)
	towerSite := towerSites[0]

	bin := buildZone(t)
	port := freePort(t)
	world := fmt.Sprintf("itest-explore-%d", time.Now().UnixNano())
	zoneID := "zone-itest-explore"
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID="+zoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_WORLD_SEED="+strconv.Itoa(seed),
		"LODESTONE_GEN_VERSION=dev",
		"LODESTONE_WORLDGEN_WASM="+wasmPath,
		"LODESTONE_ZONE_EXIT_AFTER=60s", // WP10: climbing with a rest on the ledge takes ~25 s of input
		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_ZONE_DEBUG_RAIN=0", // WP10: the prediction below assumes dry weather
		"LODESTONE_ZONE_NO_REDIS=1",
		"LODESTONE_ZONE_WT_ADDR=off",
	)
	logs := &strings.Builder{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		if t.Failed() {
			t.Logf("zone logs:\n%s", logs.String())
		}
	}()
	waitHealthy(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if !strings.Contains(logs.String(), `"towers":`+strconv.Itoa(overlay.Len())) {
		t.Fatalf("zone should build the same %d towers", overlay.Len())
	}

	// Spawn 3 m outside the tower's footprint on its uphill side (WP10: the
	// walls are climbed with stamina, and on a slope the downhill face is
	// taller than one wheel climbs; the uphill face plus a rest on the ledge
	// is the intended route).
	best, ang := math.Inf(-1), 0.0
	for k := 0; k < 16; k++ {
		a := float64(k) * math.Pi / 8
		if h := ground.HeightAt(tw.CX+math.Cos(a)*(tw.MaxR+3), tw.CZ+math.Sin(a)*(tw.MaxR+3)); h > best {
			best, ang = h, a
		}
	}
	sx, sz := tw.CX+math.Cos(ang)*(tw.MaxR+3), tw.CZ+math.Sin(ang)*(tw.MaxR+3)
	dx, dz := -math.Cos(ang), -math.Sin(ang) // toward the axis
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=%s,%s", port, strconv.FormatFloat(sx, 'f', -1, 64), strconv.FormatFloat(sz, 'f', -1, 64)))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(transport.CloseNormal, "")
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{CharacterID: "itest-climber", CharacterName: "Climber", WorldID: world, Audience: ticket.AudienceZone(zoneID)})
	if err := c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket})); err != nil {
		t.Fatal(err)
	}
	var dec snapshot.Decoder
	var last *snapshot.Frame
	var lastAck uint32
	events := map[uint16][]*proto.Event{}
	recv := func(d time.Duration) proto.Message {
		ctx, cancel := context.WithTimeout(context.Background(), d)
		defer cancel()
		b, err := c.Recv(ctx)
		if err != nil {
			return nil
		}
		m, err := proto.DecodeMessage(b)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		switch v := m.(type) {
		case *proto.Snapshot:
			f, err := dec.Apply(v)
			if err != nil {
				t.Fatalf("apply: %v", err)
			}
			last, lastAck = f, v.AckInputSeq
		case *proto.Event:
			events[v.Kind] = append(events[v.Kind], v)
		}
		return m
	}
	w, ok := recv(10 * time.Second).(*proto.Welcome)
	if !ok {
		t.Fatal("no welcome")
	}
	g0 := ground.HeightAt(sx, sz)
	if w.Y != proto.MetersToCm(g0) {
		t.Fatalf("welcome y %d cm, overlay ground %v", w.Y, g0)
	}

	// Walk east (+x) into the tower and climb it the WP10 way: up the lower
	// wall with stamina, rest on the ledge until the wheel is full, up the
	// upper wall, mantle onto the top, walk to the axis. Predict every step
	// locally (movement.PlanClimb; the zone runs with rain off).
	face := math.Atan2(-dx, -dz) // forward = (-sin yaw, -cos yaw) = (dx, dz)
	sim := movement.NewState(movement.Vec3{X: sx, Y: g0, Z: sz})
	faceYaw := proto.U16ToYaw(proto.YawToU16(face)) // plan with the angle the zone decodes
	plan, _ := movement.PlanClimb(sim, faceYaw, ground, func(s movement.State) bool {
		return s.Pos.Y >= tw.TopY-1e-6 && (s.Pos.X-tw.CX)*dx+(s.Pos.Z-tw.CZ)*dz >= 0
	}, 5000)
	var frames []proto.InputFrame
	maxY := sim.Pos.Y
	climbed := false
	for i, fl := range plan {
		f := proto.InputFrame{Seq: uint32(i + 1), Flags: fl, Yaw: proto.YawToU16(face)}
		frames = append(frames, f)
		sim = movement.StepFrame(sim, f, ground)
		maxY = math.Max(maxY, sim.Pos.Y)
		climbed = climbed || sim.Mode == movement.ModeClimb
	}
	if !climbed {
		t.Fatal("the tower walls were not climbed (WP10)")
	}
	total := uint32(len(frames))
	go func() {
		for i := 0; i < len(frames); i += 2 {
			_ = c.SendUnreliable(proto.Encode(&proto.Input{Frames: frames[max(i-1, 0):min(i+2, len(frames))]}))
			time.Sleep(33 * time.Millisecond)
		}
	}()
	deadline := time.Now().Add(time.Duration(len(frames))*time.Second/30 + 15*time.Second)
	for lastAck != total && time.Now().Before(deadline) {
		recv(time.Second)
	}
	if lastAck != total {
		t.Fatalf("server acked %d of %d frames", lastAck, total)
	}
	if last.Self.X != proto.MetersToCm(sim.Pos.X) || last.Self.Y != proto.MetersToCm(sim.Pos.Y) || last.Self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("server %d,%d,%d cm != predicted %.4f,%.4f,%.4f m", last.Self.X, last.Self.Y, last.Self.Z, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)
	}
	if math.Abs(sim.Pos.Y-tw.TopY) > 1e-9 {
		t.Fatalf("walk should end on the top: y %v, top %v", sim.Pos.Y, tw.TopY)
	}
	t.Logf("climbed %.2f m in %d steps (%.1f s); server agrees to the cm", tw.TopY-g0, total, float64(total)/60)

	for len(events[game.EventTowerUnlocked]) == 0 && time.Now().Before(deadline) {
		recv(time.Second)
	}
	if ev := events[game.EventTowerUnlocked]; len(ev) != 1 || int(ev[0].TargetID) != towerSite || ev[0].Y != proto.MetersToCm(tw.TopY) {
		t.Fatalf("tower unlocked events %+v (want site %d)", ev, towerSite)
	}
	pe := events[game.EventProgress]
	p, revealed, err := explore.DecodeProgress(pe[len(pe)-1].Data)
	if err != nil || !p.Towers.Has(towerSite) || revealed != 1<<atlas.Sites[towerSite].Region {
		t.Fatalf("progress %+v revealed %b err %v", p, revealed, err)
	}

	// Walk off the top (west), then fast travel back.
	back := make([]proto.InputFrame, 0, 300)
	for i := uint32(1); i <= 300; i++ {
		back = append(back, proto.InputFrame{Seq: total + i, Flags: proto.InputFlagForward, Yaw: proto.YawToU16(math.Pi / 2)})
	}
	go func() {
		for i := 0; i < len(back); i += 2 {
			_ = c.SendUnreliable(proto.Encode(&proto.Input{Frames: back[max(i-1, 0):min(i+2, len(back))]}))
			time.Sleep(33 * time.Millisecond) // 30 packets/s: the zone rate-limits Input
		}
	}()
	deadline = time.Now().Add(15 * time.Second)
	for lastAck != total+uint32(len(back)) && time.Now().Before(deadline) {
		recv(time.Second)
	}
	if d := math.Hypot(float64(last.Self.X)/100-tw.CX, float64(last.Self.Z)/100-tw.CZ); d < tw.MaxR {
		t.Fatalf("should have walked off the tower: %.1f m from its axis", d)
	}
	if err := c.SendReliable(proto.Encode(&proto.Interact{TargetKind: game.InteractSite, TargetID: uint64(towerSite), Action: game.ActionFastTravel})); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for len(events[game.EventTeleport]) == 0 && time.Now().Before(deadline) {
		recv(time.Second)
	}
	tp := events[game.EventTeleport]
	if len(tp) != 1 || tp[0].EntityID != w.EntityID || tp[0].X != proto.MetersToCm(tw.CX) || tp[0].Y != proto.MetersToCm(tw.TopY) {
		t.Fatalf("teleport %+v", tp)
	}
	if d := events[game.EventFastTravelDenied]; len(d) != 0 {
		t.Fatalf("denied %+v", d[0].ToJSON())
	}
}
