package game

import (
	"testing"

	"lodestone/server/zone/internal/dialog"
)

// Playtest 5 (CR 055): "Marking on your map didn't work for pointing out
// where the horse stables are": the pin was an unnamed purple drop. A marked
// place now carries what it is.
func TestDialogPinLabel(t *testing.T) {
	cases := []struct {
		kind, name, want string
	}{
		{dialog.KindStable, "Kudrogair", "Stables, Kudrogair"},
		{dialog.KindTower, "The Spire", "Tower, The Spire"},
		{dialog.KindFish, "the place", "Fishing spot"},
		{dialog.KindCave, "Mossbound Hollow", "Mossbound Hollow"},
	}
	for _, c := range cases {
		if got := dialogPinLabel(dialog.Site{Kind: c.kind}, c.name); got != c.want {
			t.Errorf("%s: %q, want %q", c.kind, got, c.want)
		}
	}
}
