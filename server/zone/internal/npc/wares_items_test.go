package npc

import (
	"testing"

	"lodestone/server/pkg/itemdefs"
)

// WP14: every merchant ware and bounty delivery is a real item key
// (contracts/items.yaml), so purchases land in the inventory.
func TestWaresAreItems(t *testing.T) {
	for k, ws := range wares {
		for _, w := range ws {
			if itemdefs.D.Item(w.Item) == nil {
				t.Errorf("wares[%d]: %s is not in items.yaml", k, w.Item)
			}
		}
	}
	for _, d := range deliverItems {
		if itemdefs.D.Item(d.id) == nil {
			t.Errorf("bounty delivery %s is not in items.yaml", d.id)
		}
	}
}
