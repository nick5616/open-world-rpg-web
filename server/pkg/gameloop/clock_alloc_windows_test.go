//go:build windows

package gameloop

import "testing"

// G5: the spin tail calls monoNow thousands of times a tick; it must not
// allocate.
func TestMonoNowDoesNotAllocate(t *testing.T) {
	if n := testing.AllocsPerRun(1000, func() { _ = monoNow() }); n != 0 {
		t.Fatalf("monoNow allocates %v times per call", n)
	}
}
