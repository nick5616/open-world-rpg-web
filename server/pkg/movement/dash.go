package movement

// WP13 (CR 005): the dodge and the mobility-spell dashes, inside the shared
// step so client prediction and the zone agree on where a dodging player
// ends up (a dodge that only existed on one side would be a correction on
// every press). The TS twin is client/src/sim/dash.ts; change both together.
//
// A dash starts on a step whose input has the dodge flag; castSlot then
// names the variant (0 = plain dodge from constants.yaml DODGE_*, 1..15 =
// combat.yaml `dashes`, used by mobility spells and the wind elemental
// form). It sets the horizontal velocity to dir * speed (dir = the wish
// direction, or straight back for a plain dodge / straight ahead for a
// dash when no key is held), optionally a vertical lift, and then holds
// that horizontal velocity for `steps` steps with no friction and no
// steering. When it ends the horizontal speed is clamped to
// DASH_EXIT_SPEED so blinks stop crisply. I-frames (spec 8: 150 ms for the
// dodge) count down independently; State.IFrames > 0 means the zone ignores
// enemy hits (Invulnerable). A new dash can start once both counters are 0.
//
// Only the walk family (ground, air) and gliding (which closes the glider)
// can dash; climbing and swimming ignore the flag. Whether a variant is
// allowed at all (equipped, off cooldown, mana) is the zone's combat layer's
// call: it strips the flag from frames it refuses BEFORE the step runs, so
// the server step never applies an illegal dash and the client is simply
// corrected. Only the plain dodge costs stamina here (DODGE_STAMINA).

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// DashVariant is one row of the dash table.
type DashVariant struct {
	Speed   float64
	Steps   int
	IFrames int
	Lift    float64
	Cost    int // stamina, fine units
	Back    bool
}

var dashVariants = buildDashes()

// MaxDashSpeed bounds a dashing player's horizontal speed (zone validation).
var MaxDashSpeed float64

// MaxDashLift bounds the vertical speed a dash can give (zone validation).
var MaxDashLift float64

func buildDashes() [16]*DashVariant {
	var t [16]*DashVariant
	t[0] = &DashVariant{Speed: constants.DodgeSpeed, Steps: constants.DodgeDashSteps, IFrames: constants.DodgeIframeSteps,
		Cost: int(math.Round(constants.DodgeStamina * constants.StaminaFinePerPoint)), Back: true}
	MaxDashSpeed, MaxDashLift = constants.DodgeSpeed, 0
	for _, d := range combatdefs.D.Dashes {
		if d.ID < 1 || d.ID > 15 {
			continue
		}
		t[d.ID] = &DashVariant{Speed: d.Speed, Steps: d.Steps, IFrames: d.IFrames, Lift: d.Lift}
		MaxDashSpeed = max(MaxDashSpeed, d.Speed)
		MaxDashLift = max(MaxDashLift, d.Lift)
	}
	return t
}

// Dash returns dash variant v (nil if unknown).
func Dash(v int) *DashVariant {
	if v < 0 || v > 15 {
		return nil
	}
	return dashVariants[v]
}

// Invulnerable reports dodge i-frames in s (spec 8: enemy hits miss).
func Invulnerable(s State) bool { return s.IFrames > 0 }

// Dashing reports a dash in progress after s.
func Dashing(s State) bool { return s.Dash > 0 }

// beginDash is the dash part of a step, run before the mode dispatch: count
// the timers down, clamp the speed of a dash that just ended, and start a
// new one if the input asks for it and it is allowed. Returns the state the
// mode step should run on and whether this step is a dashing step.
func beginDash(s State, flags uint16, castSlot uint8, yaw, wx, wz float64) (State, bool) {
	d := s
	d.Dash = max(0, s.Dash-1)
	d.IFrames = max(0, s.IFrames-1)
	if s.Dash == 1 {
		if sp := math.Sqrt(float64(d.Vel.X*d.Vel.X) + float64(d.Vel.Z*d.Vel.Z)); sp > constants.DashExitSpeed {
			k := constants.DashExitSpeed / sp
			d.Vel.X *= k
			d.Vel.Z *= k
		}
	}
	dashing := d.Dash > 0
	if flags&proto.InputFlagDodge == 0 || d.Dash != 0 || d.IFrames != 0 {
		return d, dashing
	}
	if d.Mode != ModeGround && d.Mode != ModeAir && d.Mode != ModeGlide {
		return d, dashing
	}
	v := Dash(int(castSlot))
	if v == nil || (v.Cost > 0 && !canUse(d)) {
		return d, dashing
	}
	dx, dz := wx, wz
	if dx == 0 && dz == 0 {
		c, sn := math.Cos(yaw), math.Sin(yaw)
		if v.Back {
			dx, dz = sn, c
		} else {
			dx, dz = -sn, -c
		}
	}
	d.Vel.X = dx * v.Speed
	d.Vel.Z = dz * v.Speed
	if v.Lift > 0 {
		d.Vel.Y = v.Lift
	}
	d.Stamina -= min(d.Stamina, v.Cost)
	d.Timer = 0
	d.Dash, d.IFrames = v.Steps, v.IFrames
	if d.Mode == ModeGlide {
		d.Mode = ModeAir
	}
	return d, true
}
