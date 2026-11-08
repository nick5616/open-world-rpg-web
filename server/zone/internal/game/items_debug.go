package game

import (
	"context"
	"slices"

	"lodestone/server/pkg/proto"
	"lodestone/server/zone/internal/items"
)

// ItemsDebugInfo is the /debug/items snapshot.
type ItemsDebugInfo struct {
	Character string           `json:"character,omitempty"`
	Online    bool             `json:"online"`
	Persist   string           `json:"persist,omitempty"`
	Gold      int              `json:"gold"`
	Items     []items.WireItem `json:"items"`
	Markers   []string         `json:"markers,omitempty"`
	Journal   int              `json:"journalDepth"`
	Pending   int              `json:"pending"`
	Applied   int64            `json:"applied"`
	Pickups   int              `json:"pickups"`
	Dropped   int              `json:"droppedInWorld"`
	Rolls     int64            `json:"killRolls"`
}

// ItemsDebug snapshots a character's items (tick goroutine via Do).
func (s *Server) ItemsDebug(ctx context.Context, char string) (ItemsDebugInfo, error) {
	var out ItemsDebugInfo
	err := s.Do(ctx, func() {
		out = ItemsDebugInfo{Character: char, Items: []items.WireItem{}, Journal: s.ItemsDepth(), Pending: s.ItemsPending(char), Rolls: s.itm.loot}
		if s.itm.j != nil {
			out.Applied = s.itm.j.applied.Load()
		}
		for _, e := range s.ents {
			if e.Kind == proto.EntityKindPickup {
				out.Pickups++
				if e.drop != nil && e.drop.world {
					out.Dropped++
				}
			}
		}
		sess := s.byChar[char]
		if sess == nil || sess.items == nil {
			return
		}
		ci := sess.items
		out.Online, out.Persist, out.Gold = true, persistNames[ci.persist], ci.inv.Gold()
		for _, it := range ci.inv.Items {
			out.Items = append(out.Items, it.Wire())
		}
		for k := range ci.markers {
			out.Markers = append(out.Markers, k)
		}
		slices.Sort(out.Markers)
	})
	return out, err
}
