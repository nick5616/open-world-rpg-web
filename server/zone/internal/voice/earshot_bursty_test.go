package voice

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

// The voice soak (spec 14 scenario 3) replayed through the netsim "thailand"
// model of a WebSocket input stream (tools/netsim/proxy.mjs makeOrderedPipe:
// each 30 Hz input packet waits 80 ms + N(0, 20 ms), 3 % of them stall a
// TCP RTO of 200-300 ms, and nothing overtakes an earlier packet), so the
// zone sees every player's position late, frozen during stalls and then
// jumping forward in a clump.
//
// G5 hypothesis 1 for the voice-under-thailand failure was that such a feed
// moves players across the 40/48 m band repeatedly. It does not: the lag is
// at most ~0.5 s (2.5 m at walking speed) and never backwards, far inside the
// 8 m band. The failure was night demons killing the bots (voicebots README,
// "G5"); this test keeps the property it relied on.

type soakBot struct {
	angle, r0 float64
}

// soakPos is bot b's true position at time t (s) in the soak's script:
// clustered 10 s, walk outward 20 s at 4.9 m/s, stand 6 s, walk back until
// at r0 (22 s), stand 10 s.
func soakPos(b soakBot, t float64) (x, z float64) {
	const v = 4.9
	r := b.r0
	switch {
	case t < 10:
	case t < 30:
		r += v * (t - 10)
	case t < 36:
		r += v * 20
	default:
		r = max(b.r0, b.r0+v*20-v*(t-36))
	}
	return r * math.Sin(b.angle), r * math.Cos(b.angle)
}

// thailandFeed returns, for each bot, the send times of the packets the zone
// has applied by time T: packets every 1/30 s, released in order.
type thailandFeed struct {
	release [][]float64 // per bot, per packet k (sent at k/30 s), release time
}

func newThailandFeed(rng *rand.Rand, bots int, dur float64) *thailandFeed {
	f := &thailandFeed{release: make([][]float64, bots)}
	n := int(dur * 30)
	for b := range f.release {
		rel := make([]float64, n)
		last := 0.0
		for k := range rel {
			sent := float64(k) / 30
			r := sent + max(0, 0.080+rng.NormFloat64()*0.020)
			if rng.Float64() < 0.03 {
				r += 0.200 + rng.Float64()*0.100
			}
			r = max(r, last)
			rel[k], last = r, r
		}
		f.release[b] = rel
	}
	return f
}

// seen is the send time of the newest packet of bot b released by T (the
// zone applies frames in order, so its position is the one sent then).
func (f *thailandFeed) seen(b int, T float64) float64 {
	rel := f.release[b]
	lo, hi := 0, len(rel) // first index with release > T
	for lo < hi {
		m := (lo + hi) / 2
		if rel[m] <= T {
			lo = m + 1
		} else {
			hi = m
		}
	}
	if lo == 0 {
		return 0
	}
	return float64(lo-1) / 30
}

type pairKey struct{ l, s string }

// runSoak steps the computer every 250 ms over the scenario with positions
// from pos and returns the number of pair changes after the first step,
// the number of zone flaps (a pair reversing within 2 s), and the largest
// lag between true and seen position.
func runSoak(t *testing.T, bots []soakBot, seenAt func(b int, T float64) float64) (changes, flaps int, maxLagM float64) {
	t.Helper()
	c := NewComputer()
	ps := make([]Player, len(bots))
	for i := range ps {
		ps[i].ID = fmt.Sprintf("b%02d", i)
	}
	in := map[pairKey]bool{}
	last := map[pairKey]float64{}
	for k := 0; k <= 72*4; k++ {
		T := float64(k) * 0.25
		for i, b := range bots {
			ps[i].X, ps[i].Z = soakPos(b, seenAt(i, T))
			tx, tz := soakPos(b, T)
			maxLagM = max(maxLagM, math.Hypot(tx-ps[i].X, tz-ps[i].Z))
		}
		c.Step(ps, brute(ps), false)
		for i := range ps {
			cur := map[string]bool{}
			for _, s := range c.Current(ps[i].ID) {
				cur[s] = true
			}
			for j := range ps {
				if i == j {
					continue
				}
				p := pairKey{ps[i].ID, ps[j].ID}
				now := cur[ps[j].ID]
				if k == 0 {
					in[p] = now
					continue
				}
				if now != in[p] {
					changes++
					if prev, ok := last[p]; ok && T-prev <= 2 {
						flaps++
						t.Logf("flap at %.2f s (previous change %.2f s): %s hears %s: %v", T, prev, p.l, p.s, now)
					}
					last[p], in[p] = T, now
				}
			}
		}
	}
	return changes, flaps, maxLagM
}

func TestThailandInputFeedNoFlaps(t *testing.T) {
	for seed := int64(1); seed <= 5; seed++ {
		rng := rand.New(rand.NewSource(seed))
		bots := make([]soakBot, 50)
		for i := range bots {
			bots[i] = soakBot{angle: 2*math.Pi*float64(i)/50 + (rng.Float64()-0.5)*0.2, r0: 2 + 14*math.Sqrt(rng.Float64())}
		}
		smooth, smoothFlaps, _ := runSoak(t, bots, func(_ int, T float64) float64 { return T })
		feed := newThailandFeed(rng, len(bots), 75)
		bursty, burstyFlaps, lag := runSoak(t, bots, feed.seen)
		t.Logf("seed %d: smooth %d changes, %d flaps; thailand feed %d changes, %d flaps, max lag %.2f m", seed, smooth, smoothFlaps, bursty, burstyFlaps, lag)
		if smoothFlaps != 0 || burstyFlaps != 0 {
			t.Fatalf("seed %d: flaps smooth %d thailand %d", seed, smoothFlaps, burstyFlaps)
		}
		// The impaired feed shifts when decisions happen, not how many: the
		// G5 failure had 25-35 % more (1,084-1,182 vs 868).
		if d := math.Abs(float64(bursty-smooth)) / float64(smooth); d > 0.05 {
			t.Fatalf("seed %d: thailand feed made %d decisions, smooth %d (%.0f %% apart)", seed, bursty, smooth, d*100)
		}
		if lag > 3 {
			t.Fatalf("seed %d: the feed lags %.2f m, more than the model allows", seed, lag)
		}
	}
}

// A respawn teleport (what night demons did to the G5 bots) changes sets at
// once and only once: the teleported player leaves its old neighbours' sets
// and joins the new ones' on the next step, with no flapping after it.
func TestTeleportChangesSetsOnce(t *testing.T) {
	c := NewComputer()
	ps := []Player{at("a", 0, 0), at("b", 10, 0), at("c", 200, 0), at("d", 210, 0)}
	c.Step(ps, brute(ps), false)
	ps[1].X = 205 // b respawns next to c and d
	sets, _ := c.Step(ps, brute(ps), false)
	if len(sets) != 4 || len(c.Current("a")) != 0 || len(c.Current("b")) != 2 || len(c.Current("c")) != 2 {
		t.Fatalf("after teleport: %v", sets)
	}
	for range 8 {
		if sets, _ := c.Step(ps, brute(ps), false); len(sets) != 0 {
			t.Fatalf("standing still after a teleport must not change sets: %v", sets)
		}
	}
}
