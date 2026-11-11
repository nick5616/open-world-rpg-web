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
	"lodestone/server/pkg/camps"
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

// navDoorChanged tells enemy pathfinding (combat nav.go) that door d opened
// or closed: the grid around its doorway is sampled again. Tick goroutine,
// where the settled state changes (outside the combat phase).
func (s *Server) navDoorChanged(d int) {
	w := s.town.doors
	if s.cbt.w == nil || w == nil || d < 0 || d >= len(w.s.D) {
		return
	}
	dr := &w.s.D[d]
	r := dr.Width/2 + dr.Thick + 0.5
	s.cbt.w.NavInvalidate(dr.X-r, dr.Z-r, dr.X+r, dr.Z+r)
}

// navCampsChanged: the solid camp pieces were rebuilt (CR 025); the grid
// around every piece placed or picked up since the last set is sampled
// again.
func (s *Server) navCampsChanged(old, now []camps.SolidPiece) {
	if s.cbt.w == nil {
		return
	}
	const r = 3.0 // m: the largest solid piece's half extent with margin
	was := make(map[camps.SolidPiece]bool, len(old))
	for _, p := range old {
		was[p] = true
	}
	is := make(map[camps.SolidPiece]bool, len(now))
	for _, p := range now {
		is[p] = true
		if !was[p] {
			s.cbt.w.NavInvalidate(p.X-r, p.Z-r, p.X+r, p.Z+r)
		}
	}
	for _, p := range old {
		if !is[p] {
			s.cbt.w.NavInvalidate(p.X-r, p.Z-r, p.X+r, p.Z+r)
		}
	}
}

// enemyBlocked is combat World.Obstacles: a town box or a closed door.
func (s *Server) enemyBlocked(x, y, z, r, h float64) bool {
	if s.camp.set.Blocked(x, y, z, r, h) {
		return true // CR 025: solid camp pieces (camps.go; the set is replaced, never mutated, on the tick)
	}
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
