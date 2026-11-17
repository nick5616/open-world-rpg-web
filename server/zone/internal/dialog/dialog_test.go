package dialog

import (
	"strings"
	"testing"
)

func person(id uint64, role uint8) Person {
	return Person{ID: id, Name: "Mira", Role: role, Town: "Draedmore", Region: "the Gilded Fields",
		Neighbours: []Near{{Name: "Teiraben", DX: 800, DZ: -200}, {Name: "Baimteick", DX: -1500, DZ: 900}}}
}

func TestGreetingFirstMeetingVersusMetUsesName(t *testing.T) {
	p := person(7, RoleVillager)
	ps := PersonaOf(p)
	ctx := Context{Player: "Nicole", Hour: 13}
	first := Greeting(p, ps, Memory{}, ctx)
	if strings.Contains(first, "Nicole") {
		t.Fatalf("a stranger doesn't know your name: %q", first)
	}
	var seen bool
	for talks := 1; talks < 12 && !seen; talks++ {
		g := Greeting(p, ps, Memory{Met: true, Talks: talks}, ctx)
		seen = strings.Contains(g, "Nicole")
	}
	if !seen {
		t.Fatal("met before: they never use your name")
	}
	if Greeting(p, ps, Memory{}, ctx) != first {
		t.Fatal("greeting is not deterministic")
	}
}

func TestGreetingVariesWithTimeWeatherLevelAndDeeds(t *testing.T) {
	p := person(11, RoleInnkeeper)
	ps := PersonaOf(p)
	m := Memory{Met: true, Talks: 2}
	base := Context{Player: "Nicole", Hour: 13, Level: 5, Gear: 1}
	rain := base
	rain.Weather = "rain"
	rs := rain.remarks(p, ps, m)
	found := false
	for _, r := range rs {
		for _, w := range weatherLines["rain"][0] {
			found = found || r == w
		}
		for _, w := range weatherLines["rain"][1] {
			found = found || r == w
		}
	}
	if !found {
		t.Fatalf("no rain remark in %v", rs)
	}
	night := base
	night.Night, night.Hour = true, 23
	if len(night.remarks(p, ps, m)) == 0 {
		t.Fatal("night: nothing to say")
	}
	newbie := base
	newbie.Level = 1
	hasNew := false
	for _, r := range newbie.remarks(p, ps, m) {
		hasNew = hasNew || strings.Contains(r, "new") || strings.Contains(r, "Fresh")
	}
	if !hasNew {
		t.Fatal("a level 1 player isn't noticed")
	}
	deed := base
	deed.Deeds = []Deed{{Kind: "camp", Name: "Rook Hollow"}, {Kind: "warden"}}
	joined := strings.Join(deed.remarks(p, ps, m), "|")
	if !strings.Contains(joined, "Rook Hollow") || !strings.Contains(joined, "warden") {
		t.Fatalf("deeds not mentioned: %s", joined)
	}
	if d := (Context{Defense: true, Hour: 22, Night: true}); !strings.Contains(strings.Join(d.remarks(p, ps, m), "|"), "beacon") {
		t.Fatal("a night defense isn't mentioned")
	}
}

func TestPersonalitiesDiffer(t *testing.T) {
	temps := map[Temper]bool{}
	quirksSeen := map[string]bool{}
	families := map[string]bool{}
	for i := uint64(1); i <= 14; i++ {
		p := person(i*0x9E3779B97F4A7C15, uint8(i%7))
		ps := PersonaOf(p)
		temps[ps.Temper] = true
		quirksSeen[ps.Quirk] = true
		families[ps.Family] = true
	}
	if len(temps) < 5 || len(quirksSeen) < 8 || len(families) < 6 {
		t.Fatalf("too samey: %d temperaments, %d quirks, %d families", len(temps), len(quirksSeen), len(families))
	}
	// Same id, same person.
	a, b := PersonaOf(person(5, RoleGuard)), PersonaOf(person(5, RoleGuard))
	if a != b {
		t.Fatal("persona not deterministic")
	}
	// Two people in one town greet differently.
	x, y := person(101, RoleFarmer), person(202, RoleMerchant)
	gx := Greeting(x, PersonaOf(x), Memory{}, Context{})
	gy := Greeting(y, PersonaOf(y), Memory{}, Context{})
	if gx == gy {
		t.Fatalf("two townsfolk say the same: %q", gx)
	}
}

func TestKeyCharactersKeepTheirVoiceAndDwarvesTheirs(t *testing.T) {
	p := person(3, RoleInnkeeper)
	p.Key = KeyKeeper
	ps := PersonaOf(p)
	if ps.Temper != Warm || !strings.Contains(Who(p, ps), "inn") || !strings.Contains(ps.Family, "grandmother") {
		t.Fatalf("keeper: %+v %q", ps, Who(p, ps))
	}
	d := person(3, RoleBlacksmith)
	d.Dwarven = true
	g := Greeting(d, PersonaOf(d), Memory{}, Context{})
	if !strings.Contains(g, "Surface") && !strings.Contains(g, "visitor") && !strings.Contains(g, "Welcome to Draedmore") {
		t.Fatalf("dwarven greeting %q", g)
	}
}

func sites() []Site {
	return []Site{
		{Kind: KindCave, Key: "site:1", Name: "the Weeping Cave", X: 100, Z: 100, DX: 300, DZ: 0},
		{Kind: KindBandit, Key: "site:2", X: 900, Z: 0, DX: 900, DZ: 0},
		{Kind: KindTower, Key: "site:3", Name: "Craidath Spire", X: 0, Z: -2500, DX: 0, DZ: -2500},
		{Kind: KindHerb, Key: "site:4", Name: "heartleaf", X: 50, Z: 60, DX: 60, DZ: 60, Done: true},
	}
}

func TestRumourSkipsDoneAndPicksNearby(t *testing.T) {
	p := person(9, RoleVillager)
	ps := PersonaOf(p)
	r, ok := PickRumour(p, ps, Memory{}, sites())
	if !ok {
		t.Fatal("no rumour")
	}
	if r.Key == "site:4" {
		t.Fatal("told about a place the player already did")
	}
	if r.Key == "site:3" {
		t.Fatalf("picked the far tower over nearer places: %s", r.Text)
	}
	if !r.Pos || r.X == 0 && r.Z == 0 {
		t.Fatalf("no marker position: %+v", r)
	}
	if !strings.Contains(r.Text, "m ") && !strings.Contains(r.Text, "short walk") {
		t.Fatalf("no distance or direction: %q", r.Text)
	}
}

func TestRumoursDoNotRepeatAndRunOut(t *testing.T) {
	p := person(9, RoleGuard)
	ps := PersonaOf(p)
	var m Memory
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		r, ok := PickRumour(p, ps, m, sites())
		if !ok {
			t.Fatalf("ran out after %d", i)
		}
		if seen[r.Key] {
			t.Fatalf("repeated %s", r.Key)
		}
		seen[r.Key] = true
		m.Hear(RumourKey(r.Key))
	}
	if _, ok := PickRumour(p, ps, m, sites()); ok {
		t.Fatal("a fourth rumour from three places")
	}
	if NoRumour(p, ps) == "" {
		t.Fatal("no line for nothing")
	}
}

func TestRoleBiasPointsAtTheTrade(t *testing.T) {
	ss := []Site{
		{Kind: KindTower, Key: "site:t", X: 1, Z: 1, DX: 380, DZ: 0},
		{Kind: KindShaft, Key: "site:s", X: 1, Z: 1, DX: 560, DZ: 0},
	}
	smith := person(21, RoleBlacksmith)
	r, _ := PickRumour(smith, PersonaOf(smith), Memory{}, ss)
	if r.Kind != KindShaft {
		t.Fatalf("a blacksmith talked about %s", r.Kind)
	}
}

func TestMemoryUpdatesAndUnlocks(t *testing.T) {
	p := person(15, RoleMerchant)
	var m Memory
	ctx := Context{Player: "Nicole", Sites: sites(), Work: Work{Shop: true}}
	// Opening: nothing personal yet, "Who are you?" first.
	has := func(n Node, act string) bool {
		for _, c := range n.Choices {
			if c.Act == act {
				return true
			}
		}
		return false
	}
	open := Open(p, m, ctx)
	if !has(open, "topic:who") || !has(open, "work:shop") || !has(open, "topic:rumour") || !has(open, "topic:place") || !has(open, "bye") {
		t.Fatalf("menu %+v", open.Choices)
	}
	if has(open, "topic:family") {
		t.Fatal("family offered to a stranger")
	}
	m.Talked(3)
	if !m.Met || m.Talks != 1 || m.Affinity != 1 {
		t.Fatalf("after talk %+v", m)
	}
	m.Talked(3) // same day: no extra warmth
	if m.Affinity != 1 || m.Talks != 2 {
		t.Fatalf("same day %+v", m)
	}
	m.Talked(4)
	if m.Affinity != 2 {
		t.Fatalf("new day %+v", m)
	}
	n := Reply(p, &m, ctx, "who")
	if !m.Has("t:who") || n.Line == "" || has(n, "topic:who") {
		t.Fatalf("who: %+v %+v", n, m)
	}
	if !has(n, "topic:family") {
		t.Fatalf("family did not unlock after who: %+v", n.Choices)
	}
	n = Reply(p, &m, ctx, "family")
	if n.Line != PersonaOf(p).Family || !m.Has("t:family") {
		t.Fatal("family reply")
	}
	if has(n, "topic:family") {
		t.Fatal("a heard backstory is offered again")
	}
	// Rumour then mark.
	n = Reply(p, &m, ctx, "rumour")
	if n.Rumour == nil || !has(n, "mark:"+n.Rumour.Key) || !has(n, "menu") || !m.Has(RumourKey(n.Rumour.Key)) {
		t.Fatalf("rumour node %+v", n)
	}
	// Warm one more time and "origin" unlocks.
	m.Add(5)
	if !has(Open(p, m, ctx), "topic:origin") {
		t.Fatal("origin not unlocked by affinity")
	}
	// Memory round-trips a cap.
	for i := 0; i < 100; i++ {
		m.Hear("x" + string(rune('a'+i%26)) + string(rune('a'+i/26)))
	}
	if len(m.Heard) > maxHeard {
		t.Fatal("memory grows without bound")
	}
}

func TestPlaceNamesTheNeighbours(t *testing.T) {
	p := person(4, RoleVillager)
	s := Place(p, PersonaOf(p))
	if !strings.Contains(s, "Draedmore") || !strings.Contains(s, "Teiraben") || !strings.Contains(s, "the Gilded Fields") {
		t.Fatal(s)
	}
}

// Real ids have the high bit set about half the time: nothing may index a
// list with a negative number (the dev zone's first conversation panicked on one).
func TestNeverPanicsOnAnyIDOrContext(t *testing.T) {
	ctxs := []Context{
		{Player: "Nicole", Hour: 7, Level: 1},
		{Player: "Nicole", Hour: 23, Night: true, Defense: true, Weather: "thunderstorm", Level: 20, Gear: 3, Act: 4, Event: "word is about a caravan", Deeds: []Deed{{Kind: "camp"}, {Kind: "tower"}, {Kind: "vault"}, {Kind: "warden"}, {Kind: "beaten"}}, Work: Work{Shop: true, Bounty: true, Rest: true, Forge: true}},
		{Player: "", Hour: 13, Weather: "snow", Sites: sites()},
	}
	for i := uint64(0); i < 60; i++ {
		id := mix(i) | uint64(i%2)<<63
		for role := uint8(0); role < 7; role++ {
			for _, dw := range []bool{false, true} {
				for _, key := range []string{"", KeyKeeper, KeyMeadows, KeySmith, KeyBounty, KeyCaptain, KeyMasterSmith} {
					p := person(id, role)
					p.Dwarven, p.Key = dw, key
					for _, ctx := range ctxs {
						for talks := 0; talks < 6; talks++ {
							m := Memory{Met: talks > 0, Talks: talks, Affinity: talks * 2}
							n := Open(p, m, ctx)
							if n.Line == "" || len(n.Choices) < 3 {
								t.Fatalf("empty node for %d/%d", id, role)
							}
							for _, topic := range []string{"who", "place", "rumour", "family", "origin", "wants", "secret", "nope"} {
								mm := m
								if Reply(p, &mm, ctx, topic).Line == "" {
									t.Fatalf("no reply to %s", topic)
								}
							}
							_ = Farewell(p, PersonaOf(p), m, ctx.Player)
						}
					}
				}
			}
		}
	}
}
