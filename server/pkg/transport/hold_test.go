package transport

import (
	"sync"
	"sync/atomic"
	"testing"
)

// WP19b: a held wake-up is delivered exactly when released, and a poke that
// races with Release is never lost.
func TestHoldDefersWakeups(t *testing.T) {
	var k wake
	var n atomic.Int64
	fire := func() { n.Add(1) }
	k.poke(fire)
	if n.Load() != 1 {
		t.Fatal("unheld poke must wake at once")
	}
	k.hold()
	k.poke(fire)
	k.poke(fire)
	if n.Load() != 1 {
		t.Fatalf("held pokes woke the writer: %d", n.Load())
	}
	k.release(fire)
	if n.Load() != 2 {
		t.Fatalf("release must wake once for the held pokes, got %d", n.Load()-1)
	}
	k.release(fire)
	if n.Load() != 2 {
		t.Fatal("a release with nothing pending must not wake")
	}
	// Races: pokes from other goroutines while the holder releases. After
	// everything settles, the last poke must have been followed by a wake
	// (pending must be false: nothing left undelivered).
	for round := 0; round < 2000; round++ {
		k.hold()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); k.poke(fire) }()
		go func() { defer wg.Done(); k.release(fire) }()
		wg.Wait()
		if k.pending.Load() && !k.held.Load() {
			t.Fatalf("round %d: a wake-up was left pending after release", round)
		}
	}
}
