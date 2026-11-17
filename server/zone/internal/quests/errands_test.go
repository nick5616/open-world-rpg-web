package quests

import "testing"

// CR 051: a do step counts only its own deed, N times, saved in Count and
// shown through the wire; the chain helpers; every errand is well formed.
func TestDoStepsCountDeeds(t *testing.T) {
	l := NewLog()
	q := &Quest{ID: 9, Key: "story:errand:x", Kind: KindStory, Steps: []Step{
		{Text: "mine", Obj: Objective{Kind: ObjDo, Family: DeedMine, N: 3, Settlement: -1, Site: -1}},
		{Text: "smelt", Obj: Objective{Kind: ObjDo, Family: DeedSmelt, N: 1, Settlement: -1, Site: -1}},
	}}
	if err := l.Add(q); err != nil {
		t.Fatal(err)
	}
	f := &facts{have: map[string]int{}, known: map[string]bool{}}
	var hs []Happening
	if hs = l.Advance(f, &Signal{Kind: ObjDo, Family: DeedSmelt}, hs[:0]); len(hs) != 0 || q.Count != 0 {
		t.Fatal("the wrong deed counted")
	}
	l.Advance(f, &Signal{Kind: ObjDo, Family: DeedMine}, hs[:0])
	l.Advance(f, &Signal{Kind: ObjDo, Family: DeedMine}, hs[:0])
	if w := view(q); q.Count != 2 || w.Need != 3 || w.Progress != 2 {
		t.Fatalf("count %d %+v", q.Count, w)
	}
	// Saved and reloaded mid-way, the count survives.
	l2 := Load(l.JSON())
	q2 := l2.Find(9)
	if q2 == nil || q2.Count != 2 {
		t.Fatalf("reloaded %+v", q2)
	}
	if hs = l2.Advance(f, &Signal{Kind: ObjDo, Family: DeedMine}, hs[:0]); len(hs) != 1 || hs[0].Step != 0 || q2.Step != 1 || q2.Count != 0 {
		t.Fatalf("third deed %+v step %d", hs, q2.Step)
	}
	if hs = l2.Advance(f, &Signal{Kind: ObjDo, Family: DeedSmelt}, hs[:0]); len(hs) != 1 || !hs[0].Finished || !l2.IsDone("story:errand:x") {
		t.Fatalf("last deed %+v", hs)
	}
	if !l.Needs(ObjDo) {
		t.Fatal("Needs(ObjDo)")
	}
}

func TestErrandsAreWellFormed(t *testing.T) {
	person := func(name string, role int, title string) Person {
		return Person{Name: name, Role: role, Title: title, At: Place{OK: true, X: 1, Z: 2}}
	}
	p := &ErrandPlaces{Settlement: 1, Town: "Draedmore", Smith: person("Selina", 2, "blacksmith"), Mentor: person("Tammir", 5, "farmer"), Guard: person("Fenen", 6, "guard"),
		Innkeeper: person("Ulus", 3, "innkeeper"), Merchant: person("Fenia", 1, "merchant"), Keeper: person("Kelmir", 4, "bounty keeper"),
		Forge: Place{OK: true, X: 3, Z: 3}, OreMouth: Place{OK: true, X: 9, Z: 9, Where: "490 m south-west of Draedmore"}, OreVeins: Place{OK: true, X: 9, Z: 20, R: 15},
		DarkMouth: Place{OK: true, X: 9, Z: 9}, Water: Place{OK: true, X: 5, Z: 5}, Tower: Place{OK: true, X: 50, Z: 50}, TowerSite: 4, TowerName: "The Spire"}
	ids := map[uint32]string{}
	var xp int64
	for _, id := range ErrandChain {
		for _, withTalk := range []bool{true, false} {
			q, say := Errand(id, p, withTalk, 0)
			if q == nil || say == "" || len(q.Steps) < 2 || q.Gold <= 0 || q.XP <= 0 {
				t.Fatalf("errand %s: %+v %q", id, q, say)
			}
			if first := q.Steps[0].Obj.Kind; withTalk != (first == ObjTalk) {
				t.Fatalf("errand %s withTalk %v starts with %s", id, withTalk, first)
			}
			if last := q.Steps[len(q.Steps)-1]; last.Obj.Kind != ObjTalk || last.Say == "" {
				t.Fatalf("errand %s does not end with its giver's word: %+v", id, last)
			}
			if q.Key != ErrandKey(id) || !IsErrand(q.Key) || q.ID != ErrandID(id) {
				t.Fatalf("errand %s ids: %s %d", id, q.Key, q.ID)
			}
			if withTalk && other(ids, q.ID, id) {
				t.Fatalf("errand id collision for %s", id)
			}
			if withTalk {
				xp += q.XP
			}
		}
	}
	if xp > 600 {
		t.Fatalf("the errands pay %d XP: more than a level and a half", xp)
	}
	// A town without a cave or water skips those errands instead of breaking.
	p.OreMouth, p.Water = Place{}, Place{}
	if q, _ := Errand(ErrandOre, p, true, 0); q != nil {
		t.Fatal("ore errand without a cave")
	}
	if q, _ := Errand(ErrandPond, p, true, 0); q != nil {
		t.Fatal("pond errand without water")
	}
}

func other(ids map[uint32]string, id uint32, name string) bool {
	if n, ok := ids[id]; ok && n != name {
		return true
	}
	ids[id] = name
	return false
}

func TestNextErrandFollowsTheChain(t *testing.T) {
	l := NewLog()
	if got := NextErrand(l, ErrandPrologue); got != ErrandOre {
		t.Fatalf("first %q", got)
	}
	l.MarkDone(ErrandKey(ErrandOre))
	l.MarkDone(ErrandKey(ErrandTimber))
	if got := NextErrand(l, ErrandPrologue); got != ErrandTorch {
		t.Fatalf("third %q", got)
	}
	l.MarkDone(ErrandKey(ErrandTorch))
	if got := NextErrand(l, ErrandPrologue); got != "" || ErrandsDone(l) != 3 {
		t.Fatalf("after the prologue %q (%d done)", got, ErrandsDone(l))
	}
	if got := NextErrand(l, len(ErrandChain)); got != ErrandPond {
		t.Fatalf("fourth %q", got)
	}
}
