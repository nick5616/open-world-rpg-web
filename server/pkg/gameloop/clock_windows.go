//go:build windows

package gameloop

import (
	"syscall"
	"unsafe"
)

// On Windows, Go's time.Now reads the kernel's interrupt-time counter, which
// only advances once per system timer interrupt: measured 0.52-0.56 ms steps on
// the dev machine (and 15.6 ms on a box where nothing raised the timer
// resolution). A spin tail that polls time.Now can therefore only land within
// half a millisecond of the deadline, and jitter measured with it is quantized
// to the same steps; the first measurement run showed jitter p50 0.2-0.3 ms
// no matter how long the spin was. QueryPerformanceCounter ticks at 10 MHz
// and costs ~85 ns per call, which is cheap enough to spin on.
var (
	qpc     = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryPerformanceCounter")
	qpfFreq int64
	qpcBase int64
)

func init() {
	qpf := syscall.NewLazyDLL("kernel32.dll").NewProc("QueryPerformanceFrequency")
	_, _, _ = qpf.Call(uintptr(unsafe.Pointer(&qpfFreq)))
	_, _, _ = qpc.Call(uintptr(unsafe.Pointer(&qpcBase)))
	if qpfFreq <= 0 {
		qpfFreq = 0 // fall back to the portable clock below
	}
}

// monoNow returns monotonic nanoseconds since process start.
func monoNow() int64 {
	if qpfFreq == 0 {
		return portableNow()
	}
	// SyscallN, not LazyProc.Call: Call's arguments escape, so &c was a
	// heap allocation per call, ~9 MB/s of garbage from the spin tail alone
	// (G5 4 vCPU, live zone allocation profile).
	var c int64
	_, _, _ = syscall.SyscallN(qpc.Addr(), uintptr(unsafe.Pointer(&c)))
	d := c - qpcBase
	// Split to avoid overflow: d*1e9 overflows int64 after ~15 min at 10 MHz.
	return d/qpfFreq*1e9 + d%qpfFreq*1e9/qpfFreq
}

// PreciseClock reports which clock the scheduler spins on (for evidence).
const PreciseClock = "QueryPerformanceCounter"
