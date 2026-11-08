package gameloop

import (
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Stats records tick duration and tick-start spacing. Jitter is
// |spacing - interval|: how far each tick started from where the grid said it
// should, relative to the previous one. That is what clients feel (snapshot
// timestamps, interpolation), so it is the number we budget and report.
//
// Two views: a sliding window of the last N ticks (what /metrics shows, so a
// soak's scrape covers the soak, not startup) and a lifetime histogram with
// 10 us buckets (exact enough for p99 over hours without keeping samples).
type Stats struct {
	interval time.Duration
	forgiven atomic.Int64

	mu       sync.Mutex
	win      []sample
	next     int
	full     bool
	ticks    int64
	durHist  hist
	jitHist  hist
	maxDur   time.Duration
	maxJit   time.Duration
	stalls   int64
	winBuf   []float64
	winBufJ  []float64
	winBufSp []float64
}

type sample struct{ dur, spacing time.Duration }

// NewStats keeps a window of the last `window` ticks.
func NewStats(interval time.Duration, window int) *Stats {
	if window < 1 {
		window = 1
	}
	return &Stats{interval: interval, win: make([]sample, window)}
}

// Record adds one tick. spacing is 0 for the first tick after (re)start.
func (s *Stats) Record(dur, spacing time.Duration) {
	s.mu.Lock()
	s.win[s.next] = sample{dur, spacing}
	s.next++
	if s.next == len(s.win) {
		s.next, s.full = 0, true
	}
	s.ticks++
	s.durHist.add(dur)
	if dur > s.maxDur {
		s.maxDur = dur
	}
	if spacing > 0 {
		j := absDur(spacing - s.interval)
		s.jitHist.add(j)
		if j > s.maxJit {
			s.maxJit = j
		}
	}
	if dur > s.interval {
		s.stalls++
	}
	s.mu.Unlock()
}

// Quantiles summarizes a distribution in milliseconds.
type Quantiles struct {
	N   int     `json:"n"`
	P50 float64 `json:"p50"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

// Summary is what metrics and evidence report.
type Summary struct {
	Ticks     int64     `json:"ticks"`
	Overruns  int64     `json:"overruns"` // ticks longer than the interval
	Forgiven  int64     `json:"forgiven"` // catch-up debts dropped
	WinTick   Quantiles `json:"windowTickMs"`
	WinJitter Quantiles `json:"windowJitterMs"`
	WinSpace  Quantiles `json:"windowSpacingMs"`
	LifeTick  Quantiles `json:"lifetimeTickMs"`
	LifeJit   Quantiles `json:"lifetimeJitterMs"`
}

// Summary computes percentiles over the window and lifetime.
func (s *Stats) Summary() Summary {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.next
	if s.full {
		n = len(s.win)
	}
	s.winBuf, s.winBufJ, s.winBufSp = s.winBuf[:0], s.winBufJ[:0], s.winBufSp[:0]
	for i := 0; i < n; i++ {
		x := s.win[i]
		s.winBuf = append(s.winBuf, ms(x.dur))
		if x.spacing > 0 {
			s.winBufSp = append(s.winBufSp, ms(x.spacing))
			s.winBufJ = append(s.winBufJ, ms(absDur(x.spacing-s.interval)))
		}
	}
	return Summary{
		Ticks:     s.ticks,
		Overruns:  s.stalls,
		Forgiven:  s.forgiven.Load(),
		WinTick:   quantiles(s.winBuf),
		WinJitter: quantiles(s.winBufJ),
		WinSpace:  quantiles(s.winBufSp),
		LifeTick:  s.durHist.quantiles(ms(s.maxDur)),
		LifeJit:   s.jitHist.quantiles(ms(s.maxJit)),
	}
}

func quantiles(v []float64) Quantiles {
	if len(v) == 0 {
		return Quantiles{}
	}
	sort.Float64s(v)
	at := func(p float64) float64 { return round3(v[min(len(v)-1, int(float64(len(v))*p))]) }
	return Quantiles{N: len(v), P50: at(0.5), P99: at(0.99), Max: round3(v[len(v)-1])}
}

// hist is a linear histogram with 10 us buckets up to 200 ms (+ overflow).
const (
	histBucket = 10 * time.Microsecond
	histN      = 20000
)

type hist struct {
	b [histN + 1]uint32
	n int64
}

func (h *hist) add(d time.Duration) {
	i := int(d / histBucket)
	if i > histN || i < 0 {
		i = histN
	}
	h.b[i]++
	h.n++
}

func (h *hist) quantiles(max float64) Quantiles {
	if h.n == 0 {
		return Quantiles{}
	}
	at := func(p float64) float64 {
		target := int64(math.Ceil(float64(h.n) * p))
		var acc int64
		for i, c := range h.b {
			acc += int64(c)
			if acc >= target {
				// Upper edge of the bucket: a conservative estimate.
				return round3(ms(time.Duration(i+1) * histBucket))
			}
		}
		return max
	}
	return Quantiles{N: int(h.n), P50: at(0.5), P99: at(0.99), Max: round3(max)}
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
func round3(x float64) float64   { return math.Round(x*1000) / 1000 }
func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
