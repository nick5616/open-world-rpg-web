package main

// WebTransport across a process boundary (WP06): the real zone binary serves
// HTTP/3 on UDP with its self-signed dev certificate; a client pins the cert
// by the hash the zone publishes (as a browser does with
// serverCertificateHashes), handshakes over the reliable stream, sends Input
// as datagrams and receives snapshots, while a WebSocket client in the same
// zone sees it move. Also checks the registry entry announces wtEndpoint
// with the #certHash fragment and the metrics count sessions per transport.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"lodestone/server/pkg/env"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
	"lodestone/server/pkg/zoneregistry"
)

func TestZoneProcessWebTransport(t *testing.T) {
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
	world := fmt.Sprintf("itest-wt-%d", time.Now().UnixNano())
	zoneID := "zone-itest-wt"
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("LODESTONE_ZONE_PORT=%d", port),
		fmt.Sprintf("LODESTONE_ZONE_WT_ADDR=127.0.0.1:%d", port),
		fmt.Sprintf("LODESTONE_ZONE_WT_PUBLIC_URL=https://127.0.0.1:%d/wt", port),
		"LODESTONE_ZONE_ID="+zoneID,
		"LODESTONE_WORLD_ID="+world,
		"LODESTONE_ZONE_EXIT_AFTER=8s",
		"LODESTONE_ZONE_NO_DB=1",
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

	var info struct{ WTEndpoint, CertHash string }
	if err := json.Unmarshal([]byte(get(t, base+"/debug/wt")), &info); err != nil || info.CertHash == "" {
		t.Fatalf("/debug/wt: %+v %v", info, err)
	}
	if u, h := transport.SplitCertHash(info.WTEndpoint); h != info.CertHash || u != fmt.Sprintf("https://127.0.0.1:%d/wt", port) {
		t.Fatalf("endpoint %q does not carry the cert hash", info.WTEndpoint)
	}

	priv, _, _ := ticket.PrivateKeyFromEnv()
	hello := func(name string, tr proto.Transport) []byte {
		tk := ticket.Sign(priv, ticket.Claims{CharacterID: "itest-" + name, CharacterName: name, WorldID: world, Audience: ticket.AudienceZone(zoneID)})
		return proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: 1, Transport: tr})
	}
	recvMsg := func(c transport.Conn) proto.Message {
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

	// The WebSocket watcher joins first, 10 m away.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	ws, err := transport.DialWebSocket(ctx, fmt.Sprintf("ws://127.0.0.1:%d/ws?spawn=1010,1000", port))
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(transport.CloseNormal, "")
	_ = ws.SendReliable(hello("Watcher", proto.TransportWebsocket))
	if _, ok := recvMsg(ws).(*proto.Welcome); !ok {
		t.Fatal("watcher: no welcome")
	}

	// The WebTransport client: URL from the zone (plus the dev spawn query,
	// which must work on this transport too), hash from the fragment.
	u, h := transport.SplitCertHash(info.WTEndpoint)
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	wt, err := transport.DialWebTransport(ctx, transport.WithCertHash(u+"?spawn=1000,1000", h), "")
	cancel()
	if err != nil {
		t.Fatalf("dial webtransport: %v", err)
	}
	defer wt.Close(transport.CloseNormal, "")
	_ = wt.SendReliable(hello("Quic", proto.TransportWebtransport))
	// The first snapshot (a datagram) can overtake Welcome (stream data):
	// different QUIC streams/datagrams are not ordered. Clients skip
	// snapshots until they have their Welcome.
	var w *proto.Welcome
	for i := 0; i < 10 && w == nil; i++ {
		w, _ = recvMsg(wt).(*proto.Welcome)
	}
	if w == nil || w.Name != "Quic" {
		t.Fatalf("webtransport welcome: %+v", w)
	}

	// Walk forward 1 s: datagram Input packets, acking snapshots.
	var dec snapshot.Decoder
	go func() {
		seq := uint32(0)
		for i := 0; i < 30; i++ {
			var pkt []proto.InputFrame
			for k := 0; k < 2; k++ {
				seq++
				pkt = append(pkt, proto.InputFrame{Seq: seq, Flags: proto.InputFlagForward})
			}
			wt.SendUnreliable(proto.Encode(&proto.Input{AckTick: dec.Latest(), Frames: pkt}))
			time.Sleep(33 * time.Millisecond)
		}
	}()
	var lastAck uint32
	deadline := time.Now().Add(5 * time.Second)
	for lastAck < 50 && time.Now().Before(deadline) {
		if s, ok := recvMsg(wt).(*proto.Snapshot); ok {
			if _, err := dec.Apply(s); err != nil && err != snapshot.ErrStale {
				t.Fatalf("apply: %v", err)
			}
			lastAck = s.AckInputSeq
		}
	}
	if lastAck < 50 {
		t.Fatalf("zone acked only %d datagram input frames", lastAck)
	}

	// The watcher sees the WebTransport player, by name, having moved north.
	var wdec snapshot.Decoder
	var seen *snapshot.EntState
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s, ok := recvMsg(ws).(*proto.Snapshot); ok {
			f, err := wdec.Apply(s)
			if err != nil {
				continue
			}
			_ = ws.SendUnreliable(proto.Encode(&proto.Input{AckTick: wdec.Latest()}))
			for i := range f.Ents {
				if f.Ents[i].Name == "Quic" {
					e := f.Ents[i]
					seen = &e
				}
			}
			if seen != nil && seen.Z < proto.MetersToCm(1000)-200 {
				break
			}
		}
	}
	if seen == nil || seen.Z >= proto.MetersToCm(1000)-200 {
		t.Fatalf("watcher did not see the WebTransport player walk: %+v", seen)
	}

	time.Sleep(1200 * time.Millisecond)
	body := get(t, base+"/metrics")
	for _, want := range []string{`zone_sessions{transport="webtransport"} 1`, `zone_sessions{transport="websocket"} 1`, "zone_downlink_budget_kbps 150"} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q", want)
		}
	}

	rdb := redis.NewClient(&redis.Options{Addr: env.RedisAddr()})
	defer rdb.Close()
	rctx, rcancel := context.WithTimeout(context.Background(), time.Second)
	if rdb.Ping(rctx).Err() == nil {
		live, err := zoneregistry.Live(context.Background(), rdb, world, time.Now())
		if err != nil || len(live) != 1 || live[0].WTEndpoint != info.WTEndpoint {
			t.Fatalf("registry must announce wtEndpoint: %+v %v", live, err)
		}
	}
	rcancel()

	// Shutdown kick arrives over the WebTransport stream with its close code.
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		b, err := wt.Recv(ctx)
		cancel()
		if err != nil {
			if code := transport.CloseCode(err); code != transport.CloseKickBase+int(proto.KickCodeShutdown) {
				t.Fatalf("session closed with %d (%T %v) at %s, want shutdown kick code", code, err, err, time.Now().Format("15:04:05.000"))
			}
			break
		}
		if m, _ := proto.DecodeMessage(b); m != nil {
			if k, ok := m.(*proto.Kick); ok && k.Code != proto.KickCodeShutdown {
				t.Fatalf("unexpected kick %+v", k)
			}
		}
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("zone exited with %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("zone did not exit")
	}
}
