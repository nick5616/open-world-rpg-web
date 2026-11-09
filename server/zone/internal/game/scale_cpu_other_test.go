//go:build unix

package game

import "syscall"

// cpuUnit names processCPU's unit in BenchmarkScale's metric (see
// scale_cpu_windows_test.go): CPU milliseconds here.
const cpuUnit = "cpu-ms"

// processCPU is the process's user + system CPU time so far, in ms.
func processCPU() float64 {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return float64(ru.Utime.Nano()+ru.Stime.Nano()) / 1e6
}
