package writebehind

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func quiet(q *Queue) *Queue { q.Log = slog.New(slog.NewTextHandler(io.Discard, nil)); return q }

func TestCoalesceKeepsNewestAndPosition(t *testing.T) {
	q := quiet(New(10))
	var got []string
	rec := func(s string) Op {
		return Op{Key: s[:1], Run: func(context.Context) error { got = append(got, s); return nil }}
	}
	q.Enqueue(rec("a1"))
	q.Enqueue(rec("b1"))
	q.Enqueue(rec("a2")) // replaces a1, stays ahead of b1
	if q.Depth() != 2 || q.Stats.Coalesced.Load() != 1 {
		t.Fatalf("depth %d coalesced %d", q.Depth(), q.Stats.Coalesced.Load())
	}
	if err := q.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != "[a2 b1]" {
		t.Fatalf("order/coalescing wrong: %v", got)
	}
}

func TestBoundedNeverBlocks(t *testing.T) {
	q := quiet(New(3))
	for i := 0; i < 5; i++ {
		q.Enqueue(Op{Run: func(context.Context) error { return nil }})
	}
	if q.Depth() != 3 || q.Stats.Dropped.Load() != 2 {
		t.Fatalf("depth %d dropped %d", q.Depth(), q.Stats.Dropped.Load())
	}
}

func TestRetryThenSucceedAndSkip(t *testing.T) {
	q := quiet(New(10))
	var mu sync.Mutex
	calls := 0
	done := make(chan struct{})
	q.Enqueue(Op{Key: "c", Run: func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls < 3 {
			return errors.New("db down")
		}
		close(done)
		return nil
	}})
	q.Enqueue(Op{Key: "missing", Run: func(context.Context) error { return fmt.Errorf("no row: %w", ErrSkip) }})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go q.Run(ctx)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("op never succeeded")
	}
	time.Sleep(20 * time.Millisecond)
	if q.Stats.Retries.Load() != 2 || q.Stats.Done.Load() != 1 || q.Stats.Skipped.Load() != 1 || q.Depth() != 0 {
		t.Fatalf("stats retries=%d done=%d skipped=%d depth=%d", q.Stats.Retries.Load(), q.Stats.Done.Load(), q.Stats.Skipped.Load(), q.Depth())
	}
}

func TestGivesUpAfterMaxAttempts(t *testing.T) {
	q := quiet(New(10))
	q.MaxAttempts = 3
	q.Enqueue(Op{Run: func(context.Context) error { return errors.New("always") }})
	if err := q.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if q.Stats.Failed.Load() != 1 || q.Stats.Retries.Load() != 2 {
		t.Fatalf("failed %d retries %d", q.Stats.Failed.Load(), q.Stats.Retries.Load())
	}
}

func TestFlushHonorsDeadline(t *testing.T) {
	q := quiet(New(10))
	q.OpTimeout = 50 * time.Millisecond
	for i := 0; i < 5; i++ {
		q.Enqueue(Op{Run: func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := q.Flush(ctx); err == nil {
		t.Fatal("expected deadline error")
	}
	if time.Since(start) > time.Second {
		t.Fatal("flush overran its deadline")
	}
}
