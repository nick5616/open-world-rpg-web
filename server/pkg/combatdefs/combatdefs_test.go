package combatdefs

import (
	"testing"

	"lodestone/server/pkg/constants"
)

// The generator already refuses tables that break the feel targets; these
// tests re-check the loaded tables from the Go side so the zone can never
// run with a stale or hand-edited JSON.
func TestFeelTargetsInTables(t *testing.T) {
	ms := func(steps int) float64 { return float64(steps) * 1000 / float64(D.StepHz) }
	for _, m := range D.Moves {
		if m.Kind != "light" {
			continue
		}
		if ms(m.StartupSteps) > constants.LightStartupMaxMs {
			t.Errorf("%s: startup %.0f ms > %d", m.Key, ms(m.StartupSteps), constants.LightStartupMaxMs)
		}
		if ms(m.RecoverySteps) > constants.LightRecoveryMaxMs {
			t.Errorf("%s: recovery %.0f ms > %d", m.Key, ms(m.RecoverySteps), constants.LightRecoveryMaxMs)
		}
	}
	for _, a := range D.EnemyAttacks {
		if w := ms(a.WindupSteps); w < constants.EnemyWindupMinMs || w > constants.EnemyWindupMaxMs {
			t.Errorf("%s: wind-up %.0f ms outside %d..%d", a.Key, w, constants.EnemyWindupMinMs, constants.EnemyWindupMaxMs)
		}
	}
}

func TestLookupsAndNames(t *testing.T) {
	if D.StepHz != constants.MoveStepHz {
		t.Fatalf("stepHz %d != MOVE_STEP_HZ %d", D.StepHz, constants.MoveStepHz)
	}
	for _, s := range D.Spells {
		if D.Names[s.Key] == "" || s.Name != D.Names[s.Key] {
			t.Errorf("spell %s: name %q not from the name table", s.Key, s.Name)
		}
		if D.SpellByID(s.ID) == nil || D.SpellByKey(s.Key).ID != s.ID {
			t.Errorf("spell %s: lookup", s.Key)
		}
	}
	for i := range D.Weapons {
		if len(D.WeaponMoves(&D.Weapons[i])) == 0 {
			t.Errorf("weapon %s has no moves", D.Weapons[i].Key)
		}
	}
	// The four ported trees and the four new ones (spec 8: each new tree has
	// a mobility spell, core spells, a domain and a pinnacle).
	for _, k := range []string{"fire", "ice", "dark", "earth", "lightning", "wind", "light", "void"} {
		tr := D.TreeByKey(k)
		if tr == nil {
			t.Fatalf("tree %s missing", k)
		}
		var mob, domain, core int
		for _, n := range tr.Nodes {
			s := D.SpellByKey(n.Key)
			switch s.Type {
			case "mobility":
				mob++
			case "domain":
				domain++
			case "passive", "defensive":
			default:
				core++
			}
		}
		if mob == 0 {
			t.Errorf("tree %s has no mobility spell", k)
		}
		if domain == 0 && (k == "lightning" || k == "wind" || k == "light" || k == "void") {
			t.Errorf("new tree %s has no domain", k)
		}
		if core < 3 {
			t.Errorf("tree %s has %d core spells", k, core)
		}
	}
}

func TestElementMult(t *testing.T) {
	cases := []struct {
		a, d int
		want float64
	}{
		{Fire, Ice, 1.5}, {Ice, Fire, 1}, {Fire, Fire, 0.5}, {Earth, Lightning, 1.5}, {Light, Dark, 1.5}, {Dark, Light, 1.5},
		{Void, Fire, 1.2}, {Void, Void, 0.5}, {Physical, Fire, 1}, {Fire, Physical, 1},
	}
	for _, c := range cases {
		if got := D.ElementMult(c.a, c.d); got != c.want {
			t.Errorf("ElementMult(%d,%d) = %v want %v", c.a, c.d, got, c.want)
		}
	}
}

func TestTypeIDRoundTrip(t *testing.T) {
	for _, c := range [][3]int{{1, Physical, 0}, {30, Fire, 2}, {100, Void, AffixBoss}, {255, Ice, 3}} {
		id, el, af := UnpackTypeID(TypeID(c[0], c[1], c[2]))
		if id != c[0] || el != c[1] || af != c[2] {
			t.Errorf("%v -> %d %d %d", c, id, el, af)
		}
	}
}

func TestSkillCurve(t *testing.T) {
	if D.SkillLevel(0) != 1 || D.SkillLevel(D.XPForLevel(10)) != 10 || D.SkillLevel(D.XPForLevel(10)-1) != 9 {
		t.Fatal("skill curve")
	}
	if D.SkillLevel(1<<40) != 100 {
		t.Fatal("cap 100")
	}
}
