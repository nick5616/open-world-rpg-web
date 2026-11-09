package wake

import (
	"context"
	"strings"
	"testing"
	"time"

	"log/slog"
)

// refusingVM accepts every start and never leaves Stopped, like GCE when the
// start operation fails asynchronously (QUOTA_EXCEEDED).
type refusingVM struct{ starts int }

func (r *refusingVM) Name() string                           { return "refusing" }
func (r *refusingVM) Status(context.Context) (Status, error) { return Status{State: Stopped}, nil }
func (r *refusingVM) Start(context.Context) error            { r.starts++; return nil }
func (r *refusingVM) Stop(context.Context) error             { return nil }

type logBuf struct{ strings.Builder }

func TestWakeLogsAVMThatNeverStarts(t *testing.T) {
	clk := &clock{t: time.Unix(1_700_000_000, 0)}
	var buf logBuf
	vm := &refusingVM{}
	w := &Waker{Provider: vm, Log: slog.New(slog.NewTextHandler(&buf, nil)), Now: clk.Now}
	for i := 0; i < 10; i++ {
		w.Wake(context.Background())
		clk.Add(20 * time.Second)
	}
	if vm.starts < 2 {
		t.Fatalf("starts = %d, want retries", vm.starts)
	}
	if !strings.Contains(buf.String(), "still stopped") {
		t.Fatalf("no stuck warning after 200 s of refused starts:\n%s", buf.String())
	}
}
