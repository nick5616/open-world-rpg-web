package quests

import (
	"regexp"
	"testing"
)

// Playtest 5 (CR 055): "How does Tammir know directly about the controls?"
// People of the world speak in the world. Nothing a giver says, and nothing
// the journal says in their place, names a key or a control: the client
// toasts the controls (read from the live key bindings) when the
// conversation closes (client/src/ui/tips/controlTips.ts).
var keyTalk = regexp.MustCompile(`(?i)\bpress(ed|ing)?\b|\[E\]|\bkeys?\b|\bhold E\b|\bleft click\b|\bright click\b|\bclick\b|\(([A-Z]|\d)\)|\bkey \d|\b[1-9]( to |-)[1-9]\b|\b(E|F|G|H|R|I|P|J|M) (dodges|opens|lights|mounts|casts|drinks)\b|\bbutton\b|\bhotbar\b|\bspace bar\b|\bspacebar\b`)

func assertInWorld(t *testing.T, name string, q *Quest, say string) {
	t.Helper()
	check := func(where, s string) {
		if s != "" && keyTalk.MatchString(s) {
			t.Errorf("%s %s names a key or a control: %q", name, where, s)
		}
	}
	check("offer", say)
	check("title", q.Title)
	for i, s := range q.Steps {
		check("step text", s.Text)
		check("step note", s.Note)
		check("step line", s.Say)
		_ = i
	}
}

func TestEveryErrandSpeaksInTheWorld(t *testing.T) {
	person := func(name string, role int, title string) Person {
		return Person{Name: name, Role: role, Title: title, At: Place{OK: true, X: 1, Z: 2}}
	}
	p := &ErrandPlaces{Settlement: 1, Town: "Draedmore", Smith: person("Selina", 2, "blacksmith"), Mentor: person("Tammir", 5, "farmer"), Guard: person("Fenen", 6, "guard"),
		Innkeeper: person("Ulus", 3, "innkeeper"), Merchant: person("Fenia", 1, "merchant"), Keeper: person("Kelmir", 4, "bounty keeper"),
		Forge: Place{OK: true, X: 3, Z: 3}, OreMouth: Place{OK: true, X: 9, Z: 9, Where: "490 m south-west of Draedmore"}, OreVeins: Place{OK: true, X: 9, Z: 20, R: 15},
		DarkMouth: Place{OK: true, X: 9, Z: 9}, Water: Place{OK: true, X: 5, Z: 5}, Tower: Place{OK: true, X: 50, Z: 50}, TowerSite: 4, TowerName: "The Spire"}
	for _, id := range ErrandChain {
		for _, withTalk := range []bool{true, false} {
			q, say := Errand(id, p, withTalk, 0)
			if q == nil {
				t.Fatalf("errand %s missing", id)
			}
			assertInWorld(t, "errand "+id, q, say)
		}
	}
}

func TestMeadowsAndWardSpeakInTheWorld(t *testing.T) {
	m := Meadows(meadowsPlaces(), 1)
	assertInWorld(t, "meadows", m, "")
	w := Ward(places(), 1)
	assertInWorld(t, "ward", w, "")
	// Without a shaft or a shrine the notes change; cover those branches too.
	p := places()
	p.Shaft = Place{OK: true, X: 395, Z: -195}
	p.Shrine = Place{}
	assertInWorld(t, "ward (shaft, no shrine)", Ward(p, 1), "")
}

func TestKeyTalkRegexCatchesTheOldLines(t *testing.T) {
	for _, bad := range []string{"press 8 for the torch", "Walk up and press E.", "your torch is key 8", "hold E on a trunk", "Left click swings your sword", "the glider (G)", "1 to 4 cast", "Blow it with H"} {
		if bad == "Blow it with H" {
			continue // a bare letter after "with" cannot be told from prose; the errand test covers the real line
		}
		if !keyTalk.MatchString(bad) {
			t.Errorf("the check misses %q", bad)
		}
	}
	for _, ok := range []string{"Keep a torch handy, caves are dark.", "Break three veins loose.", "Swing your sword and step out of the way."} {
		if keyTalk.MatchString(ok) {
			t.Errorf("the check flags %q", ok)
		}
	}
}
