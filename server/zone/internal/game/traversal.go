package game

// WP10 traversal on the zone: the per-tick movement env (rain from the
// weather stub at world time, updraft columns), per-mode movement validation
// (spec 9: "validated against max speed for the player's current mode;
// violations snap the player back"), and the drowned event.
//
// The step itself (server/pkg/movement) is the same one the client predicts
// with, so for honest input these checks always pass: they are a tripwire
// for bugs and for anything that ever moves a player outside the step. A
// client can only send inputs; extra simulation time is what the frame
// budget limits.

import (
	"math"
	"os"
	"strings"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
)

// EventDrowned is contracts/events.md kind 100: sent to a player whose step
// drowned them and respawned them at the shore (UI only; the step did both).
const EventDrowned = 100

// DebugEnvFromEnv reads the zone's dev overrides for the movement env:
//
//	LODESTONE_ZONE_DEBUG_UPDRAFTS  "x,z,radius,top,lift[;...]" updraft columns (the
//	                               client mirrors them with ?updraft=...)
//	LODESTONE_ZONE_DEBUG_RAIN      1 = always rain, 0 = never (default: weather stub)
func DebugEnvFromEnv() (movement.UpdraftField, *bool) {
	var up movement.UpdraftField
	if cs := movement.ParseColumns(os.Getenv("LODESTONE_ZONE_DEBUG_UPDRAFTS")); len(cs) > 0 {
		up = cs
	}
	var rain *bool
	switch strings.TrimSpace(os.Getenv("LODESTONE_ZONE_DEBUG_RAIN")) {
	case "1":
		t := true
		rain = &t
	case "0":
		f := false
		rain = &f
	}
	return up, rain
}

// stepEnv is the movement env for this tick: rain from the weather stub at
// the server clock (the client evaluates the same function at its synced
// estimate of that clock) unless overridden, plus the updraft field.
func (s *Server) stepEnv() movement.Env {
	if s.weatherOn() {
		// CR 030: the weather where each player stands (weather.go); the
		// dev rain override became the field's override in main.go.
		return movement.Env{Updraft: s.nightUpdraft(), Weather: s.weatherFieldAt(weather.Step(s.worldTimeS()))}
	}
	raining := weather.IsRaining(s.cfg.Seed, s.worldTimeS()) // WP15: the world clock (night.go)
	if s.cfg.Rain != nil {
		raining = *s.cfg.Rain
	}
	return movement.Env{Raining: raining, Updraft: s.nightUpdraft()} // WP15: fire updrafts + debug columns
}

// respawned reports a drowning respawn between prev and next: the step
// teleported the player to the shore (movement.FindShore).
func respawned(prev, next movement.State) bool {
	return prev.Flags&movement.FlagDrowned != 0 && next.Flags&movement.FlagDrowned == 0
}

// verticalOK is the vertical half of movement validation, per mode (WP07
// wrote it for walk/air; WP10 extended it). A step's new height is either
// physics (at most the previous height plus one step at the fastest upward
// speed any mode allows from prev: a jump, carried vertical speed, an
// updraft-lifted glider, a climb lunge) or a surface it was put on (the
// ground it snapped to or climbs on, the water surface a swimmer floats at),
// and never below the ground. A drowning respawn is checked for landing on
// dry ground instead. Checked on the step's own result, before the
// world-edge clamp moves x/z.
func verticalOK(prev, next movement.State, g movement.Ground) bool {
	const eps = 1e-6
	g = movement.AtLevel(g, prev.Pos.Y) // WP09: the ground the step used (cave floors underground)
	ground := g.HeightAt(next.Pos.X, next.Pos.Z)
	if respawned(prev, next) {
		return next.Mode == movement.ModeGround && math.Abs(next.Pos.Y-ground) <= eps && movement.WaterAt(g, next.Pos.X, next.Pos.Z) < ground
	}
	if next.Pos.Y < ground-eps {
		return false
	}
	up := max(prev.Vel.Y, constants.JumpForce, constants.UpdraftMaxLift-constants.GlideSinkSpeed, constants.ClimbJumpSpeed)
	if next.Dash > 0 {
		up = max(up, movement.MaxDashLift) // WP13: a launch dash (root launch, updraft) starts this step
	}
	if movement.Mounted(prev) {
		up = max(up, constants.RideJumpSpeed) // CR 027: the steed's jump
	}
	limit := max(prev.Pos.Y+up*movement.Dt, ground)
	if next.Mode == movement.ModeSwim {
		limit = max(limit, movement.WaterAt(g, next.Pos.X, next.Pos.Z)-constants.SwimFloatDepthM)
	}
	return next.Pos.Y <= limit+eps
}

// horizontalOK is the per-mode horizontal speed bound (movement.MaxHorizontalSpeed).
func horizontalOK(prev, next movement.State) bool {
	if respawned(prev, next) {
		return movement.HorizontalSpeed(next) == 0
	}
	return movement.HorizontalSpeed(next) <= movement.MaxHorizontalSpeed(prev, next)
}

// sendDrowned tells the player their step drowned and respawned them.
func (s *Server) sendDrowned(sess *session) {
	e := sess.ent
	ev := &proto.Event{
		Kind:     EventDrowned,
		EntityID: e.ID,
		X:        proto.MetersToCm(e.Move.Pos.X),
		Y:        proto.MetersToCm(e.Move.Pos.Y),
		Z:        proto.MetersToCm(e.Move.Pos.Z),
	}
	_ = sess.conn.SendReliable(proto.Encode(ev))
	s.m.drowned.Add(1)
}
