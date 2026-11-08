package gameloop

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

const hz30 = time.Second / 30

func TestLoopTicksAtRate(t *testing.T) {
	s := New(DefaultSpinTail())
	defer s.Close()
	var mu sync.Mutex
	n := 0
	st := NewStats(hz30, 100)
	l := &Loop{Interval: hz30, Stats: st, OnTick: func() { mu.Lock(); n++; mu.Unlock() }}
	s.Add(l)
	time.Sleep(time.Second)
	s.Remove(l)
	mu.Lock()
	defer mu.Unlock()
	if n < 28 || n > 31 {
		t.Fatalf("expected ~30 ticks in 1 s, got %d", n)
	}
	sum := st.Summary()
	if sum.WinSpace.P50 < 32 || sum.WinSpace.P50 > 35 {
		t.Fatalf("median spacing %v ms", sum.WinSpace.P50)
	}
}

func TestLoopsShareTheGrid(t *testing.T) {
	s := New(DefaultSpinTail())
	defer s.Close()
	var mu sync.Mutex
	var a, b []time.Time
	la := &Loop{Interval: hz30, OnTick: func() { mu.Lock(); a = append(a, time.Now()); mu.Unlock() }}
	lb := &Loop{Interval: hz30, OnTick: func() { mu.Lock(); b = append(b, time.Now()); mu.Unlock() }}
	s.Add(la)
	time.Sleep(47 * time.Millisecond) // deliberately off-phase
	s.Add(lb)
	time.Sleep(400 * time.Millisecond)
	s.Remove(la)
	s.Remove(lb)
	mu.Lock()
	defer mu.Unlock()
	// Every tick of b should coincide with a tick of a (same wake-up).
	matched := 0
	for _, tb := range b {
		for _, ta := range a {
			if d := tb.Sub(ta); d >= 0 && d < 2*time.Millisecond {
				matched++
				break
			}
		}
	}
	if len(b) < 8 || matched < len(b)-1 {
		t.Fatalf("loops not aligned: %d of %d b ticks matched", matched, len(b))
	}
}

func TestCatchupIsBoundedAndDebtForgiven(t *testing.T) {
	s := New(DefaultSpinTail())
	defer s.Close()
	var mu sync.Mutex
	var starts []time.Time
	st := NewStats(hz30, 100)
	first := true
	l := &Loop{Interval: hz30, Stats: st}
	l.OnTick = func() {
		mu.Lock()
		starts = append(starts, time.Now())
		stall := first
		first = false
		mu.Unlock()
		if stall {
			time.Sleep(300 * time.Millisecond) // ~9 intervals of debt
		}
	}
	s.Add(l)
	time.Sleep(600 * time.Millisecond)
	s.Remove(l)
	mu.Lock()
	defer mu.Unlock()
	// Count ticks that ran back to back right after the stall.
	burst := 0
	for i := 1; i < len(starts); i++ {
		if starts[i].Sub(starts[i-1]) < 3*time.Millisecond {
			burst++
		}
	}
	if burst > MaxCatchup {
		t.Fatalf("catch-up burst of %d exceeds MaxCatchup", burst)
	}
	if st.Summary().Forgiven < 1 {
		t.Fatal("expected the stall's debt to be forgiven")
	}
}

func TestRemoveInsideTickAndPanicRecovery(t *testing.T) {
	s := New(0)
	defer s.Close()
	done := make(chan struct{})
	n := 0
	var l *Loop
	l = &Loop{Interval: 5 * time.Millisecond, OnTick: func() {
		n++
		if n == 1 {
			panic("boom")
		}
		s.Remove(l)
		close(done)
	}}
	s.Add(l)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("loop did not survive a panic / remove itself")
	}
}

func TestStatsQuantiles(t *testing.T) {
	st := NewStats(10*time.Millisecond, 1000)
	for i := 1; i <= 100; i++ {
		st.Record(time.Duration(i)*time.Millisecond/10, 10*time.Millisecond+time.Duration(i%3-1)*time.Millisecond)
	}
	sum := st.Summary()
	if sum.WinTick.P50 < 5 || sum.WinTick.P50 > 5.2 || sum.WinTick.Max != 10 {
		t.Fatalf("window tick %+v", sum.WinTick)
	}
	if sum.WinJitter.Max != 1 || sum.LifeJit.Max != 1 {
		t.Fatalf("jitter %+v %+v", sum.WinJitter, sum.LifeJit)
	}
	if sum.LifeTick.P99 < 9.8 || sum.LifeTick.P99 > 10.1 {
		t.Fatalf("lifetime tick %+v", sum.LifeTick)
	}
}

// TestMeasureJitter is the evidence harness for spec 4 ("measure the zone
// scheduler's tick jitter on both operating systems"). Skipped unless
// LODESTONE_JITTER_S is set; prints one row per spin tail.
//
//	LODESTONE_JITTER_S=20 go test ./gameloop -run TestMeasureJitter -v
func TestMeasureJitter(t *testing.T) {
	secs, _ := strconv.Atoi(os.Getenv("LODESTONE_JITTER_S"))
	if secs <= 0 {
		t.Skip("set LODESTONE_JITTER_S to measure")
	}
	fmt.Printf("GOOS=%s GOARCH=%s NumCPU=%d %s, clock=%s, %d s per row, 30 Hz, idle tick body\n", runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.Version(), PreciseClock, secs)
	fmt.Printf("%-8s %8s %10s %10s %10s %10s %10s %8s\n", "spin_ms", "ticks", "jit_p50", "jit_p99", "jit_max", "space_min", "space_max", "spin%")
	for _, spin := range []float64{0, 0.5, 1, 2, 3} {
		s := New(time.Duration(spin * float64(time.Millisecond)))
		st := NewStats(hz30, secs*30+10)
		l := &Loop{Interval: hz30, Stats: st, OnTick: func() {}}
		s.Add(l)
		time.Sleep(time.Duration(secs) * time.Second)
		s.Remove(l)
		spun := s.SpinTotal()
		s.Close()
		sum := st.Summary()
		minSp := sum.WinSpace.Max
		st.mu.Lock()
		for _, x := range st.win {
			if x.spacing > 0 && ms(x.spacing) < minSp {
				minSp = ms(x.spacing)
			}
		}
		st.mu.Unlock()
		fmt.Printf("%-8.1f %8d %10.3f %10.3f %10.3f %10.3f %10.3f %7.2f%%\n", spin, sum.Ticks, sum.WinJitter.P50, sum.WinJitter.P99, sum.WinJitter.Max, minSp, sum.WinSpace.Max, 100*spun.Seconds()/float64(secs))
	}
}
