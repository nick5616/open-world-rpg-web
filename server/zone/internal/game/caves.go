package game

// Caves in the zone (WP09): the cave-aware ground, cave cell interest,
// underground interest clipping (spec 9) and WorldEdits delivery. Like the
// WP07 terrain hooks these are optional interfaces on Config.Ground, so
// tests and flat ground need nothing new.

import (
	"context"
	"math"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// caveWorld is a ground with caves (worldhost.CaveTerrain).
type caveWorld interface {
	movement.CaveGround
	CaveGraph() *caves.Graph
	SetEdit(caves.Edit)
	RemoveEdit(veinID uint64)
	InCave(x, y, z float64) bool
	SystemAt(x, y, z float64) int
	NearMouth(x, z, r float64) int
	WantCaves(x, y, z, r float64)
}

const (
	// Cave cells are wanted for players underground or within this of an
	// opening; the client meshes within ~96 m (spec 7), the server only
	// needs what players can touch in the next few seconds.
	caveWantNearMouthM = 64
	caveWantRadiusM    = 48
	// mouthAOIM: underground, you still see people standing at your
	// system's openings (spec 9: "clipped to the current cave system plus
	// its mouths"), and they see you.
	mouthAOIM = 48
	// editChunkRadius: WorldEdits are sent for chunks within this many
	// chunks of a player (5 x 5 chunks = 320 m square, past the client's
	// 96 m cave meshing radius).
	editChunkRadius = 2
	editEveryTicks  = constants.TickRateHz / 2
)

func (s *Server) caves() caveWorld {
	cw, _ := s.cfg.Ground.(caveWorld)
	return cw
}

// caveTick feeds the cave cell cache and refreshes each entity's cave
// system (used by interest clipping this tick).
func (s *Server) caveTick(tick uint32) {
	cw := s.caves()
	if cw == nil {
		return
	}
	for _, e := range s.ents {
		p := e.Move.Pos
		e.caveSys = cw.SystemAt(p.X, p.Y, p.Z)
		if e.Kind != proto.EntityKindPlayer || (tick+e.ID)%wantEveryTicks != 0 {
			continue
		}
		if e.caveSys >= 0 || cw.InCave(p.X, p.Y, p.Z) || cw.NearMouth(p.X, p.Z, caveWantNearMouthM) >= 0 {
			cw.WantCaves(p.X, p.Y, p.Z, caveWantRadiusM+movement.HorizontalSpeed(e.Move)*wantLookaheadS)
		}
	}
}

// caveVisible applies underground interest clipping: a viewer in cave
// system S sees entities in S and on the surface near S's openings; a
// viewer on the surface sees cave dwellers only from near their system's
// openings. Party members are exempt (the party ring shows them anywhere).
func (s *Server) caveVisible(cw caveWorld, viewer, o *Entity) bool {
	if viewer.caveSys == o.caveSys {
		return true
	}
	g := cw.CaveGraph()
	near := func(sys int, e *Entity) bool {
		if sys < 0 || sys >= len(g.Systems) {
			return false
		}
		for _, op := range g.SystemOpenings(sys) {
			if math.Hypot(e.Move.Pos.X-op.X, e.Move.Pos.Z-op.Z) <= mouthAOIM {
				return true
			}
		}
		return false
	}
	switch {
	case viewer.caveSys >= 0 && o.caveSys < 0:
		return near(viewer.caveSys, o)
	case viewer.caveSys < 0 && o.caveSys >= 0:
		return near(o.caveSys, viewer)
	}
	return false // two different systems
}

// Do runs f on the tick goroutine (before the tick's terrain, cave and
// snapshot phases) and waits for it. For debug endpoints and tests that
// read or poke simulation state.
func (s *Server) Do(ctx context.Context, f func()) error {
	done := make(chan struct{})
	select {
	case s.calls <- func() { f(); close(done) }:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// MiningStatus snapshots mining state (tick goroutine via Do).
func (s *Server) MiningStatus(ctx context.Context) (MiningStatus, error) {
	var st MiningStatus
	err := s.Do(ctx, func() { st = s.miningStatus() })
	return st, err
}
