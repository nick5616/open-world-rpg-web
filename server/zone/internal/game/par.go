package game

// The tick's worker pool (WP19 second pass). Besides snapshots (WP19,
// snapshots.go) three more phases fan out over GOMAXPROCS goroutines:
//
//   - inputs: sessions whose input this tick is plain movement apply their
//     frames on workers (inputs.go);
//   - combat: simple enemy groups think on workers (combat.World.SetParallel,
//     internal/combat/par.go);
//   - views: every entity's view extrapolation and quantization (grid phase,
//     server.go), each entity on its own.
//
// The rule is the same everywhere: a worker writes only the items it was
// handed (and its own scratch); everything shared is read-only while the
// phase runs; anything order-dependent is put together on the tick
// goroutine afterwards in a fixed order. So the tick's result does not depend
// on the number of workers or on scheduling (tested: TestParallelTickMatchesSerial).

import (
	"sync"
	"sync/atomic"
)

// parallelFor runs fn(worker, i) for every i in [0, n): items are handed out
// chunk at a time to up to workers goroutines (the caller is worker 0), and
// it returns when all are done. Each worker index is used by one goroutine
// at a time, so fn may keep per-worker scratch indexed by it.
func parallelFor(n, workers, chunk int, fn func(worker, i int)) {
	chunk = max(1, chunk)
	workers = min(workers, (n+chunk-1)/chunk)
	if workers <= 1 {
		for i := 0; i < n; i++ {
			fn(0, i)
		}
		return
	}
	var next atomic.Int64
	run := func(worker int) {
		for {
			i := int(next.Add(int64(chunk))) - chunk
			if i >= n {
				return
			}
			for j := i; j < min(n, i+chunk); j++ {
				fn(worker, j)
			}
		}
	}
	var wg sync.WaitGroup
	wg.Add(workers - 1)
	for k := 1; k < workers; k++ {
		go func() {
			defer wg.Done()
			run(k)
		}()
	}
	run(0)
	wg.Wait()
}

// combatParallel adapts parallelFor to combat.Parallel (one group partition
// per item, a few per hand-out).
func combatParallel(n, workers int, fn func(worker, i int)) { parallelFor(n, workers, 4, fn) }

const (
	// parallelMinItems: below this many items a phase stays on the tick
	// goroutine (small zones, most tests): the hand-off costs more than it
	// saves.
	parallelMinItems = 32
	inputChunk       = 4  // sessions per hand-out (inputs.go)
	viewChunk        = 64 // entities per hand-out (views)
)

// phaseWorkers is how many goroutines a phase over n items uses.
func (s *Server) phaseWorkers(n int) int {
	if n < parallelMinItems {
		return 1
	}
	return s.snapshotWorkers()
}
