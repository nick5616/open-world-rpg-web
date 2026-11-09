package voice

import (
	"math/rand"
	"slices"
	"testing"
)

// Ordering and idempotence of the reconcile when earshot decisions arrive in
// bursts (G5 voice-under-thailand investigation: does the leader drop or
// reorder deltas when several messages are queued before a pass, or when a
// decision reverses while the previous change is still at LiveKit?). The
// leader (service.go) applies every queued message, then runs one pass;
// passes never overlap. These tests pin that the result depends only on the
// last state the zone published, not on how messages were batched.

// A decision and its reversal queued before the same pass cancel out: no
// LiveKit call at all.
func TestReconcileBurstReversalCancels(t *testing.T) {
	r := NewReconciler()
	lk := map[string]map[string]bool{}
	r.SetParticipants(parts("a", "b"))
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {}, "b": {}}))
	apply(r, lk, false)
	r.ApplyEarshot(msg("z1", 1, false, map[string][]string{"a": {"b"}, "b": {"a"}}))
	r.ApplyEarshot(msg("z1", 2, false, map[string][]string{"a": {}, "b": {}}))
	if ch := apply(r, lk, false); len(ch) != 0 {
		t.Fatalf("in+out before one pass must not touch LiveKit: %v", ch)
	}
	// out+in on a subscribed pair: likewise nothing.
	r.ApplyEarshot(msg("z1", 3, false, map[string][]string{"a": {"b"}}))
	apply(r, lk, false)
	r.ApplyEarshot(msg("z1", 4, false, map[string][]string{"a": {}}))
	r.ApplyEarshot(msg("z1", 5, false, map[string][]string{"a": {"b"}}))
	if ch := apply(r, lk, false); len(ch) != 0 || !slices.Equal(subs(lk, "a"), []string{"TR_b"}) {
		t.Fatalf("out+in before one pass must keep the subscription untouched: %v %v", ch, lk)
	}
}

// A delta followed by a full message in the same burst: the full one wins,
// including dropping a listener the delta had just set.
func TestReconcileBurstDeltaThenFull(t *testing.T) {
	r := NewReconciler()
	lk := map[string]map[string]bool{}
	r.SetParticipants(parts("a", "b", "c"))
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {"b"}, "b": {"a"}, "c": {}}))
	apply(r, lk, false)
	r.ApplyEarshot(msg("z1", 7, false, map[string][]string{"c": {"a"}, "a": {"b", "c"}}))
	r.ApplyEarshot(msg("z1", 8, true, map[string][]string{"a": {"c"}, "b": {}}))
	apply(r, lk, false)
	if !slices.Equal(subs(lk, "a"), []string{"TR_c"}) || len(subs(lk, "b")) != 0 || len(subs(lk, "c")) != 0 {
		t.Fatalf("full after delta: %v", lk)
	}
}

// A decision that reverses while the change it caused is still at LiveKit
// (Plan returned it, Done not yet called): the next pass undoes it, and a
// failed in-flight change followed by a reversal leaves nothing to do.
func TestReconcileReversalWhileInFlight(t *testing.T) {
	r := NewReconciler()
	r.SetParticipants(parts("a", "b"))
	r.ApplyEarshot(msg("z1", 0, true, map[string][]string{"a": {}, "b": {}}))
	r.ApplyEarshot(msg("z1", 1, false, map[string][]string{"a": {"b"}}))
	inflight := r.Plan(false)
	if len(inflight) != 1 || !inflight[0].Subscribe {
		t.Fatalf("subscribe planned: %v", inflight)
	}
	r.ApplyEarshot(msg("z1", 2, false, map[string][]string{"a": {}})) // reverses before LiveKit answered
	r.Done(inflight[0], true)
	r.ClearPending()
	next := r.Plan(false)
	if len(next) != 1 || next[0].Subscribe || !slices.Equal(next[0].Tracks, []string{"TR_b"}) {
		t.Fatalf("the reversal must unsubscribe what the in-flight call subscribed: %v", next)
	}
	for _, c := range next {
		r.Done(c, true)
	}
	// Failure in flight, then a reversal: LiveKit never changed, nothing to undo.
	r.ApplyEarshot(msg("z1", 3, false, map[string][]string{"a": {"b"}}))
	inflight = r.Plan(false)
	r.ApplyEarshot(msg("z1", 4, false, map[string][]string{"a": {}}))
	r.Done(inflight[0], false)
	if ch := r.Plan(false); len(ch) != 0 {
		t.Fatalf("nothing applied, nothing wanted: %v", ch)
	}
}

// Property: for random earshot streams (deltas, a full every 8, listeners
// coming and going), LiveKit ends in the same state whether the leader runs a
// pass after every message or after random bursts of them, and that state is
// exactly the zone's last sets.
func TestReconcileBatchingDoesNotMatter(t *testing.T) {
	ids := []string{"a", "b", "c", "d", "e", "f"}
	for seed := int64(1); seed <= 50; seed++ {
		rng := rand.New(rand.NewSource(seed))
		// The zone's view, evolving; every message carries the sets that
		// changed (all of them when full), as the runner publishes.
		zone := map[string][]string{}
		var msgs []func(*Reconciler)
		for seq := uint64(0); seq < 120; seq++ {
			changed := map[string][]string{}
			for _, l := range ids {
				if rng.Float64() < 0.3 {
					var s []string
					for _, o := range ids {
						if o != l && rng.Float64() < 0.4 {
							s = append(s, o)
						}
					}
					zone[l] = s
					changed[l] = s
				}
			}
			full := seq%8 == 0
			sets := changed
			if full {
				sets = map[string][]string{}
				for l, s := range zone {
					sets[l] = s
				}
			}
			m := msg("z1", seq, full, sets)
			msgs = append(msgs, func(r *Reconciler) { r.ApplyEarshot(m) })
		}
		run := func(burst func() int) map[string]map[string]bool {
			r := NewReconciler()
			r.SetParticipants(parts(ids...))
			lk := map[string]map[string]bool{}
			for i := 0; i < len(msgs); {
				n := burst()
				for k := 0; k < n && i < len(msgs); k++ {
					msgs[i](r)
					i++
				}
				apply(r, lk, false)
			}
			return lk
		}
		one := run(func() int { return 1 })
		bursty := run(func() int { return 1 + rng.Intn(6) })
		for _, l := range ids {
			want := make([]string, 0, len(zone[l]))
			for _, s := range zone[l] {
				want = append(want, "TR_"+s)
			}
			slices.Sort(want)
			if got := subs(one, l); !slices.Equal(got, want) {
				t.Fatalf("seed %d: one-by-one %s = %v, zone says %v", seed, l, got, want)
			}
			if got := subs(bursty, l); !slices.Equal(got, want) {
				t.Fatalf("seed %d: bursts %s = %v, zone says %v", seed, l, got, want)
			}
		}
	}
}
