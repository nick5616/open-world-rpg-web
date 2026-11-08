package main

// WP11 process-boundary test: the real zone binary publishes earshot sets
// to Redis (voice:{worldId}). Two players join 10 m apart; the test reads
// the channel like the social service does and checks the sets, the 4 Hz
// cadence, the full/delta pattern, and that one player walking away (past
// the 48 m leave radius) shows up as an empty set within the next interval.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/earshot"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
)

func TestZoneProcessPublishesEarshot(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the zone binary")
	}
	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	pctx, pcancel := context.WithTimeout(context.Background(), 2*time.Second)
	if err := rdb.Ping(pctx).Err(); err != nil {
		pcancel()
		t.Skipf("redis not available: %v", err)
	}
	pcancel()

	bin := filepath.Join(t.TempDir(), "zone")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	port := freePort(t)
	world := fmt.Sprintf("itest-voice-%d", time.Now().UnixNano())
	zoneID := "zone-itest-voice"

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	sub := rdb.Subscribe(ctx, earshot.Channel(world))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	msgs := sub.Channel()

	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		"LODESTONE_ZONE_ID="+zoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_ZONE_WT_ADDR=off",
		"LODESTONE_ZONE_NO_DB=1",
		"LODESTONE_WORLDGEN_WASM="+filepath.Join(t.TempDir(), "absent.wasm"),
	)
	logs := &strings.Builder{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		if t.Failed() {
			t.Logf("zone logs:\n%s", logs.String())
		}
	}()
	waitHealthy(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", port))

	priv, _, _ := ticket.PrivateKeyFromEnv()
	join := func(char string, x, z float64) transport.Conn {
		t.Helper()
		dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
		defer dcancel()
		c, err := transport.DialWebSocket(dctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=%.0f,%.0f", port, x, z))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close(transport.CloseNormal, "") })
		tk := ticket.Sign(priv, ticket.Claims{CharacterID: char, CharacterName: char, WorldID: world, Audience: ticket.AudienceZone(zoneID)})
		_ = c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: proto.TransportWebsocket}))
		go func() { // drain snapshots
			for {
				if _, err := c.Recv(context.Background()); err != nil {
					return
				}
			}
		}()
		return c
	}
	join("char-a", 1000, 1000)
	b := join("char-b", 1010, 1000)

	type got struct {
		m  earshot.Message
		at time.Time
	}
	next := func() got {
		t.Helper()
		select {
		case m := <-msgs:
			var e earshot.Message
			if err := json.Unmarshal([]byte(m.Payload), &e); err != nil {
				t.Fatal(err)
			}
			return got{e, time.Now()}
		case <-ctx.Done():
			t.Fatal("no earshot message")
		}
		return got{}
	}
	// Wait until both are in each other's set.
	var sets = map[string][]string{}
	var fulls []time.Time
	deadline := time.Now().Add(10 * time.Second)
	for !(slices.Equal(sets["char-a"], []string{"char-b"}) && slices.Equal(sets["char-b"], []string{"char-a"})) {
		if time.Now().After(deadline) {
			t.Fatalf("never saw a and b in earshot: %v", sets)
		}
		g := next()
		if g.m.V != earshot.Version || g.m.Zone != zoneID || g.m.T <= 0 {
			t.Fatalf("bad message %+v", g.m)
		}
		if g.m.Full {
			fulls = append(fulls, g.at)
		}
		for l, s := range g.m.Sets {
			sets[l] = s
		}
	}
	// Full messages every 2 s (8 x 250 ms), with nothing in between while
	// nobody moves (no deltas without changes).
	for len(fulls) < 3 {
		g := next()
		if !g.m.Full {
			t.Fatalf("delta without any change: %+v", g.m)
		}
		if len(g.m.Sets) != 2 {
			t.Fatalf("full message must list both players: %+v", g.m)
		}
		fulls = append(fulls, g.at)
	}
	gap := fulls[len(fulls)-1].Sub(fulls[len(fulls)-2])
	if gap < 1700*time.Millisecond || gap > 2300*time.Millisecond {
		t.Fatalf("full messages %v apart, want 2 s", gap)
	}

	// B sprints away along +x: 60 frames per second of forward+sprint at
	// yaw -pi/2 (forward = (-sin yaw, -cos yaw) = +x).
	start := time.Now()
	go func() {
		seq := uint32(0)
		var prev proto.InputFrame
		for i := 0; i < 30*12 && ctx.Err() == nil; i++ {
			var fr []proto.InputFrame
			if seq > 0 {
				fr = append(fr, prev)
			}
			for k := 0; k < 2; k++ {
				seq++
				prev = proto.InputFrame{Seq: seq, Flags: proto.InputFlagForward | proto.InputFlagSprint, Yaw: proto.YawToU16(-1.5707963)}
				fr = append(fr, prev)
			}
			_ = b.SendUnreliable(proto.Encode(&proto.Input{Frames: fr}))
			time.Sleep(33 * time.Millisecond)
		}
	}()
	for {
		g := next()
		if s, ok := g.m.Sets["char-a"]; ok && len(s) == 0 {
			el := time.Since(start)
			// Sprint 7.8 m/s from 10 m: past 48 m after ~4.9 s, plus one interval.
			if el < 4*time.Second || el > 7*time.Second {
				t.Fatalf("a's set emptied after %v; expected ~5 s of sprinting", el)
			}
			if !g.m.Full && len(g.m.Sets["char-b"]) != 0 {
				t.Fatalf("b's set must empty in the same message: %+v", g.m)
			}
			t.Logf("earshot left after %v of sprinting (message seq %d)", el, g.m.Seq)
			break
		}
	}
	metrics := get(t, fmt.Sprintf("http://127.0.0.1:%d/metrics", port))
	for _, want := range []string{"zone_earshot_published_total", "zone_earshot_failed_total 0", "zone_earshot_skipped_total 0"} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q", want)
		}
	}
}
