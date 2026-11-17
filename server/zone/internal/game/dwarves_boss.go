package game

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
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
