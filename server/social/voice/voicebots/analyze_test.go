package main

import (
	"strings"
	"testing"
)

// The soak's verdict logic on hand-made timelines.
func TestAnalyzeMatchesLatencyAndFlaps(t *testing.T) {
	ready := map[string]float64{"a": 0, "b": 0}
	ev := []event{
		{T: 50, Kind: "zin", L: "a", S: "b"}, // before the scenario: initial
		{T: 900, Kind: "sub", L: "a", S: "b"},
		{T: 1000, Kind: "phase", S: "clustered"},
		{T: 5000, Kind: "zout", L: "a", S: "b"},
		{T: 5030, Kind: "mstop", L: "a", S: "b"},
		{T: 6015, Kind: "unsub", L: "a", S: "b"}, // track ends after LiveKit's flush
		{T: 9000, Kind: "zin", L: "a", S: "b"},
		{T: 9060, Kind: "sub", L: "a", S: "b"},
		{T: 12000, Kind: "phase", S: "end"},
		{T: 12100, Kind: "zout", L: "a", S: "b"}, // teardown: ignored
	}
	s := analyze(ev, nil, ready, 2)
	if s.ZoneTransitions != 2 || s.Matched != 2 || s.Missed != 0 || s.Initial != 1 || s.Flaps != 0 {
		t.Fatalf("%+v", s)
	}
	if s.LatencySubMs.Max != 60 || s.LatencyUnsubMediaMs.Max != 30 || s.LatencyUnsubMs.Max != 1015 || s.LatencyMs.Max != 60 {
		t.Fatalf("latencies %+v", s)
	}
	if !s.Pass {
		t.Fatalf("should pass: %s", s.Verdict)
	}

	// A listener-side reversal the zone never asked for is a flap.
	ev = append(ev[:8:8], event{T: 9500, Kind: "unsub", L: "a", S: "b"}, event{T: 10000, Kind: "sub", L: "a", S: "b"}, event{T: 12000, Kind: "phase", S: "end"})
	s = analyze(ev, nil, ready, 2)
	if s.Flaps == 0 || s.Pass {
		t.Fatalf("flap not caught: %+v", s)
	}

	// A zone decision never reflected at the listener is missed.
	ev = []event{{T: 0, Kind: "phase", S: "clustered"}, {T: 100, Kind: "zin", L: "a", S: "b"}, {T: 9000, Kind: "phase", S: "end"}}
	s = analyze(ev, nil, ready, 2)
	if s.Missed != 1 || s.Pass {
		t.Fatalf("missed not caught: %+v", s)
	}
}

// A decision in the last second before "end" is still matched by what the
// listener observes in the tail (G5 Linux thailand runs: all 34 "missed"
// were such decisions; an unsubscribe is observed when the track ends, ~1 s
// after the decision). Listener events in the tail that answer nothing
// before "end" are teardown, not extras.
func TestAnalyzeEndTail(t *testing.T) {
	ready := map[string]float64{"a": 0, "b": 0, "c": 0}
	ev := []event{
		{T: 0, Kind: "phase", S: "clustered"},
		{T: 100, Kind: "zin", L: "a", S: "b"},
		{T: 130, Kind: "sub", L: "a", S: "b"},
		{T: 9600, Kind: "zout", L: "a", S: "b"},
		{T: 9612, Kind: "mstop", L: "a", S: "b"},
		{T: 9800, Kind: "zin", L: "a", S: "c"},
		{T: 10000, Kind: "phase", S: "end"},
		{T: 10050, Kind: "sub", L: "a", S: "c"},
		{T: 10615, Kind: "unsub", L: "a", S: "b"},
		{T: 10700, Kind: "zout", L: "c", S: "b"},  // after "end": not counted
		{T: 11800, Kind: "unsub", L: "a", S: "c"}, // teardown in the tail: not an extra
		{T: 13000, Kind: "sub", L: "b", S: "a"},   // after the tail: ignored
	}
	s := analyze(ev, nil, ready, 3)
	if s.ZoneTransitions != 3 || s.Matched != 3 || s.Missed != 0 || s.Extra != 0 || s.Flaps != 0 || !s.Pass {
		t.Fatalf("%+v", s)
	}
	if s.LatencyUnsubMediaMs.Max != 12 {
		t.Fatalf("media-stop latency %+v", s.LatencyUnsubMediaMs)
	}
	// Observed only after the tail: missed.
	ev[8].T = 10000 + endTailMs + 1
	if s = analyze(ev, nil, ready, 3); s.Missed != 1 || s.Pass {
		t.Fatalf("unsub after the tail should be missed: %+v", s)
	}
}

// A run in which the zone teleported a bot (a death respawn) is not the
// scenario: INVALID, whatever the subscriptions did.
func TestAnalyzeTeleportInvalidates(t *testing.T) {
	ready := map[string]float64{"a": 0, "b": 0}
	ev := []event{
		{T: 0, Kind: "phase", S: "clustered"},
		{T: 100, Kind: "zin", L: "a", S: "b"},
		{T: 130, Kind: "sub", L: "a", S: "b"},
		{T: 5000, Kind: "tp", L: "b"},
		{T: 10000, Kind: "phase", S: "end"},
	}
	s := analyze(ev, nil, ready, 2)
	if s.Teleports != 1 || s.Pass || !strings.HasPrefix(s.Verdict, "INVALID") {
		t.Fatalf("%+v", s)
	}
}
