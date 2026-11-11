package game

// The vertical world in the zone (genVersion 3, CR 038): each entity's layer
// (surface, sky, Underground, Depths) every tick, layer tile interest, 3D
// interest clipping between layers, fall damage, lava, and the palace /
// activity hooks for the follow-up agents. Like the cave hooks these are
// optional interfaces on Config.Ground: flat and atlas-less worlds (tests,
// the G5 scale worlds) have no vertical world and nothing here runs.

import (
	"math"

	"lodestone/server/pkg/constants"
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
	s.payFalls()
	vw := s.vertical()
	if vw == nil {
		return
	}
	defer s.lavaTick()
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

// verticalUpdraft is the vertical world's wind columns (nil without one).
func (s *Server) verticalUpdraft() movement.UpdraftField {
	vw := s.vertical()
	if vw == nil || len(vw.Vertical().Updrafts) == 0 {
		return nil
	}
	return vertical.Updrafts(vw.Vertical().Updrafts)
}

// Entity.layer values.
const (
	layerSky    = int8(vertical.LayerSky)
	layerUnder  = int8(vertical.LayerUnder)
	layerDepths = int8(vertical.LayerDepths)
)

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

// Event kinds and Interact targets of the vertical world (CR 038,
// contracts/events.md 1700-1719, Interact 150-151).
const (
	EventFallDamage   = 1700
	EventLava         = 1701
	EventPalaceDoor   = 1702
	EventActivitySpot = 1703

	InteractPalace   = 150
	InteractActivity = 151
)

// noteLanding (input workers, own entity only): a step that went from the
// air to the ground remembers its impact speed. Glides, climbs, dashes,
// swims (water landings) and riders (thrown by the steed instead) never count.
func (e *Entity) noteLanding(prev movement.State) {
	if prev.Mode != movement.ModeAir || e.Move.Mode != movement.ModeGround {
		return
	}
	if prev.Dash > 0 || prev.Flags&movement.FlagMounted != 0 {
		return
	}
	if v := -prev.Vel.Y; v > fallSafeSpeed && v > e.fallHit {
		e.fallHit = v
	}
}

// payFalls (tick goroutine) charges the landings of this tick's frames:
// health (no armor), Event 1700 to the player with the damage and the speed.
func (s *Server) payFalls() {
	for _, e := range s.ents {
		v := e.fallHit
		if v == 0 {
			continue
		}
		e.fallHit = 0
		if e.cbt == nil || s.cbt.w == nil {
			continue
		}
		dealt := s.cbt.w.HurtByEnvironment(e.cbt, fallDamagePct(v))
		if dealt <= 0 {
			continue
		}
		p := e.Move.Pos
		s.sendEventTo(e, &proto.Event{Kind: EventFallDamage, EntityID: e.ID, Value: int32(dealt), TargetID: uint32(math.Round(v * 10)), X: cm(p.X), Y: cm(p.Y), Z: cm(p.Z)})
	}
}

// inLavaAt: feet in the Depths' lava (standing in it or swimming in it).
func (s *Server) inLavaAt(e *Entity) bool {
	if e.layer != vertical.LayerDepths {
		return false
	}
	p := e.Move.Pos
	g := movement.AtLevel(s.cfg.Ground, p.Y)
	lava := movement.WaterAt(g, p.X, p.Z)
	return lava > g.HeightAt(p.X, p.Z)+0.05 && p.Y <= lava+0.05
}

// lavaTick: players in the Depths' lava burn (lavaPctPerS of max health a
// second); Event 1701 value 1 / 0 when it starts and stops.
func (s *Server) lavaTick() {
	if s.cbt.w == nil {
		return
	}
	pct := lavaPctPerS / float64(constants.TickRateHz)
	for _, e := range s.ents {
		if e.Kind != proto.EntityKindPlayer {
			continue
		}
		in := s.inLavaAt(e)
		if in != e.inLava {
			e.inLava = in
			v := int32(0)
			if in {
				v = 1
			}
			s.sendEventTo(e, &proto.Event{Kind: EventLava, EntityID: e.ID, Value: v})
		}
		if in && e.cbt != nil {
			s.cbt.w.HurtByEnvironment(e.cbt, pct)
		}
	}
}

// verticalInteract: the hooks the follow-up agents build on. Interact 150
// (target = the sky palace's atlas site index, action 1 = open the doors)
// answers Event 1702 (value 0 = the doors are sealed; the palace agent
// replaces this with the instanced interior). Interact 151 (target = an
// ACTIVITY prop's stable id in a sky town square, towns prop kind 31,
// action 1 = use) answers Event 1703 (value 0 = nothing here yet; the
// activities agent starts its challenge here). Both check reach.
func (s *Server) verticalInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	p := e.Move.Pos
	switch m.TargetKind {
	case InteractPalace:
		vw := s.vertical()
		if vw == nil {
			return
		}
		site := int(m.TargetID)
		for _, d := range vw.Vertical().Decos {
			if d.Kind != decoPalace || d.Aux != site {
				continue
			}
			if math.Hypot(p.X-d.X, p.Z-d.Z) > d.Size+30 || math.Abs(p.Y-d.Y) > 40 {
				return
			}
			s.sendEvent(sess, &proto.Event{Kind: EventPalaceDoor, EntityID: e.ID, TargetID: uint32(site), Value: 0, X: cm(d.X), Y: cm(d.Y), Z: cm(d.Z)})
			return
		}
	case InteractActivity:
		if s.cfg.Towns == nil {
			return
		}
		x, y, z, ok := s.cfg.Towns.PropAt(m.TargetID, propActivity)
		if !ok || math.Hypot(p.X-x, p.Z-z) > 6 || math.Abs(p.Y-y) > 4 {
			return
		}
		s.sendEvent(sess, &proto.Event{Kind: EventActivitySpot, EntityID: e.ID, TargetID: uint32(m.TargetID), Value: 0, X: cm(x), Y: cm(y), Z: cm(z), Data: binaryID(m.TargetID)})
	}
}

const (
	decoPalace   = 16 // worldgen vertical dk::PALACE
	propActivity = 31 // towns pk::ACTIVITY
)

func binaryID(id uint64) []byte {
	b := make([]byte, 8)
	for i := 0; i < 8; i++ {
		b[i] = byte(id >> (8 * i))
	}
	return b
}

// skyTown: settlement si stands on a sky island (CR 038). Story, content
// and quest picks leave sky towns out so every existing sequence stays.
func (s *Server) skyTown(si int) bool {
	w := s.cfg.Towns
	if w == nil || s.cfg.Ground == nil {
		return false
	}
	if s.skyTowns == nil {
		s.skyTowns = make([]int8, len(w.T.Settlements))
	}
	if si < 0 || si >= len(s.skyTowns) {
		return false
	}
	if s.skyTowns[si] == 0 {
		s.skyTowns[si] = 1
		if w.SkySettlement(si, s.cfg.Ground.HeightAt) {
			s.skyTowns[si] = 2
		}
	}
	return s.skyTowns[si] == 2
}
