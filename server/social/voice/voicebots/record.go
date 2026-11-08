package main

import (
	"encoding/json"
	"slices"
	"sync"
	"sync/atomic"

	"lodestone/server/pkg/earshot"
)

// event is one timestamped fact (Unix ms, all from this machine's clock; the
// zone's earshot t is the same clock because everything runs locally).
//
//	sub / unsub  listener L's LiveKit client got / lost speaker S's track
//	zin / zout   the zone decided L hears / stops hearing S (t = zone compute time)
//	ready        L is in LiveKit with its track published
//	phase        scenario phase S begins
type event struct {
	T    float64 `json:"t"`
	Kind string  `json:"k"`
	L    string  `json:"l,omitempty"`
	S    string  `json:"s,omitempty"`
}

type posSample struct {
	T, X, Z float64
}

type recorder struct {
	mu     sync.Mutex
	events []event
	pos    map[string][]posSample
	ready  map[string]float64
	sets   map[string]map[string]bool // the zone's current sets, rebuilt from messages
	msgs   int
	fulls  int
	// packets: RTP packets bots received on subscribed tracks (audio flows).
	packets atomic.Int64
}

func newRecorder() *recorder {
	return &recorder{pos: map[string][]posSample{}, ready: map[string]float64{}, sets: map[string]map[string]bool{}}
}

func (r *recorder) add(e event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) sub(l, s string, on bool) {
	k := "unsub"
	if on {
		k = "sub"
	}
	r.add(event{T: nowMs(), Kind: k, L: l, S: s})
}

func (r *recorder) phase(name string) { r.add(event{T: nowMs(), Kind: "phase", S: name}) }

func (r *recorder) markReady(l string, t float64) {
	r.mu.Lock()
	r.ready[l] = t
	r.mu.Unlock()
	r.add(event{T: t, Kind: "ready", L: l})
}

func (r *recorder) logPos(id string, x, z float64) {
	r.mu.Lock()
	r.pos[id] = append(r.pos[id], posSample{nowMs(), x, z})
	r.mu.Unlock()
}

// earshot folds one zone message into the reconstructed sets and records
// every pair transition it implies, stamped with the zone's compute time.
func (r *recorder) earshot(raw []byte) {
	var m earshot.Message
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs++
	if m.Full {
		r.fulls++
	}
	update := func(l string, next []string) {
		cur := r.sets[l]
		nm := map[string]bool{}
		for _, s := range next {
			nm[s] = true
			if !cur[s] {
				r.events = append(r.events, event{T: m.T, Kind: "zin", L: l, S: s})
			}
		}
		for s := range cur {
			if !nm[s] {
				r.events = append(r.events, event{T: m.T, Kind: "zout", L: l, S: s})
			}
		}
		r.sets[l] = nm
	}
	if m.Full {
		var ls []string
		for l := range r.sets {
			if _, ok := m.Sets[l]; !ok {
				ls = append(ls, l)
			}
		}
		slices.Sort(ls)
		for _, l := range ls {
			update(l, nil)
		}
	}
	ls := make([]string, 0, len(m.Sets))
	for l := range m.Sets {
		ls = append(ls, l)
	}
	slices.Sort(ls)
	for _, l := range ls {
		update(l, m.Sets[l])
	}
	for _, l := range m.Gone {
		update(l, nil)
	}
}

func (r *recorder) snapshot() ([]event, map[string][]posSample, map[string]float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ev := slices.Clone(r.events)
	slices.SortStableFunc(ev, func(a, b event) int {
		switch {
		case a.T < b.T:
			return -1
		case a.T > b.T:
			return 1
		}
		return 0
	})
	pos := make(map[string][]posSample, len(r.pos))
	for k, v := range r.pos {
		pos[k] = slices.Clone(v)
	}
	ready := make(map[string]float64, len(r.ready))
	for k, v := range r.ready {
		ready[k] = v
	}
	return ev, pos, ready
}
