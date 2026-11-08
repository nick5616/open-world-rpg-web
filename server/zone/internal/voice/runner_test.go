package voice

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"slices"
	"sync"
	"testing"

	"lodestone/server/pkg/earshot"
)

type fakePub struct {
	mu   sync.Mutex
	msgs []*earshot.Message
	fail bool
}

func (f *fakePub) Publish(_ context.Context, m *earshot.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("redis down")
	}
	f.msgs = append(f.msgs, m)
	return nil
}

// stepSync runs one batch on the caller's goroutine (deterministic tests).
func stepSync(r *Runner, g *hashGrid, ps []Player, t float64) {
	r.step(context.Background(), g, batch{ps, t})
}

func TestRunnerMessages(t *testing.T) {
	pub := &fakePub{}
	r := NewRunner("z1", pub)
	g := newHashGrid(48)
	ps := []Player{at("a", 0, 0), at("b", 10, 0)}
	stepSync(r, g, ps, 1000)
	if len(pub.msgs) != 1 || !pub.msgs[0].Full || pub.msgs[0].Zone != "z1" || pub.msgs[0].T != 1000 || pub.msgs[0].V != earshot.Version {
		t.Fatalf("first message must be full: %+v", pub.msgs)
	}
	for i := 1; i < earshot.FullEvery; i++ {
		stepSync(r, g, ps, float64(1000+250*i))
	}
	if len(pub.msgs) != 1 {
		t.Fatalf("no changes => no deltas, got %d messages", len(pub.msgs))
	}
	stepSync(r, g, ps, 3000) // seq 8: scheduled full
	if len(pub.msgs) != 2 || !pub.msgs[1].Full || len(pub.msgs[1].Sets) != 2 {
		t.Fatalf("scheduled full message missing: %+v", pub.msgs[len(pub.msgs)-1])
	}
	ps[1].X = 60
	stepSync(r, g, ps, 3250)
	last := pub.msgs[len(pub.msgs)-1]
	if last.Full || len(last.Sets["a"]) != 0 || len(last.Sets) != 2 {
		t.Fatalf("delta after b walked away: %+v", last)
	}

	// A failed publish forces the next message full.
	pub.fail = true
	ps[1].X = 5
	stepSync(r, g, ps, 3500)
	pub.fail = false
	stepSync(r, g, ps, 3750)
	last = pub.msgs[len(pub.msgs)-1]
	if !last.Full || r.Failed.Load() != 1 {
		t.Fatalf("message after a failed publish must be full: %+v failed=%d", last, r.Failed.Load())
	}

	// A skipped interval (runner busy) forces the next message full too.
	r.Skipped.Add(1)
	ps = ps[:1]
	stepSync(r, g, ps, 4000)
	last = pub.msgs[len(pub.msgs)-1]
	if !last.Full || !slices.Equal(last.Gone, []string{"b"}) {
		t.Fatalf("after a skip: full with b gone, got %+v", last)
	}
}

func TestRunnerOfferNeverBlocks(t *testing.T) {
	r := NewRunner("z", &fakePub{})
	if !r.Offer(nil, 1) {
		t.Fatal("first offer should be accepted")
	}
	if r.Offer(nil, 2) || r.Skipped.Load() != 1 {
		t.Fatal("second offer while the first is pending must be skipped, not block")
	}
}

func TestHashGridMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(9))
	ps := make([]Player, 400)
	for i := range ps {
		ps[i] = Player{ID: fmt.Sprintf("p%03d", i), X: rng.Float64()*600 - 100, Y: rng.Float64() * 30, Z: rng.Float64() * 600}
	}
	a, b := NewComputer(), NewComputer()
	g := newHashGrid(48)
	for step := 0; step < 20; step++ {
		for i := range ps {
			ps[i].X += rng.Float64()*6 - 3
			ps[i].Z += rng.Float64()*6 - 3
		}
		g.build(ps)
		a.Step(ps, g.neighbors(ps), false)
		b.Step(ps, brute(ps), false)
		for _, p := range ps {
			if !slices.Equal(a.Current(p.ID), b.Current(p.ID)) {
				t.Fatalf("step %d %s: grid %v brute %v", step, p.ID, a.Current(p.ID), b.Current(p.ID))
			}
		}
	}
}
