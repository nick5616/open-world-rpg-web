// Package movement is the authoritative player movement step, shared by the
// zone server and the Go bots. The browser client runs a TypeScript port of
// the exact same algorithm for prediction (WP02), so any drift between the two
// shows up as reconciliation snaps: change both together or neither.
//
// adapted from wizard-wars shared/movement.js and
// client/src/networking/ClientPrediction.ts predict() (Source-style ground
// friction + acceleration, air-strafe acceleration, double jump, ground snap).
//
// Differences from wizard-wars, all deliberate:
//   - State.Pos is the FEET position (wizard-wars tracked the eye, ground +
//     PLAYER_HEIGHT). Terrain queries and nameplates both want feet.
//   - One step is a fixed 1/60 s (MOVE_STEP_HZ), not wizard-wars' 1/64; each
//     InputFrame is exactly one step on both sides (docs/decisions/0001).
//   - Grounded is derived from position every step (y <= ground + 1e-4), not
//     carried as a flag, so a client replaying from a server snapshot (which
//     carries position, velocity and airJumps but no grounded bit) reaches the
//     same answer the server did. The ground snap at the end of every step
//     leaves y exactly at ground height, so the tolerance only absorbs float
//     noise.
//   - No arena clamp, barriers or spell kinematics yet; terrain collision is
//     the pluggable Ground (flat for now; WP07 plugs in the wasm terrain).
//
// Bitwise note: math.Sin/Cos in Go and Math.sin/cos in V8 may differ in the
// last ulp for some inputs. That is ~1e-16 relative, nine orders of magnitude
// below the 1 cm wire quantization, and reconciliation replays from the
// server's state anyway, so we accept it rather than ship a custom sin/cos.
package movement

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// Dt is one movement step: each InputFrame advances the simulation by exactly
// this much (1/60 s).
const Dt = 1.0 / float64(constants.MoveStepHz)

// groundEps absorbs float noise in the grounded test; see package comment.
const groundEps = 1e-4

// Vec3 is a plain 3-vector in meters (or m/s).
type Vec3 struct{ X, Y, Z float64 }

// State is everything a movement step reads and writes. It is exactly what a
// client needs to replay from: SelfState carries pos, vel and airJumps.
type State struct {
	Pos      Vec3 // feet position, m
	Vel      Vec3 // m/s
	AirJumps int  // air jumps used since last touching the ground
}

// Ground answers terrain height (feet y) at a horizontal position. WP07
// replaces Flat with the wasm terrain; WP02 has the same interface in TS.
type Ground interface {
	HeightAt(x, z float64) float64
}

// Flat is a flat plane at height Y (the placeholder world until WP07).
type Flat struct{ Y float64 }

// HeightAt implements Ground.
func (f Flat) HeightAt(_, _ float64) float64 { return f.Y }

// Grounded reports whether s stands on g (same test Step uses).
func Grounded(s State, g Ground) bool {
	return s.Pos.Y <= g.HeightAt(s.Pos.X, s.Pos.Z)+groundEps
}

// StepFrame applies one input frame. Yaw is dequantized from the wire u16 so
// server and client steer by the identical angle the client sent, not the
// unquantized mouse angle the client happened to have locally.
func StepFrame(s State, f proto.InputFrame, g Ground) State {
	return Step(s, f.Flags, proto.U16ToYaw(f.Yaw), g)
}

// Step advances s by one fixed Dt with input flags (proto.InputFlag*) and yaw
// in radians. Order matters and matches wizard-wars exactly: friction/accel,
// gravity, jump, integrate, snap.
func Step(s State, flags uint16, yaw float64, g Ground) State {
	speed := constants.BaseMoveSpeed
	if flags&proto.InputFlagSprint != 0 {
		speed *= constants.SprintMultiplier
	}

	// Wish direction relative to yaw. Yaw 0 faces -Z (three.js camera
	// convention), so forward is (-sin, -cos).
	c, sn := math.Cos(yaw), math.Sin(yaw)
	var wishX, wishZ float64
	if flags&proto.InputFlagForward != 0 {
		wishZ -= c
		wishX -= sn
	}
	if flags&proto.InputFlagBack != 0 {
		wishZ += c
		wishX += sn
	}
	if flags&proto.InputFlagLeft != 0 {
		wishZ += sn
		wishX -= c
	}
	if flags&proto.InputFlagRight != 0 {
		wishZ -= sn
		wishX += c
	}
	wishX, wishZ = normalizeWishDir(wishX, wishZ)

	grounded := s.Pos.Y <= g.HeightAt(s.Pos.X, s.Pos.Z)+groundEps

	vx, vz := s.Vel.X, s.Vel.Z
	if grounded {
		vx, vz = applyGroundFriction(vx, vz, constants.GroundFriction, constants.StopSpeed, Dt)
		vx, vz = applyGroundAccel(vx, vz, wishX, wishZ, speed, constants.GroundAccel, Dt)
	} else {
		vx, vz = applyAirAccel(vx, vz, wishX, wishZ, speed, constants.AirAccel, constants.AirCapSpeed, Dt)
	}

	vy := s.Vel.Y
	if !grounded {
		vy += constants.Gravity * Dt
	}

	// Held JUMP auto-hops off the ground (Source sv_autobunnyhop); the double
	// jump fires only on JUMP_EDGE (rising edge, computed client-side) so
	// holding space doesn't burn both charges in the two steps it takes to
	// leave the ground.
	airJumps := s.AirJumps
	if flags&proto.InputFlagJump != 0 && grounded {
		vy = constants.JumpForce
		airJumps = 0
	} else if !grounded && flags&proto.InputFlagJumpEdge != 0 && airJumps < constants.MaxAirJumps {
		vy = constants.JumpForce
		airJumps++
	}

	x := s.Pos.X + vx*Dt
	y := s.Pos.Y + vy*Dt
	z := s.Pos.Z + vz*Dt

	// Ground snap: landing, or descending within GROUND_SNAP_M of the surface
	// (ramp descent would otherwise stutter between ground and air physics).
	groundY := g.HeightAt(x, z)
	hugging := vy <= 0 && y-groundY <= constants.GroundSnapM
	if y <= groundY || hugging {
		y = groundY
		vy = 0
		airJumps = 0
	}

	return State{Pos: Vec3{x, y, z}, Vel: Vec3{vx, vy, vz}, AirJumps: airJumps}
}

// MaxLegitHorizontalSpeed is the zone's sanity bound for horizontal speed.
// Steady ground speed is GROUND_ACCEL*wish/GROUND_FRICTION (4.9 m/s walking,
// 7.8 sprinting with the wizard-wars constants); air strafing (bunny hopping,
// kept on purpose) can exceed that, so the bound (25.6 m/s) is generous. It exists to catch
// bugs and future dash/glide mistakes, not normal play; the real speed-hack
// defense is the zone's per-session frame budget (frames are simulation time).
const MaxLegitHorizontalSpeed = constants.BaseMoveSpeed * constants.SprintMultiplier * 2

// HorizontalSpeed returns |vel.xz|.
func HorizontalSpeed(s State) float64 { return math.Hypot(s.Vel.X, s.Vel.Z) }

// applyGroundFriction decelerates horizontal velocity, acting as if at least
// stopSpeed so players actually stop instead of creeping forever.
func applyGroundFriction(vx, vz, friction, stopSpeed, dt float64) (float64, float64) {
	speed := math.Sqrt(vx*vx + vz*vz)
	if speed < 0.01 {
		return 0, 0
	}
	control := speed
	if speed < stopSpeed {
		control = stopSpeed
	}
	drop := control * friction * dt
	k := math.Max(speed-drop, 0) / speed
	return vx * k, vz * k
}

// applyGroundAccel accelerates toward wishDir, clamped so one step never
// overshoots wishSpeed.
func applyGroundAccel(vx, vz, wx, wz, wishSpeed, accel, dt float64) (float64, float64) {
	cur := vx*wx + vz*wz
	add := wishSpeed - cur
	if add <= 0 {
		return vx, vz
	}
	a := math.Min(accel*dt*wishSpeed, add)
	return vx + a*wx, vz + a*wz
}

// applyAirAccel is Quake/Source PM_AirAccelerate: the addSpeed check uses the
// capped wish speed but the rate scales with the full wish speed. That
// mismatch is what makes strafe-jumping gain speed.
func applyAirAccel(vx, vz, wx, wz, wishSpeed, accel, airCap, dt float64) (float64, float64) {
	capped := math.Min(wishSpeed, airCap)
	cur := vx*wx + vz*wz
	add := capped - cur
	if add <= 0 {
		return vx, vz
	}
	a := math.Min(accel*dt*wishSpeed, add)
	return vx + a*wx, vz + a*wz
}

func normalizeWishDir(x, z float64) (float64, float64) {
	l := math.Sqrt(x*x + z*z)
	if l == 0 {
		return 0, 0
	}
	return x / l, z / l
}
