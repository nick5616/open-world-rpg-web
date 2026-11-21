// Package rift is the pure, deterministic half of rift runs (playtest 2,
// CR 040, docs/cr/040-rift-runs.md): chapters of 50 compact arena stages
// whose enemies fire readable bullet patterns, perks, loot odds by depth,
// gem events and the portal schedule. No I/O, no clocks: the zone glue is
// internal/game/rift.go.
//
// Everything a client must agree on (the arena layout and its collision,
// every bullet's path) is computed from small integers with 32-bit integer
// hashing and IEEE float arithmetic, so the TS twin (client/src/rift/
// layout.ts, patterns.ts) reproduces it from the same inputs. A Go test
// writes testdata/rift_golden.json and the client's vitest replays it.
package rift

import "math"

// Arena geometry (metres, arena-local: the origin is the arena centre on the
// floor, +z is the entrance (south), -z the door (north)).
const (
	HalfX = 10.0 // the room is 20 m wide
	HalfZ = 14.0 // and 28 m deep
	// PlayerR is the body radius the arena pushes out of walls, pillars and
	// pools (the movement capsule's radius).
	PlayerR = 0.4
	// HitR is the player's hit radius against bullets: smaller than the body
	// (fair hitboxes: a bullet that visibly grazes you does not hit).
	HitR = 0.28
	// BulletY is the height bullets fly at above the floor.
	BulletY = 1.0
	// DoorZ is where the door stands (arena-local z) and DoorReach how near a
	// player must walk to it once it opens.
	DoorZ     = -HalfZ + 0.6
	DoorReach = 1.8
	// StartZ is where players arrive.
	StartZ = HalfZ - 2.5
)

// Obstacle kinds.
const (
	Pillar = 0 // stops players and bullets
	Pool   = 1 // deep water: stops players, bullets fly over it
	Spikes = 2 // floor strip: hurts while raised (a timed hazard, not solid)
)

// Obstacle is a circle (pillar, pool) or a box (spikes: X, Z centre, R half
// width on x, H half depth on z).
type Obstacle struct {
	Kind  int
	X, Z  float64
	R, H  float64
	Phase float64 // spikes: offset of the raise cycle, seconds
}

// Layout is one stage's arena.
type Layout struct {
	Chapter, Stage int
	Template       int
	Obstacles      []Obstacle
	// Slots are where enemies stand (arena-local x, z), in spawn order.
	Slots [][2]float64
}

// Solid reports whether o blocks the player.
func (o Obstacle) Solid() bool { return o.Kind == Pillar || o.Kind == Pool }

// templates: obstacle positions in half-units of the room (x in [-1, 1] of
// HalfX, z of HalfZ) with a radius in metres; mirrored on x where flagged.
type tmplObs struct {
	x, z, r float64
	mirror  bool
}

var templates = [][]tmplObs{
	{}, // 0: open hall
	{{0.5, -0.1, 1.1, true}, {0.5, 0.35, 1.1, true}},                            // 1: four pillars
	{{0, 0.05, 1.8, false}},                                                     // 2: a centre column
	{{0.55, -0.35, 0.9, true}, {0, 0.1, 1.2, false}, {0.55, 0.45, 0.9, true}},   // 3: diamond
	{{0.3, -0.2, 0.8, true}, {0.75, 0.1, 0.8, true}, {0.3, 0.4, 0.8, true}},     // 4: zigzag rows
	{{0.65, -0.45, 1.0, true}, {0.65, 0.05, 1.0, true}, {0.65, 0.5, 1.0, true}}, // 5: colonnade
	{{0.35, 0.1, 1.4, true}},                                                    // 6: twin columns
	{{0, -0.25, 1.0, false}, {0.6, 0.2, 1.0, true}},                             // 7: triangle
}

// Themes per chapter: which kinds the template's circles become, and
// spike strips.
type theme struct {
	pools  bool // every second circle becomes a pool
	spikes int  // spike strips (0-2)
}

var themes = []theme{
	{pools: false, spikes: 1}, // 1 Emberglass Steps: pillars and a vent of spikes
	{pools: true, spikes: 0},  // 2 Drowned Atrium: pools between columns
	{pools: false, spikes: 2}, // 3 Thornvault: thorn strips
	{pools: true, spikes: 1},  // 4 Stormcrown Spire
	{pools: true, spikes: 2},  // 5 The Hollow Star
}

// enemySlots: candidate enemy positions (fractions of the half extents), in
// spawn order; the north part of the room, away from the entrance.
var enemySlots = [][2]float64{
	{0, -0.55}, {-0.55, -0.4}, {0.55, -0.4}, {-0.3, -0.75}, {0.3, -0.75},
	{-0.75, -0.1}, {0.75, -0.1}, {0, -0.2}, {-0.45, 0.05}, {0.45, 0.05},
}

// StageLayout is the arena of chapter c (1-based), stage s (1..50).
func StageLayout(c, s int) Layout {
	h := Hash(0x5a17, uint32(c), uint32(s))
	t := int(h % uint32(len(templates)))
	if s%10 == 0 {
		t = 0 // boss rooms are open halls
	}
	th := themes[(c-1+len(themes))%len(themes)]
	l := Layout{Chapter: c, Stage: s, Template: t}
	k := 0
	for _, o := range templates[t] {
		xs := []float64{o.x}
		if o.mirror && o.x != 0 {
			xs = []float64{-o.x, o.x}
		}
		kind := Pillar
		if th.pools && k%2 == 1 {
			kind = Pool
		}
		k++
		for _, x := range xs {
			l.Obstacles = append(l.Obstacles, Obstacle{Kind: kind, X: x * HalfX, Z: o.z * HalfZ, R: o.r})
		}
	}
	if s%10 != 0 {
		for i := 0; i < th.spikes; i++ {
			hz := Hash(0x5b1e, uint32(c), uint32(s), uint32(i))
			z := (-0.3 + 0.55*Unit(hz)) * HalfZ
			if i == 1 {
				z = -z * 0.7
			}
			l.Obstacles = append(l.Obstacles, Obstacle{Kind: Spikes, X: 0, Z: math.Round(z*10) / 10, R: HalfX * 0.55, H: 0.7, Phase: float64(i) * 1.5})
		}
	}
	for _, sl := range enemySlots {
		x, z := sl[0]*HalfX, sl[1]*HalfZ
		if l.blocked(x, z, 1.2) {
			continue
		}
		l.Slots = append(l.Slots, [2]float64{x, z})
	}
	return l
}

func (l *Layout) blocked(x, z, m float64) bool {
	for _, o := range l.Obstacles {
		if dx, dz := x-o.X, z-o.Z; o.Kind != Spikes && math.Sqrt(dx*dx+dz*dz) < o.R+m {
			return true
		}
	}
	return false
}

// Collide pushes a body at arena-local (x, z) out of the walls and the solid
// obstacles: two passes over the circles in order, then the walls. Returns
// the pushed position. The TS twin is layout.ts collide.
func (l *Layout) Collide(x, z float64) (float64, float64) {
	const r = PlayerR
	for pass := 0; pass < 2; pass++ {
		for _, o := range l.Obstacles {
			if !o.Solid() {
				continue
			}
			dx, dz := x-o.X, z-o.Z
			d2 := dx*dx + dz*dz
			m := o.R + r
			if d2 >= m*m {
				continue
			}
			if d2 == 0 {
				x = o.X + m
				continue
			}
			d := math.Sqrt(d2)
			k := m / d
			x, z = o.X+dx*k, o.Z+dz*k
		}
		x = clamp(x, -HalfX+r, HalfX-r)
		z = clamp(z, -HalfZ+r, HalfZ-r)
	}
	return x, z
}

// SpikesUp reports whether a spike strip is raised t seconds into the stage
// (a 3.2 s cycle: 1.2 s down, 1.0 s glowing (telegraph), 1.0 s up).
func SpikesUp(o Obstacle, t float64) (up, warn bool) {
	c := math.Mod(t+o.Phase, 3.2)
	if c < 0 {
		c += 3.2
	}
	return c >= 2.2, c >= 1.2 && c < 2.2
}

// OnSpikes reports whether a body at (x, z) stands on strip o.
func OnSpikes(o Obstacle, x, z float64) bool {
	return math.Abs(x-o.X) <= o.R+HitR && math.Abs(z-o.Z) <= o.H+HitR
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ---- hashing (the TS twin uses Math.imul and >>> 0) ----

// Mix is a 32-bit avalanche (lowbias32).
func Mix(a uint32) uint32 {
	a ^= a >> 16
	a *= 0x7feb352d
	a ^= a >> 15
	a *= 0x846ca68b
	a ^= a >> 16
	return a
}

// Hash folds values into one 32-bit hash.
func Hash(vals ...uint32) uint32 {
	h := uint32(0x9e3779b9)
	for _, v := range vals {
		h = Mix(h ^ (v + 0x632be5ab + (h << 6) + (h >> 2)))
	}
	return h
}

// Unit is a hash as a fraction in [0, 1).
func Unit(h uint32) float64 { return float64(h) / 4294967296 }
