package snapshot

import (
	"math"
	"math/rand"
	"reflect"
	"testing"

	"lodestone/server/pkg/proto"
)

func TestRecordSizeMatchesCodec(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 2000; i++ {
		r := proto.EntityRecord{ID: rng.Uint32(), Mask: uint16(rng.Intn(1 << 15)), Name: string(make([]byte, rng.Intn(40)))}
		var w proto.Writer
		r.Write(&w)
		if got := RecordSize(&r); got != len(w.B) {
			t.Fatalf("mask %b: RecordSize %d, codec %d", r.Mask, got, len(w.B))
		}
	}
	self := proto.SelfState{Mask: 0, X: 5}
	full := proto.Snapshot{Self: DiffSelf(nil, &self), Removed: []uint32{1, 2, 3}}
	if got, want := snapshotFixed(&full.Self, 3), len(proto.Encode(&full)); got != want {
		t.Fatalf("snapshotFixed %d, encoded %d", got, want)
	}
}

// crowd is n players walking in a 64 m disc around the client, like the
// dense bot soak: everyone is in the near ring and moves every tick.
type crowd struct {
	rng  *rand.Rand
	ents []EntState
	dist []float64
}

func newCrowd(n int, seed int64) *crowd {
	c := &crowd{rng: rand.New(rand.NewSource(seed))}
	for i := 0; i < n; i++ {
		d := 2 + c.rng.Float64()*60
		a := c.rng.Float64() * 2 * math.Pi
		c.ents = append(c.ents, EntState{ID: uint32(i + 1), Kind: proto.EntityKindPlayer, X: int32(d * math.Cos(a) * 100), Z: int32(d * math.Sin(a) * 100),
			HealthPct: 100, Name: "Walker", Level: 1, Vx: 489})
		c.dist = append(c.dist, d)
	}
	return c
}

func (c *crowd) step() []Candidate {
	cands := make([]Candidate, len(c.ents))
	for i := range c.ents {
		e := &c.ents[i]
		e.X += 16 // 4.9 m/s at 30 Hz, in cm
		if c.rng.Intn(20) == 0 {
			e.Yaw = uint8(c.rng.Intn(256))
		}
		cands[i] = Candidate{State: e, Due: true, Weight: 16 / (c.dist[i] + 8)}
	}
	return cands
}

func TestBudgetCapsBytesAndStaysCorrect(t *testing.T) {
	const ticks = 900
	const budgetBps = 150_000.0 / 8 // 150 kbps
	run := func(budget float64) (avgBytes float64, maxGap map[uint32]int, sends map[uint32]int, c *crowd) {
		var enc Encoder
		var dec Decoder
		if budget > 0 {
			enc.SetBudget(budget, 30, 3, 4)
		}
		c = newCrowd(143, 3)
		self := proto.SelfState{Health: 100, HealthMax: 100}
		last := map[uint32]int{}
		maxGap, sends = map[uint32]int{}, map[uint32]int{}
		acked := uint32(0)
		total := 0
		rng := rand.New(rand.NewSource(9))
		for tick := uint32(1); tick <= ticks; tick++ {
			s := enc.Build(tick, acked, tick, float64(tick), &self, c.step())
			b := proto.Encode(s)
			total += len(b) + 4
			for _, r := range s.Entities {
				id := r.ID
				if g := int(tick) - last[id]; last[id] != 0 && g > maxGap[id] {
					maxGap[id] = g
				}
				last[id] = int(tick)
				sends[id]++
			}
			m, err := proto.DecodeMessage(b)
			if err != nil {
				t.Fatal(err)
			}
			if rng.Intn(20) == 0 {
				continue // 5% loss: deltas must still line up
			}
			f, err := dec.Apply(m.(*proto.Snapshot))
			if err != nil {
				t.Fatalf("tick %d: %v", tick, err)
			}
			if !reflect.DeepEqual(f.Ents, enc.Last().Ents) {
				t.Fatalf("tick %d: decoded frame differs from the encoder's", tick)
			}
			acked = dec.Latest()
		}
		return float64(total) / ticks, maxGap, sends, c
	}

	unlimited, _, _, _ := run(0)
	avg, maxGap, sends, c := run(budgetBps)
	perTick := budgetBps / 30
	t.Logf("143 players within 64 m: unlimited %.0f B/tick (%.0f kbps), budgeted %.0f B/tick (%.0f kbps, cap %.0f)",
		unlimited, unlimited*30*8/1000, avg, avg*30*8/1000, perTick)
	if avg > perTick*1.01 {
		t.Fatalf("budgeted average %.1f B/tick over the cap %.1f", avg, perTick)
	}
	if unlimited < perTick*2 {
		t.Fatalf("scenario too small to exercise the budget (%.0f B/tick)", unlimited)
	}
	// Everyone still gets updates, and nobody waits long: the accumulator's
	// age bonus bounds staleness even for the farthest walker.
	worst := 0
	for _, e := range c.ents {
		if sends[e.ID] == 0 {
			t.Fatalf("entity %d never updated", e.ID)
		}
		if maxGap[e.ID] > worst {
			worst = maxGap[e.ID]
		}
	}
	if worst > 30 {
		t.Fatalf("worst update gap %d ticks (> 1 s)", worst)
	}
	// Closer entities are updated more often than far ones.
	var nearSends, farSends, nNear, nFar float64
	for i, e := range c.ents {
		switch {
		case c.dist[i] < 12:
			nearSends += float64(sends[e.ID])
			nNear++
		case c.dist[i] > 50:
			farSends += float64(sends[e.ID])
			nFar++
		}
	}
	nearHz, farHz := nearSends/nNear/ticks*30, farSends/nFar/ticks*30
	t.Logf("update rate: within 12 m %.1f Hz, beyond 50 m %.1f Hz, worst gap %d ticks", nearHz, farHz, worst)
	if nearHz < farHz*2 {
		t.Fatalf("near entities (%.1f Hz) should update much faster than far ones (%.1f Hz)", nearHz, farHz)
	}
}

func TestBudgetPartyFirstAndNoStarvationOfBigRecords(t *testing.T) {
	var enc Encoder
	// Tiny budget: ~40 bytes a tick, barely one record after the header.
	enc.SetBudget(40*30, 30, 4, 0)
	self := proto.SelfState{}
	ents := []EntState{
		{ID: 1, Kind: proto.EntityKindPlayer, X: 100, Name: "Stranger"},
		{ID: 2, Kind: proto.EntityKindPlayer, X: 100, Name: "PartyFriendWithAVeryLongNameIndeed", PartyID: 9},
	}
	seen := map[uint32]uint32{}
	acked := uint32(0)
	var dec Decoder
	for tick := uint32(1); tick <= 60; tick++ {
		ents[0].X += 10
		ents[1].X += 10
		cands := []Candidate{{State: &ents[0], Due: true, Weight: 1}, {State: &ents[1], Due: true, Weight: 10}}
		s := roundTrip(t, enc.Build(tick, acked, 0, 0, &self, cands))
		for _, r := range s.Entities {
			if seen[r.ID] == 0 {
				seen[r.ID] = tick
			}
		}
		if _, err := dec.Apply(s); err != nil {
			t.Fatal(err)
		}
		acked = dec.Latest()
	}
	if seen[2] == 0 || seen[1] == 0 {
		t.Fatalf("both entities must eventually be sent: %v", seen)
	}
	if seen[2] > seen[1] {
		t.Fatalf("party member (weight 10) should be first seen before the stranger: %v", seen)
	}
	if st := enc.Stats(); st.Deferred == 0 || st.Sent == 0 {
		t.Fatalf("stats not counted: %+v", st)
	}
}

// Per-client Build cost in the dense case (143 movers), budget on vs off:
// the zone runs this once per client per tick.
func BenchmarkBuildDense(b *testing.B) {
	for _, budget := range []float64{0, 150_000.0 / 8} {
		name := "unlimited"
		if budget > 0 {
			name = "budget150"
		}
		b.Run(name, func(b *testing.B) {
			var enc Encoder
			if budget > 0 {
				enc.SetBudget(budget, 30, 3, 4)
			}
			c := newCrowd(143, 3)
			self := proto.SelfState{}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				tick := uint32(i + 2)
				enc.Build(tick, tick-1, tick, 0, &self, c.step())
			}
		})
	}
}
