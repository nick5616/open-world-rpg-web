// Package ratelimit is a token bucket for per-connection, per-message-type
// limits (spec 9 security).
//
// adapted from the-circle backend/rooms/consumers.py Bucket: bursts up to
// Capacity, refills at Rate per second. Not goroutine-safe on purpose: each
// bucket belongs to exactly one connection goroutine (or the tick), so a lock
// would be pure overhead on the hottest path we have (every input packet).
package ratelimit

import "time"

// Bucket allows bursts up to Capacity and refills at Rate tokens/s.
type Bucket struct {
	Capacity float64
	Rate     float64
	tokens   float64
	stamp    time.Time
}

// New returns a full bucket.
func New(capacity, rate float64) Bucket {
	return Bucket{Capacity: capacity, Rate: rate, tokens: capacity}
}

// Take consumes one token if available.
func (b *Bucket) Take(now time.Time) bool { return b.TakeN(now, 1) }

// TakeN consumes n tokens if all are available.
func (b *Bucket) TakeN(now time.Time, n float64) bool {
	b.refill(now)
	if b.tokens >= n {
		b.tokens -= n
		return true
	}
	return false
}

// Tokens reports the current balance (after refill).
func (b *Bucket) Tokens(now time.Time) float64 {
	b.refill(now)
	return b.tokens
}

func (b *Bucket) refill(now time.Time) {
	if b.stamp.IsZero() {
		b.stamp = now
		return
	}
	if dt := now.Sub(b.stamp).Seconds(); dt > 0 {
		b.tokens = min(b.Capacity, b.tokens+dt*b.Rate)
		b.stamp = now
	}
}
