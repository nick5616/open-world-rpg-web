package quests

import (
	"encoding/json"
	"strings"
	"testing"
)

type facts struct {
	have   map[string]int
	known  map[string]bool
	x, z   float64
	quiet  bool
	quietQ int
}

func (f *facts) Have(item string) int    { return f.have[item] }
func (f *facts) Knows(spell string) bool { return f.known[spell] }
func (f *facts) Pos() (float64, float64) { return f.x, f.z }
func (f *facts) Quiet(int, float64, float64, float64) bool {
	f.quietQ++
	return f.quiet
}

func places() WardPlaces {
	return WardPlaces{Settlement: 3, Town: "Draedmore", Smith: "Brannoc",
		SmithAt: Place{OK: true, X: 100, Z: 100}, Forge: Place{OK: true, X: 102, Z: 101},
		Ore:    Place{OK: true, X: 400, Z: -200, R: 30, Name: "Mossbound Hollow", Where: "500 m north-east of Draedmore"},
		Mouth:  Place{OK: true, X: 390, Z: -190, Name: "Mossbound Hollow"},
		Shrine: Place{OK: true, X: -300, Z: 50, R: 20, Name: "the Quiet Shrine", Where: "400 m west of Draedmore"}}
}

func TestWardLineStepByStep(t *testing.T) {
	l := NewLog()
	q := Ward(places(), 1)
	if err := l.Add(q); err != nil {
		t.Fatal(err)
	}
	if !l.HasStarted(WardKey) || l.Tracked != WardID {
		t.Fatalf("started %v tracked %x", l.Started, l.Tracked)
	}
	f := &facts{have: map[string]int{}, known: map[string]bool{}}
	var hs []Happening
	// Nothing happens without the talk.
	if hs = l.Advance(f, nil, hs[:0]); len(hs) != 0 {
		t.Fatalf("advanced without talking: %+v", hs)
	}
	// Talking to another settlement's blacksmith doesn't count.
	if hs = l.Advance(f, &Signal{Kind: ObjTalk, Role: 2, Settlement: 4}, hs[:0]); len(hs) != 0 {
		t.Fatal("wrong settlement counted")
	}
	hs = l.Advance(f, &Signal{Kind: ObjTalk, Role: 2, Settlement: 3}, hs[:0])
	if len(hs) != 1 || hs[0].Step != 0 || q.Step != 1 || hs[0].Finished {
		t.Fatalf("talk: %+v step %d", hs, q.Step)
	}
	if g := q.Steps[0].Grant; len(g) != 1 || g[0].Item != "currency:gold" {
		t.Fatalf("smith coin %v", g)
	}
	// Mining: progress shows, completes at 4.
	f.have["ore:sunsteel"] = 2
	hs = l.Advance(f, nil, hs[:0])
	if len(hs) != 0 || q.Progress != 2 {
		t.Fatalf("progress %d", q.Progress)
	}
	if w := view(q); w.Need != 4 || w.Progress != 2 || len(w.Markers) != 2 || w.Markers[0].R != 30 {
		t.Fatalf("wire %+v", w)
	}
	f.have["ore:sunsteel"] = 4
	hs = l.Advance(f, nil, hs[:0])
	if len(hs) != 1 || q.Step != 2 {
		t.Fatalf("mined: %+v step %d", hs, q.Step)
	}
	// Blueprint then blade in one go (a player who forged already skips).
	f.have["weapon:sunsteel_blade"] = 1
	hs = l.Advance(f, nil, hs[:0])
	if len(hs) != 2 || q.Step != 4 {
		t.Fatalf("blade: %+v step %d", hs, q.Step)
	}
	// The shrine: reach grants the tome.
	f.x, f.z = -295, 52
	hs = l.Advance(f, nil, hs[:0])
	if len(hs) != 1 || q.Steps[hs[0].Step].Grant[0].Item != LightTome {
		t.Fatalf("shrine: %+v", hs)
	}
	f.known[LightSpell] = true
	hs = l.Advance(f, nil, hs[:0])
	if len(hs) != 1 || !hs[0].Finished || l.Find(WardID) != nil || !l.IsDone(WardKey) {
		t.Fatalf("finish: %+v active %d done %v", hs, len(l.Active), l.Done)
	}
	if err := l.Add(Ward(places(), 2)); err != ErrDone {
		t.Fatalf("re-add after done: %v", err)
	}
}

func TestWardWithoutShrineGivesTomeAtForge(t *testing.T) {
	p := places()
	p.Shrine.OK = false
	q := Ward(p, 1)
	if len(q.Steps) != 5 || q.Steps[3].Grant[0].Item != LightTome || q.Steps[4].Obj.Kind != ObjKnow {
		t.Fatalf("steps %+v", q.Steps)
	}
}

func TestBountyKinds(t *testing.T) {
	base := BountyInfo{ID: 77, Settlement: 2, Town: "Ost", Reward: 60, Site: 9, SiteName: "Old Ruin",
		Target: Place{OK: true, X: 500, Z: 500, R: 40}, Board: Place{OK: true, X: 10, Z: 10}}
	f := &facts{have: map[string]int{}, known: map[string]bool{}}

	// Clear: a cleared group at the site completes it.
	l := NewLog()
	b := base
	b.Kind = BountyClear
	q := FromBounty(b, 0)
	if err := l.Add(q); err != nil {
		t.Fatal(err)
	}
	if hs := l.Advance(f, &Signal{Kind: ObjClear, Site: 3, X: 0, Z: 0}, nil); len(hs) != 0 {
		t.Fatal("another site's clear counted")
	}
	if hs := l.Advance(f, &Signal{Kind: ObjClear, Site: 9}, nil); len(hs) != 1 || !hs[0].Finished || hs[0].Quest.Gold != 60 {
		t.Fatalf("clear: %+v", hs)
	}
	// ... or arriving while it's quiet.
	l = NewLog()
	q = FromBounty(b, 0)
	_ = l.Add(q)
	f.x, f.z = 520, 510
	if hs := l.Advance(f, nil, nil); len(hs) != 0 || f.quietQ != 1 {
		t.Fatalf("not quiet yet: %+v", hs)
	}
	f.quiet = true
	if hs := l.Advance(f, nil, nil); len(hs) != 1 {
		t.Fatal("quiet arrival did not complete")
	}

	// Slay: a demon kill near the site.
	l = NewLog()
	b.Kind = BountySlay
	_ = l.Add(FromBounty(b, 0))
	if hs := l.Advance(f, &Signal{Kind: ObjSlay, X: 2000, Z: 2000}, nil); len(hs) != 0 {
		t.Fatal("far demon counted")
	}
	if hs := l.Advance(f, &Signal{Kind: ObjSlay, X: 700, Z: 500}, nil); len(hs) != 1 {
		t.Fatal("demon near the site did not count")
	}

	// Explore: reach.
	l = NewLog()
	b.Kind = BountyExplore
	_ = l.Add(FromBounty(b, 0))
	f.x, f.z = 0, 0
	if hs := l.Advance(f, nil, nil); len(hs) != 0 {
		t.Fatal("explore completed from afar")
	}
	f.x, f.z = 510, 490
	if hs := l.Advance(f, nil, nil); len(hs) != 1 {
		t.Fatal("explore did not complete on arrival")
	}

	// Deliver: needs the items and the turn-in at its own settlement.
	l = NewLog()
	b.Kind, b.Item, b.Qty = BountyDeliver, "ingot:iron", 5
	q = FromBounty(b, 0)
	_ = l.Add(q)
	if !view(q).TurnIn || view(q).Need != 5 || view(q).Markers[0].X != 10 {
		t.Fatalf("deliver wire %+v", view(q))
	}
	f.have["ingot:iron"] = 5
	if hs := l.Advance(f, nil, nil); len(hs) != 0 {
		t.Fatal("deliver completed without a turn-in")
	}
	if hs := l.Advance(f, &Signal{Kind: ObjTurnIn, Settlement: 1}, nil); len(hs) != 0 {
		t.Fatal("turn-in at another settlement counted")
	}
	f.have["ingot:iron"] = 4
	if hs := l.Advance(f, &Signal{Kind: ObjTurnIn, Settlement: 2}, nil); len(hs) != 0 {
		t.Fatal("short turn-in counted")
	}
	f.have["ingot:iron"] = 6
	if hs := l.Advance(f, &Signal{Kind: ObjTurnIn, Settlement: 2}, nil); len(hs) != 1 || !l.IsDone(q.Key) {
		t.Fatal("turn-in did not complete")
	}
}

func TestLimitsTrackAndRoundTrip(t *testing.T) {
	l := NewLog()
	for i := 0; i < MaxBounties; i++ {
		if err := l.Add(FromBounty(BountyInfo{ID: uint32(i + 1), Kind: BountyExplore, Site: i}, 0)); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.Add(FromBounty(BountyInfo{ID: 99, Kind: BountyExplore}, 0)); err != ErrTooMany {
		t.Fatalf("6th bounty: %v", err)
	}
	if err := l.Add(FromBounty(BountyInfo{ID: 1, Kind: BountyExplore}, 0)); err != ErrHave {
		t.Fatalf("duplicate: %v", err)
	}
	if err := l.Add(Ward(places(), 0)); err != nil { // story quests don't count against the bounty limit
		t.Fatal(err)
	}
	if !l.Track(WardID) || l.Tracked != WardID || l.Track(12345) {
		t.Fatal("track")
	}
	l.Remove(WardID)
	if l.Tracked == WardID || l.Tracked == 0 {
		t.Fatalf("tracked after removing the tracked quest: %d", l.Tracked)
	}
	b := l.JSON()
	l2 := Load(b)
	if len(l2.Active) != MaxBounties || l2.Tracked != l.Tracked || !l2.HasStarted(WardKey) {
		t.Fatalf("round trip: %s", b)
	}
	if Load([]byte("garbage")) == nil || len(Load(nil).Active) != 0 {
		t.Fatal("bad input")
	}
	var w struct {
		Quests []WireQuest `json:"quests"`
	}
	if err := json.Unmarshal(l.Wire(), &w); err != nil || len(w.Quests) != MaxBounties {
		t.Fatalf("wire: %v %d", err, len(w.Quests))
	}
	var o WireQuest
	if err := json.Unmarshal(OfferWire(Ward(places(), 0)), &o); err != nil || len(o.StepMarkers) != len(o.Steps) || len(o.StepMarkers[1]) != 2 {
		t.Fatalf("offer: %v %+v", err, o)
	}
}

func TestDoneIsBoundedButKeepsStories(t *testing.T) {
	l := NewLog()
	l.markDone(WardKey)
	for i := 0; i < 200; i++ {
		l.markDone(BountyKey(1, uint32(i)))
	}
	if len(l.Done) > maxDone || !l.IsDone(WardKey) || !l.IsDone(BountyKey(1, 199)) || l.IsDone(BountyKey(1, 0)) {
		t.Fatalf("done %d ward %v", len(l.Done), l.IsDone(WardKey))
	}
}

func TestWhere(t *testing.T) {
	if s := Where(0, 0, 300, -300, "Ost"); !strings.Contains(s, "north-east of Ost") || !strings.HasPrefix(s, "420 m") {
		t.Fatal(s)
	}
	if s := Where(0, 0, 0, 1500, "Ost"); s != "1.5 km south of Ost" {
		t.Fatal(s)
	}
}
