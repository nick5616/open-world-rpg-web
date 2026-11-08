package voice

import (
	"context"
	"math"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/earshot"
)

// Publisher sends one earshot message (Redis PUBLISH in production).
type Publisher interface {
	Publish(ctx context.Context, m *earshot.Message) error
}

// Runner computes and publishes earshot sets on its own goroutine, so the
// zone tick only copies positions (a few microseconds) and never pays for
// the computation (~1.5 ms for 300 players packed into earshot of each
// other) or a Redis round trip.
type Runner struct {
	Zone string
	Pub  Publisher
	// OnError is called (from the runner goroutine) when a publish fails;
	// the zone logs it, throttled.
	OnError func(error)

	in   chan batch
	comp *Computer
	seq  uint64
	// forceFull: a batch was skipped or a publish failed, so a delta was
	// lost; the next message is full so the receiver catches up at once
	// instead of waiting for the next scheduled full one.
	forceFull   bool
	lastSkipped int64

	// Counters for metrics (read from any goroutine).
	Published, Skipped, Failed, Changes, Pairs atomic.Int64
	LastComputeUs                              atomic.Int64
}

type batch struct {
	players []Player
	t       float64
}

// NewRunner makes a runner; call Run on a goroutine.
func NewRunner(zone string, pub Publisher) *Runner {
	return &Runner{Zone: zone, Pub: pub, in: make(chan batch, 1), comp: NewComputer()}
}

// Offer hands this interval's players to the runner without blocking. It
// returns false (and the interval is skipped) if the previous one is still
// being computed or published, which only happens when Redis stalls.
func (r *Runner) Offer(players []Player, serverTimeMs float64) bool {
	select {
	case r.in <- batch{players, serverTimeMs}:
		return true
	default:
		r.Skipped.Add(1)
		return false
	}
}

// Run processes batches until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	g := newHashGrid(r.comp.OpenM + r.comp.HystM)
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-r.in:
			r.step(ctx, g, b)
		}
	}
}

func (r *Runner) step(ctx context.Context, g *hashGrid, b batch) {
	start := time.Now()
	if s := r.Skipped.Load(); s != r.lastSkipped {
		r.lastSkipped = s // an interval was skipped since the last message
		r.forceFull = true
	}
	g.build(b.players)
	full := r.seq%earshot.FullEvery == 0 || r.forceFull
	sets, gone := r.comp.Step(b.players, g.neighbors(b.players), full)
	r.LastComputeUs.Store(time.Since(start).Microseconds())
	r.Pairs.Store(int64(r.comp.Pairs()))
	if !full {
		r.Changes.Add(int64(len(sets)))
	}
	m := &earshot.Message{V: earshot.Version, Zone: r.Zone, Seq: r.seq, T: b.t, Full: full, Sets: sets, Gone: gone}
	r.seq++
	if !full && len(sets) == 0 && len(gone) == 0 {
		return // nothing changed: no message (the receiver's staleness clock is fed by full messages every 2 s)
	}
	pctx, cancel := context.WithTimeout(ctx, time.Second)
	err := r.Pub.Publish(pctx, m)
	cancel()
	if err != nil {
		r.Failed.Add(1)
		r.forceFull = true
		if r.OnError != nil {
			r.OnError(err)
		}
		return
	}
	r.forceFull = false
	r.Published.Add(1)
}

// hashGrid is a spatial hash over x/z with cells as wide as the largest
// leave radius, so a query is the 3x3 cells around a player. The zone's AOI
// grid belongs to the tick goroutine, so the runner keeps its own.
type hashGrid struct {
	cell  float64
	cells map[[2]int32][]int
}

func newHashGrid(cell float64) *hashGrid {
	return &hashGrid{cell: cell, cells: map[[2]int32][]int{}}
}

func (g *hashGrid) key(x, z float64) [2]int32 {
	return [2]int32{int32(math.Floor(x / g.cell)), int32(math.Floor(z / g.cell))}
}

func (g *hashGrid) build(ps []Player) {
	for k, v := range g.cells {
		if len(v) == 0 {
			delete(g.cells, k) // nobody here two builds running: forget the cell
		} else {
			g.cells[k] = v[:0]
		}
	}
	for i := range ps {
		k := g.key(ps[i].X, ps[i].Z)
		g.cells[k] = append(g.cells[k], i)
	}
}

func (g *hashGrid) neighbors(ps []Player) Neighbors {
	return func(i int, r float64, fn func(j int)) {
		k := g.key(ps[i].X, ps[i].Z)
		span := int32(math.Ceil(r / g.cell))
		for dz := -span; dz <= span; dz++ {
			for dx := -span; dx <= span; dx++ {
				for _, j := range g.cells[[2]int32{k[0] + dx, k[1] + dz}] {
					fn(j)
				}
			}
		}
	}
}
