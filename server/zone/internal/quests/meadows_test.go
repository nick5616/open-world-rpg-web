package quests

import (
	"strings"
	"testing"
)

func meadowsPlaces() MeadowsPlaces {
	return MeadowsPlaces{Settlement: 3, Town: "Draedmore", Giver: "Hild", GiverRole: 5, GiverTitle: "farmer", Smith: "Selina",
		GiverAt: Place{OK: true, X: 90, Z: 95},
		Packs: []Place{
			{OK: true, X: 200, Z: 100, R: 18, Where: "110 m east of Draedmore"},
			{OK: true, X: 0, Z: 260, R: 18},
		}}
}

// Playtest 2: the first quest. Talk to the giver, kill five slimes (only
// slimes count, and only on the kill step), go back for the reward.
func TestMeadowsStepByStep(t *testing.T) {
	q := Meadows(meadowsPlaces(), 1)
	if q == nil || len(q.Steps) != 3 || q.Kind != KindStory {
		t.Fatalf("meadows %+v", q)
	}
	l := NewLog()
	if err := l.Add(q); err != nil {
		t.Fatal(err)
	}
	if !l.HasStarted(MeadowsKey) || l.Tracked != MeadowsID {
		t.Fatalf("started %v tracked %x", l.Started, l.Tracked)
	}
	f := &facts{have: map[string]int{}, known: map[string]bool{}}
	slime := &Signal{Kind: ObjKill, Family: "slime", Site: -1}
	// A kill before the talk doesn't count.
	if hs := l.Advance(f, slime, nil); len(hs) != 0 || q.Tally != 0 {
		t.Fatalf("kill before the talk: %+v tally %d", hs, q.Tally)
	}
	w := view(q)
	if len(w.Markers) != 1 || w.Markers[0].Label != "Hild, farmer" || !strings.Contains(w.Text, "Hild, the farmer of Draedmore") {
		t.Fatalf("talk step %+v", w)
	}
	hs := l.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 3}, nil)
	if len(hs) != 1 || q.Step != 1 || !strings.Contains(q.Steps[0].Say, "110 m east of Draedmore") {
		t.Fatalf("talk: %+v step %d say %q", hs, q.Step, q.Steps[0].Say)
	}
	w = view(q)
	if w.Need != MeadowsSlimes || w.Progress != 0 || len(w.Markers) != 2 || w.Markers[0].R != 18 || w.Markers[0].Label != "Slimes" {
		t.Fatalf("kill step wire %+v", w)
	}
	// Other families don't count; slimes do, one per kill.
	if hs := l.Advance(f, &Signal{Kind: ObjKill, Family: "wolf"}, nil); len(hs) != 0 || q.Tally != 0 {
		t.Fatalf("wolf counted: tally %d", q.Tally)
	}
	for i := 1; i < MeadowsSlimes; i++ {
		if hs := l.Advance(f, slime, nil); len(hs) != 0 || q.Tally != i || q.Progress != i {
			t.Fatalf("kill %d: %+v tally %d progress %d", i, hs, q.Tally, q.Progress)
		}
	}
	// The tally survives a save and load (it is the only record of the kills).
	l2 := Load(l.JSON())
	if q2 := l2.Find(MeadowsID); q2 == nil || q2.Tally != MeadowsSlimes-1 || q2.Step != 1 {
		t.Fatalf("reloaded %+v", q2)
	}
	// A state check (no signal) doesn't count a kill.
	if hs := l.Advance(f, nil, nil); len(hs) != 0 || q.Tally != MeadowsSlimes-1 {
		t.Fatal("a recheck counted a kill")
	}
	hs = l.Advance(f, slime, nil)
	if len(hs) != 1 || q.Step != 2 || q.Tally != 0 {
		t.Fatalf("fifth slime: %+v step %d tally %d", hs, q.Step, q.Tally)
	}
	// One kill is used up by one step: the return step still needs the talk.
	if hs := l.Advance(f, slime, nil); len(hs) != 0 || q.Step != 2 {
		t.Fatal("a kill completed the return step")
	}
	if hs := l.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 4}, nil); len(hs) != 0 {
		t.Fatal("another town's farmer counted")
	}
	hs = l.Advance(f, &Signal{Kind: ObjTalk, Role: 5, Settlement: 3}, nil)
	if len(hs) != 1 || !hs[0].Finished || !l.IsDone(MeadowsKey) || l.Find(MeadowsID) != nil {
		t.Fatalf("hand in: %+v", hs)
	}
	last := q.Steps[2]
	if len(last.Grant) != 2 || !strings.Contains(last.Say, "Selina") || q.Gold != MeadowsGold || q.XP != MeadowsXP {
		t.Fatalf("reward %+v say %q", last.Grant, last.Say)
	}
}

func TestMeadowsNeedsGiverAndSlimes(t *testing.T) {
	p := meadowsPlaces()
	p.Packs = nil
	if Meadows(p, 1) != nil {
		t.Fatal("a starter with no slimes to mark")
	}
	p = meadowsPlaces()
	p.Giver = ""
	if Meadows(p, 1) != nil {
		t.Fatal("a starter with nobody to give it")
	}
}

// A kill counts for every quest whose current step wants that family, and
// never for one that doesn't.
func TestKillCountsPerQuest(t *testing.T) {
	l := NewLog()
	a := &Quest{ID: 1, Key: "story:a", Kind: KindStory, Steps: []Step{{Obj: Objective{Kind: ObjKill, Family: "slime", Count: 2}}}}
	b := &Quest{ID: 2, Key: "story:b", Kind: KindStory, Steps: []Step{{Obj: Objective{Kind: ObjKill, Count: 1}}}} // any family
	c := &Quest{ID: 3, Key: "story:c", Kind: KindStory, Steps: []Step{{Obj: Objective{Kind: ObjKill, Family: "wolf", Count: 1}}}}
	for _, q := range []*Quest{a, b, c} {
		if err := l.Add(q); err != nil {
			t.Fatal(err)
		}
	}
	f := &facts{have: map[string]int{}, known: map[string]bool{}}
	hs := l.Advance(f, &Signal{Kind: ObjKill, Family: "slime"}, nil)
	if len(hs) != 1 || hs[0].Quest != b || a.Tally != 1 || c.Tally != 0 {
		t.Fatalf("first slime: %+v a %d c %d", hs, a.Tally, c.Tally)
	}
	if !l.Needs(ObjKill) {
		t.Fatal("kill steps left")
	}
}
