package game

// Enemies respect buildings (playtest polish): enemy and demon movement
// (combat World.Obstacles, checked in stepMove and the demons' shadow
// step) is refused where the body would overlap a solid town box, the
// same boxes the players' movement step pushes them out of
// (server/pkg/towns, the Go half of the TS/Go collision twin), or a
// closed door.
//
// Cost: a towns.Blocker bitmask over the world (8 m squares near a solid
// box) answers "nowhere near a building" with one array read, which is
// every query of an enemy outside a town; the box index and the door
// index are only consulted inside marked squares. Enemies are kept out of
// settlements by spawn rules, so in practice only chasers and night
// demons ever pay the narrow phase. The queries run on the AI workers
// (combat par.go): everything here is read-only during the combat phase
// (door state changes on the tick goroutine, in townsTick, after it).

import (
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/towns"
)

// townCollider is a ground that carries the towns' collision index
// (server/zone/towns.go's grounds, *towns.Ground): the blocker reuses it
// instead of indexing the boxes twice.
type townCollider interface {
	TownCollision() *towns.Collision
}

type obstacleState struct {
	b *towns.Blocker
}

// initObstacles wires building collision into enemy movement (New, after
// initCombat). No towns: nothing (the hook stays nil and costs nothing).
func (s *Server) initObstacles() {
	if s.cfg.Towns == nil || s.cbt.w == nil {
		return
	}
	var c *towns.Collision
	if tc, ok := s.cfg.Ground.(townCollider); ok {
		c = tc.TownCollision()
	}
	if c == nil {
		c = towns.NewCollision(&s.cfg.Towns.T.Boxes)
	}
	s.obst.b = towns.NewBlocker(c, float64(constants.WorldSizeM))
	s.doorsInit()
	s.cbt.w.Obstacles = s.enemyBlocked
	s.log.Info("enemies respect buildings", "boxes", c.B.Len(), "maskCells", s.obst.b.Marked())
}

// enemyBlocked is combat World.Obstacles: a town box or a closed door.
func (s *Server) enemyBlocked(x, y, z, r, h float64) bool {
	b := s.obst.b
	if r <= towns.MaskCell && !b.Near(x, z) {
		return false
	}
	if b.Blocked(x, y, z, r, h) {
		return true
	}
	w := s.town.doors
	if w == nil || w.active == 0 {
		return false
	}
	var buf [16]int32
	for _, d := range w.s.Candidates(x, z, r, buf[:0]) {
		if !w.open[d] && w.s.Touches(int(d), x, y, z, r) {
			return true
		}
	}
	return false
}
