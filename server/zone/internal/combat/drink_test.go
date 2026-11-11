package combat

import "testing"

// Playtest 2 co-op: a draught heals the same share of the bar at any level.
func TestDrinkScalesWithHealthPool(t *testing.T) {
	base := D.Leveling.Health.Base
	if s := drinkScale(base); s != 1 {
		t.Fatalf("at the base pool: %v", s)
	}
	if s := drinkScale(base * 2.47); s < 2.46 || s > 2.48 {
		t.Fatalf("a level 12 pool: %v", s)
	}
	if s := drinkScale(base / 2); s != 1 {
		t.Fatalf("never below the written heal: %v", s)
	}
}
