package game

// Tick phase timing (WP19). Where a slow tick's time went, without a CPU
// profiler (Go's profiler once crashed a zone on Windows unwinding wazero
// JIT frames, WP16): every tick records the duration of its phases; the
// last tickPhaseWindow ticks are kept, and /debug/tickstats reports each
// phase's mean and max plus the phase split of the slowest tick. Cost: a
// handful of clock reads per tick.

import (
	"sync"
	"time"
)

const (
	phInputs    = iota // joins, leaves, inbox drain + movement (drain)
	phWorld            // terrain, exploration, caves, mining, handoff
	phCombat           // combat AI, strikes, claims
	phTowns            // townsfolk
	phNight            // WP15: clock, demons, defense events, chemistry
	phGrid             // view, quantize, AOI grid, mirrors, earshot, checkpoints
	phSnapshots        // the parallel snapshot phase (snapshots.go)
	phCount
)

var phaseNames = [phCount]string{"inputs", "world", "combat", "towns", "night", "grid", "snapshots"}

const tickPhaseWindow = 30 * 60 // one minute

type tickPhases struct {
	mu       sync.Mutex
	ring     [tickPhaseWindow][phCount]time.Duration
	n        int
	cur      [phCount]time.Duration
	last     time.Time
	loggedAt time.Time // last slow-tick log
}

// mark ends phase p at now.
func (t *tickPhases) mark(p int) {
	now := time.Now()
	t.cur[p] += now.Sub(t.last)
	t.last = now
}

func (t *tickPhases) start() {
	t.cur = [phCount]time.Duration{}
	t.last = time.Now()
}

func (t *tickPhases) end() {
	t.mu.Lock()
	t.ring[t.n%tickPhaseWindow] = t.cur
	t.n++
	t.mu.Unlock()
}

// slowTickLog: a tick longer than this logs its phase split (at most once a
// second). Stalls this long show as a remote "lurch" in every client: the
// stalled tick's snapshot carries normal motion, the next (catch-up) tick
// applies all the input that queued meanwhile within a millisecond of
// server time (WP19 lurch investigation, docs/decisions/v1-capacity.md).
const slowTickLog = 100 * time.Millisecond

// endTick records the tick's phases and logs a slow one.
func (s *Server) endTick(tick uint32) {
	t := &s.phases
	t.end()
	var total time.Duration
	for _, d := range t.cur {
		total += d
	}
	if total < slowTickLog || time.Since(t.loggedAt) < time.Second {
		return
	}
	t.loggedAt = time.Now()
	args := []any{"tick", tick, "ms", total.Milliseconds(), "players", len(s.sessions), "entities", len(s.ents)}
	for p, name := range phaseNames {
		args = append(args, name, float64(t.cur[p].Microseconds())/1000)
	}
	s.log.Warn("slow tick", args...)
}

// PhaseStats is the /debug/tickstats phase report (ms).
type PhaseStats struct {
	Ticks   int                `json:"ticks"`
	MeanMs  map[string]float64 `json:"meanMs"`
	MaxMs   map[string]float64 `json:"maxMs"`
	Slowest map[string]float64 `json:"slowestTickMs"`
}

// TickPhases summarizes the last minute of tick phases (any goroutine).
func (s *Server) TickPhases() PhaseStats {
	t := &s.phases
	t.mu.Lock()
	defer t.mu.Unlock()
	n := min(t.n, tickPhaseWindow)
	st := PhaseStats{Ticks: n, MeanMs: map[string]float64{}, MaxMs: map[string]float64{}, Slowest: map[string]float64{}}
	if n == 0 {
		return st
	}
	var sum, mx [phCount]time.Duration
	slow, slowTotal := 0, time.Duration(-1)
	for i := 0; i < n; i++ {
		var tot time.Duration
		for p, d := range t.ring[i] {
			sum[p] += d
			mx[p] = max(mx[p], d)
			tot += d
		}
		if tot > slowTotal {
			slow, slowTotal = i, tot
		}
	}
	ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
	for p, name := range phaseNames {
		st.MeanMs[name] = ms(sum[p] / time.Duration(n))
		st.MaxMs[name] = ms(mx[p])
		st.Slowest[name] = ms(t.ring[slow][p])
	}
	return st
}
