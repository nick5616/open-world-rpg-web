package story

import (
	"strings"
	"testing"

	"lodestone/server/zone/internal/quests"
)

func testPlaces() *Places {
	npc := func(si, idx, role int, name, title, town string, x, z float64) NPC {
		return NPC{OK: true, Settlement: si, Town: town, Index: idx, Role: role, Name: name, Title: title, X: x, Z: z}
	}
	site := func(i int, name string, x, z float64) Place {
		return Place{OK: true, Site: i, Name: name, Region: "Somewhere", X: x, Z: z, R: 20}
	}
	p := &Places{HomeX: 1000, HomeZ: 1000, Home: "Havenford",
		Keeper:   npc(0, 4, 3, "Ulus", "innkeeper", "Havenford", 1005, 1002),
		Tablet:   site(50, "The Old Stone", 1200, 1100),
		Captain:  npc(2, 30, 6, "Gartha", "guard", "Vigilholm", 2000, 1000),
		Vigil:    Place{OK: true, Site: 2, Name: "Vigilholm", X: 2000, Z: 1000, R: 40},
		Smith:    npc(3, 40, 2, "Breus", "blacksmith", "Farforge", 3000, 500),
		Sanctum:  site(92, "Sanctum of Lenses", 2900, 600),
		LastFork: site(33, "Last Spire", 3200, 400), Heartfall: Place{OK: true, Site: -1, Name: "the Heartfall", X: 3100, Z: 700, R: 30}}
	for i := range p.Forks {
		p.Forks[i] = site(30+i, "Spire "+Roman(i+1), 1000+float64(i)*300, 700)
	}
	p.Vaults[0] = site(112, "The Undervault", 1300, 1300)
	p.Vaults[1] = site(287, "The Sealed Hall", 900, 1500)
	return p
}

type facts struct {
	level int
	have  map[string]int
}

func (f facts) Have(item string) int                      { return f.have[item] }
func (f facts) Knows(string) bool                         { return true }
func (f facts) Pos() (float64, float64)                   { return 0, 0 }
func (f facts) Quiet(int, float64, float64, float64) bool { return false }
func (f facts) Level() int                                { return f.level }

func TestEveryActBuildsWithMarkersAndText(t *testing.T) {
	p := testPlaces()
	for n := 1; n <= Acts; n++ {
		q := Act(n, p, 1)
		if q == nil {
			t.Fatalf("act %d did not build", n)
		}
		if q.Key != Key(n) || q.ID != ID(n) || q.Kind != quests.KindMain || ActOf(q.Key) != n {
			t.Fatalf("act %d ids %+v", n, q)
		}
		if !strings.Contains(q.Title, ActList[n-1].Title) || q.Gold <= 0 || q.XP <= 0 {
			t.Fatalf("act %d rewards %+v", n, q)
		}
		gate := ActList[n-1].Level > 0
		if gate != (q.Steps[0].Obj.Kind == quests.ObjLevel) {
			t.Fatalf("act %d gate: %+v", n, q.Steps[0])
		}
		for i, s := range q.Steps {
			if s.Text == "" || strings.Contains(s.Text, "%") || strings.Contains(s.Text+s.Note+s.Say, "{") {
				t.Fatalf("act %d step %d text %q / %q", n, i, s.Text, s.Note)
			}
			if s.Obj.Kind != quests.ObjLevel && len(s.Markers) == 0 {
				t.Fatalf("act %d step %d has no marker", n, i)
			}
		}
		t.Logf("Act %s: %s (%d steps)", Roman(n), ActList[n-1].Title, len(q.Steps))
	}
	// Places missing: no act (the glue turns the story off).
	p.Heartfall.OK = false
	if Act(6, p, 1) != nil {
		t.Fatal("act 6 without the Heartfall")
	}
	if ActOf("story:ward") != 0 || ActOf("story:main:7") != 0 || ActOf("story:main:x") != 0 {
		t.Fatal("ActOf")
	}
}

func TestProgressNextAndGates(t *testing.T) {
	p := testPlaces()
	l := quests.NewLog()
	if a, s := Progress(l); a != 0 || s != 0 || Next(l) != 1 {
		t.Fatalf("fresh %d %d next %d", a, s, Next(l))
	}
	if err := l.Add(Act(1, p, 1)); err != nil {
		t.Fatal(err)
	}
	if a, s := Progress(l); a != 1 || s != 0 || Next(l) != 0 {
		t.Fatalf("act 1: %d %d", a, s)
	}
	// Act II's gate holds below level 5, opens at it.
	l2 := quests.NewLog()
	l2.MarkDone(Key(1))
	if Next(l2) != 2 {
		t.Fatal("next after act 1")
	}
	_ = l2.Add(Act(2, p, 1))
	f := facts{level: 4}
	if hs := l2.Advance(f, nil, nil); len(hs) != 0 {
		t.Fatalf("gate opened at level 4: %+v", hs)
	}
	f.level = 5
	if hs := l2.Advance(f, nil, nil); len(hs) != 1 || hs[0].Step != 0 {
		t.Fatalf("gate at level 5: %+v", hs)
	}
	// Attune steps name their tower: another tower's crystal does nothing.
	if hs := l2.Advance(f, &quests.Signal{Kind: quests.ObjAttune, Site: 999}, nil); len(hs) != 0 {
		t.Fatal("the wrong tower counted")
	}
	if hs := l2.Advance(f, &quests.Signal{Kind: quests.ObjAttune, Site: p.Forks[1].Site}, nil); len(hs) != 1 {
		t.Fatal("the right tower did not count")
	}
	if a, s := Progress(l2); a != 2 || s != 2 || Rank(a, s) <= Rank(1, 9) {
		t.Fatalf("progress %d %d", a, s)
	}
	for n := 1; n <= Acts; n++ {
		l2.MarkDone(Key(n))
	}
	if q := l2.ByKey(Key(2)); q != nil {
		l2.Remove(q.ID)
	}
	if a, _ := Progress(l2); a != Acts+1 || Next(l2) != 0 {
		t.Fatalf("all done: %d next %d", a, Next(l2))
	}
}

func TestForceStepSharesOneStep(t *testing.T) {
	p := testPlaces()
	l := quests.NewLog()
	_ = l.Add(Act(1, p, 1))
	if hs := l.ForceStep(Key(1), 1, nil); len(hs) != 0 {
		t.Fatal("a step not current was forced")
	}
	hs := l.ForceStep(Key(1), 0, nil)
	if len(hs) != 1 || l.ByKey(Key(1)).Step != 1 {
		t.Fatalf("forced %+v", hs)
	}
	// The last step finishes the act.
	q := l.ByKey(Key(1))
	l.SetStep(q.Key, len(q.Steps)-1)
	hs = l.ForceStep(Key(1), len(q.Steps)-1, nil)
	if len(hs) != 1 || !hs[0].Finished || !l.IsDone(Key(1)) || l.ByKey(Key(1)) != nil {
		t.Fatalf("finish %+v", hs)
	}
	if hs[0].Quest.Steps[hs[0].Step].Grant[0].Item != ItemFork {
		t.Fatal("the last step of act 1 hands over the fork")
	}
	if g := hs[0].Quest.Steps[hs[0].Step].Grant; len(g) != 2 || g[1].Item != ItemWhistle {
		t.Fatalf("act 1 hands over a spirit whistle for the long roads of act 2: %+v", g)
	}
}

func TestCatchUpSkipsWithRelicsAndHalfXP(t *testing.T) {
	p := testPlaces()
	l := quests.NewLog()
	_ = l.Add(Act(1, p, 1))
	l.SetStep(Key(1), 2)
	// The leader is on Act IV, step 2 (light the beacon, after the gate and the captain).
	sk, ok := CatchUp(l, p, 4, 2, 5)
	if !ok {
		t.Fatal("no catch-up")
	}
	if a, s := Progress(l); a != 4 || s != 2 {
		t.Fatalf("now at %d %d", a, s)
	}
	for n := 1; n <= 3; n++ {
		if !l.IsDone(Key(n)) {
			t.Fatalf("act %d not done", n)
		}
	}
	want := map[string]bool{ItemFork: true, ItemVerseDawn: true, ItemVerseDusk: true}
	for _, it := range sk.Items {
		delete(want, it.Item)
	}
	if len(want) != 0 {
		t.Fatalf("relics missing %v (got %+v)", want, sk.Items)
	}
	if xp := ActList[0].XP/2 + ActList[1].XP/2 + ActList[2].XP/2; sk.XP != xp || len(sk.Acts) != 3 {
		t.Fatalf("xp %d want %d acts %v", sk.XP, xp, sk.Acts)
	}
	if l.Tracked != ID(4) {
		t.Fatal("not tracked")
	}
	// Not behind: nothing.
	if _, ok := CatchUp(l, p, 4, 1, 5); ok {
		t.Fatal("caught up backwards")
	}
	if _, ok := CatchUp(l, p, 9, 0, 5); ok {
		t.Fatal("caught up past the end")
	}
}
