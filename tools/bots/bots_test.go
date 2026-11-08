package main

import (
	"testing"
	"time"

	"lodestone/server/pkg/proto"
)

func TestJumperPressesThenDoubleJumpsOnEdgesOnly(t *testing.T) {
	b := newBot(1, &botConfig{worldM: 4096, centerX: 2048, centerZ: 2048}, 1, 100, 100)
	b.persona = jumper
	b.jumpFrames, b.doubleAt = 1, 15
	var edges []int
	for i := 1; i <= 40; i++ {
		f := b.nextFrame()
		if f.Flags&proto.InputFlagJumpEdge != 0 {
			edges = append(edges, i)
			if f.Flags&proto.InputFlagJump == 0 {
				t.Fatal("an edge must come with the held bit")
			}
		}
		if f.Seq != uint32(i) {
			t.Fatalf("seq %d at frame %d", f.Seq, i)
		}
	}
	if len(edges) != 2 || edges[0] != 1 || edges[1] != 15 {
		t.Fatalf("edges at %v, want [1 15]", edges)
	}
}

func TestClusteredBotSteersHome(t *testing.T) {
	b := newBot(1, &botConfig{worldM: 4096, centerX: 2048, centerZ: 2048, radius: 100}, 1, 2048, 2048)
	b.state.Pos.X, b.state.Pos.Z = 2048+500, 2048 // far east of center
	b.decide(time.Now())
	// Yaw convention: forward = (-sin yaw, -cos yaw); heading west is yaw pi/2.
	if d := b.heading - 1.5707963; d > 1e-6 || d < -1e-6 {
		t.Fatalf("heading %v, want pi/2 (west, toward center)", b.heading)
	}
}

func TestMetricsHelpersAndVerdict(t *testing.T) {
	if got := deriveMetricsURL("ws://localhost:8092/ws?x=1"); got != "http://localhost:8092/metrics" {
		t.Fatal(got)
	}
	if got := deriveMetricsURL("wss://zone.example/ws"); got != "https://zone.example/metrics" {
		t.Fatal(got)
	}
	m := parseZoneMetrics("# HELP x\nzone_players 3\nzone_tick_ms{q=\"p99\"} 7.5\nother 1\n")
	if m["zone_players"] != 3 || m[`zone_tick_ms{q="p99"}`] != 7.5 || len(m) != 2 {
		t.Fatalf("%v", m)
	}
	b := newBot(1, &botConfig{}, 1, 0, 0)
	b.st.Connected, b.st.DownKbps, b.st.UpKbps = true, 70, 10
	s := summarize([]*bot{b}, "spread", 1, 0, time.Second, "zone_tick_ms{q=\"p99\"} 1.2\n", 0)
	if s.Pass || len(s.Failures) != 1 {
		t.Fatalf("70 kbps spread must fail the 64 kbps budget: %+v", s.Failures)
	}
	s = summarize([]*bot{b}, "clustered", 1, 300, time.Second, "zone_tick_ms{q=\"p99\"} 1.2\n", 0)
	if !s.Pass {
		t.Fatalf("70 kbps clustered is within 160: %+v", s.Failures)
	}
}
