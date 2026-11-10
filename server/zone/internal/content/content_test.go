package content

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/itemdefs"
	"lodestone/server/zone/internal/quests"
)

// A small synthetic world: three towns in two regions, places of every kind.
func testWorld() *World {
	w := &World{Seed: 20261108}
	mk := func(i int, name string, x, z float64, region int, roles ...int) Town {
		t := Town{Index: i, ID: uint64(1000 + i), Name: name, X: x, Z: z, Radius: 50, Region: region, Biome: i % 6}
		for k, r := range roles {
			t.NPCs = append(t.NPCs, NPC{Index: i*20 + k, Name: name + "-npc" + string(rune('A'+k)), Role: r, X: x + float64(k), Z: z})
		}
		return t
	}
	w.Towns = []Town{
		mk(0, "Draedmore", 1000, 1000, 0, RoleBlacksmith, RoleInnkeeper, RoleBounty, RoleFarmer, RoleVillager, RoleVillager, RoleMerchant, RoleGuard),
		mk(1, "Crokathloch", 1600, 1100, 0, RoleBlacksmith, RoleInnkeeper, RoleBounty, RoleFarmer),
		mk(2, "Steinmadun", 2600, 1000, 1, RoleBlacksmith, RoleInnkeeper, RoleBounty, RoleFarmer, RoleMerchant),
	}
	kinds := []string{SiteShrine, SiteRuin, SiteWatchtower, SiteTower, SiteBanditCamp, SiteLandmark, SiteCamp}
	n := 0
	for _, k := range kinds {
		for j := 0; j < 3; j++ {
			a := float64(n) * 0.9
			d := 300.0 + float64(j)*350
			w.Sites = append(w.Sites, Site{Index: n, Kind: k, Name: strings.Title(k) + " " + string(rune('A'+j)), X: 1000 + d*math.Cos(a), Z: 1000 + d*math.Sin(a), R: 15, Region: 0})
			n++
		}
	}
	w.Dungeons = []Site{{Index: 1, Kind: SiteDungeon, Name: "The Undervault of Ruin A", X: 1200, Z: 900, R: 25}}
	return w
}

func TestGiversDeterministicAndBounded(t *testing.T) {
	w := testWorld()
	for i := range w.Towns {
		a, b := Givers(w.Seed, &w.Towns[i]), Givers(w.Seed, &w.Towns[i])
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("givers differ: %v %v", a, b)
		}
		if len(a) < 2 || len(a) > 4 {
			t.Fatalf("town %d: %d givers", i, len(a))
		}
		for _, g := range a {
			n := w.Towns[i].NPC(g)
			if n.Role == RoleBlacksmith || n.Role == RoleBounty {
				t.Fatalf("a %d is never a giver", n.Role)
			}
		}
	}
	// Another seed picks (usually) other givers in the big town.
	if reflect.DeepEqual(Givers(1, &w.Towns[0]), Givers(2, &w.Towns[0])) && reflect.DeepEqual(Givers(3, &w.Towns[0]), Givers(4, &w.Towns[0])) {
		t.Fatal("givers ignore the seed")
	}
}

func TestSideQuestsDeterministicEveryKind(t *testing.T) {
	w := testWorld()
	kinds := map[string]int{}
	for ti := range w.Towns {
		town := &w.Towns[ti]
		for _, g := range Givers(w.Seed, town) {
			prev := ""
			for seq := 0; seq < 12; seq++ {
				a := SideQuest(w, town, g, seq, 1)
				b := SideQuest(w, town, g, seq, 1)
				if a == nil {
					t.Fatalf("town %d giver %d seq %d: no quest", ti, g, seq)
				}
				ja, _ := json.Marshal(a.Quest)
				jb, _ := json.Marshal(b.Quest)
				if string(ja) != string(jb) || a.Say != b.Say {
					t.Fatal("side quest not deterministic")
				}
				if a.Kind == prev {
					t.Fatalf("same kind twice running: %s", a.Kind)
				}
				prev = a.Kind
				kinds[a.Kind]++
				q := a.Quest
				if q.Kind != quests.KindSide || q.Key != SideKey(ti, g, seq) || q.ID == 0 || q.Gold <= 0 || q.XP <= 0 || q.Rep <= 0 || len(q.Steps) == 0 {
					t.Fatalf("bad quest %+v", q)
				}
				if strings.Contains(string(ja), "{") && strings.Contains(q.Title+a.Say, "{") {
					t.Fatalf("unfilled placeholder: %q / %q", q.Title, a.Say)
				}
				for _, s := range q.Steps {
					if strings.Contains(s.Text+s.Note+s.Say, "{") || s.Text == "" {
						t.Fatalf("step text %q / %q / %q", s.Text, s.Note, s.Say)
					}
				}
				switch a.Kind {
				case "deliver":
					if len(q.Start) != 1 || q.Start[0].Item != Parcel || q.Steps[0].Obj.Settlement == ti {
						t.Fatalf("deliver: %+v", q)
					}
				case "gather":
					if q.Steps[0].Obj.Kind != quests.ObjGive || itemdefs.D.Item(q.Steps[0].Obj.Items[0].Item) == nil {
						t.Fatalf("gather: %+v", q.Steps[0])
					}
				case "hunt":
					if q.Steps[0].Obj.Kind != quests.ObjKill || q.Steps[0].Obj.N < 1 || q.Steps[1].Obj.NPC != g+1 {
						t.Fatalf("hunt: %+v", q.Steps)
					}
				case "rescue":
					if q.Steps[1].Obj.Kind != quests.ObjEscort || RescueVillager(q) == "" || RescueVillager(q) == "the villager" {
						t.Fatalf("rescue: %+v %q", q.Steps, RescueVillager(q))
					}
				}
			}
		}
	}
	for _, k := range []string{"hunt", "gather", "deliver", "explore", "rescue"} {
		if kinds[k] == 0 {
			t.Fatalf("kind %s never generated: %v", k, kinds)
		}
	}
	t.Logf("kinds %v", kinds)
	// Not a giver: nothing.
	if SideQuest(w, &w.Towns[0], w.Towns[0].NPCOf(RoleBlacksmith).Index, 0, 1) != nil {
		t.Fatal("the blacksmith offered a side quest")
	}
}

func TestStoriesResolve(t *testing.T) {
	w := testWorld()
	home := &w.Towns[0]
	for _, def := range contentdefs.D.Stories {
		giver := home.NPCOf(def.Role)
		if giver == nil {
			giver = home.NPCOf(def.AltRole)
		}
		q := Story(w, &def, home, giver.Index, 1)
		if q == nil {
			t.Fatalf("story %s did not resolve", def.Key)
		}
		if len(q.Steps) != len(def.Steps) || q.ID != StoryID(def.Key) || q.Key != StoryKey(def.Key) || q.RollItems != def.Items {
			t.Fatalf("story %s: %+v", def.Key, q)
		}
		for _, s := range q.Steps {
			if strings.Contains(s.Text+s.Note, "{") {
				t.Fatalf("story %s step %q / %q", def.Key, s.Text, s.Note)
			}
		}
		t.Logf("%s: %d steps, first %q", def.Key, len(q.Steps), q.Steps[0].Text)
	}
	// The watch banner goes to a town in another region.
	q := Story(w, contentdefs.D.Story("old_watch"), home, home.NPCOf(RoleGuard).Index, 1)
	if give := q.Steps[2].Obj; give.Kind != quests.ObjGive || give.Settlement != 2 {
		t.Fatalf("far town: %+v", give)
	}
}

func TestStateFeatsCodexRepRoundTrip(t *testing.T) {
	s := NewState()
	if !s.Kill("slime", "slime", false) || s.Kill("slime", "slime", false) {
		t.Fatal("first kill")
	}
	for i := 0; i < 98; i++ {
		s.Kill("slime", "slime", false)
	}
	fs := earn(s, func(stat string) int { return 0 })
	got := map[string]bool{}
	for _, f := range fs {
		got[f.Key] = true
	}
	if !got["first_steps"] || !got["slimebane"] || s.TitleText() != "Slimebane" {
		t.Fatalf("feats %v title %q", got, s.TitleText())
	}
	if len(earn(s, nil)) != 0 {
		t.Fatal("feats earned twice")
	}
	if !s.SetTitle("") || s.TitleText() != "" || s.SetTitle("skyreader") {
		t.Fatal("titles")
	}
	_, before, after := s.AddRep(3, 25)
	if before != 0 || after != 1 || s.RepOf(3) != 25 {
		t.Fatalf("rep %d -> %d", before, after)
	}
	s.AddRep(3, 200)
	if s.Honored() != 1 {
		t.Fatal("honored")
	}
	s.GiverDone(3, 7, 0)
	s.ReadTablet(4)
	s.Walked(5)
	s.VaultSeen(12)
	s.Pick(99, 5000, 1000)
	r := LoadState(s.JSON())
	if !reflect.DeepEqual(r.JSON(), s.JSON()) || r.GiverSeq(3, 7) != 1 || !r.Picked(99, 2000) || r.Picked(99, 6000) || !r.VaultKnown(12) || r.RegionsWalked() != 1 {
		t.Fatalf("round trip %s", r.JSON())
	}
	if LoadState([]byte("garbage")).V != StateVersion {
		t.Fatal("bad json")
	}
}

func TestCodexCoversEveryEnemy(t *testing.T) {
	if len(contentdefs.D.Codex) != len(combatdefs.D.Enemies) {
		t.Fatalf("codex %d enemies %d", len(contentdefs.D.Codex), len(combatdefs.D.Enemies))
	}
	for _, f := range contentdefs.D.Achievements {
		if f.N <= 0 || f.Name == "" {
			t.Fatalf("feat %+v", f)
		}
	}
}

func TestPatchesDeterministic(t *testing.T) {
	biome := func(x, z float64) int { return int(x/256) % 6 }
	a := PatchesIn(7, 3, 4, biome, nil)
	b := PatchesIn(7, 3, 4, biome, nil)
	if !reflect.DeepEqual(a, b) || len(a) == 0 {
		t.Fatalf("patches %d", len(a))
	}
	for _, p := range a {
		cx, cz := PatchCell(p.ID)
		q, ok := PatchAt(7, cx, cz, biome, nil)
		if !ok || q != p || p.X < 3*256 || p.X >= 4*256+48 || HerbByID(p.Herb) == nil {
			t.Fatalf("patch %+v / %+v", p, q)
		}
	}
	// Adjacent areas never share a cell.
	seen := map[uint32]bool{}
	for ax := 0; ax < 4; ax++ {
		for _, p := range PatchesIn(7, ax, 0, biome, nil) {
			if seen[p.ID] {
				t.Fatal("a cell in two areas")
			}
			seen[p.ID] = true
		}
	}
}

func TestVaultPlansAndSeals(t *testing.T) {
	w := testWorld()
	sites := PickVaultSites(w.Sites, func(r int) (float64, float64) { return 1000, 1000 }, 2)
	if len(sites) != 1 || sites[0].Kind != SiteRuin {
		t.Fatalf("vault sites %+v", sites)
	}
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		s := w.Sites[0]
		s.Index = i
		v := PlanVault(9, s)
		v2 := PlanVault(9, s)
		if !reflect.DeepEqual(v, v2) {
			t.Fatal("plan not deterministic")
		}
		seen[v.Puzzle.Key] = true
		if strings.Contains(v.Hint, "{") || v.Name == "" || len(v.Parts) != v.Puzzle.Parts {
			t.Fatalf("plan %+v", v)
		}
		sl := NewSeal(v)
		switch v.Puzzle.Key {
		case "levers":
			// Wrong first: reset.
			wrongID := 0
			for _, p := range v.Parts {
				if p.Glyph != v.Order[0] {
					wrongID = p.ID
				}
			}
			if ok, wrong := sl.Lever(wrongID); !ok || !wrong || len(sl.Pulled) != 0 {
				t.Fatal("wrong lever")
			}
			for _, g := range v.Order {
				for _, p := range v.Parts {
					if p.Glyph == g {
						sl.Lever(p.ID)
					}
				}
			}
		case "plates":
			sl.Press(1, 0)
			sl.Press(2, 5)
			if sl.Open {
				t.Fatal("open too early")
			}
			sl.Press(3, 20) // plate 1 rose at 14 s
			if sl.Open {
				t.Fatal("plates not held together")
			}
			sl.Press(1, 21)
			sl.Press(2, 21)
		case "braziers", "font":
			wrongEl := "ice"
			if v.Puzzle.Element == "ice" {
				wrongEl = "fire"
			}
			if sl.Kindle(1, wrongEl) {
				t.Fatal("wrong element lit it")
			}
			for _, p := range v.Parts {
				sl.Kindle(p.ID, v.Puzzle.Element)
			}
		}
		if !sl.Open {
			t.Fatalf("%s never opened", v.Puzzle.Key)
		}
	}
	if len(seen) != 4 {
		t.Fatalf("puzzles %v", seen)
	}
}

func TestPickEventDeterministic(t *testing.T) {
	n, night := 0, 0
	for slot := int64(0); slot < 400; slot++ {
		a, ok := PickEvent(1, slot, 77, slot%2 == 0)
		b, ok2 := PickEvent(1, slot, 77, slot%2 == 0)
		if ok != ok2 || ok && (a.Kind != b.Kind || a.Angle != b.Angle || a.Dist != b.Dist) {
			t.Fatal("pick not deterministic")
		}
		if !ok {
			continue
		}
		n++
		if a.Kind.Night {
			night++
			if slot%2 != 0 {
				t.Fatal("night event by day")
			}
		}
		sc := contentdefs.D.Events.Scheduler
		if a.Dist < sc.SpawnMinM || a.Dist > sc.SpawnMaxM {
			t.Fatal("distance")
		}
	}
	if n < 60 || n > 200 || night == 0 {
		t.Fatalf("picked %d (night %d) of 400", n, night)
	}
}
