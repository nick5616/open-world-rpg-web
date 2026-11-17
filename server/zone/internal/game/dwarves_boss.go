package game

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
)

// addWarden puts the lower halls' boss at the heart of chamber c (the rune
// circle): the deep warden, a boss group with the chamber as its arena.
func (s *Server) addWarden(w *combat.World, c *vertical.Chamber) {
	x, z := c.X, c.Z
	lv := movement.AtLevel(s.cfg.Ground, c.Floor+2)
	y := lv.HeightAt(x, z)
	bd := combatdefs.D.BossByKey("deep_warden")
	if bd == nil {
		return
	}
	r := math.Min(bd.ArenaRadius, math.Min(c.Rx, c.Rz)*0.5)
	at := movement.Vec3{X: x, Y: y, Z: z}
	w.AddGroup(&combat.Group{Kind: combat.GroupBoss, Anchor: at, Radius: r, Element: 8, Level: 1, Site: -1,
		Boss: "deep_warden", AreaLevel: true, Layer: vertical.LayerUnder, Seed: c.ID,
		Arena: &combat.Arena{Center: at, Radius: r, Kind: "cave", Site: -1, System: -1, Node: c.Index}})
}

// dwarfWardenEvents (CR 043): Event 1863 `lower_halls` goes with the combat
// boss events (209 engaged, 210 defeated) of the deep warden, to the same
// audience (radius + 40 m, at least 140 m): value 0 it wakes, 1 it falls;
// EntityID = the boss entity, TargetID = the lower_halls atlas site.
func (s *Server) dwarfWardenEvents(events []combat.Out) []combat.Out {
	bd := combatdefs.D.EnemyByKey("deep_warden")
	if bd == nil || s.cfg.Explore == nil {
		return events
	}
	var extra []combat.Out
	for _, o := range events {
		if (o.Ev.Kind != combat.EvBossEngaged && o.Ev.Kind != combat.EvBossDefeated) || int(o.Ev.TargetID) != bd.ID {
			continue
		}
		site, best := -1, math.Inf(1)
		bx, bz := proto.CmToMeters(o.Ev.X), proto.CmToMeters(o.Ev.Z)
		for i := range s.cfg.Explore.Atlas.Sites {
			st := &s.cfg.Explore.Atlas.Sites[i]
			if st.Category == structures.CategoryPOI && st.Kind == structures.POILowerHalls {
				if d := math.Hypot(st.X-bx, st.Z-bz); d < best {
					site, best = i, d
				}
			}
		}
		v := int32(0)
		if o.Ev.Kind == combat.EvBossDefeated {
			v = 1
		}
		ev := proto.Event{Kind: EventLowerHalls, EntityID: o.Ev.EntityID, TargetID: uint32(max(site, 0)), Value: v, X: o.Ev.X, Y: o.Ev.Y, Z: o.Ev.Z}
		aud := o.Aud
		aud.Radius = math.Max(aud.Radius, 100) + 40
		extra = append(extra, combat.Out{Aud: aud, Ev: ev})
	}
	if len(extra) == 0 {
		return events
	}
	return append(append([]combat.Out(nil), events...), extra...)
}
