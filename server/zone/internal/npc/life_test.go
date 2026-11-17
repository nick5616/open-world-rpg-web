package npc

import (
	"math"
	"testing"

	"lodestone/server/pkg/towns"
)

func hourS(h float64) float64 { return h / 24 * DayLengthS }

// counts tallies what every NPC wants at hour h.
func counts(w *World, h float64) map[int]int {
	out := map[int]int{}
	for i := range w.NPCs {
		out[w.Want(i, hourS(h))]++
	}
	return out
}

func TestLunchEveningMarketHours(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)

	// Lunch: some villagers and farmers are at the inn at 13:00, none at 11:00.
	lunch := 0
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		if w.Want(i, hourS(13)) == GoalInn {
			lunch++
			if d.Role != towns.RoleVillager && d.Role != towns.RoleFarmer {
				t.Errorf("npc %d (%s) goes to lunch at the inn", i, towns.RoleNames[d.Role])
			}
		}
		if w.Want(i, hourS(11)) == GoalInn {
			t.Errorf("npc %d wants the inn at 11:00", i)
		}
	}
	if lunch < 10 {
		t.Fatalf("only %d NPCs lunch at the inn at 13:00", lunch)
	}

	// Evening: a gathering at the square, a few at the inn, the rest home; everyone home by 21:00.
	ev := counts(w, 19.5)
	if ev[GoalSquare] < 15 || ev[GoalInn] < 5 || ev[GoalHome] < 20 {
		t.Fatalf("evening at 19:30: square %d inn %d home %d", ev[GoalSquare], ev[GoalInn], ev[GoalHome])
	}
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		g := w.Want(i, hourS(21.2))
		if d.Role != towns.RoleInnkeeper && d.Role != towns.RoleGuard && g != GoalHome {
			t.Fatalf("npc %d (%s) is not home at 21:12 (goal %d)", i, towns.RoleNames[d.Role], g)
		}
		if w.Want(i, hourS(3)) != GoalHome && d.Role != towns.RoleInnkeeper && d.Role != towns.RoleGuard {
			t.Fatalf("npc %d is up at 03:00", i)
		}
	}
	t.Logf("13:00: %d at the inn; 19:30: %v", lunch, ev)

	// Market hours: merchants keep stall 08:00-18:00, not at 07:30 or 18:30.
	merchants := 0
	for i := range w.NPCs {
		if w.NPCs[i].Def.Role != towns.RoleMerchant {
			continue
		}
		merchants++
		if w.Works(i, 7.5) || !w.Works(i, 8.5) || !w.Works(i, 17.5) || w.Works(i, 18.5) {
			t.Fatalf("merchant %d hours wrong", i)
		}
	}
	if merchants == 0 {
		t.Fatal("no merchants in the world")
	}
}

func TestGuardBeatsVisitsAndBenchesVary(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)
	beats, posts, guards := 0, 0, 0
	visits, steps, wanders := 0, 0, 0
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		for s := 0; s < 4; s++ { // 10:00-12:00 in 75 s stretches (before lunch)
			g := w.Want(i, hourS(10)+float64(s)*stretchS)
			switch d.Role {
			case towns.RoleGuard:
				if g == GoalBeat {
					beats++
				} else if g == GoalWork {
					posts++
				} else {
					t.Fatalf("guard %d goal %d", i, g)
				}
			case towns.RoleVillager:
				switch g {
				case GoalVisit:
					visits++
				case GoalStep:
					steps++
				case GoalWander:
					wanders++
				default:
					t.Fatalf("villager %d goal %d at 10:00", i, g)
				}
			}
		}
		if d.Role == towns.RoleGuard {
			guards++
		}
	}
	t.Logf("%d guards: %d beat stretches vs %d at the post; villagers: %d visits, %d doorstep rests, %d wanders", guards, beats, posts, visits, steps, wanders)
	if guards == 0 || beats == 0 || posts <= beats {
		t.Fatalf("guard beats %d, posts %d", beats, posts)
	}
	if visits == 0 || steps == 0 || wanders <= visits {
		t.Fatalf("visits %d steps %d wanders %d", visits, steps, wanders)
	}
	if float64(visits)/float64(visits+steps+wanders) < 0.12 || float64(visits)/float64(visits+steps+wanders) > 0.35 {
		t.Fatalf("a day-shift villager visits neighbours %d of %d stretches", visits, visits+steps+wanders)
	}
}

func TestRainSendsVillagersIndoorsOnly(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)
	w.Rain = true
	for i := range w.NPCs {
		d := w.NPCs[i].Def
		g := w.Want(i, hourS(10))
		switch d.Role {
		case towns.RoleVillager, towns.RoleFarmer:
			if g != GoalHome {
				t.Fatalf("%s %d stays out in the rain (goal %d)", towns.RoleNames[d.Role], i, g)
			}
		case towns.RoleMerchant, towns.RoleBlacksmith, towns.RoleBounty:
			if g != GoalWork {
				t.Fatalf("%s %d leaves its post in the rain (goal %d)", towns.RoleNames[d.Role], i, g)
			}
		}
	}
	// And the square gathering moves into the inn.
	if c := counts(w, 19.5); c[GoalSquare] != 0 || c[GoalInn] == 0 {
		t.Fatalf("rainy evening: %v", c)
	}
}

// TestLifeGoalsReachTheirPlaces walks every NPC to each new goal and checks it
// arrives (inside the inn, at the square, at the beat point, near the bench or
// neighbour) within ten minutes, along streets and through doors.
func TestLifeGoalsReachTheirPlaces(t *testing.T) {
	tw := officialTowns(t)
	w := New(tw, 20261108, nil)
	type probe struct {
		h    float64
		goal int
	}
	for _, p := range []probe{{13, GoalInn}, {19.5, GoalSquare}, {19.5, GoalInn}} {
		walkers, arrived := 0, 0
		for i := range w.NPCs {
			d := w.NPCs[i].Def
			if w.Want(i, hourS(p.h)) != p.goal {
				continue
			}
			// Start where the NPC was an hour earlier (at work or at home).
			w.Place(i, hourS(p.h-1.0), flat, flatSurface)
			walkers++
			t0 := hourS(p.h)
			for k := 0; k < 30*900 && !(w.NPCs[i].At && w.NPCs[i].Goal == p.goal); k++ {
				w.Step(i, t0+float64(k)/30, 1.0/30, flat)
			}
			s := w.NPCs[i]
			if !(s.At && s.Goal == p.goal) {
				continue
			}
			pt := w.lifePoint(i, p.goal, t0)
			if math.Hypot(s.X-pt[0], s.Z-pt[1]) > 0.05 {
				continue
			}
			if p.goal == GoalInn && !inside(&tw.Buildings[w.ex[i].inn], s.X, s.Z, 0.1) {
				t.Errorf("npc %d (%s) at the inn spot is outside the inn", i, towns.RoleNames[d.Role])
				continue
			}
			arrived++
		}
		t.Logf("goal %d at %.1f h: %d of %d arrived", p.goal, p.h, arrived, walkers)
		if walkers == 0 || arrived != walkers {
			t.Fatalf("goal %d: %d of %d arrived", p.goal, arrived, walkers)
		}
	}
	// Beats, visits and doorstep rests: arrive within their stretch (75 s).
	for _, g := range []int{GoalBeat, GoalVisit, GoalStep} {
		walkers, arrived := 0, 0
		for i := range w.NPCs {
			var tod float64
			found := false
			for k := 0; k < 80 && !found; k++ {
				tod = hourS(10) + float64(k)*stretchS
				found = w.Want(i, tod) == g
			}
			if !found {
				continue
			}
			w.Place(i, tod-1, flat, flatSurface)
			walkers++
			for k := 0; k < 30*74; k++ {
				w.Step(i, tod+float64(k)/30, 1.0/30, flat)
			}
			s := w.NPCs[i]
			if s.At && s.Goal == g && math.Hypot(s.X-s.target[0], s.Z-s.target[1]) < 0.05 {
				arrived++
			}
		}
		t.Logf("goal %d: %d of %d arrived within their stretch", g, arrived, walkers)
		if walkers == 0 || float64(arrived) < 0.9*float64(walkers) {
			t.Fatalf("goal %d: %d of %d arrived", g, arrived, walkers)
		}
	}
}

func TestDuskLineDeterministicAndVaried(t *testing.T) {
	seen := map[string]bool{}
	for night := int64(0); night < 40; night++ {
		a := DuskLine(3, night)
		if a == "" || a != DuskLine(3, night) {
			t.Fatalf("night %d: %q", night, a)
		}
		seen[a] = true
	}
	if len(seen) < 3 {
		t.Fatalf("only %d distinct dusk calls over 40 nights", len(seen))
	}
}

// BenchmarkStepActiveTown steps every NPC of the largest settlement once per
// iteration (one zone tick of townsTick for one awake town) at midday; the
// per-tick cost must stay flat against the pre-CR-050 schedule.
func BenchmarkStepActiveTown(b *testing.B) {
	tw := officialTowns(b)
	w := New(tw, 20261108, nil)
	si, n := 0, 0
	for i := range tw.Settlements {
		if tw.Settlements[i].NPCs > n {
			si, n = i, tw.Settlements[i].NPCs
		}
	}
	st := &tw.Settlements[si]
	for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
		w.Place(i, hourS(10), flat, flatSurface)
	}
	b.ResetTimer()
	tod := hourS(10)
	for k := 0; k < b.N; k++ {
		tod += 1.0 / 30
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			w.Step(i, tod, 1.0/30, flat)
		}
	}
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/float64(st.NPCs), "ns/npc-tick")
}
