package movement

// WP13 (CR 009): the dodge and the mobility-spell dashes, inside the shared
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
// steering. When it ends the horizontal speed is clamped to the variant's
// exit speed (DASH_EXIT_SPEED for the dodge) so blinks stop crisply.
// I-frames (spec 8: 150 ms for the dodge) count down independently;
// State.IFrames > 0 means the zone ignores enemy hits (Invulnerable). A new
// dash can start once both counters are 0.
//
// Playtest 2 dash overhaul (CR 021, docs/cr/021-dash-overhaul.md):
//   - `aim: look` variants start along the 3D look direction (the frame's
//     yaw AND pitch): magma dash flies.
//   - Hold to sustain: while a dash runs (the state's Dash counter entering
//     the step is > 0), a frame with InputFlag.channel, castSlot = a variant
//     with a sustain block and no attack/dodge/cast keeps it going: it re-arms
//     `carrySteps` of dash and applies the kind (jet thrust toward the look,
//     a steered dash, a skate over water, blink pulses, a glide, phasing
//     i-frames). The client sends castSlot = the running variant on every
//     step of the dash (channel only while the key is held), so the step also
//     knows which exit speed to clamp to when the dash ends. The zone's
//     combat layer (Player.sustainDash) pays for every held step and zeroes
//     castSlot when the frame does not belong to the dash it allowed (or it
//     cannot pay): the step then ends the dash on both sides.
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
	// CR 021.
	Look bool    // start along the 3D look direction
	Exit float64 // horizontal speed kept when the dash ends
	// Sustain (Kind 0 = none): combatdefs.Sustain* kinds.
	Kind       int
	SusSpeed   float64
	Steer      float64
	Carry      int
	BlinkSpeed float64
	BlinkEvery int
	Sink       float64
}

var dashVariants = buildDashes()

// MaxDashSpeed bounds a dashing player's horizontal speed (zone validation).
var MaxDashSpeed float64

// MaxDashLift bounds the vertical speed a dash can give (zone validation).
var MaxDashLift float64

func buildDashes() [16]*DashVariant {
	var t [16]*DashVariant
	t[0] = &DashVariant{Speed: constants.DodgeSpeed, Steps: constants.DodgeDashSteps, IFrames: constants.DodgeIframeSteps,
		Cost: int(math.Round(constants.DodgeStamina * constants.StaminaFinePerPoint)), Back: true, Exit: constants.DashExitSpeed}
	MaxDashSpeed, MaxDashLift = constants.DodgeSpeed, 0
	for _, d := range combatdefs.D.Dashes {
		if d.ID < 1 || d.ID > 15 {
			continue
		}
		v := &DashVariant{Speed: d.Speed, Steps: d.Steps, IFrames: d.IFrames, Lift: d.Lift, Look: d.Aim == "look", Exit: d.ExitSpeed}
		if v.Exit <= 0 {
			v.Exit = constants.DashExitSpeed
		}
		MaxDashSpeed = max(MaxDashSpeed, d.Speed)
		MaxDashLift = max(MaxDashLift, d.Lift)
		if v.Look {
			MaxDashLift = max(MaxDashLift, d.Speed)
		}
		if s := d.Sustain; s != nil {
			v.Kind, v.SusSpeed, v.Steer, v.Carry, v.BlinkSpeed, v.BlinkEvery, v.Sink = s.KindID, s.Speed, s.Steer, s.CarrySteps, s.BlinkSpeed, s.BlinkEvery, s.Sink
			MaxDashSpeed = max(MaxDashSpeed, s.Speed, s.BlinkSpeed)
			if s.KindID == combatdefs.SustainJet {
				MaxDashLift = max(MaxDashLift, s.Speed)
			}
		}
		t[d.ID] = v
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

// sustainFlags: a frame with any of these never sustains a dash (the cast
// flag's castSlot is a spell slot, not a variant).
const sustainBlock = proto.InputFlagAttack | proto.InputFlagDodge | proto.InputFlagCast

// Holding reports whether frame flags/castSlot hold (sustain) the dash a
// state with Dash > 0 is running: the zone's combat layer pays for exactly
// these steps.
func Holding(prev State, flags uint16, castSlot uint8) bool {
	if prev.Dash <= 0 || flags&proto.InputFlagChannel == 0 || flags&sustainBlock != 0 {
		return false
	}
	v := Dash(int(castSlot))
	return v != nil && v.Kind != 0 && castSlot != 0
}

// lookDir is the unit 3D look direction (yaw 0 faces -Z, pitch up positive).
func lookDir(yaw, pitch float64) (float64, float64, float64) {
	cp := math.Cos(pitch)
	return -math.Sin(yaw) * cp, math.Sin(pitch), -math.Cos(yaw) * cp
}

// beginDash is the dash part of a step, run before the mode dispatch: count
// the timers down, sustain a held dash (CR 021), clamp the speed of a dash
// that just ended, and start a new one if the input asks for it and it is
// allowed. Returns the state the mode step should run on, whether this step
// is a dashing step and the sustain kind applied this step (0 none).
func beginDash(s State, flags uint16, castSlot uint8, yaw, pitch, wx, wz float64, grounded bool) (State, bool, int) {
	d := s
	d.Dash = max(0, s.Dash-1)
	d.IFrames = max(0, s.IFrames-1)
	kind := 0
	if Holding(s, flags, castSlot) && (d.Mode == ModeGround || d.Mode == ModeAir || d.Mode == ModeGlide) {
		v := Dash(int(castSlot))
		kind = v.Kind
		dx, dz := wx, wz
		if dx == 0 && dz == 0 {
			dx, dz = -math.Sin(yaw), -math.Cos(yaw)
		}
		sp := v.SusSpeed
		switch v.Kind {
		case combatdefs.SustainJet:
			fx, fy, fz := lookDir(yaw, pitch)
			k := v.Steer
			d.Vel.X += float64((float64(fx*sp) - d.Vel.X) * k)
			d.Vel.Y += float64((float64(fy*sp) - d.Vel.Y) * k)
			d.Vel.Z += float64((float64(fz*sp) - d.Vel.Z) * k)
			if !grounded {
				d.Vel.Y -= float64(constants.Gravity * dt) // the walk step adds it back: thrust holds you up
			}
		case combatdefs.SustainBlink:
			if s.Dash <= 1 {
				sp = v.BlinkSpeed // the counter ran out: one step at blink speed, re-armed
			}
			d.Vel.X, d.Vel.Z = dx*sp, dz*sp
		default:
			d.Vel.X, d.Vel.Z = dx*sp, dz*sp
		}
		switch v.Kind {
		case combatdefs.SustainBlink:
			if s.Dash <= 1 {
				d.Dash = v.BlinkEvery
			}
		default:
			d.Dash = v.Carry
		}
		if v.Kind == combatdefs.SustainGlide && d.Vel.Y < -v.Sink {
			d.Vel.Y = -v.Sink
		}
		if v.Kind == combatdefs.SustainPhase {
			d.IFrames = max(d.IFrames, 2)
		}
		if d.Mode == ModeGlide {
			d.Mode = ModeAir
		}
	} else if s.Dash == 1 {
		exit := constants.DashExitSpeed
		if v := Dash(int(castSlot)); v != nil && castSlot != 0 && flags&sustainBlock == 0 {
			exit = v.Exit // the client names the running variant on every step of it
		}
		if sp := math.Sqrt(float64(d.Vel.X*d.Vel.X) + float64(d.Vel.Z*d.Vel.Z)); sp > exit {
			k := exit / sp
			d.Vel.X *= k
			d.Vel.Z *= k
		}
	}
	dashing := d.Dash > 0
	if flags&proto.InputFlagDodge == 0 || d.Dash != 0 || d.IFrames != 0 {
		return d, dashing, kind
	}
	if d.Mode != ModeGround && d.Mode != ModeAir && d.Mode != ModeGlide {
		return d, dashing, kind
	}
	v := Dash(int(castSlot))
	if v == nil || (v.Cost > 0 && !canUse(d)) {
		return d, dashing, kind
	}
	if v.Look {
		fx, fy, fz := lookDir(yaw, pitch)
		d.Vel = Vec3{fx * v.Speed, fy * v.Speed, fz * v.Speed}
	} else {
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
	}
	if v.Lift > 0 {
		d.Vel.Y = v.Lift
	}
	d.Stamina -= min(d.Stamina, v.Cost)
	d.Timer = 0
	d.Dash, d.IFrames = v.Steps, v.IFrames
	if d.Mode == ModeGlide {
		d.Mode = ModeAir
	}
	return d, true, kind
}

// skateGround treats water as ground (glacier step's held skate, CR 021):
// the height is the higher of the terrain and the water surface, and it has
// no water of its own, so the walk step never swims on it.
type skateGround struct{ g Ground }

func (k skateGround) HeightAt(x, z float64) float64 {
	return math.Max(k.g.HeightAt(x, z), WaterAt(k.g, x, z))
}
