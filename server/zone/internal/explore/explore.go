// Package explore is the zone's exploration logic (WP12, spec 8
// "Exploration structure", spec 11 character_progress): towers that reveal a
// region's map and unlock fast travel when you stand on top, waypoint stones
// activated by touch (and the last one touched is the respawn point),
// discovery XP for entering a POI's radius once per character, fast-travel
// validation, and personal/party map pins.
//
// Everything here is pure and tick-safe: no I/O, no clocks, no goroutines.
// The game package calls Check from the tick with the player's authoritative
// position, sends the Happenings as Events, and persists Progress through
// the write-behind queue.
package explore

import (
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/structures"
)

// Rule constants. Why these numbers:
const (
	// WaypointTouchM: "activated by touching". Server positions are feet,
	// the stone is ~0.8 m wide; 3 m horizontally is arm's reach plus
	// interpolation slack so a player who walks into the stone always
	// triggers it, without triggering from across a road.
	WaypointTouchM = 3.0
	// waypointTouchDY: same stone, not the cliff above it.
	waypointTouchDY = 3.0
	// layerWaypointDY (CR 038): a sky town's or an underground camp's stone
	// stands on its island / cavern floor (the site's y, within the floor's relief).
	layerWaypointDY = 12.0
	// TowerTopSlackM: the top check accepts feet within the platform plus
	// this much, and down to this far below the platform surface (ground
	// snapping keeps feet on it; the slack covers the 1e-4 grounded epsilon
	// and a hop on the top).
	TowerTopSlackM = 0.6
	// ArrivalOffsetM: fast travel to a waypoint puts you beside the stone,
	// not inside it.
	ArrivalOffsetM = 2.5
	// MaxPersonalPins: spec 8 "up to 10 personal pins".
	MaxPersonalPins = 10
	// TowerClimbXP is granted once per tower, on top of its discovery XP:
	// climbing is the hardest exploration act (and the map reveal).
	TowerClimbXP = 150
)

// Happening kinds (each becomes one Event, contracts/events.md 600-699).
type Kind uint8

const (
	TowerUnlocked Kind = iota + 1
	WaypointActivated
	Discovered
	RespawnPointSet
)

// Happening is one exploration event for one player.
type Happening struct {
	Kind   Kind
	Site   int   // atlas site index
	XP     int64 // XP granted by this happening (0 if none)
	Region int   // region of the site
}

// Tower is a tower site with its overlay structure.
type Tower struct {
	Site    int
	Overlay int // index in the structure overlay
	Shape   *structures.Radial
}

// World is the exploration view of one world: sites, towers, a proximity
// grid. Built once at zone start; read-only afterwards (safe from any
// goroutine).
type World struct {
	Atlas  *structures.Atlas
	Ground *structures.Ground // terrain + structure overlay (the zone's movement ground)
	Towers []Tower

	towerBySite   map[int]int // site index -> Towers index
	towerByOver   map[int]int // overlay index -> Towers index
	cells         map[[2]int32][]int32
	discoverR     []float64 // per site, 0 = not discoverable
	discoverXP    []int64
	maxDiscoverR  float64
	siteCount     int
	waypointSites []int
}

// cell of the proximity grid: 128 m, so the largest discovery radius
// (towns, 130 m) touches at most 3 x 3 cells.
const cell = 128

func cellOf(v float64) int32 { return int32(math.Floor(v / cell)) }

// DiscoverRadius is how close (horizontally) a player must come to discover
// a site, and 0 for sites that are not discoveries. Spec 8: "experience
// comes from discovery (towers, caves, structures, towns)"; landmarks count
// too (they exist to pull explorers over the next hill). Waypoints have
// their own touch rule; enemy camps are combat, not discovery.
func DiscoverRadius(s *structures.Site) float64 {
	switch s.Category {
	case structures.CategorySettlement:
		return s.Radius // walking into the town's footprint
	case structures.CategoryStructure:
		return math.Max(s.Radius, 15) + 10
	}
	switch s.Kind {
	case structures.POITower:
		return 40 // at the foot of the tower, before the climb
	case structures.POICaveMouth:
		return 20
	case structures.POILandmark:
		return 25
	// CR 038, the vertical world (layer sites also need VerticalReach).
	case structures.POITunnel:
		return 25
	case structures.POICavern, structures.POIDepths:
		return math.Max(30, s.Radius*0.6)
	case structures.POIDepthsGate:
		return s.Radius + 10
	case structures.POIArchipelago:
		return s.Radius
	case structures.POISkyLift:
		return 15
	}
	return 0
}

// VerticalReach (CR 038): how far above or below a site of a vertical layer
// (sky, Underground, Depths) a player may be to discover or touch it; +Inf
// for surface sites (horizontal distance only, as before).
func VerticalReach(s *structures.Site) float64 {
	switch {
	case s.Layer == 0:
		return math.Inf(1)
	case s.Category == structures.CategoryPOI && s.Kind == structures.POIArchipelago:
		return 260 // anywhere up among its islands
	case s.Layer == 1:
		return 45
	}
	return 110 // a cavern's floor to its roof
}

// DiscoverXP is the one-time XP for discovering s. Scaled so a level-1
// explorer levels after two or three discoveries (wizard-wars curve: 100 XP
// to level 2), and bigger places are worth more.
func DiscoverXP(s *structures.Site) int64 {
	switch s.Category {
	case structures.CategorySettlement:
		return 60 + 20*int64(s.Size) // hamlet 60, village 80, town 100
	case structures.CategoryStructure:
		return 50 + 25*int64(s.Size) // tier 0..2
	}
	switch s.Kind {
	case structures.POITower:
		return 40
	case structures.POICaveMouth:
		return 50
	case structures.POILandmark:
		return 30
	case structures.POITunnel:
		return 50
	case structures.POICavern:
		return 70
	case structures.POIDepths:
		return 90
	case structures.POIDepthsGate:
		return 40
	case structures.POIArchipelago:
		return 40
	case structures.POISkyLift:
		return 20
	}
	return 0
}

// NewWorld indexes an atlas. ground must be the overlay ground built from
// the same atlas with structures.Towers (towerSites = its second result).
func NewWorld(a *structures.Atlas, ground *structures.Ground, towerSites []int) *World {
	w := &World{Atlas: a, Ground: ground, towerBySite: map[int]int{}, towerByOver: map[int]int{}, cells: map[[2]int32][]int32{}, siteCount: len(a.Sites)}
	for oi, si := range towerSites {
		w.towerBySite[si] = len(w.Towers)
		w.towerByOver[oi] = len(w.Towers)
		w.Towers = append(w.Towers, Tower{Site: si, Overlay: oi, Shape: ground.Overlay.At(oi).(*structures.Radial)})
	}
	w.discoverR = make([]float64, len(a.Sites))
	w.discoverXP = make([]int64, len(a.Sites))
	for i := range a.Sites {
		s := &a.Sites[i]
		r := DiscoverRadius(s)
		reach := r
		if s.IsWaypoint() {
			reach = WaypointTouchM
			w.waypointSites = append(w.waypointSites, i)
		}
		if _, ok := w.towerBySite[i]; ok {
			reach = math.Max(reach, w.Towers[w.towerBySite[i]].Shape.MaxR)
		}
		if reach <= 0 {
			continue
		}
		w.discoverR[i] = r
		w.discoverXP[i] = DiscoverXP(s)
		w.maxDiscoverR = math.Max(w.maxDiscoverR, reach)
		for cz := cellOf(s.Z - reach); cz <= cellOf(s.Z+reach); cz++ {
			for cx := cellOf(s.X - reach); cx <= cellOf(s.X+reach); cx++ {
				k := [2]int32{cx, cz}
				w.cells[k] = append(w.cells[k], int32(i))
			}
		}
	}
	return w
}

// SiteCount is the size of every per-character bitset (in bits).
func (w *World) SiteCount() int { return w.siteCount }

// TowerOfSite returns the tower at a site index.
func (w *World) TowerOfSite(site int) (*Tower, bool) {
	i, ok := w.towerBySite[site]
	if !ok {
		return nil, false
	}
	return &w.Towers[i], true
}

// OnTowerTop reports which tower's top platform pos stands on (-1 none),
// as a Towers index. Server-validated: pos is the authoritative position,
// and standing there means the ground under it is that tower's top.
func (w *World) OnTowerTop(pos movement.Vec3) int {
	oi := w.Ground.StructureAt(pos.X, pos.Z)
	if oi < 0 {
		return -1
	}
	ti, ok := w.towerByOver[oi]
	if !ok {
		return -1
	}
	t := w.Towers[ti].Shape
	dx, dz := pos.X-t.CX, pos.Z-t.CZ
	if math.Hypot(dx, dz) > structures.TowerTopRadius+TowerTopSlackM || pos.Y < t.TopY-TowerTopSlackM {
		return -1
	}
	return ti
}

// Check applies every proximity rule for a player at pos and returns what
// happened (appended to out). Idempotent: a second call at the same spot
// returns nothing new.
func (w *World) Check(p *Progress, pos movement.Vec3, out []Happening) []Happening {
	p.ensure(w.siteCount)
	for _, si := range w.cells[[2]int32{cellOf(pos.X), cellOf(pos.Z)}] {
		s := &w.Atlas.Sites[si]
		d := math.Hypot(pos.X-s.X, pos.Z-s.Z)
		if s.Layer != 0 && math.Abs(pos.Y-s.Y) > VerticalReach(s) {
			continue // CR 038: under a sky town, over a cavern: not there yet
		}
		if r := w.discoverR[si]; r > 0 && d <= r && !p.Discoveries.Has(int(si)) {
			p.Discoveries.Set(int(si))
			xp := w.discoverXP[si]
			p.AddXP(xp)
			out = append(out, Happening{Kind: Discovered, Site: int(si), XP: xp, Region: int(s.Region)})
		}
		if s.IsWaypoint() && d <= WaypointTouchM && (s.Layer != 0 && math.Abs(pos.Y-s.Y) <= layerWaypointDY || s.Layer == 0 && math.Abs(pos.Y-w.Ground.HeightAt(s.X, s.Z)) <= waypointTouchDY) {
			if !p.Waypoints.Has(int(si)) {
				p.Waypoints.Set(int(si))
				p.dirty = true
				out = append(out, Happening{Kind: WaypointActivated, Site: int(si), Region: int(s.Region)})
			}
			if p.LastWaypoint != int(si) {
				p.LastWaypoint = int(si)
				p.dirty = true
				out = append(out, Happening{Kind: RespawnPointSet, Site: int(si), Region: int(s.Region)})
			}
		}
	}
	if ti := w.OnTowerTop(pos); ti >= 0 {
		t := &w.Towers[ti]
		if !p.Towers.Has(t.Site) {
			p.Towers.Set(t.Site)
			p.AddXP(TowerClimbXP)
			out = append(out, Happening{Kind: TowerUnlocked, Site: t.Site, XP: TowerClimbXP, Region: int(w.Atlas.Sites[t.Site].Region)})
		}
	}
	return out
}

// Attune errors (Event 903 attune_refused value; playtest 1, CR 012).
type AttuneError int32

const (
	AttuneOK       AttuneError = 0
	AttuneNotThere AttuneError = 1 // not standing on that tower's top
	AttuneAlready  AttuneError = 2 // this character already attuned it
	AttuneUnknown  AttuneError = 3 // not a tower
)

// Attune attunes the player at pos to the crystal of tower site (playtest
// 1): they must stand on its top (server-validated, like the unlock). The
// first attunement of each tower sets the Attuned bit and returns ok; the
// caller grants the boon. Standing on the top also unlocks the tower if the
// 10 Hz check has not yet (the returned happenings, possibly empty).
func (w *World) Attune(p *Progress, pos movement.Vec3, site int, out []Happening) ([]Happening, AttuneError) {
	t, ok := w.TowerOfSite(site)
	if !ok {
		return out, AttuneUnknown
	}
	p.ensure(w.siteCount)
	ti := w.OnTowerTop(pos)
	if ti < 0 || w.Towers[ti].Site != t.Site {
		return out, AttuneNotThere
	}
	out = w.Check(p, pos, out)
	if p.Attuned.Has(site) {
		return out, AttuneAlready
	}
	p.Attuned.Set(site)
	p.dirty = true
	return out, AttuneOK
}

// RevealedRegions returns a bitmask of regions whose map the player has
// revealed: a region is revealed by climbing any tower in it.
func (w *World) RevealedRegions(p *Progress) uint32 {
	var m uint32
	for _, t := range w.Towers {
		if p.Towers.Has(t.Site) {
			m |= 1 << w.Atlas.Sites[t.Site].Region
		}
	}
	return m
}

// TravelError says why a fast travel was refused (Event value for
// fast_travel_denied).
type TravelError int32

const (
	TravelOK       TravelError = 0
	TravelUnknown  TravelError = 1 // not a tower or waypoint
	TravelLocked   TravelError = 2 // not unlocked by this character
	TravelCooldown TravelError = 3 // too soon after the last one
)

// Destination returns where a fast travel to site lands (feet position).
// Towers: the middle of the top platform. Waypoints: beside the stone, on
// the side it faces.
func (w *World) Destination(site int) (movement.Vec3, bool) {
	if site < 0 || site >= w.siteCount {
		return movement.Vec3{}, false
	}
	if t, ok := w.TowerOfSite(site); ok {
		return movement.Vec3{X: t.Shape.CX, Y: t.Shape.TopY, Z: t.Shape.CZ}, true
	}
	s := &w.Atlas.Sites[site]
	if !s.IsWaypoint() {
		return movement.Vec3{}, false
	}
	x, z := s.X+ArrivalOffsetM*math.Cos(s.Yaw), s.Z+ArrivalOffsetM*math.Sin(s.Yaw)
	if s.Layer != 0 {
		// CR 038: a sky town's / underground camp's stone: arrive just above
		// its floor (the zone's Teleport lifts onto the layer's floor at that level).
		return movement.Vec3{X: x, Y: s.Y + 2.5, Z: z}, true
	}
	return movement.Vec3{X: x, Y: w.Ground.HeightAt(x, z), Z: z}, true
}

// CanTravel validates a fast travel request against the character's
// progress (cooldown is the caller's: it owns the clock).
func (w *World) CanTravel(p *Progress, site int) TravelError {
	if site < 0 || site >= w.siteCount {
		return TravelUnknown
	}
	p.ensure(w.siteCount)
	if _, ok := w.TowerOfSite(site); ok {
		if !p.Towers.Has(site) {
			return TravelLocked
		}
		return TravelOK
	}
	if !w.Atlas.Sites[site].IsWaypoint() {
		return TravelUnknown
	}
	if !p.Waypoints.Has(site) {
		return TravelLocked
	}
	return TravelOK
}

// RespawnPoint is where a character respawns (WP13's death hook): beside
// the last waypoint they touched, or ok=false (caller uses the world spawn).
func (w *World) RespawnPoint(p *Progress) (movement.Vec3, bool) {
	if p.LastWaypoint < 0 {
		return movement.Vec3{}, false
	}
	return w.Destination(p.LastWaypoint)
}
