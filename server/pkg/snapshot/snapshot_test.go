package snapshot

import (
	"math/rand"
	"reflect"
	"testing"

	"lodestone/server/pkg/proto"
)

func roundTrip(t *testing.T, s *proto.Snapshot) *proto.Snapshot {
	t.Helper()
	m, err := proto.DecodeMessage(proto.Encode(s))
	if err != nil {
		t.Fatal(err)
	}
	return m.(*proto.Snapshot)
}

func ent(id uint32, x int32) EntState {
	return EntState{ID: id, Kind: proto.EntityKindPlayer, X: x, Y: 0, Z: 500, HealthPct: 100, Name: "p", Level: 1}
}

func TestFirstSightOmitsZeroFieldsButCarriesKindAndName(t *testing.T) {
	e := EntState{ID: 7, Kind: proto.EntityKindPlayer, X: 100, Name: "Nicole"}
	r := Diff(nil, &e)
	want := proto.EntityRecordHasKind | proto.EntityRecordHasX | proto.EntityRecordHasName
	if r.Mask != want {
		t.Fatalf("mask %b want %b", r.Mask, want)
	}
	if got := Apply(nil, &r); got != e {
		t.Fatalf("apply onto zero: %+v", got)
	}
	// Unchanged entity: empty mask.
	if Diff(&e, &e).Mask != 0 {
		t.Fatal("unchanged entity must diff to nothing")
	}
	// Moving entity: only x.
	m := e
	m.X = 105
	if r := Diff(&e, &m); r.Mask != proto.EntityRecordHasX {
		t.Fatalf("moving mask %b", r.Mask)
	}
}

func TestDeltaAgainstAckedBaselineAndRemoval(t *testing.T) {
	var enc Encoder
	var dec Decoder
	self := proto.SelfState{X: 1, Health: 100, HealthMax: 100}
	a, b := ent(1, 0), ent(2, 0)

	s := roundTrip(t, enc.Build(1, 0, 0, 0, &self, []Candidate{{State: &a, Due: true}, {State: &b, Due: true}}))
	if s.BaselineTick != 0 || len(s.Entities) != 2 {
		t.Fatalf("first snapshot must be full: %+v", s.ToJSON())
	}
	if _, err := dec.Apply(s); err != nil {
		t.Fatal(err)
	}

	// Tick 2, client acked 1: a moved, b didn't, c appears.
	a.X = 10
	c := ent(3, 0)
	s = roundTrip(t, enc.Build(2, 1, 5, 0, &self, []Candidate{{State: &a, Due: true}, {State: &b, Due: true}, {State: &c, Due: true}}))
	if s.BaselineTick != 1 || len(s.Entities) != 2 || s.Entities[0].Mask != proto.EntityRecordHasX || s.Self.Mask != 0 {
		t.Fatalf("delta wrong: %+v", s.ToJSON())
	}
	f, err := dec.Apply(s)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Ents) != 3 || f.Find(1).X != 10 || f.Find(3) == nil || f.Find(3).Name != "p" {
		t.Fatalf("decoded frame wrong: %+v", f.Ents)
	}

	// Tick 3, client still acked 1 (tick 2 ack lost): delta vs 1 again, so c
	// is sent in full again and b leaves.
	s = roundTrip(t, enc.Build(3, 1, 6, 0, &self, []Candidate{{State: &a, Due: true}, {State: &c, Due: true}}))
	if s.BaselineTick != 1 || len(s.Removed) != 1 || s.Removed[0] != 2 {
		t.Fatalf("removal wrong: %+v", s.ToJSON())
	}
	f, err = dec.Apply(s)
	if err != nil {
		t.Fatal(err)
	}
	if f.Find(2) != nil || f.Find(3) == nil || len(f.Ents) != 2 {
		t.Fatalf("decoded frame wrong after removal: %+v", f.Ents)
	}
}

func TestNotDueEntitiesCostNothingAndKeepBaselineState(t *testing.T) {
	var enc Encoder
	self := proto.SelfState{}
	a := ent(1, 0)
	enc.Build(1, 0, 0, 0, &self, []Candidate{{State: &a, Due: true}})
	a.X = 999
	s := enc.Build(2, 1, 0, 0, &self, []Candidate{{State: &a, Due: false}})
	if len(s.Entities) != 0 {
		t.Fatal("not-due entity must not be sent")
	}
	// Frame 2 must record what the client believes (x=0), so the next due
	// tick against baseline 2 still sends x.
	if enc.Last().Find(1).X != 0 {
		t.Fatal("frame must keep the baseline state for not-due entities")
	}
	s = enc.Build(3, 2, 0, 0, &self, []Candidate{{State: &a, Due: true}})
	if len(s.Entities) != 1 || s.Entities[0].X != 999 {
		t.Fatalf("due tick must send the change: %+v", s.ToJSON())
	}
}

func TestOldOrMissingAckFallsBackToFull(t *testing.T) {
	var enc Encoder
	self := proto.SelfState{}
	a := ent(1, 0)
	for tick := uint32(1); tick <= 40; tick++ {
		enc.Build(tick, 0, 0, 0, &self, []Candidate{{State: &a, Due: true}})
	}
	if s := enc.Build(41, 5, 0, 0, &self, []Candidate{{State: &a, Due: true}}); s.BaselineTick != 0 {
		t.Fatal("ack older than the ring must produce a full snapshot")
	}
	var dec Decoder
	if _, err := dec.Apply(&proto.Snapshot{Tick: 10, BaselineTick: 9}); err != ErrNoBaseline {
		t.Fatalf("decoder must refuse a delta without its baseline: %v", err)
	}
}

// Randomized: entities move, appear, vanish and switch rate; the client acks
// with random loss and lag. The decoded frame must always equal the encoder's
// frame for that tick, which is the whole contract.
func TestRandomizedEncoderDecoderAgree(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	var enc Encoder
	var dec Decoder
	world := map[uint32]*EntState{}
	for id := uint32(1); id <= 40; id++ {
		e := ent(id, int32(rng.Intn(1000)))
		world[id] = &e
	}
	acked := uint32(0)
	self := proto.SelfState{Health: 100}
	for tick := uint32(1); tick < 2000; tick++ {
		for _, e := range world {
			if rng.Intn(3) == 0 {
				e.X += int32(rng.Intn(21) - 10)
			}
			if rng.Intn(50) == 0 {
				e.Yaw = uint8(rng.Intn(256))
			}
		}
		self.X += int32(rng.Intn(3) - 1)
		var cands []Candidate
		for id := uint32(1); id <= 40; id++ {
			if rng.Intn(10) < 8 {
				cands = append(cands, Candidate{State: world[id], Due: rng.Intn(3) != 0})
			}
		}
		s := roundTrip(t, enc.Build(tick, acked, tick, float64(tick), &self, cands))
		want := enc.Last()
		if rng.Intn(5) == 0 {
			continue // snapshot lost
		}
		f, err := dec.Apply(s)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if !reflect.DeepEqual(f.Ents, want.Ents) && !(len(f.Ents) == 0 && len(want.Ents) == 0) {
			t.Fatalf("tick %d: decoded %d ents, encoder has %d", tick, len(f.Ents), len(want.Ents))
		}
		if f.Self != want.Self {
			t.Fatalf("tick %d: self %+v vs %+v", tick, f.Self, want.Self)
		}
		// Ack arrives with lag 0-3 ticks, sometimes lost.
		if rng.Intn(4) != 0 {
			acked = dec.Latest()
		}
	}
}
