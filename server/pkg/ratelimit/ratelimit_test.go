package ratelimit

import (
	"testing"
	"time"
)

func TestBurstThenRefill(t *testing.T) {
	t0 := time.Unix(1000, 0)
	b := New(3, 2) // burst 3, 2/s
	for i := 0; i < 3; i++ {
		if !b.Take(t0) {
			t.Fatalf("burst token %d refused", i)
		}
	}
	if b.Take(t0) {
		t.Fatal("4th token in the same instant must be refused")
	}
	if !b.Take(t0.Add(500 * time.Millisecond)) {
		t.Fatal("one token should refill after 0.5 s at 2/s")
	}
	if b.Take(t0.Add(500 * time.Millisecond)) {
		t.Fatal("only one token refilled")
	}
	// Long idle caps at capacity.
	if got := b.Tokens(t0.Add(time.Hour)); got != 3 {
		t.Fatalf("tokens capped at capacity, got %v", got)
	}
	if !b.TakeN(t0.Add(time.Hour), 3) || b.TakeN(t0.Add(time.Hour), 1) {
		t.Fatal("TakeN accounting")
	}
}
