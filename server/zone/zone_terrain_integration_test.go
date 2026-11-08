package main

// Terrain across a process boundary (WP07): the real zone binary loads
// worldgen.wasm, builds the atlas for its world and simulates on it; a
// client in this test process predicts with its own worldhost instance of
// the same wasm and must agree with the server to the centimeter. Also
// checks the genVersion pin makes the zone refuse a world it can't serve.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/weather"
	"lodestone/server/pkg/worldhost"
)

func buildZone(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "zone")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

func terrainWasm(t *testing.T) (*worldhost.Module, string) {
	t.Helper()
	path, err := worldhost.ResolvePath(os.Getenv(worldhost.EnvWasmPath))
	if err != nil {
		if errors.Is(err, worldhost.ErrNoWasm) && os.Getenv("LODESTONE_REQUIRE_WASM") != "1" {
			t.Skipf("skipping: %v", err)
		}
		t.Fatal(err)
	}
	mod, err := worldhost.Load(context.Background(), path, worldhost.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mod.Close(context.Background()) })
	return mod, path
}

func TestZoneProcessTerrain(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	mod, wasmPath := terrainWasm(t)
	const seed = 777
	mt, err := mod.Mint(seed, nil, worldhost.WorldOptions{MaxInstances: 2})
	if err != nil {
		t.Fatal(err)
	}
	local := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{Workers: 1})
	defer local.Close()

	bin := buildZone(t)
	port := freePort(t)
	world := fmt.Sprintf("itest-terrain-%d", time.Now().UnixNano())
	zoneID := "zone-itest-terrain"
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID="+zoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_WORLD_SEED="+strconv.Itoa(seed),
		"LODESTONE_GEN_VERSION=dev", // unminted: the zone derives spec_from_seed
		"LODESTONE_WORLDGEN_WASM="+wasmPath,
		"LODESTONE_ZONE_EXIT_AFTER=12s",
		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_ZONE_NO_REDIS=1",
	)
	logs := &strings.Builder{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
		}
		if t.Failed() {
			t.Logf("zone logs:\n%s", logs.String())
		}
	}()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitHealthy(t, base+"/healthz")

	// The zone serves the same atlas we built.
	var dz struct {
		GenVersion string          `json:"genVersion"`
		AtlasHash  string          `json:"atlasHash"`
		Spec       json.RawMessage `json:"spec"`
	}
	if err := json.Unmarshal([]byte(get(t, base+"/debug/zone")), &dz); err != nil {
		t.Fatal(err)
	}
	if dz.GenVersion != mt.GenVersion || dz.AtlasHash != mt.AtlasHash || len(dz.Spec) < 100 {
		t.Fatalf("/debug/zone %+v, want genVersion %s atlas %s", dz, mt.GenVersion, mt.AtlasHash)
	}

	// Spawn on a hillside, walk, jump, compare.
	sx, sz := float64(mt.World.Header.SpawnX)+210.5, float64(mt.World.Header.SpawnZ)-170.25
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=%s,%s", port, strconv.FormatFloat(sx, 'f', -1, 64), strconv.FormatFloat(sz, 'f', -1, 64)))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(transport.CloseNormal, "")
	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{CharacterID: "itest-terrain", CharacterName: "Hiker", WorldID: world, Audience: ticket.AudienceZone(zoneID)})
	if err := c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket})); err != nil {
		t.Fatal(err)
	}
	recv := func() proto.Message {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("recv: %v", err)
		}
		m, err := proto.DecodeMessage(b)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		return m
	}
	w, ok := recv().(*proto.Welcome)
	ground := local.HeightAt(sx, sz)
	if !ok || w.Seed != seed || w.GenVersion != mt.GenVersion || w.Y != proto.MetersToCm(ground) {
		t.Fatalf("bad welcome %+v (ground %v)", w, ground)
	}

	sim := movement.NewState(movement.Vec3{X: sx, Y: ground, Z: sz}) // WP10: full stamina, like join
	const total = 150
	var frames []proto.InputFrame
	for seq := uint32(1); seq <= total; seq++ {
		flags := uint16(proto.InputFlagForward | proto.InputFlagSprint)
		if seq%45 == 0 {
			flags |= proto.InputFlagJump | proto.InputFlagJumpEdge
		}
		f := proto.InputFrame{Seq: seq, Flags: flags, Yaw: proto.YawToU16(1.1 + float64(seq)/120)}
		frames = append(frames, f)
		sim = movement.StepFrameEnv(sim, f, local, movement.Env{Raining: weather.IsRaining(seed, weather.WorldTimeS(float64(time.Now().UnixMilli())))})
	}
	go func() {
		for i := 0; i < total; i += 2 {
			pkt := frames[max(i-1, 0) : i+2]
			_ = c.SendUnreliable(proto.Encode(&proto.Input{Frames: pkt}))
			time.Sleep(33 * time.Millisecond)
		}
	}()
	var dec snapshot.Decoder
	var last *snapshot.Frame
	var lastAck uint32
	deadline := time.Now().Add(8 * time.Second)
	for lastAck != total && time.Now().Before(deadline) {
		if s, ok := recv().(*proto.Snapshot); ok {
			f, err := dec.Apply(s)
			if err != nil {
				t.Fatalf("apply: %v", err)
			}
			last, lastAck = f, s.AckInputSeq
		}
	}
	if lastAck != total {
		t.Fatalf("server acked %d of %d frames", lastAck, total)
	}
	if last.Self.X != proto.MetersToCm(sim.Pos.X) || last.Self.Y != proto.MetersToCm(sim.Pos.Y) || last.Self.Z != proto.MetersToCm(sim.Pos.Z) {
		t.Fatalf("server %d,%d,%d cm != predicted %.4f,%.4f,%.4f m", last.Self.X, last.Self.Y, last.Self.Z, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)
	}
	t.Logf("hiked from (%.1f, %.2f, %.1f) to (%.1f, %.2f, %.1f); server agrees to the cm", sx, ground, sz, sim.Pos.X, sim.Pos.Y, sim.Pos.Z)

	time.Sleep(2500 * time.Millisecond) // terrain gauges publish every 2 s
	body := get(t, base+"/metrics")
	for _, want := range []string{"zone_terrain_chunks", `zone_terrain_queries_total{path="cache"}`, "zone_terrain_generated_total"} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q", want)
		}
	}
	var dt struct {
		Cache worldhost.TerrainStats `json:"cache"`
	}
	if err := json.Unmarshal([]byte(get(t, base+"/debug/terrain")), &dt); err != nil {
		t.Fatal(err)
	}
	if dt.Cache.Generated == 0 || dt.Cache.Hits == 0 {
		t.Fatalf("zone terrain cache unused: %+v", dt.Cache)
	}
	t.Logf("zone terrain cache: %+v", dt.Cache)
	_ = cmd.Process.Kill()
}

// TestZoneRefusesWrongGenVersion: a minted world whose gen_version the
// loaded wasm can't produce must not be served (spec 5 rule 6).
func TestZoneRefusesWrongGenVersion(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	_, wasmPath := terrainWasm(t)
	bin := buildZone(t)
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", freePort(t)),
		"LODESTONE_WORLD_ID=itest-refuse",
		"LODESTONE_WORLD_SEED=1",
		"LODESTONE_GEN_VERSION=99",
		"LODESTONE_WORLDGEN_WASM="+wasmPath,
		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_ZONE_NO_REDIS=1",
	)
	done := make(chan struct{})
	var out []byte
	var err error
	go func() { out, err = cmd.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("zone kept running with a genVersion it cannot serve")
	}
	if err == nil || !strings.Contains(string(out), "refusing to serve") || !strings.Contains(string(out), "gen_version") {
		t.Fatalf("expected a refusal exit, got err=%v\n%s", err, out)
	}
}
