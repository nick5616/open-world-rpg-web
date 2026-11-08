package main

// Integration test across a process boundary: builds the real zone binary,
// runs it as a subprocess with env configuration, and drives a client over a
// real WebSocket through Hello -> Welcome -> Input -> Snapshot, checks the
// Prometheus scrape and the Redis zone registry, then lets the zone shut down
// on its own (LODESTONE_ZONE_EXIT_AFTER) and checks the client was kicked
// with `shutdown`, the process exited cleanly and the registry entry is gone.

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/zoneregistry"
)

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestZoneProcessEndToEnd(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	bin := filepath.Join(t.TempDir(), "zone")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	port := freePort(t)
	world := fmt.Sprintf("itest-%d", time.Now().UnixNano())
	zoneID := "zone-itest"
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID="+zoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_WORLD_SEED=777",
		"LODESTONE_GEN_VERSION=itest-gen",
		"LODESTONE_ZONE_EXIT_AFTER=6s",
		// Flat ground on purpose (no wasm): this test is about the protocol;
		// zone_terrain_integration_test.go covers terrain (WP07).
		"LODESTONE_WORLDGEN_WASM="+filepath.Join(t.TempDir(), "absent.wasm"),
		// A database that refuses connections: the zone must still serve
		// (logins fall back to the default spawn, checkpoints retry).
		"LODESTONE_PG_URL=postgres://x:y@127.0.0.1:1/none?sslmode=disable&connect_timeout=1",
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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	c, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=1000,1000", port))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(transport.CloseNormal, "")

	priv, _, _ := ticket.PrivateKeyFromEnv()
	tk := ticket.Sign(priv, ticket.Claims{CharacterID: "itest-char", CharacterName: "Integration", WorldID: world, Audience: ticket.AudienceZone(zoneID)})
	send := func(m proto.Message) {
		if err := c.SendReliable(proto.Encode(m)); err != nil {
			t.Fatal(err)
		}
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

	send(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket})
	w, ok := recv().(*proto.Welcome)
	if !ok || w.WorldID != world || w.Seed != 777 || w.GenVersion != "itest-gen" || w.X != 100000 || w.Name != "Integration" {
		t.Fatalf("bad welcome: %+v", w)
	}

	// Walk forward for one second: 30 packets of 2 new frames + 1 repeat,
	// acking snapshots as they arrive.
	var dec snapshot.Decoder
	sim := movement.NewState(movement.Vec3{X: 1000, Z: 1000})
	var frames []proto.InputFrame
	seq := uint32(0)
	snaps := 0
	var last *snapshot.Frame
	var lastAck uint32
	go func() {
		for i := 0; i < 30; i++ {
			var pkt []proto.InputFrame
			if len(frames) > 0 {
				pkt = append(pkt, frames[len(frames)-1])
			}
			for k := 0; k < 2; k++ {
				seq++
				f := proto.InputFrame{Seq: seq, Flags: proto.InputFlagForward, Yaw: proto.YawToU16(0)}
				frames = append(frames, f)
				pkt = append(pkt, f)
			}
			_ = c.SendUnreliable(proto.Encode(&proto.Input{AckTick: dec.Latest(), Frames: pkt}))
			time.Sleep(33 * time.Millisecond)
		}
	}()
	for i := 0; i < 60; i++ {
		sim = movement.Step(sim, proto.InputFlagForward, proto.U16ToYaw(proto.YawToU16(0)), movement.Flat{})
	}
	deadline := time.Now().Add(4 * time.Second)
	for lastAck != 60 && time.Now().Before(deadline) {
		if s, ok := recv().(*proto.Snapshot); ok {
			f, err := dec.Apply(s)
			if err != nil {
				t.Fatalf("apply: %v", err)
			}
			snaps++
			last, lastAck = f, s.AckInputSeq
		}
	}
	if lastAck != 60 {
		t.Fatalf("server never acked all 60 frames (ack %d after %d snapshots)", lastAck, snaps)
	}
	if last.Self.Z != proto.MetersToCm(sim.Pos.Z) || last.Self.X != proto.MetersToCm(sim.Pos.X) {
		t.Fatalf("server position %d,%d cm != predicted %.4f,%.4f m", last.Self.X, last.Self.Z, sim.Pos.X, sim.Pos.Z)
	}

	// Metrics scrape (published once a second).
	time.Sleep(1200 * time.Millisecond)
	body := get(t, base+"/metrics")
	for _, want := range []string{"zone_players 1", `zone_tick_ms{q="p99"}`, `zone_tick_jitter_ms{q="p99"}`, "zone_writebehind_depth", `zone_client_down_kbps{q="max"}`, `zone_aoi_entities_avg{ring="near"}`, "zone_bytes_out_total ", "go_goroutines "} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q:\n%s", want, body)
		}
	}

	// Zone registry, when the shared Redis is up.
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	rctx, rcancel := context.WithTimeout(context.Background(), time.Second)
	redisUp := rdb.Ping(rctx).Err() == nil
	rcancel()
	if redisUp {
		live, err := zoneregistry.Live(context.Background(), rdb, world, time.Now())
		if err != nil || len(live) != 1 || live[0].ZoneID != zoneID || !strings.Contains(live[0].Endpoint, "/ws") {
			t.Fatalf("zone registry entry: %+v err=%v", live, err)
		}
	} else {
		t.Log("redis not reachable; skipping registry checks")
	}

	// Graceful shutdown after LODESTONE_ZONE_EXIT_AFTER: kicked with shutdown.
	kicked := false
	for !kicked {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		b, err := c.Recv(ctx)
		cancel()
		if err != nil {
			break
		}
		if m, _ := proto.DecodeMessage(b); m != nil {
			if k, ok := m.(*proto.Kick); ok {
				kicked = k.Code == proto.KickCodeShutdown
				if !kicked {
					t.Fatalf("unexpected kick %+v", k)
				}
			}
		}
	}
	if !kicked {
		t.Fatal("client was not kicked with `shutdown`")
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("zone exited with %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("zone did not exit")
	}
	if redisUp {
		n, _ := rdb.HLen(context.Background(), zoneregistry.Key(world)).Result()
		if n != 0 {
			t.Fatalf("registry entry not removed on shutdown (%d left)", n)
		}
	}
	if !strings.Contains(logs.String(), "zone stopped") {
		t.Fatalf("no clean-stop log line")
	}
}

func waitHealthy(t *testing.T, url string) {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(url); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("zone never became healthy")
}

func get(t *testing.T, url string) string {
	r, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return string(b)
}
