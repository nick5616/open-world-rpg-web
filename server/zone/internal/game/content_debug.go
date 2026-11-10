package game

import (
	"lodestone/server/zone/internal/content"
)

// ContentDebug is GET /debug/content (tick goroutine via Do): the sealed
// vault plans and live phases, live world events, lore tablet places and
// every settlement's quest givers (tools, the evidence harness).
func (s *Server) ContentDebug() map[string]any {
	cw := s.contentWorld()
	var tablets []map[string]any
	for _, si := range s.cnt.tabSite {
		p, _ := s.tabletPos(si)
		tablets = append(tablets, map[string]any{"site": si, "tablet": s.cnt.tablets[si], "x": p.X, "y": p.Y, "z": p.Z, "name": s.cfg.Explore.Atlas.Sites[si].Name})
	}
	var givers []map[string]any
	if cw != nil {
		for i := range cw.Towns {
			t := &cw.Towns[i]
			for _, g := range content.Givers(cw.Seed, t) {
				n := t.NPC(g)
				kind := ""
				if o := content.SideQuest(cw, t, g, 0, 0); o != nil {
					kind = o.Kind
				}
				givers = append(givers, map[string]any{"town": t.Index, "townName": t.Name, "npc": g, "name": n.Name, "role": n.Role, "x": n.X, "z": n.Z, "first": kind})
			}
		}
	}
	return map[string]any{"vaults": s.VaultDebug(), "events": s.WorldEventsDebug(), "tablets": tablets, "givers": givers}
}
