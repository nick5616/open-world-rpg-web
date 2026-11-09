package chem

import (
	"math"
	"sync/atomic"

	"lodestone/server/pkg/movement"
)

// Overlay is what ice sheets and pillars add to the movement ground
// (spec 8: ice freezes a walkable sheet; earth raises a climbable pillar).
// The simulation lives on the tick goroutine; the overlay publishes an
// immutable snapshot through an atomic pointer, so ground queries from any
// goroutine (spawns on connection goroutines) are race-free. The TS twin is
// client/src/systems/chem/ground.ts; both evaluate the same arithmetic.
type Overlay struct {
	snap    atomic.Pointer[surface]
	version uint64
}

type surface struct {
	sheets  map[uint32]float64
	pillars []Pillar
}

// Sync rebuilds the snapshot when the simulation's surface changed.
func (o *Overlay) Sync(s *Sim) {
	if o.snap.Load() != nil && o.version == s.SurfaceVersion {
		return
	}
	o.version = s.SurfaceVersion
	sf := &surface{sheets: map[uint32]float64{}, pillars: append([]Pillar(nil), s.Pillars...)}
	s.Frozen(func(id uint32, y float64) { sf.sheets[id] = y })
	o.snap.Store(sf)
}

// below: the overlay applies to feet at most this far under its surface
// (a player on the surface or swimming), never to someone in a cave below.
const below = 3.0

// HeightAt is the overlay's surface at (x, z) for feet at y, or -Inf.
func (o *Overlay) HeightAt(x, y, z float64) (float64, bool) {
	sf := o.snap.Load()
	if sf == nil || (len(sf.sheets) == 0 && len(sf.pillars) == 0) {
		return 0, false
	}
	best, ok := 0.0, false
	if len(sf.sheets) > 0 {
		ix, iz := CellAt(x, z)
		if InWorld(ix, iz) {
			if h, f := sf.sheets[CellID(ix, iz)]; f && y >= h-below {
				best, ok = h, true
			}
		}
	}
	for i := range sf.pillars {
		p := &sf.pillars[i]
		if y < p.BaseY-below {
			continue
		}
		if h, in := PillarHeight(p, x, z); in && (!ok || h > best) {
			best, ok = h, true
		}
	}
	return best, ok
}

// PillarHeight is a pillar's surface at (x, z): a square top 2*Half wide
// and walls that fall to the base over Run (80 degrees).
func PillarHeight(p *Pillar, x, z float64) (float64, bool) {
	dx, dz := x-p.X, z-p.Z
	if dx < 0 {
		dx = -dx
	}
	if dz < 0 {
		dz = -dz
	}
	d := max(dx, dz)
	switch {
	case d <= p.Half:
		return p.BaseY + p.Height, true
	case d < p.Half+p.Run:
		return p.BaseY + float64(p.Height*(p.Half+p.Run-d))/p.Run, true
	}
	return 0, false
}

// Ground puts the overlay on a movement ground: HeightAt is the max of the
// inner ground and the overlay (at the surface), AtLevel views keep the
// inner level ground's water and wall collision. Wrap the zone's ground
// with it; server/zone/night.go keeps the concrete ground's other methods
// (chunk interest, caves) by embedding.
type Ground struct {
	Inner movement.Ground
	O     *Overlay
}

// HeightAt implements movement.Ground (the surface: the overlay always applies).
func (g Ground) HeightAt(x, z float64) float64 {
	h := g.Inner.HeightAt(x, z)
	if oh, ok := g.O.HeightAt(x, math.Inf(1), z); ok && oh > h {
		return oh
	}
	return h
}

// WaterAt implements movement.Water.
func (g Ground) WaterAt(x, z float64) float64 { return movement.WaterAt(g.Inner, x, z) }

// AtLevel implements movement.LevelGround.
func (g Ground) AtLevel(y float64) movement.Ground {
	return Level(movement.AtLevel(g.Inner, y), g.O, y)
}

// Level wraps a level view (the ground a step stands on) with the overlay.
func Level(inner movement.Ground, o *Overlay, y float64) movement.Ground {
	if sf := o.snap.Load(); sf == nil || (len(sf.sheets) == 0 && len(sf.pillars) == 0) {
		return inner
	}
	lv := &level{inner: inner, o: o, y: y}
	if c, ok := inner.(movement.Collider); ok {
		return levelCollider{lv, c}
	}
	return lv
}

type level struct {
	inner movement.Ground
	o     *Overlay
	y     float64
}

func (l *level) HeightAt(x, z float64) float64 {
	h := l.inner.HeightAt(x, z)
	if oh, ok := l.o.HeightAt(x, l.y, z); ok && oh > h {
		return oh
	}
	return h
}

func (l *level) WaterAt(x, z float64) float64 { return movement.WaterAt(l.inner, x, z) }

type levelCollider struct {
	*level
	c movement.Collider
}

func (l levelCollider) Collide(x, y, z float64) movement.CollideResult { return l.c.Collide(x, y, z) }
