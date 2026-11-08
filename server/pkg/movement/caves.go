package movement

// Caves (WP09). The step is a heightfield state machine (WP10): every mode
// asks Ground.HeightAt(x, z). Underground the floor depends on the height
// you stand at, and walls push back, so two small hooks plug caves in
// without touching the modes:
//
//  1. LevelGround: at the start of a step the ground is viewed "at the
//     player's level" (AtLevel(feet y)). In a cave (a mouth hole, or more
//     than 1 m under the surface) that view's HeightAt is the highest cave
//     floor at or below feet + MAX_STEP_UP_M; probes that land inside solid
//     rock read level (walls are not slopes to climb, see 2.); elsewhere it
//     is the surface ground (terrain + structures) unchanged. Water reads
//     -Inf underground (no swimming in the lake overhead).
//  2. Collider: after the mode step, one wall/ceiling push-out (not while
//     climbing): the horizontal velocity slides along the push, a ceiling
//     stops a rising jump, and a grounded player is re-snapped to the floor
//     at the pushed point.
//
// Grounds without caves implement neither and step exactly as before (every
// WP02/WP10 golden is unchanged). The TS twin is in client/src/sim/caves.ts;
// server/pkg/caves.Ground implements both. Algorithm and constants:
// worldgen/README.md "Cave collision and ground dispatch".

import "math"

// LevelGround is a ground whose surface depends on the height you stand at.
type LevelGround interface {
	Ground
	AtLevel(y float64) Ground
}

// Collider pushes a player (feet at x, y, z) out of walls and ceilings.
type Collider interface {
	Collide(x, y, z float64) CollideResult
}

// CollideResult is the pushed feet position, the horizontal push, and
// whether the head hit a ceiling.
type CollideResult struct {
	X, Y, Z      float64
	PushX, PushZ float64
	Ceiling      bool
}

// AtLevel is g viewed at feet height y (g itself unless it is a LevelGround).
func AtLevel(g Ground, y float64) Ground {
	if lg, ok := g.(LevelGround); ok {
		return lg.AtLevel(y)
	}
	return g
}

// GroundAt is the ground under a player whose feet are at height y: what
// the step stands on (zone validation and spawns use it).
func GroundAt(g Ground, x, y, z float64) float64 { return AtLevel(g, y).HeightAt(x, z) }

// collideStep applies the cave push-out to a mode step's result; g is the
// level view the step used.
func collideStep(g Ground, out State) State {
	c, ok := g.(Collider)
	if !ok || out.Mode == ModeClimb {
		return out
	}
	r := c.Collide(out.Pos.X, out.Pos.Y, out.Pos.Z)
	if r.PushX == 0 && r.PushZ == 0 && !r.Ceiling {
		return out
	}
	if r.PushX != 0 || r.PushZ != 0 {
		l := math.Sqrt(float64(r.PushX*r.PushX) + float64(r.PushZ*r.PushZ))
		nx, nz := r.PushX/l, r.PushZ/l
		vn := float64(out.Vel.X*nx) + float64(out.Vel.Z*nz)
		if vn < 0 {
			out.Vel.X = out.Vel.X - float64(vn*nx)
			out.Vel.Z = out.Vel.Z - float64(vn*nz)
		}
	}
	out.Pos = Vec3{r.X, r.Y, r.Z}
	if r.Ceiling && out.Vel.Y > 0 {
		out.Vel.Y = 0
	}
	fy := g.HeightAt(out.Pos.X, out.Pos.Z)
	if out.Mode == ModeGround || out.Pos.Y < fy {
		out.Pos.Y = fy
		if out.Vel.Y < 0 {
			out.Vel.Y = 0
		}
	}
	return out
}
