package voice

import (
	"slices"

	"lodestone/server/pkg/earshot"
)

// Reconciler is the-circle's declarative reconcile (frontend/src/rtc.ts)
// applied to SFU subscriptions instead of peer links: inputs describe who
// SHOULD hear whom, Plan diffs that against what we last told LiveKit, and
// the caller applies the changes and reports back. It owns no goroutines or
// I/O, so every rule is unit-testable; Leader drives it.
//
// Who should hear whom (listener L, speaker S):
//
//	(S in L's earshot set from its zone  OR  S in L's party)
//	AND neither blocked the other   (spec 10: block = no voice both ways)
//	AND L has not muted S           (spec 10: mute = stop hearing them)
//	AND S is in the room with a published audio track
//
// Party members beyond earshot are subscribed like anyone else; the client
// decides whether they sound spatial or through the radio filter by distance
// (one published track covers both, spec 10 "Proximity voice" 2).
type Reconciler struct {
	// From the zones.
	zoneSets     map[string]map[string][]string // zone -> listener -> speakers
	listenerZone map[string]string              // listener -> the zone whose set we use
	zoneSeen     map[string]float64             // zone -> last message t (server ms)

	// From the social service.
	party   map[string][]string // char -> other party members
	blocked map[[2]string]bool  // {a, b}: a blocked b
	muted   map[[2]string]bool  // {a, b}: a muted b

	// From LiveKit.
	parts map[string]Participant // by identity

	// What we told LiveKit, by listener participant sid (a reconnect gets a
	// new sid and starts with no subscriptions), then track sid.
	applied map[string]map[string]bool

	// pendingT: for each listener, the zone time of the oldest earshot
	// change not yet applied (latency metric).
	pendingT map[string]float64
}

// NewReconciler returns an empty reconciler.
func NewReconciler() *Reconciler {
	return &Reconciler{
		zoneSets: map[string]map[string][]string{}, listenerZone: map[string]string{}, zoneSeen: map[string]float64{},
		party: map[string][]string{}, blocked: map[[2]string]bool{}, muted: map[[2]string]bool{},
		parts: map[string]Participant{}, applied: map[string]map[string]bool{}, pendingT: map[string]float64{},
	}
}

// ApplyEarshot folds one zone message in (see lodestone/server/pkg/earshot
// for full vs delta semantics).
func (r *Reconciler) ApplyEarshot(m *earshot.Message) {
	if m.V != earshot.Version {
		return
	}
	sets := r.zoneSets[m.Zone]
	if sets == nil {
		sets = map[string][]string{}
		r.zoneSets[m.Zone] = sets
	}
	r.zoneSeen[m.Zone] = m.T
	note := func(l string) {
		if _, ok := r.pendingT[l]; !ok {
			r.pendingT[l] = m.T
		}
	}
	if m.Full {
		for l := range sets {
			if _, ok := m.Sets[l]; !ok {
				delete(sets, l)
				if r.listenerZone[l] == m.Zone {
					delete(r.listenerZone, l)
					note(l)
				}
			}
		}
	}
	for l, s := range m.Sets {
		if old, ok := sets[l]; !ok || !slices.Equal(old, s) || r.listenerZone[l] != m.Zone {
			note(l)
		}
		sets[l] = s
		r.listenerZone[l] = m.Zone // the newest zone to report a player owns it (handoff)
	}
	for _, l := range m.Gone {
		delete(sets, l)
		if r.listenerZone[l] == m.Zone {
			delete(r.listenerZone, l)
			note(l)
		}
	}
}

// ExpireZones drops the sets of zones silent since before cutoff (server ms):
// a crashed zone must not keep its players subscribed forever.
func (r *Reconciler) ExpireZones(nowMs float64) {
	for z, t := range r.zoneSeen {
		if nowMs-t <= earshot.StaleAfterMs {
			continue
		}
		for l := range r.zoneSets[z] {
			if r.listenerZone[l] == z {
				delete(r.listenerZone, l)
			}
		}
		delete(r.zoneSets, z)
		delete(r.zoneSeen, z)
	}
}

// SetParticipants replaces the room roster (from ListParticipants).
func (r *Reconciler) SetParticipants(ps []Participant) {
	r.parts = make(map[string]Participant, len(ps))
	live := make(map[string]bool, len(ps))
	for _, p := range ps {
		r.parts[p.Identity] = p
		live[p.Sid] = true
	}
	for sid := range r.applied {
		if !live[sid] {
			delete(r.applied, sid) // left the room; its subscriptions went with it
		}
	}
}

// SetRelations replaces parties, blocks and mutes.
func (r *Reconciler) SetRelations(party map[string][]string, blocked, muted [][2]string) {
	r.party = party
	r.blocked = make(map[[2]string]bool, len(blocked))
	for _, p := range blocked {
		r.blocked[p] = true
	}
	r.muted = make(map[[2]string]bool, len(muted))
	for _, p := range muted {
		r.muted[p] = true
	}
}

// Identities is everyone in the room (relations lookups).
func (r *Reconciler) Identities() []string {
	out := make([]string, 0, len(r.parts))
	for id := range r.parts {
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

// Hears reports whether listener should hear speaker, ignoring whether the
// speaker has a track (the rule in the type comment).
func (r *Reconciler) Hears(listener, speaker string) bool {
	if listener == speaker || r.blocked[[2]string{listener, speaker}] || r.blocked[[2]string{speaker, listener}] || r.muted[[2]string{listener, speaker}] {
		return false
	}
	if z, ok := r.listenerZone[listener]; ok && slices.Contains(r.zoneSets[z][listener], speaker) {
		return true
	}
	return slices.Contains(r.party[listener], speaker)
}

// Desired lists the speakers a listener should hear (sorted).
func (r *Reconciler) Desired(listener string) []string {
	var cand []string
	if z, ok := r.listenerZone[listener]; ok {
		cand = append(cand, r.zoneSets[z][listener]...)
	}
	cand = append(cand, r.party[listener]...)
	slices.Sort(cand)
	cand = slices.Compact(cand)
	out := cand[:0]
	for _, s := range cand {
		if r.Hears(listener, s) {
			out = append(out, s)
		}
	}
	return out
}

// Change is one UpdateSubscriptions call.
type Change struct {
	Identity  string   // listener
	Sid       string   // listener participant sid (applied state is keyed by it)
	Tracks    []string // track sids
	Subscribe bool
	// PendingT is the zone time of the earshot change this answers (0 if
	// it was caused by something else), for the latency metric.
	PendingT float64
}

// Plan returns the calls that bring LiveKit to the desired state. With heal
// it re-sends every desired subscription even if we think it is applied
// (idempotent on LiveKit's side): the self-healing pass that repairs a call
// we believe succeeded but did not stick, or a client that unsubscribed
// itself. Speakers or listeners not in the room are skipped (they will be
// picked up when the roster shows them).
func (r *Reconciler) Plan(heal bool) []Change {
	var out []Change
	ids := r.Identities()
	for _, l := range ids {
		lp := r.parts[l]
		want := map[string]bool{}
		for _, s := range r.Desired(l) {
			if sp, ok := r.parts[s]; ok {
				for _, t := range sp.AudioTracks {
					want[t] = true
				}
			}
		}
		have := r.applied[lp.Sid]
		var sub, unsub []string
		for t := range want {
			if heal || !have[t] {
				sub = append(sub, t)
			}
		}
		for t := range have {
			if !want[t] {
				unsub = append(unsub, t)
			}
		}
		pt := r.pendingT[l]
		if len(sub) > 0 {
			slices.Sort(sub)
			out = append(out, Change{Identity: l, Sid: lp.Sid, Tracks: sub, Subscribe: true, PendingT: pt})
		}
		if len(unsub) > 0 {
			slices.Sort(unsub)
			out = append(out, Change{Identity: l, Sid: lp.Sid, Tracks: unsub, Subscribe: false, PendingT: pt})
		}
	}
	return out
}

// Done records the outcome of a planned change. On failure nothing is
// recorded, so the next Plan retries it.
func (r *Reconciler) Done(c Change, ok bool) {
	if !ok {
		return
	}
	have := r.applied[c.Sid]
	if have == nil {
		have = map[string]bool{}
		r.applied[c.Sid] = have
	}
	for _, t := range c.Tracks {
		if c.Subscribe {
			have[t] = true
		} else {
			delete(have, t)
		}
	}
}

// ClearPending forgets pending earshot times after a pass (called once per
// pass, after every change was applied or failed).
func (r *Reconciler) ClearPending() { clear(r.pendingT) }

// AppliedPairs counts (listener, track) subscriptions we believe are in place.
func (r *Reconciler) AppliedPairs() int {
	n := 0
	for _, s := range r.applied {
		n += len(s)
	}
	return n
}

// Unknown lists identities wanted as speakers or listeners that are not in
// the room roster, or that are in it without an audio track (a fresh joiner,
// or someone who has not pressed push-to-talk yet). The leader polls the
// roster sooner while this is non-empty.
func (r *Reconciler) Unknown() []string {
	seen := map[string]bool{}
	var out []string
	for l := range r.parts {
		for _, s := range r.Desired(l) {
			if p, ok := r.parts[s]; (!ok || len(p.AudioTracks) == 0) && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	slices.Sort(out)
	return out
}
