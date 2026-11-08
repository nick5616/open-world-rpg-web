// Package writebehind is the per-zone write-behind queue (spec 11 rules: zone
// servers never block a tick on Postgres).
//
// The tick only ever calls Enqueue, which takes a mutex for a few hundred
// nanoseconds and never waits on I/O. One worker goroutine drains the queue
// in order and runs each op against the database with a timeout. Design
// points, each from a failure mode we want to rule out:
//
//   - Coalescing by key: a checkpoint for character C replaces any queued,
//     not-yet-run checkpoint for C (keeping its place in line). If Postgres is
//     down for ten minutes, the queue holds one entry per character, not
//     twenty, and recovery writes the newest state once.
//   - Bounded: when full, Enqueue drops the new op and counts it rather than
//     growing without limit or blocking the tick. Size it well above online
//     players so coalesced checkpoints never hit the bound.
//   - Retry with exponential backoff (100 ms doubling to 10 s) for transient
//     errors, then give up after MaxAttempts and log; an op returning
//     ErrSkip (or wrapping it) is dropped at once (e.g. the character row does
//     not exist yet: retrying cannot help).
//   - Flush on shutdown drains everything that is left until the deadline.
//
// A crash still loses whatever is queued (at most SAVE_INTERVAL_S of
// movement); loot grants never go through here, they are transactional
// (spec 11).
package writebehind

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// ErrSkip marks a permanent, expected failure: drop the op without retrying.
var ErrSkip = errors.New("writebehind: skip")

// Op is one unit of durable work.
type Op struct {
	// Key coalesces ops: a newer op with the same non-empty Key replaces a
	// queued older one. Empty Key never coalesces.
	Key string
	// Run performs the write. It must honor ctx.
	Run func(ctx context.Context) error
}

// Stats are cumulative counters for metrics.
type Stats struct {
	Enqueued, Coalesced, Dropped, Done, Retries, Failed, Skipped atomic.Int64
}

type item struct {
	op        Op
	attempts  int
	notBefore time.Time
}

// Queue is a bounded, coalescing, retrying write-behind queue.
type Queue struct {
	Max         int
	MaxAttempts int
	OpTimeout   time.Duration
	Stats       Stats
	Log         *slog.Logger

	mu     sync.Mutex
	items  []*item
	byKey  map[string]*item
	notify chan struct{}
	busy   bool // an op is executing (counted in Depth)
}

// New creates a queue holding at most max ops.
func New(max int) *Queue {
	return &Queue{Max: max, MaxAttempts: 8, OpTimeout: 5 * time.Second, Log: slog.Default(),
		byKey: map[string]*item{}, notify: make(chan struct{}, 1)}
}

// Enqueue adds op without blocking. Returns false if the queue was full.
func (q *Queue) Enqueue(op Op) bool {
	q.mu.Lock()
	if op.Key != "" {
		if it, ok := q.byKey[op.Key]; ok {
			it.op = op
			q.mu.Unlock()
			q.Stats.Coalesced.Add(1)
			return true
		}
	}
	if len(q.items) >= q.Max {
		q.mu.Unlock()
		q.Stats.Dropped.Add(1)
		return false
	}
	it := &item{op: op}
	q.items = append(q.items, it)
	if op.Key != "" {
		q.byKey[op.Key] = it
	}
	q.mu.Unlock()
	q.Stats.Enqueued.Add(1)
	select {
	case q.notify <- struct{}{}:
	default:
	}
	return true
}

// Depth is the number of queued ops (including ones waiting to retry).
func (q *Queue) Depth() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	n := len(q.items)
	if q.busy {
		n++
	}
	return n
}

// Run drains the queue until ctx ends. Call it on its own goroutine.
func (q *Queue) Run(ctx context.Context) {
	for {
		it, wait := q.next(time.Now())
		if it == nil {
			t := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-q.notify:
			case <-t.C:
			}
			t.Stop()
			continue
		}
		q.exec(ctx, it, true)
	}
}

// Flush runs every remaining op (ignoring backoff, one attempt each beyond
// what they already had, up to MaxAttempts) until the queue is empty or ctx
// expires. Call after Run's context is cancelled, on shutdown.
func (q *Queue) Flush(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			if d := q.Depth(); d > 0 {
				q.Log.Error("write-behind flush incomplete", "left", d)
			}
			return err
		}
		q.mu.Lock()
		if len(q.items) == 0 {
			q.mu.Unlock()
			return nil
		}
		it := q.pop(0)
		q.busy = true
		q.mu.Unlock()
		q.exec(ctx, it, false)
	}
}

// next pops the first op whose backoff has elapsed, or reports how long to
// wait for one.
func (q *Queue) next(now time.Time) (*item, time.Duration) {
	q.mu.Lock()
	defer q.mu.Unlock()
	wait := time.Hour
	for i, it := range q.items {
		if !it.notBefore.After(now) {
			q.busy = true
			return q.pop(i), 0
		}
		if d := it.notBefore.Sub(now); d < wait {
			wait = d
		}
	}
	return nil, wait
}

// pop removes items[i]; caller holds mu.
func (q *Queue) pop(i int) *item {
	it := q.items[i]
	copy(q.items[i:], q.items[i+1:])
	q.items[len(q.items)-1] = nil
	q.items = q.items[:len(q.items)-1]
	if it.op.Key != "" && q.byKey[it.op.Key] == it {
		delete(q.byKey, it.op.Key)
	}
	return it
}

func (q *Queue) exec(ctx context.Context, it *item, backoff bool) {
	octx, cancel := context.WithTimeout(context.WithoutCancel(ctx), q.OpTimeout)
	err := it.op.Run(octx)
	cancel()
	it.attempts++

	q.mu.Lock()
	q.busy = false
	defer q.mu.Unlock()
	switch {
	case err == nil:
		q.Stats.Done.Add(1)
	case errors.Is(err, ErrSkip):
		q.Stats.Skipped.Add(1)
	case it.attempts >= q.MaxAttempts:
		q.Stats.Failed.Add(1)
		q.Log.Error("write-behind op failed, giving up", "key", it.op.Key, "attempts", it.attempts, "err", err)
	default:
		// Re-queue unless a newer op for the same key arrived meanwhile (it
		// supersedes this one).
		if it.op.Key != "" {
			if _, newer := q.byKey[it.op.Key]; newer {
				q.Stats.Coalesced.Add(1)
				return
			}
			q.byKey[it.op.Key] = it
		}
		q.Stats.Retries.Add(1)
		if backoff {
			d := 100 * time.Millisecond << min(it.attempts-1, 7)
			it.notBefore = time.Now().Add(min(d, 10*time.Second))
		}
		q.items = append(q.items, it)
		if it.attempts == 1 {
			q.Log.Warn("write-behind op failed, retrying", "key", it.op.Key, "err", err)
		}
	}
}
