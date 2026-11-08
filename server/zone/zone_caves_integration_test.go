package main

// Caves and mining across process boundaries (WP09): the real zone binary
// on the default world (seed 20261108) and a scratch Postgres. A client
// spawns in front of a vein deep in a cave, mines it over the wire, gets
// its drop and the WorldEdits; the edit lands in world_edits; the zone is
// killed and restarted and restores the mined vein (a late client gets the
// active edit on first interest); then the vein respawns on its short test
// schedule, clients get the expiry and the row is deleted.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/accountapi/dbtest"
	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/zone/internal/game"
)

type caveZone struct {
	cmd  *exec.Cmd
	logs *strings.Builder
	port int
}

func startCaveZone(t *testing.T, bin, wasm, dbURL, world string, port int) *caveZone {
	t.Helper()
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID=zone-itest-caves",
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_WORLD_SEED=20261108",
		"LODESTONE_GEN_VERSION=dev",
		"LODESTONE_WORLDGEN_WASM="+wasm,
		"LODESTONE_PG_URL="+dbURL,
		"LODESTONE_ZONE_NO_REDIS=1",
		"LODESTONE_ZONE_WT_ADDR=off",
		"LODESTONE_ZONE_EXIT_AFTER=60s",
		// Spec 7 says 6-24 h; the test proves the schedule with seconds.
		"LODESTONE_ZONE_VEIN_RESPAWN_MIN=14s",
		"LODESTONE_ZONE_VEIN_RESPAWN_MAX=15s",
	)
	z := &caveZone{cmd: cmd, logs: &strings.Builder{}, port: port}
	cmd.Stdout, cmd.Stderr = z.logs, z.logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	waitHealthy(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	return z
}

type wireClient struct {
	t    *testing.T
	c    transport.Conn
	msgs chan proto.Message
	evs  []*proto.Event
	eds  []*proto.WorldEdits
}

func dialCave(t *testing.T, port int, world, char string, x, y, z float64) *wireClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	q := fmt.Sprintf("?spawn=%s,%s,%s", strconv.FormatFloat(x, 'f', -1, 64), strconv.FormatFloat(y, 'f', -1, 64), strconv.FormatFloat(z, 'f', -1, 64))
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws%s", port, q))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(transport.CloseNormal, "") })
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{CharacterID: char, CharacterName: char, WorldID: world, Audience: ticket.AudienceZone("zone-itest-caves")})
	if err := c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket})); err != nil {
		t.Fatal(err)
	}
	w := &wireClient{t: t, c: c, msgs: make(chan proto.Message, 4096)}
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

func (w *wireClient) pump(d time.Duration) {
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
			case *proto.WorldEdits:
				w.eds = append(w.eds, x)
			}
		case <-deadline:
			return
		}
	}
}

func (w *wireClient) count(kind uint16) int {
	n := 0
	for _, e := range w.evs {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (w *wireClient) editFor(vein uint64) *proto.EditRecord {
	var out *proto.EditRecord
	for _, we := range w.eds {
		for i := range we.Edits {
			if we.Edits[i].TargetID == vein {
				out = &we.Edits[i]
			}
		}
	}
	return out
}

func TestZoneProcessCavesMining(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	mod, wasmPath := terrainWasm(t)
	pool, dbURL := dbtest.Postgres(t)
	ctx := context.Background()

	// A minted-looking world row so world_edits can reference it.
	mt, err := mod.Mint(20261108, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	var world string
	if err := pool.QueryRow(ctx, `INSERT INTO worlds (name, seed, spec, gen_version, atlas_hash) VALUES ($1, 20261108, $2::jsonb, $3, $4) RETURNING id::text`,
		mt.Name, string(mt.Spec), mt.GenVersion, mt.AtlasHash).Scan(&world); err != nil {
		t.Fatal(err)
	}

	// The client's own view of the caves: pick a vein deep in a chamber with
	// floor in front of it.
	tr := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{Workers: 1})
	defer tr.Close()
	cv, err := worldhost.NewCaves(mt.World, worldhost.CaveOptions{Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer cv.Close()
	ct := worldhost.NewCaveTerrain(tr, nil, cv)
	var vein caves.Vein
	var sx, sy, sz float64
	for _, v := range cv.Graph.Veins {
		nl := math.Hypot(v.NX, v.NZ)
		if v.Band < 1 || nl < 0.3 || v.NY > 0.5 {
			continue
		}
		x, z := v.X+v.NX/nl*1.4, v.Z+v.NZ/nl*1.4
		cv.Ensure(x, v.Y, z, 40)
		y := ct.FloorAt(x, v.Y+0.5, z)
		if v.Y-y < 2.2 && v.Y-y > -0.5 {
			vein, sx, sy, sz = v, x, y, z
			break
		}
	}
	if vein.ID == 0 {
		t.Fatal("no reachable vein")
	}
	bin := buildZone(t)
	port := freePort(t)
	z1 := startCaveZone(t, bin, wasmPath, dbURL, world, port)

	a := dialCave(t, port, world, "itest-miner", sx, sy+0.3, sz)
	a.pump(500 * time.Millisecond)
	swings := 0
	for a.count(game.EventVeinBreak) == 0 && swings < 40 {
		if err := a.c.SendReliable(proto.Encode(&proto.Interact{TargetKind: game.InteractVein, TargetID: vein.ID, Action: game.ActionUse})); err != nil {
			t.Fatal(err)
		}
		swings++
		a.pump(320 * time.Millisecond)
	}
	if a.count(game.EventVeinBreak) != 1 || a.count(game.EventDropSpawned) != 1 {
		t.Fatalf("no break after %d swings (events %d)\nlogs:\n%s", swings, len(a.evs), z1.logs.String())
	}
	ed := a.editFor(vein.ID)
	if ed == nil || ed.Kind != proto.EditKindVeinMined {
		t.Fatalf("no WorldEdits for the vein")
	}
	brokeAt := time.Now()
	respawnAt := time.UnixMicro(int64(ed.ExpiresAt * 1000))
	if d := respawnAt.Sub(brokeAt); d < 12*time.Second || d > 16*time.Second {
		t.Fatalf("respawn in %v, want the configured 14-15 s", d)
	}
	a.pump(1500 * time.Millisecond) // auto-pickup + write-behind
	if a.count(game.EventItemGranted) != 1 {
		t.Fatalf("drop not granted (%d grants)", a.count(game.EventItemGranted))
	}
	var rows int
	var target, kind string
	var params []byte
	deadline := time.Now().Add(5 * time.Second)
	for rows == 0 && time.Now().Before(deadline) {
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM world_edits WHERE world_id = $1::uuid`, world).Scan(&rows)
		time.Sleep(100 * time.Millisecond)
	}
	if err := pool.QueryRow(ctx, `SELECT target_id::text, kind, params FROM world_edits WHERE world_id = $1::uuid`, world).Scan(&target, &kind, &params); err != nil || rows != 1 {
		t.Fatalf("world_edits rows %d: %v", rows, err)
	}
	var p struct{ X, Y, Z, R float32 }
	_ = json.Unmarshal(params, &p)
	if target != strconv.FormatUint(vein.ID, 10) || kind != "vein_mined" || p.R != game.CarveRadiusM || p.X != float32(vein.X) {
		t.Fatalf("row target %s kind %s params %s", target, kind, params)
	}

	// Kill the zone and start it again on the same database.
	_ = z1.cmd.Process.Kill()
	_ = z1.cmd.Wait()
	z2 := startCaveZone(t, bin, wasmPath, dbURL, world, port)
	if !strings.Contains(z2.logs.String(), "world edits restored") {
		time.Sleep(300 * time.Millisecond)
	}
	if !strings.Contains(z2.logs.String(), "world edits restored") {
		t.Fatalf("restart did not restore edits; logs:\n%s", z2.logs.String())
	}
	b := dialCave(t, port, world, "itest-late", sx, sy+0.3, sz)
	b.pump(1200 * time.Millisecond)
	if e := b.editFor(vein.ID); e == nil || e.ExpiresAt <= float64(time.Now().UnixMicro())/1000 {
		t.Fatalf("late client did not get the active edit after restart: %+v", e)
	}
	// Mining it again is refused: still mined after the restart.
	_ = b.c.SendReliable(proto.Encode(&proto.Interact{TargetKind: game.InteractVein, TargetID: vein.ID, Action: game.ActionUse}))
	b.pump(400 * time.Millisecond)
	refused := false
	for _, e := range b.evs {
		if e.Kind == game.EventMineRefused && e.Value == game.RefuseMined && binary.LittleEndian.Uint64(e.Data) == vein.ID {
			refused = true
		}
	}
	if !refused {
		t.Fatal("restored vein was minable")
	}

	// Respawn on schedule: expiry delta, row deleted, minable again.
	for time.Now().Before(respawnAt.Add(3 * time.Second)) {
		b.pump(200 * time.Millisecond)
		if e := b.editFor(vein.ID); e != nil && e.ExpiresAt <= float64(time.Now().UnixMicro())/1000 {
			break
		}
	}
	e := b.editFor(vein.ID)
	if e == nil || e.ExpiresAt > float64(time.Now().UnixMicro())/1000 {
		t.Fatalf("no expiry delta by %v", time.Since(brokeAt))
	}
	respawnedAfter := time.Since(brokeAt)
	deadline = time.Now().Add(5 * time.Second)
	for rows != 0 && time.Now().Before(deadline) {
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM world_edits WHERE world_id = $1::uuid`, world).Scan(&rows)
		time.Sleep(100 * time.Millisecond)
	}
	if rows != 0 {
		t.Fatalf("world_edits row not deleted after respawn")
	}
	b.evs = nil
	_ = b.c.SendReliable(proto.Encode(&proto.Interact{TargetKind: game.InteractVein, TargetID: vein.ID, Action: game.ActionUse}))
	b.pump(400 * time.Millisecond)
	if b.count(game.EventVeinHit) != 1 {
		t.Fatalf("respawned vein not minable (events %+v)", b.evs)
	}
	var dc struct {
		Mining game.MiningStatus `json:"mining"`
	}
	_ = json.Unmarshal([]byte(get(t, fmt.Sprintf("http://127.0.0.1:%d/debug/caves", port))), &dc)
	msg := fmt.Sprintf("[caves-itest] vein %x (%s, band %d, hp %d) mined in %d swings over the wire; respawnAt %s after the break (configured 14-15 s); world_edits row written, restored after kill+restart (late client got the active edit, re-mine refused), respawned after %.1f s, row deleted, minable again",
		vein.ID, vein.MaterialName(), vein.Band, vein.HP, swings, respawnAt.Sub(brokeAt).Round(time.Millisecond), respawnedAfter.Seconds())
	fmt.Println(msg)
	if out := os.Getenv("LODESTONE_CAVES_EVIDENCE"); out != "" {
		_ = os.WriteFile(out, []byte(msg+"\n\n--- zone (first run) log excerpt ---\n"+grepLines(z1.logs.String(), "vein", "caves ready", "world edits")+"\n--- zone (after restart) log excerpt ---\n"+grepLines(z2.logs.String(), "vein", "caves ready", "world edits", "item granted")+"\n"), 0o644)
	}
}

func grepLines(s string, needles ...string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		for _, n := range needles {
			if strings.Contains(l, n) {
				out = append(out, l)
				break
			}
		}
	}
	return strings.Join(out, "\n")
}
