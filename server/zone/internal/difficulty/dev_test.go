package difficulty

import (
	"testing"

	"lodestone/server/pkg/combatdefs"
)

// The vibe explorer's override sits on top of what the area shows and
// clears back to exactly that: a stamp, the Haven's 1, or unknown; a stamp
// arriving meanwhile lands underneath.
func TestDevOverrideIsReversible(t *testing.T) {
	def := &combatdefs.D.Difficulty
	m := New(def, 4096, 1000, 1000, nil)
	haven := m.Cell(1000, 1000)
	stamped := m.Cell(3000, 3000)
	unknown := m.Cell(3500, 500)
	m.Set(Stamp{Cell: stamped, Level: 6, ByName: "Nicole"}, 0)

	for _, c := range []int{haven, stamped, unknown} {
		bl, bk := m.Level(c)
		bh := m.Haven(c)
		if prev, known := m.DevOverride(c, 17); prev != bl || known != bk {
			t.Fatalf("cell %d: prev %d/%v, want %d/%v", c, prev, known, bl, bk)
		}
		if l, ok := m.Level(c); l != 17 || !ok || m.Haven(c) || !m.Stamped(c) || m.DevOverridden(c) != 17 {
			t.Fatalf("cell %d overridden: %d %v haven %v", c, l, ok, m.Haven(c))
		}
		if tr, i, _ := m.Tier(c); tr.Key != "dread" || i != 4 {
			t.Fatalf("cell %d tier %s", c, tr.Key)
		}
		if m.NeedsClaim(c, 0) != (!bk) {
			t.Fatalf("cell %d: an override must not change claiming (unknown areas still get stamped)", c)
		}
		m.DevOverride(c, 0)
		if l, k := m.Level(c); l != bl || k != bk || m.Haven(c) != bh || m.DevOverridden(c) != 0 {
			t.Fatalf("cell %d cleared: %d/%v haven %v, want %d/%v haven %v", c, l, k, m.Haven(c), bl, bk, bh)
		}
	}
	// A stamp that lands under an override shows once it is cleared.
	m.DevOverride(unknown, 3)
	m.Set(Stamp{Cell: unknown, Level: 9}, 0)
	if l, _ := m.Level(unknown); l != 3 {
		t.Fatalf("override hidden by a stamp: %d", l)
	}
	m.DevOverride(unknown, 0)
	if l, _ := m.Level(unknown); l != 9 {
		t.Fatalf("the stamp under the override: %d", l)
	}
	if len(m.DevOverrides()) != 0 {
		t.Fatal("overrides left")
	}
	// Clamped to the tiers' range; Projected follows the stamp rule.
	m.DevOverride(stamped, 9999)
	if l, _ := m.Level(stamped); l != def.MaxLevel {
		t.Fatalf("clamp: %d", l)
	}
	m.DevOverride(stamped, 0)
	if p := m.Projected(m.Cell(3300, 3000), 20); p > 6+def.MaxStep || p < 6-def.MaxStep {
		t.Fatalf("projected %d beside a level-6 stamp", p)
	}
}
