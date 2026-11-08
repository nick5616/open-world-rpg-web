// Package gameloop runs fixed-rate loops (the zone's 30 Hz tick) on ONE shared
// scheduler.
//
// adapted from wizard-wars server/src/GameLoop.js; the reasoning carries over:
//
// A plain timer is subject to OS timer-resolution rounding. On Windows the
// default system timer ticks every ~15.6 ms; Go asks for high-resolution
// waitable timers there, which helps, but wake-ups still land up to a
// millisecond or two late under load (1000 x Sleep(1ms) took 1.21 s on the
// dev machine). Worse, Go's time.Now on Windows moves in timer-interrupt
// steps (0.5 ms there), so the spin polls QueryPerformanceCounter instead
// (clock_windows.go); spinning on time.Now gave the same ~0.3 ms jitter p50
// with or without a tail (docs/evidence/wp03-jitter-idle-windows-timenow.txt). At 30 Hz (33.3 ms) that unevenness
// feeds straight into snapshot timestamps, the client's clock sync and remote
// interpolation. So each wait is split into a coarse sleep for most of the
// remaining time and a short busy-wait tail (polling the monotonic clock) for
// the last SpinTail. The tail is configurable (LODESTONE_SPIN_MS) and defaults
// to 2 ms on Windows, 1 ms elsewhere, because Windows wake-ups are the
// sloppier ones; measure before changing it (docs/evidence/wp03-jitter-*.txt).
//
// Why shared: wizard-wars once ran one timer + one spin per room; K rooms spun
// their own tails at unrelated phases, burned most of a core and queued in
// front of each other, adding jitter instead of removing it. Here every loop
// is aligned to a single global grid: one wake-up, one spin, then every due
// loop runs back to back. Spin cost does not scale with loop count, and with
// no loops the scheduler sleeps.
//
// Catch-up is bounded (MaxCatchup ticks per wake-up per loop) so a stall
// cannot snowball into a death spiral, and debt beyond that is forgiven: the
// loop re-snaps to the next grid boundary instead of firing a long run of
// back-to-back ticks that would distort spacing for every client.
package gameloop

import (
	"log/slog"
	"runtime"
	"sync"
	"time"

	"lodestone/server/pkg/env"
)

const (
	// MaxCatchup bounds ticks run per wake-up per loop (wizard-wars: 4).
	MaxCatchup = 4
	// DueSlop: a loop due within this of now runs now instead of costing
	// another wake-up and spin.
	DueSlop = 250 * time.Microsecond
)

// DefaultSpinTail is the busy-wait tail: 2 ms on Windows, 1 ms elsewhere,
// overridable with LODESTONE_SPIN_MS (fractional ms allowed, 0 disables).
func DefaultSpinTail() time.Duration {
	def := 1.0
	if runtime.GOOS == "windows" {
		def = 2.0
	}
	return time.Duration(env.Float("LODESTONE_SPIN_MS", def) * float64(time.Millisecond))
}

// Loop is one fixed-rate loop. OnTick runs on the scheduler goroutine; it
// must not block (the zone never waits on I/O inside a tick).
type Loop struct {
	Interval time.Duration
	OnTick   func()
	Stats    *Stats // optional; tick duration and spacing are recorded here

	// Timestamps are Now() values (precise monotonic ns since process start).
	due       time.Duration
	running   bool
	lastStart time.Duration
	hasLast   bool
}

// Scheduler is the shared grid. The zero value is not usable; call New.
type Scheduler struct {
	SpinTail time.Duration

	mu      sync.Mutex
	loops   map[*Loop]struct{}
	origin  time.Duration
	wake    chan struct{}
	stopped chan struct{}
	quit    chan struct{}
	spinNs  int64 // total spin time, for the spin-cost metric
	log     *slog.Logger
}

// New creates and starts a scheduler goroutine with the given spin tail.
func New(spin time.Duration) *Scheduler {
	s := &Scheduler{
		SpinTail: spin,
		loops:    map[*Loop]struct{}{},
		origin:   Now(),
		wake:     make(chan struct{}, 1),
		stopped:  make(chan struct{}),
		quit:     make(chan struct{}),
		log:      slog.Default(),
	}
	go s.run()
	return s
}

// Add starts a loop. Its first deadline snaps onto the shared grid (next
// boundary strictly in the future) so loops added at different moments still
// tick together.
func (s *Scheduler) Add(l *Loop) {
	s.mu.Lock()
	l.running = true
	l.hasLast = false
	s.snap(l, Now())
	s.loops[l] = struct{}{}
	s.mu.Unlock()
	s.poke()
}

// Remove stops a loop. Safe to call from inside its own OnTick.
func (s *Scheduler) Remove(l *Loop) {
	s.mu.Lock()
	l.running = false
	delete(s.loops, l)
	s.mu.Unlock()
	s.poke()
}

// Close stops the scheduler goroutine and waits for it (a tick in progress
// finishes first).
func (s *Scheduler) Close() {
	close(s.quit)
	<-s.stopped
}

// SpinTotal returns cumulative time spent busy-waiting.
func (s *Scheduler) SpinTotal() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Duration(s.spinNs)
}

func (s *Scheduler) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// snap moves l's deadline to the first grid boundary strictly after now.
func (s *Scheduler) snap(l *Loop, now time.Duration) {
	n := (now-s.origin)/l.Interval + 1
	l.due = s.origin + n*l.Interval
}

func (s *Scheduler) earliest() (time.Duration, bool) {
	var min time.Duration
	found := false
	for l := range s.loops {
		if !found || l.due < min {
			min, found = l.due, true
		}
	}
	return min, found
}

func (s *Scheduler) run() {
	defer close(s.stopped)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		s.mu.Lock()
		deadline, ok := s.earliest()
		s.mu.Unlock()

		if !ok {
			select {
			case <-s.quit:
				return
			case <-s.wake:
				continue
			}
		}

		// Coarse sleep until SpinTail before the deadline.
		if d := deadline - Now() - s.SpinTail; d > 0 {
			timer.Reset(d)
			select {
			case <-s.quit:
				return
			case <-s.wake:
				if !timer.Stop() {
					<-timer.C
				}
				continue // loop set changed; re-evaluate the deadline
			case <-timer.C:
			}
		}

		// Busy-wait the last sliver on the precise clock (QPC on Windows,
		// see clock_windows.go: time.Now there moves in 0.5 ms steps).
		spinStart := Now()
		for Now() < deadline {
		}
		spun := Now() - spinStart

		s.mu.Lock()
		s.spinNs += int64(spun)
		due := make([]*Loop, 0, len(s.loops))
		now := Now()
		for l := range s.loops {
			if l.running && l.due-now <= DueSlop {
				due = append(due, l)
			}
		}
		s.mu.Unlock()

		for _, l := range due {
			s.runDue(l)
		}

		select {
		case <-s.quit:
			return
		default:
		}
	}
}

// runDue runs l's due tick(s): catch up if behind, but at most MaxCatchup,
// then forgive the remaining debt.
func (s *Scheduler) runDue(l *Loop) {
	now := Now()
	for i := 0; i < MaxCatchup; i++ {
		s.mu.Lock()
		run := l.running && l.due-now <= DueSlop
		if run {
			l.due += l.Interval
		}
		s.mu.Unlock()
		if !run {
			break
		}
		t0 := Now()
		s.safeTick(l)
		now = Now()
		if l.Stats != nil {
			var spacing time.Duration
			if l.hasLast {
				spacing = t0 - l.lastStart
			}
			l.Stats.Record(now-t0, spacing)
		}
		l.lastStart, l.hasLast = t0, true
	}
	// Still behind after the catch-up budget: drop the debt (the old
	// accumulator never forgave it; one long stall caused a long run of
	// back-to-back ticks that distorted spacing for every client).
	s.mu.Lock()
	if l.running && l.due < now {
		s.snap(l, now)
		if l.Stats != nil {
			l.Stats.forgiven.Add(1)
		}
	}
	s.mu.Unlock()
}

func (s *Scheduler) safeTick(l *Loop) {
	defer func() {
		if r := recover(); r != nil {
			// One bad tick must not take the zone down; log and keep the grid.
			s.log.Error("tick panic", "panic", r)
		}
	}()
	l.OnTick()
}
