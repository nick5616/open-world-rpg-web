package quests

import "testing"

type escortFacts struct {
	facts
	near bool
}

func (f *escortFacts) Escorted(uint32) bool { return f.near }

// CR 023 objectives: kill counts (saved in Count), give steps need the
// item and the right NPC, escorts need the follower, read/attune/dungeon
// signals, MaxSide.
func TestContentObjectives(t *testing.T) {
	l := NewLog()
	q := &Quest{ID: 7, Key: "side:1:2:0", Kind: KindSide, Steps: []Step{
		{Text: "kill", Obj: Objective{Kind: ObjKill, N: 3, X: 0, Z: 0, R: 50}},
		{Text: "give", Obj: Objective{Kind: ObjGive, Role: 5, Settlement: 1, NPC: 3, Items: []ItemQty{{Item: "herb:frostcap", Qty: 2}}}},
		{Text: "read", Obj: Objective{Kind: ObjRead, Site: 9}},
		{Text: "attune", Obj: Objective{Kind: ObjAttune}},
		{Text: "escort", Obj: Objective{Kind: ObjEscort, X: 100, Z: 0, R: 20}},
		{Text: "vault", Obj: Objective{Kind: ObjDungeon, Site: 4}},
	}}
	if err := l.Add(q); err != nil {
		t.Fatal(err)
	}
	f := &escortFacts{facts: facts{have: map[string]int{}, known: map[string]bool{}}}
	var hs []Happening
	far := &Signal{Kind: ObjKill, X: 80, Z: 0}
	if hs = l.Advance(f, far, hs[:0]); len(hs) != 0 || q.Count != 0 {
		t.Fatal("a kill outside the radius counted")
	}
	for i := 0; i < 2; i++ {
		l.Advance(f, &Signal{Kind: ObjKill, X: 10, Z: 0}, hs[:0])
	}
	if q.Count != 2 || q.Step != 0 || view(q).Need != 3 || view(q).Progress != 2 {
		t.Fatalf("count %d step %d %+v", q.Count, q.Step, view(q))
	}
	// Saved and reloaded mid-way, the count survives.
	l2 := Load(l.JSON())
	q2 := l2.Find(7)
	if q2.Count != 2 {
		t.Fatal("count not saved")
	}
	if hs = l2.Advance(f, &Signal{Kind: ObjKill, X: 10, Z: 0}, hs[:0]); len(hs) != 1 || q2.Step != 1 || q2.Count != 0 {
		t.Fatalf("third kill: %+v step %d", hs, q2.Step)
	}
	// Give: wrong NPC, no items, then right.
	f.have["herb:frostcap"] = 2
	if hs = l2.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 1, NPC: 4}, hs[:0]); len(hs) != 0 {
		t.Fatal("wrong npc")
	}
	f.have["herb:frostcap"] = 1
	if hs = l2.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 1, NPC: 3}, hs[:0]); len(hs) != 0 {
		t.Fatal("gave without the items")
	}
	f.have["herb:frostcap"] = 2
	if hs = l2.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 1, NPC: 3}, hs[:0]); len(hs) != 1 {
		t.Fatal("give")
	}
	if hs = l2.Advance(f, &Signal{Kind: ObjRead, Site: 8}, hs[:0]); len(hs) != 0 {
		t.Fatal("wrong tablet")
	}
	l2.Advance(f, &Signal{Kind: ObjRead, Site: 9}, hs[:0])
	l2.Advance(f, &Signal{Kind: ObjAttune}, hs[:0])
	if q2.Step != 4 || !l2.Wants() {
		t.Fatalf("step %d", q2.Step)
	}
	f.x = 100
	if hs = l2.Advance(f, nil, hs[:0]); len(hs) != 0 {
		t.Fatal("escorted without the follower")
	}
	f.near = true
	l2.Advance(f, nil, hs[:0])
	hs = l2.Advance(f, &Signal{Kind: ObjDungeon, Site: 4}, hs[:0])
	if len(hs) != 1 || !hs[0].Finished || !l2.IsDone("side:1:2:0") {
		t.Fatalf("finish %+v", hs)
	}
	// MaxSide.
	for i := 0; i < MaxSide; i++ {
		if err := l2.Add(&Quest{ID: uint32(100 + i), Key: "side:x:" + string(rune('a'+i)), Kind: KindSide, Steps: []Step{{Obj: Objective{Kind: ObjAttune}}}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := l2.Add(&Quest{ID: 200, Key: "side:y", Kind: KindSide, Steps: []Step{{Obj: Objective{Kind: ObjAttune}}}}); err != ErrTooMany {
		t.Fatalf("seventh side quest: %v", err)
	}
}
