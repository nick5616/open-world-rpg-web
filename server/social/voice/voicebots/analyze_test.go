package main

import "testing"

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
