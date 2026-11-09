package game

import (
	"syscall"
	"unsafe"
)

// cpuUnit names processCPU's unit in BenchmarkScale's metric: on Windows,
// process times (GetProcessTimes) are sampled at the clock tick and miss
// most of a tick's short parallel bursts (they read ~1 ms of CPU per 7 ms
// tick on 4 busy threads), so the benchmark counts CPU cycles instead
// (QueryProcessCycleTime: every cycle any of the process's threads ran,
// at the TSC rate), in millions.
const cpuUnit = "cpu-Mcycles"

var queryProcessCycleTime = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryProcessCycleTime")

// processCPU is the process's CPU cycles so far, in millions (see cpuUnit).
func processCPU() float64 {
	h, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0
	}
	var cycles uint64
	if r, _, _ := queryProcessCycleTime.Call(uintptr(h), uintptr(unsafe.Pointer(&cycles))); r == 0 {
		return 0
	}
	return float64(cycles) / 1e6
}
