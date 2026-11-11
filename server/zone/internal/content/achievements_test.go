package content

import (
	"encoding/json"
	"slices"
	"testing"

	"lodestone/server/pkg/contentdefs"
)

// earn is NewAchievements on a current (V 2) state, at t = 1 ms.
func earn(s *State, glue StatFunc) []*contentdefs.Achievement {
	a, _ := s.NewAchievements(glue, 1)
	return a
}

// The 37 feats of CR 023 and the later features, as they were (key, stat,
// count): moved into contracts/achievements.yaml unchanged, so what a
// character earned and every counter mean the same.
var legacyFeats = map[string]struct {
	stat string
	n    int
}{
	"first_steps": {"kills", 1}, "skyreader": {"towers", 1}, "tower_chorus": {"towers", 5}, "slimebane": {"family:slime", 100},
	"beastmaster": {"family:beast", 150}, "banditbreaker": {"family:bandit", 50}, "dawnbringer": {"demons", 25}, "wanderer": {"regions", 8},
	"cartographer": {"regions", 16}, "duelist": {"duels", 1}, "champion": {"duels", 10}, "helping_hand": {"side", 5}, "folk_hero": {"side", 20},
	"storyteller": {"stories", 3}, "first_event": {"events", 1}, "event_veteran": {"events", 10}, "vault_breaker": {"dungeons", 1},
	"delver": {"dungeons", 5}, "reader": {"tablets", 8}, "all_tablets": {"tablets", 16}, "naturalist": {"codex", 15}, "bestiarist": {"codex", 30},
	"green_thumb": {"forage", 50}, "honored_guest": {"honored", 1}, "seasoned": {"level", 10}, "first_catch": {"fish", 1}, "angler": {"fish", 50},
	"fishwise": {"fishspecies", 14}, "tall_tale": {"fishlegend", 1}, "first_pet": {"tamed", 1}, "menagerie": {"tamedspecies", 9},
	"shiny_pet": {"shinytamed", 1}, "pet_veteran": {"petlevel", 10}, "bard": {"notes", 100}, "troubadour": {"notes", 2000},
	"crowd_pleaser": {"ovations", 5}, "fireside_tales": {"firesongs", 1},
}

func TestAchievementsKeepEveryFeat(t *testing.T) {
	d := contentdefs.D
	if n := len(d.Achievements); n < 80 || n > 140 { // CR 035 appended 11 (The Last Song)
		t.Fatalf("%d achievements, want 80-140", n)
	}
	for k, f := range legacyFeats {
		a := d.Achievement(k)
		if a == nil || a.Stat != f.stat || a.N != f.n {
			t.Fatalf("feat %s moved as %+v", k, a)
		}
	}
	cats := map[int]int{}
	for i, a := range d.Achievements {
		if a.ID != i+1 || d.AchievementByID(a.ID) != &d.Achievements[i] || a.Pts <= 0 || a.Name == "" || a.Desc == "" {
			t.Fatalf("achievement %+v", a)
		}
		cats[a.Cat]++
	}
	if len(cats) != len(d.AchievementCats) || len(d.AchievementCats) != 10 || len(d.AchievementTiers) != 4 {
		t.Fatalf("categories %v of %d, tiers %d", cats, len(d.AchievementCats), len(d.AchievementTiers))
	}
	ts := d.Achievement("tony_stark")
	if ts == nil || ts.Name != "Tony Stark built this in a cave with scraps" || d.AchievementTiers[ts.Tier].Key != "gold" || !ts.Hidden || ts.Title == "" || ts.Stat != "magmaflight" {
		t.Fatalf("tony stark %+v", ts)
	}
}

func TestAchievementChains(t *testing.T) {
	chains := map[string][]contentdefs.Achievement{}
	for _, a := range contentdefs.D.Achievements {
		if a.Chain != "" {
			chains[a.Chain] = append(chains[a.Chain], a)
		}
	}
	if len(chains) < 15 {
		t.Fatalf("%d chains", len(chains))
	}
	for c, steps := range chains {
		slices.SortFunc(steps, func(x, y contentdefs.Achievement) int { return x.Step - y.Step })
		for i, a := range steps {
			if a.Step != i+1 || a.Steps != len(steps) || a.Stat != steps[0].Stat || (i > 0 && a.N <= steps[i-1].N) {
				t.Fatalf("chain %s step %d: %+v", c, i, a)
			}
		}
	}
	// A chain's steps unlock in order as the one counter climbs.
	s := NewState()
	s.Add("casts", 1000)
	got := keys(earn(s, nil))
	if !slices.Contains(got, "spellslinger_1") || !slices.Contains(got, "spellslinger_2") || slices.Contains(got, "spellslinger_3") {
		t.Fatalf("spellslinger at 1000: %v", got)
	}
}

func keys(as []*contentdefs.Achievement) []string {
	var out []string
	for _, a := range as {
		out = append(out, a.Key)
	}
	return out
}

// TestFeatsMigrate: a character saved before CR 031 (content state V 1,
// feats and counters only) keeps every feat and its title, earns the new
// achievements its old counters already reach in one catch-up (not one
// toast each), and is V 2 from then on.
func TestFeatsMigrate(t *testing.T) {
	old := []byte(`{"v":1,"kills":{"slime":12,"wolf":3},"families":{"slime":12,"beast":3},"tablets":[2],"feats":["first_steps","skyreader"],"title":"skyreader","stats":{"kills":150,"duels":2},"vaults":{"5":0},"fish":{"gloam_eel":[1,800]}}`)
	s := LoadState(old)
	if !s.CatchingUp() || !s.Has("first_steps") || s.TitleText() != "the Skyreader" || s.EarnedAt("skyreader") != 0 {
		t.Fatalf("loaded %+v", s)
	}
	glue := func(stat string) int {
		if stat == "towers" {
			return 1
		}
		return 0
	}
	got, caughtUp := s.NewAchievements(glue, 5000)
	k := keys(got)
	for _, want := range []string{"getting_the_hang", "squelch", "light_reading", "x_marks", "something_fishy", "duelist"} {
		if !slices.Contains(k, want) {
			t.Fatalf("catch-up %v lacks %s", k, want)
		}
	}
	if !caughtUp || slices.Contains(k, "first_steps") || slices.Contains(k, "skyreader") || s.CatchingUp() || s.Title != "skyreader" || s.EarnedAt("squelch") != 5000 {
		t.Fatalf("catch-up %v (caught up %v) title %q", k, caughtUp, s.Title)
	}
	back := LoadState(s.JSON())
	if back.CatchingUp() || !back.Has("first_steps") || !back.Has("squelch") || back.EarnedAt("squelch") != 5000 || back.Stat("kills") != 150 {
		t.Fatalf("saved %s", s.JSON())
	}
	again, caughtUp := back.NewAchievements(glue, 6000)
	if len(again) != 0 || caughtUp {
		t.Fatalf("earned again %v", keys(again))
	}
	// A new character never catches up.
	if _, c := NewState().NewAchievements(nil, 1); c {
		t.Fatal("new state caught up")
	}
}

func TestAchievementStats(t *testing.T) {
	s := NewState()
	s.Add("cast:fire", 3)
	s.Add("cast:ice", 1)
	s.Add("cast:void", 0)
	s.Add("event:glintfox", 1)
	s.Landed("gloam_eel", 700, false)
	s.Landed("gloam_eel", 900, false)
	s.VaultSeen(3)
	s.VaultSeen(9)
	if s.Stat2("schools") != 2 || s.Stat2("eventkinds") != 1 || s.Stat2("fish:gloam_eel") != 2 || s.Stat2("vaultsfound") != 2 || s.Stat2("towers") != -1 || s.Stat2("petlevel") != -1 {
		t.Fatalf("stats %v", s.Stats)
	}
	if !s.SetMax("flighthigh", 30) || s.SetMax("flighthigh", 20) || s.Stat("flighthigh") != 30 {
		t.Fatal("SetMax")
	}
	// Hidden achievements keep their counts to themselves until earned.
	if _, ok := s.Progress(nil)["icarus"]; ok {
		t.Fatal("hidden progress sent")
	}
	if s.Progress(nil)["outfoxed"] != 1 {
		t.Fatal("outfoxed progress")
	}
	s.SetMax("flighthigh", 61)
	s.Add("magmaflight", 1)
	got := keys(earn(s, nil))
	if !slices.Contains(got, "icarus") || !slices.Contains(got, "tony_stark") || !slices.Contains(got, "outfoxed") {
		t.Fatalf("earned %v", got)
	}
	if _, ok := s.Progress(nil)["icarus"]; !ok {
		t.Fatal("earned hidden progress missing")
	}
	if !s.SetTitle("tony_stark") || s.TitleText() != "the Ironclad" || s.SetTitle("zoom") {
		t.Fatal("titles")
	}
	pts := 0
	for _, k := range s.Feats {
		pts += contentdefs.D.Achievement(k).Pts
	}
	if s.Points() != pts || pts < 100 {
		t.Fatalf("points %d %d", s.Points(), pts)
	}
	var j map[string]any
	if json.Unmarshal(s.JSON(), &j) != nil || j["at"] == nil {
		t.Fatalf("saved %s", s.JSON())
	}
}
