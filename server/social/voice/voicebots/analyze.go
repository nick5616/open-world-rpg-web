package main

import (
	"math"
	"slices"
	"sort"

	"lodestone/server/pkg/constants"
)

// Analysis windows.
const (
	// matchWindowMs: a zone decision that is not reflected at the listener
	// within this long counts as missed.
	matchWindowMs = 5000
	// flapWindowMs: a pair whose subscription reverses within this long
	// flapped (spec 14 scenario 3: "no flapping").
	flapWindowMs = 2000
	// geoLookbackMs: how far before a zone decision we look for the
	// distance crossing that explains it.
	geoLookbackMs = 1000
)

type pairKey struct{ L, S string }

type transition struct {
	T  float64
	On bool
}

// Summary is the soak verdict and its numbers.
type Summary struct {
	Bots                int         `json:"bots"`
	Ready               int         `json:"ready"`
	ZoneMessages        int         `json:"zoneMessages"`
	ZoneTransitions     int         `json:"zoneTransitions"` // earshot pair changes after both bots were voice-ready
	Matched             int         `json:"matched"`         // ... reflected at the listener within the window
	Missed              int         `json:"missed"`          // ... never reflected
	Initial             int         `json:"initialSubs"`     // pairs already in earshot when they became voice-ready
	Extra               int         `json:"extraObserved"`   // observed changes with no zone decision behind them
	ObservedChanges     int         `json:"observedChanges"` // every sub/unsub after ready
	PairsSubscribed     int         `json:"pairsEverSubscribed"`
	MaxChangesPerPair   int         `json:"maxChangesPerPair"`
	Flaps               int         `json:"flaps"`     // observed reversals within 2 s
	ZoneFlaps           int         `json:"zoneFlaps"` // zone decision reversals within 2 s
	LatencyMs           Quant       `json:"latencyMs"` // zone decision -> listener hears (TrackSubscribed) / stops hearing (last packet + 20 ms: forwarding stopped)
	LatencySubMs        Quant       `json:"latencySubscribeMs"`
	LatencyUnsubMs      Quant       `json:"latencyUnsubscribeTrackEndedMs"` // includes LiveKit's 1 s downtrack flush
	LatencyUnsubMediaMs Quant       `json:"latencyUnsubscribeMediaStopMs"`  // last real audio packet
	Within500           float64     `json:"fractionWithin500ms"`
	GeoLatencyMs        Quant       `json:"geometricLatencyMs"` // distance crossing 40 m (in) / 48 m (out) -> listener event
	GeoSamples          int         `json:"geometricSamples"`
	InitialLatencyMs    Quant       `json:"initialLatencyMs"` // both ready -> first subscription for pairs already in earshot
	ChangesHistogram    map[int]int `json:"pairsByChangeCount"`
	Pass                bool        `json:"pass"`
	Verdict             string      `json:"verdict"`
}

// Quant is a latency distribution.
type Quant struct {
	N    int     `json:"n"`
	P50  float64 `json:"p50"`
	P95  float64 `json:"p95"`
	P99  float64 `json:"p99"`
	Max  float64 `json:"max"`
	Mean float64 `json:"mean"`
}

func quant(v []float64) Quant {
	if len(v) == 0 {
		return Quant{}
	}
	s := slices.Clone(v)
	slices.Sort(s)
	at := func(q float64) float64 { return round1(s[min(len(s)-1, int(q*float64(len(s))))]) }
	sum := 0.0
	for _, x := range s {
		sum += x
	}
	return Quant{N: len(s), P50: at(0.5), P95: at(0.95), P99: at(0.99), Max: round1(s[len(s)-1]), Mean: round1(sum / float64(len(s)))}
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// analyze turns the recorded events into the verdict. Only pairs of our own
// bots count.
func analyze(ev []event, pos map[string][]posSample, ready map[string]float64, bots int) Summary {
	zone := map[pairKey][]transition{}
	obs := map[pairKey][]transition{}
	mstop := map[pairKey][]float64{}
	zoneMsgs := 0
	// Bots leave at the "end" phase; what happens after is teardown.
	// Measurement starts at the first scenario phase (joins and the settle
	// period before it are reported as initial subscriptions: until the
	// roster poll has seen a fresh track there is nothing to subscribe to).
	end, begin := math.Inf(1), math.Inf(1)
	for _, e := range ev {
		if e.Kind == "phase" && e.S != "end" && e.T < begin {
			begin = e.T
		}
		if e.Kind == "phase" && e.S == "end" {
			end = e.T
		}
	}
	for _, e := range ev {
		if e.T > end {
			continue
		}
		switch e.Kind {
		case "zin", "zout":
			zone[pairKey{e.L, e.S}] = append(zone[pairKey{e.L, e.S}], transition{e.T, e.Kind == "zin"})
		case "sub", "unsub":
			obs[pairKey{e.L, e.S}] = append(obs[pairKey{e.L, e.S}], transition{e.T, e.Kind == "sub"})
		case "mstop":
			mstop[pairKey{e.L, e.S}] = append(mstop[pairKey{e.L, e.S}], e.T)
		}
	}
	s := Summary{Bots: bots, Ready: len(ready), ZoneMessages: zoneMsgs, ChangesHistogram: map[int]int{}}
	// lat is the effective latency: subscribe = TrackSubscribed, unsubscribe
	// = the last real audio packet (forwarding stopped). latUnsub keeps the
	// track-ended time, which includes LiveKit's 1 s flush.
	var lat, latSub, latUnsub, latMedia, geo, initial []float64
	pairs := map[pairKey]bool{}
	for p := range zone {
		pairs[p] = true
	}
	for p := range obs {
		pairs[p] = true
	}
	keys := make([]pairKey, 0, len(pairs))
	for p := range pairs {
		if _, ok := ready[p.L]; !ok {
			continue
		}
		if _, ok := ready[p.S]; !ok {
			continue
		}
		keys = append(keys, p)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].L != keys[j].L {
			return keys[i].L < keys[j].L
		}
		return keys[i].S < keys[j].S
	})
	for _, p := range keys {
		readyT := max(ready[p.L], ready[p.S], begin)
		zs, os := zone[p], obs[p]
		used := make([]bool, len(os))
		// Zone state when the pair became voice-ready: if in earshot then,
		// expect an initial subscription.
		inAtReady := false
		var after []transition
		for _, z := range zs {
			if z.T < readyT {
				inAtReady = z.On
			} else {
				after = append(after, z)
			}
		}
		if inAtReady {
			s.Initial++
			for i, o := range os {
				if o.On && o.T >= max(ready[p.L], ready[p.S])-1000 && (len(after) == 0 || o.T < after[0].T+matchWindowMs) {
					used[i] = true
					initial = append(initial, max(0, o.T-max(ready[p.L], ready[p.S])))
					break
				}
			}
		}
		for zi, z := range after {
			s.ZoneTransitions++
			limit := z.T + matchWindowMs
			if zi+1 < len(after) {
				limit = min(limit, after[zi+1].T+matchWindowMs)
			}
			found := -1
			for i, o := range os {
				if !used[i] && o.On == z.On && o.T >= z.T && o.T <= limit {
					found = i
					break
				}
			}
			if found < 0 {
				s.Missed++
				continue
			}
			used[found] = true
			s.Matched++
			d := os[found].T - z.T
			eff := os[found].T
			if z.On {
				latSub = append(latSub, d)
			} else {
				latUnsub = append(latUnsub, d)
				// The listener stopped hearing at the last real packet
				// before the track ended (recorded with the unsub).
				for _, m := range mstop[p] {
					if m <= os[found].T && m >= z.T-200 {
						eff = m
					}
				}
				latMedia = append(latMedia, max(0, eff-z.T))
			}
			lat = append(lat, max(0, eff-z.T))
			if tc, ok := crossing(pos[p.L], pos[p.S], z.T, z.On); ok {
				geo = append(geo, eff-tc)
			}
		}
		n := 0
		everOn := false
		for i, o := range os {
			if o.T < readyT-1000 {
				continue
			}
			n++
			everOn = everOn || o.On
			if !used[i] {
				s.Extra++
			}
			if i > 0 && o.T-os[i-1].T <= flapWindowMs && o.On != os[i-1].On && (!used[i] || !used[i-1]) {
				// A quick reversal that no zone decision asked for (when the
				// zone itself reversed, both changes are matched and it is
				// counted as a zone flap below).
				s.Flaps++
			}
		}
		for i := 1; i < len(zs); i++ {
			if zs[i].T >= readyT && zs[i].T-zs[i-1].T <= flapWindowMs && zs[i].On != zs[i-1].On {
				s.ZoneFlaps++
			}
		}
		s.ObservedChanges += n
		s.ChangesHistogram[n]++
		s.MaxChangesPerPair = max(s.MaxChangesPerPair, n)
		if everOn {
			s.PairsSubscribed++
		}
	}
	s.LatencyMs, s.LatencySubMs, s.LatencyUnsubMs, s.LatencyUnsubMediaMs = quant(lat), quant(latSub), quant(latUnsub), quant(latMedia)
	s.GeoLatencyMs, s.GeoSamples = quant(geo), len(geo)
	s.InitialLatencyMs = quant(initial)
	within := 0
	for _, d := range lat {
		if d <= 500 {
			within++
		}
	}
	if len(lat) > 0 {
		s.Within500 = math.Round(float64(within)/float64(len(lat))*10000) / 10000
	}
	s.Pass = s.Matched > 0 && s.Missed == 0 && s.Extra == 0 && s.Flaps == 0 && s.ZoneFlaps == 0 && s.LatencyMs.P99 <= 500
	switch {
	case s.Pass:
		s.Verdict = "PASS: every earshot change reached the listener, p99 within 500 ms, no flapping"
	default:
		s.Verdict = "FAIL"
	}
	return s
}

// crossing finds when the pair's distance last crossed the join radius
// (on) or the leave radius (off) in the second before the zone decision at
// tz. Decisions driven by the 12-nearest cap have no such crossing and are
// skipped (ok = false).
func crossing(a, b []posSample, tz float64, on bool) (float64, bool) {
	if len(a) == 0 || len(b) == 0 {
		return 0, false
	}
	r := constants.EarshotOpenM
	if !on {
		r = constants.EarshotLeaveM
	}
	beyond := func(t float64) (bool, bool) {
		pa, ok1 := posAt(a, t)
		pb, ok2 := posAt(b, t)
		if !ok1 || !ok2 {
			return false, false
		}
		d := math.Hypot(pa[0]-pb[0], pa[1]-pb[1])
		if on {
			return d > r, true
		}
		return d <= r, true
	}
	// At tz the pair must be on the far side of the threshold already.
	if far, ok := beyond(tz); !ok || far {
		return 0, false
	}
	for t := tz; t >= tz-geoLookbackMs; t -= 5 {
		if far, ok := beyond(t); ok && far {
			return t + 5, true
		}
	}
	return 0, false
}

func posAt(s []posSample, t float64) ([2]float64, bool) {
	i := sort.Search(len(s), func(i int) bool { return s[i].T >= t })
	if i == 0 || i >= len(s) {
		return [2]float64{}, false
	}
	a, b := s[i-1], s[i]
	f := (t - a.T) / (b.T - a.T)
	return [2]float64{a.X + (b.X-a.X)*f, a.Z + (b.Z-a.Z)*f}, true
}
