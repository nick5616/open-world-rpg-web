package combat

import (
	"testing"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// swingAt makes one light sword swing at e (2 m straight ahead, -Z) and
// claims it; the demon is held in place so every swing is in reach.
func swingAt(t *testing.T, w *World, h *handPlayer, e *Enemy) ClaimResult {
	t.Helper()
	h.idle(30)
	e.Pos = movement.Vec3{X: h.p.Pos.X, Y: 5, Z: h.p.Pos.Z - 2}
	seq := h.frame(proto.InputFlagAttack, 0, 0)
	w.Step(w.tick + 1)
	a := h.p.Action(seq, 0)
	if a == nil {
		for i := 0; i < actionRing; i++ {
			if h.p.actions[i].Seq == seq {
				a = &h.p.actions[i]
			}
		}
	}
	if a == nil || !a.Legal {
		t.Fatalf("swing not started")
	}
	return w.Claim(h.p, claim(seq, a.ID, e.ID, w.tick, h.p.Pos))
}

func TestDemonSurvivesOrdinaryDamageAndDiesToSunsteel(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "sword")
	g := w.SpawnDemons(movement.Vec3{X: 300, Z: 298}, []string{"gloamling"}, 1)
	e := g.Members[0]
	if !e.IsDemon() || e.Demon.Rank != "lesser" {
		t.Fatal("gloamling is a lesser demon")
	}
	// Ordinary steel: 40 accepted hits, far more than its health, and it lives.
	dealt, minHP := 0, e.HPMax
	for i := 0; i < 40; i++ {
		r := swingAt(t, w, h, e)
		if !r.Accepted {
			t.Fatalf("hit %d refused: %+v", i, r)
		}
		dealt += int(r.Damage)
		minHP = min(minHP, e.HP)
		if !e.Alive() || r.Flags&FlagKilled != 0 {
			t.Fatalf("a demon died to ordinary damage after %d hits", i+1)
		}
	}
	if dealt < int(3*e.HPMax) || minHP < 1 {
		t.Fatalf("dealt %d (max %v), min hp %v", dealt, e.HPMax, minHP)
	}
	// Wounds close: a few seconds alone and it is whole again.
	for i := 0; i < 90; i++ {
		w.Step(w.tick + 1)
	}
	if e.HP < e.HPMax-1e-6 {
		t.Fatalf("regenerated to %v of %v", e.HP, e.HPMax)
	}
	// Sunsteel (combat.yaml materials.sunsteel.killsDemons): it dies in a few hits.
	if !h.p.Profile.SetMaterial(0, "sunsteel") {
		t.Fatal("set sunsteel")
	}
	hits := 0
	for e.Alive() && hits < 20 {
		r := swingAt(t, w, h, e)
		if !r.Accepted {
			t.Fatalf("sunsteel hit refused: %+v", r)
		}
		hits++
	}
	if e.Alive() || hits > 6 {
		t.Fatalf("sunsteel: alive=%v after %d hits", e.Alive(), hits)
	}
	t.Logf("ordinary: 40 hits, %d damage, min hp %.0f/%.0f, alive; sunsteel: dead in %d hits", dealt, minHP, e.HPMax, hits)
}

func TestSofteningWithSteelDoesNotHelpTheSunsteel(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "sword")
	e := w.SpawnDemons(movement.Vec3{X: 300, Z: 298}, []string{"gloamling"}, 1).Members[0]
	for i := 0; i < 8; i++ {
		swingAt(t, w, h, e)
	}
	h.p.Profile.SetMaterial(0, "sunsteel")
	r := swingAt(t, w, h, e)
	if !e.Alive() || r.Flags&FlagKilled != 0 {
		t.Fatal("one sunsteel hit after ordinary ones should not kill a fresh-seared demon")
	}
	if e.Demon.Seared <= 0 || e.Demon.Seared >= e.HPMax {
		t.Fatalf("seared %v", e.Demon.Seared)
	}
}

func TestDemonDiesToLightMagicAndTheRuleIsTheKey(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "staff")
	// The rule itself: Light spells and form, sunsteel material and arrows.
	pr := h.p.Profile
	if !KillsDemons(h.p, &Action{Spell: D.SpellByKey("glint")}) || KillsDemons(h.p, &Action{Spell: D.SpellByKey("ember_flick")}) {
		t.Fatal("Light spells kill demons, fire spells don't")
	}
	if !KillsDemons(h.p, &Action{Form: D.FormByElement(5)}) || KillsDemons(h.p, &Action{Form: D.FormByElement(0)}) {
		t.Fatal("the Light form kills demons")
	}
	sword := D.WeaponByKey("sword")
	mv := D.MoveOf(sword, "light", 0)
	if KillsDemons(h.p, &Action{Move: mv, Weapon: sword}) {
		t.Fatal("an ordinary blade doesn't")
	}
	pr.SetMaterial(0, "sunsteel")
	if !KillsDemons(h.p, &Action{Move: mv, Weapon: sword}) {
		t.Fatal("a sunsteel blade does")
	}
	pr.SetMaterial(0, "silver")
	bow := D.WeaponByKey("bow")
	pr.Loadouts[0].ArrowOre = "sunsteel"
	if KillsDemons(h.p, &Action{Move: mv, Weapon: sword}) || !KillsDemons(h.p, &Action{Move: D.MoveOf(bow, "light", 0), Weapon: bow}) {
		t.Fatal("silver doesn't kill, sunsteel arrows do")
	}
	if pr.SetMaterial(0, "cardboard") {
		t.Fatal("unknown material accepted")
	}

	// Light magic for real: Glint bolts until it dies.
	pr.SetMaterial(0, "")
	pr.Known = append(pr.Known, "glint")
	pr.Loadouts[0].Spells[0] = "glint"
	h.p.Mana, h.p.ManaMax = 1e6, 1e6
	e := w.SpawnDemons(movement.Vec3{X: 300, Z: 296}, []string{"gloamling"}, 1).Members[0]
	casts := 0
	for e.Alive() && casts < 30 {
		h.idle(30)
		e.Pos = movement.Vec3{X: 300, Y: 5, Z: 296}
		seq := h.frame(proto.InputFlagCast, 0, 0)
		w.Step(w.tick + 1)
		w.Step(w.tick + 1)
		r := w.Claim(h.p, claim(seq, D.SpellByKey("glint").ID, e.ID, w.tick, h.p.Pos))
		if !r.Accepted {
			t.Fatalf("glint refused: %+v", r)
		}
		casts++
	}
	if e.Alive() {
		t.Fatal("Light magic should kill a demon")
	}
	t.Logf("glint: dead in %d casts", casts)
}

func TestSunriseBurnsDemonsWithoutCredit(t *testing.T) {
	w, _ := newWorld()
	newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "sword")
	g := w.SpawnDemons(movement.Vec3{X: 320, Z: 300}, []string{"gloamling", "gloamling"}, 3)
	w.Drain()
	w.KillDemon(g.Members[0])
	ev, _, _, xp, _, _ := w.Drain()
	if g.Members[0].Alive() || len(xp) != 0 {
		t.Fatal("sunrise kills, no XP")
	}
	died := false
	for _, o := range ev {
		if o.Ev.Kind == EvEnemyDied && o.Ev.TargetID == 0 {
			died = true
		}
	}
	if !died {
		t.Fatal("enemy_died with no killer")
	}
	w.RemoveGroup(g)
	if len(w.Enemies()) != 0 || len(w.Groups) != 0 {
		t.Fatal("group removed")
	}
}

func TestWardsBlockDemonsAndShelterPlayers(t *testing.T) {
	w, _ := newWorld()
	h := newHand(w, 1, movement.Vec3{X: 300, Z: 300}, "sword")
	inWard := func(x, z float64) bool { return (x-300)*(x-300)+(z-300)*(z-300) < 20*20 }
	w.DemonHooks.Blocked = func(e *Enemy, x, z float64) bool { return inWard(x, z) }
	w.DemonHooks.Sheltered = func(e *Enemy, p *Player) bool { return inWard(p.Pos.X, p.Pos.Z) }
	e := w.SpawnDemons(movement.Vec3{X: 300, Z: 330}, []string{"gloamling"}, 1).Members[0]
	for i := 0; i < 30*10; i++ {
		h.p.Pos = movement.Vec3{X: 300, Y: 5, Z: 300}
		w.Step(w.tick + 1)
		if inWard(e.Pos.X, e.Pos.Z) {
			t.Fatal("demon entered the ward")
		}
	}
	if e.Target == h.p.ID && e.State == Chase {
		t.Fatal("demon still hunting a sheltered player")
	}
	// Step out: it comes.
	h.p.Pos = movement.Vec3{X: 300, Y: 5, Z: 345}
	for i := 0; i < 60; i++ {
		w.Step(w.tick + 1)
	}
	if e.Target != h.p.ID {
		t.Fatalf("demon ignores a player in the open (state %s)", e.State)
	}
}

// river is flat ground with a 12 m river across x 310..322.
type river struct{}

func (river) HeightAt(x, z float64) float64 { return 5 }
func (river) WaterAt(x, z float64) float64 {
	if x > 310 && x < 322 {
		return 7
	}
	return 0
}

func TestStuckDemonShadowStepsAcrossARiver(t *testing.T) {
	id := uint32(100)
	w := NewWorld(Config{Seed: 1, NoWildPacks: true}, river{}, func() uint32 { id++; return id })
	e := w.SpawnDemons(movement.Vec3{X: 300, Z: 300}, []string{"gloamling"}, 1).Members[0]
	goal := movement.Vec3{X: 340, Y: 5, Z: 300}
	e.Demon.Goal = &goal
	e.State = Idle
	for i := 0; i < 30*20; i++ {
		w.Step(w.tick + 1)
	}
	if e.Pos.X < 322 || e.Demon.Steps == 0 {
		t.Fatalf("demon stuck at x %.1f (steps %d)", e.Pos.X, e.Demon.Steps)
	}
}
