package combatbot

import (
	"testing"

	"lodestone/server/pkg/movement"
)

// G4: a bot leashed to a goal (the night bots at a ward garden) must fight
// what reaches the goal, not lock onto an enemy far outside its leash that
// it can never reach (it used to stick to an older demon pack asleep 160 m
// away and stand at the leash edge with 0 attacks for a whole defense).
func TestLeashedBotIgnoresEnemiesBeyondItsLeash(t *testing.T) {
	g := movement.Flat{}
	goal := movement.Vec3{X: 0, Z: 0}
	b := New("Ana", "sword", g, movement.NewState(movement.Vec3{X: 0, Z: 0}))
	b.Goal, b.Leash = &goal, 40
	far := EnemyView{ID: 1, Pos: movement.Vec3{X: 160, Z: 0}, HPPct: 100}
	if tg := b.pickTarget([]EnemyView{far}); tg != nil {
		t.Fatalf("picked enemy %d %.0f m beyond a 40 m leash", tg.ID, far.Pos.X)
	}
	near := EnemyView{ID: 2, Pos: movement.Vec3{X: 1.5, Z: 0}, HPPct: 100}
	tg := b.pickTarget([]EnemyView{far, near})
	if tg == nil || tg.ID != 2 {
		t.Fatalf("want the enemy at the goal, got %+v", tg)
	}
	attacks := b.Attacks
	for i := 0; i < 30; i++ {
		b.Step([]EnemyView{far, near}, uint32(i))
	}
	if b.Attacks == attacks {
		t.Fatal("never attacked the enemy at its goal")
	}
	// Unleashed bots (no goal) still take the nearest enemy anywhere.
	u := New("Bo", "sword", g, movement.NewState(movement.Vec3{}))
	if tg := u.pickTarget([]EnemyView{far}); tg == nil || tg.ID != 1 {
		t.Fatalf("unleashed bot: %+v", tg)
	}
}
