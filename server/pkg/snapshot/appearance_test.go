package snapshot

// Protocol v6 (CR 034): EntityRecord.appearance is delta coded like every
// field (sent on change and first sight only) and interned into encEnt's
// old padding, so baseline states stay 40 bytes.

import (
	"testing"
	"unsafe"

	"lodestone/server/pkg/proto"
)

func TestEncEntStaysFortyBytes(t *testing.T) {
	if n := unsafe.Sizeof(encEnt{}); n != 40 {
		t.Fatalf("encEnt is %d bytes, want 40 (the appearance lives in the old padding)", n)
	}
}

func TestAppearanceDeltaCoded(t *testing.T) {
	var e Encoder
	var d Decoder
	knight := EntState{ID: 5, Kind: proto.EntityKindPlayer, X: 100, Name: "Knight", Appearance: 0x1234_5678_9abc}
	plain := EntState{ID: 6, Kind: proto.EntityKindPlayer, X: 200, Name: "Plain"}
	self := proto.SelfState{}
	step := func(tick, ack uint32) *proto.Snapshot {
		s := e.Build(tick, ack, 0, 0, &self, []Candidate{{State: &knight, Due: true}, {State: &plain, Due: true}})
		m, err := proto.DecodeMessage(proto.Encode(s))
		if err != nil {
			t.Fatal(err)
		}
		snap := m.(*proto.Snapshot)
		if _, err := d.Apply(snap); err != nil {
			t.Fatal(err)
		}
		return snap
	}
	has := func(s *proto.Snapshot, id uint32) bool {
		for _, r := range s.Entities {
			if r.ID == id && r.Mask&proto.EntityRecordHasAppearance != 0 {
				return true
			}
		}
		return false
	}
	s := step(1, 0)
	if !has(s, 5) || has(s, 6) {
		t.Fatal("first sight: the knight's appearance, none for the plain player (0 costs nothing)")
	}
	for tick := uint32(2); tick < 6; tick++ {
		if s := step(tick, tick-1); has(s, 5) {
			t.Fatalf("tick %d: unchanged appearance re-sent", tick)
		}
	}
	knight.Appearance = 42
	if s := step(6, 5); !has(s, 5) {
		t.Fatal("a change is sent")
	}
	if f := d.Frame(6); f == nil || f.Find(5).Appearance != 42 || f.Find(6).Appearance != 0 {
		t.Fatalf("decoded %+v", f)
	}
	if got := e.Last().Find(5).Appearance; got != 42 {
		t.Fatalf("encoder frame %d", got)
	}
}

func TestLookIDInterns(t *testing.T) {
	if LookID(0) != 0 || lookOf(0) != 0 {
		t.Fatal("0 is 0")
	}
	a, b := LookID(777), LookID(778)
	if a == 0 || a == b || LookID(777) != a || lookOf(a) != 777 || lookOf(b) != 778 {
		t.Fatalf("ids %d %d", a, b)
	}
	// The overflow id never matches a state: same() reports a change.
	st := EntState{ID: 1, Appearance: 777}
	enc := toEnc(&st, 0)
	enc.look = lookOverflow
	if enc.same(&st, 0) {
		t.Fatal("an overflowed look must compare as changed")
	}
	if r := diffEnc(&enc, &st, 0); r.Mask&proto.EntityRecordHasAppearance == 0 || r.Appearance != 777 {
		t.Fatalf("overflow diff %+v", r)
	}
}
