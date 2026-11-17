package game

// The vertical world in the zone (genVersion 3, CR 038): each entity's layer
// (surface, sky, Underground, Depths) every tick, layer tile interest, 3D
// interest clipping between layers, fall damage, lava, and the palace /
// activity hooks for the follow-up agents. Like the cave hooks these are
// optional interfaces on Config.Ground: flat and atlas-less worlds (tests,
// the G5 scale worlds) have no vertical world and nothing here runs.

import (
	"math"

	"lodestone/server/pkg/caves"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/vertical"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
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
	return vertical.Wind{W: vw.Vertical()}
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
	// depthsLootLuck multiplies the rarity luck of a Depths kill (on top of
	// the deep-cave luck and an elite's).
	depthsLootLuck = 2.5
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

// layerSafeM: no pack within this of an underground camp (a layer waypoint).
const layerSafeM = 45.0

// addLayerGroups adds the vertical world's enemy packs to the combat world
// (after the atlas groups, so every surface group keeps its id): on dry,
// walkable cavern and Depths floors away from camps and columns (1-5 per
// chamber by size), and on the sky islands that are not a town or a palace.
// Their composition comes from combat.LayerTables, their level and tier
// from the layer's area (internal/difficulty floors); they spawn, wake and
// walk in 3D on their layer's floor.
func (s *Server) addLayerGroups(w *combat.World) {
	vw := s.vertical()
	if vw == nil {
		return
	}
	v := vw.Vertical()
	g := s.cfg.Ground
	var camps []movement.Vec3
	if a := w.Atlas; a != nil {
		for i := range a.Sites {
			st := &a.Sites[i]
			if st.Layer >= vertical.LayerUnder && st.Category == structures.CategoryPOI && st.Kind == structures.POIWaypoint {
				camps = append(camps, movement.Vec3{X: st.X, Y: st.Y, Z: st.Z})
			}
		}
	}
	var placed []*combat.Group
	clear := func(layer int, x, y, z float64) bool {
		for _, c := range camps {
			if math.Hypot(c.X-x, c.Z-z) < layerSafeM && math.Abs(c.Y-y) < 40 {
				return false
			}
		}
		for i := range v.Columns {
			c := &v.Columns[i]
			if c.Layer == layer && math.Hypot(c.X-x, c.Z-z) < c.R+4 {
				return false
			}
		}
		for _, o := range placed {
			if math.Hypot(o.Anchor.X-x, o.Anchor.Z-z) < 40 && math.Abs(o.Anchor.Y-y) < 40 {
				return false
			}
		}
		return true
	}
	var halls []movement.Vec3 // dwarven halls (camps and strongholds): no packs, Z = reach
	for i := range v.Chambers {
		if c := &v.Chambers[i]; c.Kind == vertical.ChamberDwarfCamp || c.Kind == vertical.ChamberStronghold {
			halls = append(halls, movement.Vec3{X: c.X, Y: c.Floor, Z: math.Max(c.Rx, c.Rz) + 12})
		}
	}
	inHall := func(x, y, z float64) bool {
		for _, h := range halls {
			if math.Hypot(h.X-x, h.Z-z) < h.Z && math.Abs(h.Y-y) < 70 {
				return true
			}
		}
		return false
	}
	add := func(layer int, x, z, from float64, seed uint64, comp []string) bool {
		lv := movement.AtLevel(g, from)
		y := lv.HeightAt(x, z)
		if vw.LayerAt(x, y, z) != layer && layer != vertical.LayerSky {
			return false
		}
		if movement.WaterAt(lv, x, z) > y-0.2 || movement.SlopeAt(lv, x, z).T2 > constants.WalkableTanSq || !clear(layer, x, y, z) || inHall(x, y, z) {
			return false
		}
		gr := w.AddGroup(&combat.Group{Kind: combat.GroupPack, Anchor: movement.Vec3{X: x, Y: y, Z: z}, Radius: 9, Element: 8, Level: 1, Site: -1,
			Seed: seed, AreaLevel: true, Layer: layer, Comp: comp})
		placed = append(placed, gr)
		return true
	}
	for i := range v.Chambers {
		c := &v.Chambers[i]
		if c.Kind == vertical.ChamberDwarfCamp || c.Kind == vertical.ChamberStronghold {
			continue // CR 043: the dwarves' halls are safe (no packs)
		}
		want := min(5, 1+int(c.Rx*c.Rz/9000))
		comp := combat.LayerTables[c.Layer]
		if c.Layer == vertical.LayerUnder {
			comp = combat.UnderComp(c.Floor)
		}
		if c.Kind == vertical.ChamberLowerHalls {
			want, comp = 7, combat.LowerHallsComp // the old mines: dense and dangerous
		}
		got := 0
		for k := 0; k < want*12 && got < want; k++ {
			h := content.Mix(c.ID ^ uint64(k+1)*0x9E3779B97F4A7C15)
			e := 0.22 + 0.58*float64(h>>11)/float64(1<<53)
			th := 2 * math.Pi * float64(content.Mix(h)>>11) / float64(1<<53)
			u, vv := c.Rx*e*math.Cos(th), c.Rz*e*math.Sin(th)
			x, z := c.X+u*c.C-vv*c.S, c.Z+u*c.S+vv*c.C
			if add(c.Layer, x, z, c.Floor+2, h, comp) {
				got++
			}
		}
		if c.Kind == vertical.ChamberLowerHalls {
			s.addWarden(w, c)
		}
	}
	for i := range v.Islands {
		is := &v.Islands[i]
		if is.Kind == vertical.IslandTown || is.Kind == vertical.IslandPalace || is.R < 30 {
			continue
		}
		for k := 0; k < 6; k++ {
			h := content.Mix(is.ID ^ uint64(k+1)*0xBF58476D1CE4E5B9)
			d := is.R * (0.25 + 0.35*float64(h>>11)/float64(1<<53))
			th := 2 * math.Pi * float64(content.Mix(h)>>11) / float64(1<<53)
			if add(vertical.LayerSky, is.X+d*math.Cos(th), is.Z+d*math.Sin(th), is.Top+2, h, combat.LayerTables[vertical.LayerSky]) {
				break
			}
		}
	}
	// CR 043: packs along the Underground's tunnels and passages, about one per
	// 140 m (not in a tunnel's first 40 m), by the depth of the floor there.
	for ci := range v.Corridors {
		r := &v.Corridors[ci]
		if r.Layer != vertical.LayerUnder || (r.Kind != 0 && r.Kind != 3) || len(r.Pts) < 3 {
			continue
		}
		run, next := 0.0, 40.0
		if r.Kind != 0 {
			next = 70.0
		}
		for k := 1; k < len(r.Pts); k++ {
			run += math.Hypot(r.Pts[k][0]-r.Pts[k-1][0], r.Pts[k][2]-r.Pts[k-1][2])
			if run < next {
				continue
			}
			next = run + 140
			h := content.Mix(uint64(ci+1)<<24 ^ uint64(k)*0x9E3779B97F4A7C15 ^ 0xC0DE)
			add(vertical.LayerUnder, r.Pts[k][0], r.Pts[k][2], r.Pts[k][1]+2, h, combat.UnderComp(r.Pts[k][1]))
		}
	}
	s.log.Info("vertical packs", "groups", len(placed))
}

// layerVein looks a vein up among the vertical world's (CR 038: the
// descriptor's veins, cave record format, band 3 Underground / 4 Depths).
// They mine like cave veins (Interact 40, drops, respawn, the vein_mined
// edit with a zero carve radius: the mined flag only).
func (s *Server) layerVein(id uint64) (caves.Vein, bool) {
	if s.layerVeins == nil {
		s.layerVeins = map[uint64]caves.Vein{}
		if vw := s.vertical(); vw != nil {
			for _, lv := range vw.Vertical().Veins {
				s.layerVeins[lv.ID] = caves.Vein{ID: lv.ID, X: lv.X, Y: lv.Y, Z: lv.Z, NX: lv.N[0], NY: lv.N[1], NZ: lv.N[2],
					Kind: uint8(lv.Kind), Material: uint8(lv.Material), Element: uint8(lv.Element), HP: uint16(lv.HP), Size: uint8(lv.Size),
					Flags: uint8(lv.Flags), Band: uint8(lv.Band), Chamber: uint8(lv.Chamber)}
			}
		}
	}
	v, ok := s.layerVeins[id]
	return v, ok
}

// isLayerVein: a vein of the vertical world (bands 3 and 4).
func isLayerVein(v caves.Vein) bool { return v.Band >= 3 }

// safeSaved (CR 038) moves a saved position the vertical world made unsafe:
// standing on terrain that is now a hole (a tunnel mouth, a cenote shaft:
// onto its rim, outside the hole), inside a sky island's rock (onto its
// top), or deep underground in rock with no floor under it (the spawn).
// Everything else is left alone (join() lifts a position below the ground).
func (s *Server) safeSaved(characterID string, p movement.Vec3) movement.Vec3 {
	vw := s.vertical()
	if vw == nil {
		return p
	}
	v := vw.Vertical()
	g := s.cfg.Ground
	surf := g.HeightAt(p.X, p.Z)
	if v.SurfaceMasked(p.X, p.Z) && p.Y >= surf-vertical.Under {
		for _, o := range v.SurfaceOpenings {
			dx, dz := p.X-o.X, p.Z-o.Z
			d := math.Hypot(dx, dz)
			if d > o.R+vertical.Under+2 {
				continue
			}
			if d < 1e-6 {
				dx, dz, d = 1, 0, 1
			}
			r := o.R + 4
			x, z := o.X+dx/d*r, o.Z+dz/d*r
			return movement.Vec3{X: x, Y: g.HeightAt(x, z), Z: z}
		}
	}
	switch vw.LayerAt(p.X, p.Y, p.Z) {
	case vertical.LayerSky:
		if f := movement.GroundAt(g, p.X, p.Y, p.Z); f == p.Y { // inside the island: onto its top
			return movement.Vec3{X: p.X, Y: movement.GroundAt(g, p.X, 1e4, p.Z), Z: p.Z}
		}
	case vertical.LayerSurface:
		if p.Y < surf-vertical.Under {
			if cw := s.caves(); cw != nil && cw.SystemAt(p.X, p.Y, p.Z) < 0 && movement.GroundAt(g, p.X, p.Y, p.Z) < p.Y-30 {
				return s.newCharacterSpawn(characterID) // in rock, nothing under it
			}
		}
	}
	return p
}
