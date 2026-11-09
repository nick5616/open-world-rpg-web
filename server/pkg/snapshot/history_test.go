package snapshot

import (
	"bytes"
	"math"
	"math/rand"
	"reflect"
	"slices"
	"testing"

	"lodestone/server/pkg/proto"
)

// G5: frames refer to states in a shared History (or the encoder's own
// arena) instead of holding copies. These tests drive three encoders with
// identical input, the pre-WP19 reference (budgeted cases), an encoder
// without a History (every state in its own arena) and two clients sharing
// one History, and require byte-identical snapshots and identical priority
// state every tick, under ack lags up to and beyond the ring (so baselines
// as old as Ring-1 ticks are used and references are carried forward),
// budget starvation (deferred entities keep old states for many ticks) and
// entities entering and leaving interest.
func TestHistoryMatchesOwnStates(t *testing.T) {
	for _, tc := range []struct {
		n      int
		budget float64 // bytes/s, 0 = unlimited
		burst  float64
		seed   int64
		maxLag int // ack lag 0..maxLag ticks
	}{
		{143, 150_000.0 / 8, 3, 1, 3},
		{400, 150_000.0 / 8, 3, 2, 31},
		{1200, 150_000.0 / 8, 3, 3, 12},
		{300, 2_000.0 / 8, 1, 4, 40}, // tiny budget: entities deferred for hundreds of ticks
		{200, 2_000_000.0 / 8, 3, 5, 31},
		{250, 0, 0, 6, 31}, // unlimited
		{60, 0, 0, 7, 3},
	} {
		rng := rand.New(rand.NewSource(tc.seed))
		var hist History
		var own, shared, shared2 Encoder
		var ref refEncoder
		shared.SetHistory(&hist)
		shared2.SetHistory(&hist)
		if tc.budget > 0 {
			for _, e := range []*Encoder{&own, &shared, &shared2} {
				e.SetBudget(tc.budget, 30, tc.burst, 4)
			}
			ref.SetBudget(tc.budget, 30, tc.burst, 4)
		}
		ents := make([]EntState, tc.n)
		for i := range ents {
			ents[i] = EntState{ID: uint32(3*i + 2), Kind: proto.EntityKind(1 + rng.Intn(3)), X: rng.Int31n(60000) - 30000, Z: rng.Int31n(60000) - 30000,
				HealthPct: 100, Name: []string{"A", "Walker", "Somebody Long"}[rng.Intn(3)], Level: 1}
		}
		prev := make([]EntState, tc.n) // last tick's states, for Set's since
		since := make([]uint32, tc.n)
		in := make([]bool, tc.n)
		for i := range in {
			in[i] = rng.Intn(10) != 0
		}
		var dec Decoder
		ack, ack2 := uint32(0), uint32(0)
		carried := 0
		var wo, ws, wr, w2 proto.Writer
		self := proto.SelfState{Health: 100, HealthMax: 100}
		for tick := uint32(1); tick <= 900; tick++ {
			for i := range ents {
				e := &ents[i]
				if rng.Intn(100) < 2 {
					in[i] = !in[i]
				}
				switch r := rng.Intn(100); {
				case r < 60:
					e.X += int32(rng.Intn(33) - 16)
					e.Vx = int16(rng.Intn(1000) - 500)
				case r < 62:
					e.HealthPct = uint8(rng.Intn(101))
				case r < 63:
					e.Name = "Renamed"
				case r < 64:
					e.Level++
				case r < 67:
					e.Activity ^= 1 // flips back and forth: equal states with a change between
				}
			}
			// The zone's order: open the tick's store, then build.
			hist.Begin(tick, len(ents))
			for i := range ents {
				if tick == 1 || ents[i] != prev[i] || tick%97 == 0 { // now and then "unsure" (since = now)
					since[i] = tick
				}
				prev[i] = ents[i]
				hist.Set(i, &ents[i], NameID(ents[i].Name), since[i])
			}
			var cands, cands2 []Candidate
			for i := range ents {
				e := &ents[i]
				d := math.Hypot(float64(e.X), float64(e.Z)) / 100
				due := d < 64 || (d < 200 && (tick+e.ID)%3 == 0) || (tick+e.ID)%15 == 0
				c := Candidate{State: e, Due: due, Weight: 16 / (d + 8), Ref: uint32(i) + 1}
				if in[i] {
					cands = append(cands, c)
				}
				if i%2 == 0 { // the second client sees a different set
					cands2 = append(cands2, c)
				}
			}
			noRef := slices.Clone(cands)
			for i := range noRef {
				noRef[i].Ref = 0
			}
			self.X += 7
			wo.Reset()
			proto.WriteMessage(&wo, own.Build(tick, ack, tick, float64(tick), &self, noRef))
			ws.Reset()
			sn := shared.Build(tick, ack, tick, float64(tick), &self, cands)
			proto.WriteMessage(&ws, sn)
			carried += len(shared.own[tick%histLen].ents) // states carried forward (every candidate has a Ref)
			w2.Reset()
			proto.WriteMessage(&w2, shared2.Build(tick, ack2, tick, float64(tick), &self, cands2))
			if !bytes.Equal(wo.B, ws.B) {
				t.Fatalf("n=%d seed=%d tick %d: History snapshot differs from own-state snapshot (%d vs %d bytes)", tc.n, tc.seed, tick, len(ws.B), len(wo.B))
			}
			if own.tokens != shared.tokens || own.stats != shared.stats || !slices.Equal(own.accIDs, shared.accIDs) || !slices.Equal(own.accVals, shared.accVals) {
				t.Fatalf("n=%d seed=%d tick %d: encoder state differs", tc.n, tc.seed, tick)
			}
			if tc.budget > 0 {
				wr.Reset()
				proto.WriteMessage(&wr, ref.Build(tick, ack, tick, float64(tick), &self, cands))
				if !bytes.Equal(wr.B, ws.B) {
					t.Fatalf("n=%d seed=%d tick %d: snapshot differs from the reference encoder", tc.n, tc.seed, tick)
				}
			}
			for _, e := range []*Encoder{&own, &shared, &shared2} {
				for _, r := range e.r.get(tick).Ents {
					if tick-r.Tick > carryAge {
						t.Fatalf("tick %d: frame refers to a state from tick %d", tick, r.Tick)
					}
				}
			}
			// The client's view of the History encoder's frames (the
			// decoder keeps full copies) must match what the encoder believes.
			msg := roundTrip(t, sn)
			f, err := dec.Apply(msg)
			if err != nil {
				t.Fatalf("tick %d: %v", tick, err)
			}
			if want := shared.Last(); !reflect.DeepEqual(f.Ents, want.Ents) && !(len(f.Ents) == 0 && len(want.Ents) == 0) {
				t.Fatalf("n=%d seed=%d tick %d: decoded frame differs from the encoder's", tc.n, tc.seed, tick)
			}
			// Acks lag 0..maxLag ticks behind the newest snapshot (past
			// the ring: a full snapshot), the second client independently.
			if lag := uint32(rng.Intn(tc.maxLag + 1)); lag < tick {
				ack = tick - lag
			}
			if lag := uint32(rng.Intn(tc.maxLag + 1)); lag < tick {
				ack2 = tick - lag
			}
		}
		if tc.budget > 0 && tc.budget < 1e6/8 && (own.stats.Deferred == 0 || carried == 0) {
			t.Fatalf("n=%d: %d deferred, %d carried; not exercising carried states", tc.n, own.stats.Deferred, carried)
		}
		t.Logf("n=%d budget=%.0f: %d records deferred, %d states carried", tc.n, tc.budget, own.stats.Deferred, carried)
	}
}

// G5: diffEnc (names compared by id) equals Diff on the full baseline state,
// equal states have equal fingerprints, and same agrees with ==.
func TestDiffEncMatchesDiff(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	pick := func() EntState {
		return EntState{ID: 7, Kind: proto.EntityKind(rng.Intn(3)), X: rng.Int31n(3), Y: rng.Int31n(3), Z: rng.Int31n(3),
			Yaw: uint8(rng.Intn(2)), Pitch: uint8(rng.Intn(2)), Vx: int16(rng.Intn(2)), Vy: int16(rng.Intn(2)), Vz: int16(rng.Intn(2)),
			HealthPct: uint8(rng.Intn(2)), Activity: uint8(rng.Intn(2)), TypeID: uint16(rng.Intn(2)),
			Name: []string{"", "A", "Walker"}[rng.Intn(3)], Level: uint8(rng.Intn(2)), PartyID: uint32(rng.Intn(2))}
	}
	for k := 0; k < 20000; k++ {
		a, b := pick(), pick()
		be := toEnc(&a, NameID(a.Name))
		bs := be.state()
		if got, want := diffEnc(&be, &b, NameID(b.Name)), Diff(&bs, &b); !reflect.DeepEqual(got, want) {
			t.Fatalf("%+v -> %+v: diffEnc %+v, Diff %+v", a, b, got, want)
		}
		ce := toEnc(&b, NameID(b.Name))
		if a == b && fingerprint(&be) != fingerprint(&ce) {
			t.Fatal("equal states, different fingerprints")
		}
		if be.same(&b, NameID(b.Name)) != (a == b) {
			t.Fatal("same disagrees with ==")
		}
	}
}
