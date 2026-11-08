package combat

import (
	"testing"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/zone/internal/combat/combatbot"
)

// bossFight runs n sword bots against a boss and returns the fight length
// (engage to kill), phases seen and whether it died within 8 minutes.
func bossFight(t *testing.T, boss string, n int) (secs float64, phases int, ok bool, s *sim) {
	s = newSim(t)
	g := s.w.TestBoss(movement.Vec3{X: 600, Z: 630}, boss, 1, combatdefs.Fire)
	for i := 0; i < n; i++ {
		s.addPlayer("bot", "sword", movement.Vec3{X: 596 + float64(i)*3, Z: 600}, 1)
	}
	var b *Enemy
	ok = s.runUntil(30*60*8, func() bool {
		for _, e := range g.Members {
			if e.IsBoss() {
				b = e
			}
		}
		if b != nil && b.Boss.Phase+1 > phases {
			phases = b.Boss.Phase + 1
		}
		return g.cleared() && b != nil
	})
	for _, o := range s.events {
		if o.Ev.Kind == EvBossDefeated {
			secs = float64(o.Ev.Value)
		}
	}
	return secs, phases, ok, s
}

func TestBossFightLength(t *testing.T) {
	for _, boss := range []string{"warden", "archon"} {
		for _, n := range []int{1, 2, 4} {
			secs, phases, ok, s := bossFight(t, boss, n)
			t.Logf("%-6s party %d: %.0f s, %d phases, downs %d, evaded %d, player hits %d", boss, n, secs, phases, s.w.Stats.Downs, s.w.Stats.Evaded, s.w.Stats.PlayerHits)
			if !ok {
				t.Errorf("%s party %d: not defeated in 8 minutes", boss, n)
				continue
			}
			if secs < 120 || secs > 300 {
				t.Errorf("%s party %d: %.0f s, spec 8 wants 2-5 minutes", boss, n, secs)
			}
			if phases < 2 || phases > 3 {
				t.Errorf("%s party %d: %d phases", boss, n, phases)
			}
		}
	}
}

// The in-process half of the acceptance: two players clear a camp, then a
// boss (the networked run is cmd/combatbots against a real zone process).
func TestPartyOfTwoClearsCampAndBoss(t *testing.T) {
	s := newSim(t)
	camp := s.w.TestGroup(movement.Vec3{X: 400, Z: 440}, []string{"cutthroat", "cutthroat", "archer", "brute"}, 1, "")
	boss := s.w.TestBoss(movement.Vec3{X: 400, Z: 560}, "warden", 1, combatdefs.Earth)
	a := s.addPlayer("alyssa", "sword", movement.Vec3{X: 398, Z: 400}, 1)
	b := s.addPlayer("bruno", "spear", movement.Vec3{X: 402, Z: 400}, 1)
	a.p.PartyID, b.p.PartyID = 7, 7
	// Phase 1: the camp. Bots fight whatever is nearest; the boss arena is
	// 120 m away, outside its aggro.
	if !s.runUntil(30*120, camp.cleared) {
		t.Fatalf("camp not cleared in 2 minutes")
	}
	campTick := s.tick
	t.Logf("camp cleared at %.1f s (downs %d)", float64(campTick)/30, s.w.Stats.Downs)
	// Regroup at a staging point 40 m from the boss (a party pulls
	// together), touch the "waypoint" there (respawn point), then pull.
	stage := movement.Vec3{X: 400, Y: 10, Z: 520}
	inArena := func(e combatbot.EnemyView) bool { return e.Pos.Z > 500 }
	for _, sp := range s.players {
		sp.brain.Goal, sp.brain.Leash = &stage, 2
		sp.brain.PreferIDs = func(combatbot.EnemyView) bool { return false }
		sp.spawn = stage
	}
	if !s.runUntil(30*60, func() bool { return hdist(a.p.Pos, stage) < 3 && hdist(b.p.Pos, stage) < 3 }) {
		t.Fatal("party never regrouped")
	}
	for _, sp := range s.players {
		sp.brain.Goal = nil
		sp.brain.PreferIDs = inArena
	}
	if !s.runUntil(30*60*6, boss.cleared) {
		for _, e := range boss.Members {
			t.Logf("boss member %s hp %.0f/%.0f state %v", e.Def.Key, e.HP, e.HPMax, e.State)
		}
		t.Logf("group %v spawns %d; players %v %v downs %d", boss, boss.spawns, a.p.Pos, b.p.Pos, s.w.Stats.Downs)
		for _, sp := range s.players {
			t.Logf("%s downed %v hp %.0f brain %v attacks %d", sp.p.Name, sp.p.Downed, sp.p.HP, sp.brain.State.Pos, sp.brain.Attacks)
		}
		t.Fatalf("boss not defeated in 6 minutes")
	}
	t.Logf("boss defeated %.1f s after the camp (downs %d); scaled for %d", float64(s.tick-campTick)/30, s.w.Stats.Downs, 2)
}
