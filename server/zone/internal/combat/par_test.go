package combat

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"lodestone/server/pkg/movement"
)

// goParallel is a real goroutine pool (the zone's is internal/game.parallelFor).
func goParallel(n, workers int, fn func(worker, i int)) {
	var next atomic.Int64
	var wg sync.WaitGroup
	for k := 0; k < workers; k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= n {
					return
				}
				fn(k, i)
			}
		}()
	}
	wg.Wait()
}

// reverseParallel runs the items backwards on rotating worker indexes: a
// different assignment of groups to workers than goParallel, on purpose.
func reverseParallel(n, workers int, fn func(worker, i int)) {
	for i := n - 1; i >= 0; i-- {
		fn(i%workers, i)
	}
}

// crowdWorld is many camps around a few players who mostly stand and
// sometimes walk: lots of wind-ups competing for the same players, strikes,
// projectiles (archers) and the two-wind-ups cap in play.
func crowdWorld(par Parallel, workers int) (*World, []*handPlayer) {
	w, _ := newWorld()
	if par != nil {
		w.SetParallel(par, workers)
	}
	var players []*handPlayer
	for i := 0; i < 8; i++ {
		a := float64(i) * 0.8
		players = append(players, newHand(w, uint32(1+i), movement.Vec3{X: 2000 + 9*math.Cos(a), Z: 2000 + 9*math.Sin(a)}, "sword"))
	}
	for g := 0; g < 40; g++ {
		a := float64(g) * 2.4
		r := 4 + float64(g%7)*4
		w.TestGroup(movement.Vec3{X: 2000 + r*math.Cos(a), Z: 2000 + r*math.Sin(a)}, []string{"boar", "wolf", "cutthroat", "archer"}, 1, "")
	}
	return w, players
}

// worldDigest is everything Step decides: enemy states, positions, targets
// and the events it emitted, in order.
func worldDigest(w *World, events []Out) string {
	s := ""
	for _, e := range w.Enemies() {
		s += fmt.Sprintf("%d:%d:%d:%.6f,%.6f,%.6f:%.6f|", e.ID, e.State, e.Target, e.Pos.X, e.Pos.Z, e.HP, e.Yaw)
	}
	// Enemy events in emission order; per-player upkeep events (mana,
	// regen...) come from a map walk in playerUpkeep, in no fixed order even
	// before WP19b, so those are compared as a set.
	var upkeep []string
	for _, o := range events {
		e := fmt.Sprintf("e%d:%d:%d:%d:%d|", o.Ev.Kind, o.Ev.EntityID, o.Ev.TargetID, o.Ev.Value, o.Aud.To)
		if o.Aud.To != 0 && o.Ev.EntityID == o.Aud.To {
			upkeep = append(upkeep, e)
			continue
		}
		s += e
	}
	slices.Sort(upkeep)
	return s + strings.Join(upkeep, "")
}

// WP19b: partitioned enemy AI gives the same result whatever the number of
// workers or the order groups are handed out (par.go: no group reads
// another group's live state), and keeps the two-wind-ups cap.
func TestPartitionedAIMatchesAcrossWorkers(t *testing.T) {
	type run struct {
		name    string
		par     Parallel
		workers int
	}
	runs := []run{{"serial", nil, 1}, {"goroutines x4", goParallel, 4}, {"reverse x3", reverseParallel, 3}}
	worlds := make([]*World, len(runs))
	hands := make([][]*handPlayer, len(runs))
	for i, r := range runs {
		worlds[i], hands[i] = crowdWorld(r.par, r.workers)
	}
	windups := 0
	for tick := uint32(1); tick <= 30*30; tick++ {
		var ref string
		for i := range runs {
			w := worlds[i]
			for k, h := range hands[i] {
				if (int(tick)/45+k)%3 == 0 {
					h.frame(1, 0, float64(k)) // walk a little (InputFlagForward)
					h.frame(1, 0, float64(k))
				} else {
					h.idle(2)
				}
			}
			w.Step(tick)
			ev, _, _, _, _, _ := w.Drain()
			d := worldDigest(w, ev)
			if i == 0 {
				ref = d
				for _, h := range hands[i] {
					n := w.windupsOn(h.p.ID)
					if n > maxWindupsOnOne {
						t.Fatalf("tick %d: %d wind-ups on player %d", tick, n, h.p.ID)
					}
					windups += n
				}
				continue
			}
			if d != ref {
				a, b := strings.Split(ref, "|"), strings.Split(d, "|")
				for k := range min(len(a), len(b)) {
					if a[k] != b[k] {
						t.Fatalf("tick %d: %s differs from serial at item %d: %q vs %q", tick, runs[i].name, k, a[k], b[k])
					}
				}
				t.Fatalf("tick %d: %s differs from serial (lengths %d vs %d)", tick, runs[i].name, len(a), len(b))
			}
		}
	}
	if windups == 0 {
		t.Fatal("scenario too quiet: no wind-ups")
	}
}
