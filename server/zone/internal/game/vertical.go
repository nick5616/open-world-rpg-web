package game

// The vertical world in the zone (genVersion 3, CR 038): each entity's layer
// (surface, sky, Underground, Depths) every tick, layer tile interest, 3D
// interest clipping between layers, fall damage, lava, and the palace /
// activity hooks for the follow-up agents. Like the cave hooks these are
// optional interfaces on Config.Ground: flat and atlas-less worlds (tests,
// the G5 scale worlds) have no vertical world and nothing here runs.

import (
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/vertical"
)

// verticalWorld is a ground with the vertical world (worldhost.CaveTerrain
// with WithVertical, promoted through the towns wrapper).
type verticalWorld interface {
	LayerAt(x, y, z float64) int
	Vertical() *vertical.World
	WantVertical(x, z, r float64)
}

const (
	// layerAOIDY: entities in different layers farther apart than this
	// vertically never see each other (party exempt): a player on an island
	// 400 m up does not stream the crowd in the town below, nor the crowd it.
	layerAOIDY = 80.0
	// verticalWantRadiusM: layer tiles are wanted around players.
	verticalWantRadiusM = 48.0
)

// vertical returns the ground's vertical world, or nil (no vertical world,
// or a wasm before genVersion 3).
func (s *Server) vertical() verticalWorld {
	vw, _ := s.cfg.Ground.(verticalWorld)
	if vw == nil || vw.Vertical() == nil {
		return nil
	}
	return vw
}

// layerOf is the vertical layer of a point (0 without a vertical world).
func (s *Server) layerOf(x, y, z float64) int {
	vw := s.vertical()
	if vw == nil {
		return vertical.LayerSurface
	}
	return vw.LayerAt(x, y, z)
}

// verticalTick refreshes every entity's layer (on the workers, like
// caveSys) and feeds the layer tile cache around players.
func (s *Server) verticalTick(tick uint32) {
	vw := s.vertical()
	if vw == nil {
		return
	}
	parallelFor(len(s.ents), s.phaseWorkers(len(s.ents)), viewChunk, func(_, i int) {
		e := s.ents[i]
		p := e.Move.Pos
		e.layer = int8(vw.LayerAt(p.X, p.Y, p.Z))
	})
	for _, e := range s.ents {
		if e.Kind != proto.EntityKindPlayer || (tick+e.ID)%wantEveryTicks != 0 {
			continue
		}
		p := e.Move.Pos
		vw.WantVertical(p.X, p.Z, verticalWantRadiusM+movement.HorizontalSpeed(e.Move)*wantLookaheadS)
	}
}

// layerVisible: entities in different layers more than layerAOIDY apart
// vertically are not in each other's interest.
func layerVisible(myLayer int8, myY float64, o *entView) bool {
	if o.layer == myLayer {
		return true
	}
	return math.Abs(o.y-myY) <= layerAOIDY
}

// fallDamagePct: the share of max health a landing at impact speed v (m/s)
// costs (CR 038): nothing up to 18 m/s (a ~16 m fall), then 3.2 % per m/s,
// lethal past ~49 m/s; terminal speed is 54 m/s.
func fallDamagePct(v float64) float64 {
	if v <= fallSafeSpeed {
		return 0
	}
	return (v - fallSafeSpeed) * fallPctPerMS
}

const (
	fallSafeSpeed = 18.0
	fallPctPerMS  = 3.2
	// lavaPctPerS: Depths lava burns this share of max health per second.
	lavaPctPerS = 35.0
)
