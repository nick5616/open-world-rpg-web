package movement

// Playtest 2 mounts (CR 027, docs/cr/027-mounts.md): riding the spirit steed
// inside the shared step. Line-for-line twin of client/src/sim/ride.ts (the
// comment there has the whole contract); change both together and
// regenerate the goldens (client/src/sim/golden/ride.ts, replayed by
// ride_golden_test.go).
//
// FlagMounted is set only by the zone (Mount, from Interact 110), never by
// the step; the step only clears it (Space at a standstill, a hard landing,
// deep water, a mode a rider can't be in). While mounted the walk family
// runs stepRide: gaits carried in Lunge (bits 0-1 trot/walk/gallop, bit 2
// "Shift was down", bit 3 backing), spurs paid from the stamina wheel,
// turning by literal angles per step, the steed's own slope, step-up and
// water limits, a jump, no dashes. Products that are then added are wrapped
// in float64() so Go never fuses them into an FMA (TS can't).

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/proto"
)

// FlagMounted is State.Flags bit 3: riding the spirit steed.
const FlagMounted uint8 = 8

// Gaits carried in Lunge bits 0-1 while mounted.
const (
	GaitTrot   = 0
	GaitWalk   = 1
	GaitGallop = 2
	prevSprint = 4
	backingBit = 8
)

// SpurCost is one spur in fine stamina units.
var SpurCost = int(math.Round(constants.RideSpurStamina * constants.StaminaFinePerPoint))

// Turn per step as literal cos/sin (150, 110, 75 degrees per second at 60 Hz).
const (
	turnWalkC   = 0.9990482215818578
	turnWalkS   = 0.043619387365336
	turnTrotC   = 0.9994881171794909
	turnTrotS   = 0.03199224307541267
	turnGallopC = 0.9997620270799091
	turnGallopS = 0.02181488503456112
)

// Mounted reports whether s rides the steed.
func Mounted(s State) bool { return s.Flags&FlagMounted != 0 }

// Mount puts the rider in the saddle (the zone's call, Interact 110): the
// flag, a trot gait and nothing else changed. Only for a walk-family state.
func Mount(s State) State {
	s.Flags |= FlagMounted
	s.Lunge = 0
	return s
}

// Dismount takes the rider out of the saddle (E, a throw by the zone).
func Dismount(s State) State {
	s.Flags &^= FlagMounted
	s.Lunge = 0
	return s
}

func gaitSpeed(g int) float64 {
	switch g {
	case GaitWalk:
		return constants.RideWalkSpeed
	case GaitGallop:
		return constants.RideGallopSpeed
	}
	return constants.RideTrotSpeed
}

func rideStepUpOK(g Ground, pos Vec3, dx, dz float64) bool {
	d := math.Sqrt(float64(dx*dx) + float64(dz*dz))
	if d == 0 {
		return false
	}
	px := pos.X + float64(dx/d*constants.StepProbeM)
	pz := pos.Z + float64(dz/d*constants.StepProbeM)
	if g.HeightAt(px, pz)-pos.Y > constants.RideStepUpM {
		return false
	}
	return SlopeAt(g, px, pz).T2 <= constants.RideWalkableTanSq
}

// stepRide is one riding step (walk family, mounted); flags are the
// frame's, (wx, wz) the W/A/D wish direction, yaw the look.
func stepRide(s State, flags uint16, wx, wz, yaw float64, g Ground) State {
	fwd := flags&proto.InputFlagForward != 0
	back := flags&proto.InputFlagBack != 0
	side := flags&(proto.InputFlagLeft|proto.InputFlagRight) != 0
	sprint := flags&proto.InputFlagSprint != 0
	gait := s.Lunge & 3
	spurPress := sprint && s.Lunge&prevSprint == 0
	backing := s.Lunge&backingBit != 0
	exhausted := s.Flags&FlagExhausted != 0

	h0 := g.HeightAt(s.Pos.X, s.Pos.Z)
	grounded := s.Pos.Y <= h0+groundEps
	sliding := false
	var sl Slope
	if grounded {
		sl = SlopeAt(g, s.Pos.X, s.Pos.Z)
		sliding = sl.T2 > constants.RideSlideTanSq
	}

	vx, vz := s.Vel.X, s.Vel.Z
	stamina, timer := s.Stamina, s.Timer
	spurred := false
	if grounded && !sliding {
		steer := fwd || side
		if back && !fwd {
			gait = GaitWalk
		}
		if spurPress && fwd && !exhausted && stamina >= SpurCost {
			stamina -= SpurCost
			timer = 0
			spurred = true
			if gait == GaitWalk {
				gait = GaitTrot
			} else {
				gait = GaitGallop
			}
		}
		if back && !fwd && !side {
			sp := math.Sqrt(float64(vx*vx) + float64(vz*vz))
			if !backing && sp > constants.RidePivotSpeed*0.5 {
				ns := math.Max(0, sp-float64(constants.RideBrakeDecel*dt))
				k := ns / sp
				vx *= k
				vz *= k
			} else {
				backing = true
				tx := math.Sin(yaw) * constants.RideBackSpeed
				tz := math.Cos(yaw) * constants.RideBackSpeed
				dx, dz := tx-vx, tz-vz
				d := math.Sqrt(float64(dx*dx) + float64(dz*dz))
				m := constants.RideAccel * dt
				if d <= m {
					vx, vz = tx, tz
				} else {
					vx += float64(dx * (m / d))
					vz += float64(dz * (m / d))
				}
			}
		} else {
			backing = false
			target := 0.0
			if fwd {
				target = gaitSpeed(gait)
			} else if side {
				target = constants.RideWalkSpeed
			}
			depth := WaterAt(g, s.Pos.X, s.Pos.Z) - h0
			if depth > constants.RideSplashDepthM {
				target *= constants.RideWaterMult
			}
			sp := math.Sqrt(float64(vx*vx) + float64(vz*vz))
			dx, dz := 0.0, 0.0
			if sp > 0 {
				dx, dz = vx/sp, vz/sp
			}
			if steer && (wx != 0 || wz != 0) {
				if sp < constants.RidePivotSpeed {
					dx, dz = wx, wz
				} else {
					c, sn := turnGallopC, turnGallopS
					if sp < 5 {
						c, sn = turnWalkC, turnWalkS
					} else if sp < 10 {
						c, sn = turnTrotC, turnTrotS
					}
					dot := float64(dx*wx) + float64(dz*wz)
					if dot >= c {
						dx, dz = wx, wz
					} else {
						cross := float64(dx*wz) - float64(dz*wx)
						if cross < 0 {
							sn = -sn
						}
						rx := float64(dx*c) - float64(dz*sn)
						rz := float64(dx*sn) + float64(dz*c)
						dx, dz = rx, rz
					}
				}
			}
			if spurred {
				sp = math.Min(constants.RideSpurMaxSpeed, sp+constants.RideSpurKick)
			}
			if sp < target {
				sp = math.Min(target, sp+float64(constants.RideAccel*dt))
			} else if sp > target {
				decel := constants.RideSlowDecel
				if target == 0 {
					decel = constants.RideStopDecel
				} else if gait == GaitGallop && sp > constants.RideGallopSpeed {
					decel = constants.RideBurstDecay
				}
				sp = math.Max(target, sp-float64(decel*dt))
			}
			if sp == 0 && gait == GaitGallop && !fwd {
				gait = GaitTrot
			}
			vx, vz = dx*sp, dz*sp
		}
	} else if sliding {
		t := math.Sqrt(sl.T2)
		a := -constants.Gravity * t / (1 + sl.T2)
		vx -= float64(sl.GX / t * a * dt)
		vz -= float64(sl.GZ / t * a * dt)
		sp := math.Sqrt(float64(vx*vx) + float64(vz*vz))
		if sp > constants.SlideMaxSpeed {
			k := constants.SlideMaxSpeed / sp
			vx *= k
			vz *= k
		}
		backing = false
	}

	vy := s.Vel.Y
	if !grounded {
		vy += float64(constants.Gravity * dt)
	}
	mount := true
	if grounded && !sliding && flags&proto.InputFlagJumpEdge != 0 {
		sp := math.Sqrt(float64(vx*vx) + float64(vz*vz))
		if sp < constants.RideDismountSpeed && !fwd {
			mount = false
			vy = constants.JumpForce
		} else {
			vy = constants.RideJumpSpeed
		}
	}

	x := s.Pos.X + float64(vx*dt)
	y := s.Pos.Y + float64(vy*dt)
	z := s.Pos.Z + float64(vz*dt)
	groundY := g.HeightAt(x, z)

	if grounded && !sliding {
		dx, dz := x-s.Pos.X, z-s.Pos.Z
		rise := groundY - s.Pos.Y
		if rise > 0 && rise*rise > float64(constants.RideWalkableTanSq*(float64(dx*dx)+float64(dz*dz))) {
			w := SlopeAt(g, x, z)
			if w.T2 > constants.RideWalkableTanSq && !rideStepUpOK(g, s.Pos, dx, dz) {
				t := math.Sqrt(w.T2)
				nx, nz := w.GX/t, w.GZ/t
				d := float64(dx*nx) + float64(dz*nz)
				x2 := s.Pos.X + (dx - float64(d*nx))
				z2 := s.Pos.Z + (dz - float64(d*nz))
				if vd := float64(vx*nx) + float64(vz*nz); vd > 0 {
					vx -= float64(vd * nx)
					vz -= float64(vd * nz)
				}
				gy2 := g.HeightAt(x2, z2)
				rise2 := gy2 - s.Pos.Y
				ex, ez := x2-s.Pos.X, z2-s.Pos.Z
				if rise2 > 0 && rise2*rise2 > float64(constants.RideWalkableTanSq*(float64(ex*ex)+float64(ez*ez))) && SlopeAt(g, x2, z2).T2 > constants.RideWalkableTanSq {
					x, z, groundY = s.Pos.X, s.Pos.Z, h0
					vx, vz = 0, 0
				} else {
					x, z, groundY = x2, z2, gy2
				}
			}
		}
		if WaterAt(g, x, z)-groundY >= constants.RideWadeDepthM {
			x, z, groundY = s.Pos.X, s.Pos.Z, h0
			vx, vz = 0, 0
		}
	}

	thrown := false
	if y <= groundY || (vy <= 0 && y-groundY <= constants.GroundSnapM) {
		if !grounded && vy <= -constants.RideThrowFallSpeed {
			thrown = true
		}
		y, vy = groundY, 0
	}
	mode := ModeAir
	if y <= groundY+groundEps {
		mode = ModeGround
	}
	if w := WaterAt(g, x, z); w-groundY >= constants.SwimDepthM && y <= w-constants.SwimFloatDepthM {
		y, vy = w-constants.SwimFloatDepthM, 0
		mode = ModeSwim
		thrown = true
	}
	if thrown {
		mount = false
		vx *= 0.3
		vz *= 0.3
	}

	if grounded && !sliding && !spurred {
		timer = min(timer+1, TimerMax)
		if timer >= RegenDelaySteps {
			stamina = min(s.StaminaMax, stamina+RegenPerStep)
		}
	}
	lunge := 0
	flagsOut := s.Flags & FlagExhausted
	if sliding {
		flagsOut |= FlagSliding
	}
	if mount {
		lunge = gait
		if sprint {
			lunge |= prevSprint
		}
		if backing {
			lunge |= backingBit
		}
		flagsOut |= FlagMounted
	}
	return State{Pos: Vec3{x, y, z}, Vel: Vec3{vx, vy, vz}, Mode: mode, Stamina: stamina, StaminaMax: s.StaminaMax, Timer: timer, Lunge: lunge, Flags: flagsOut}
}

// collideHead pushes the steed's chest (RIDE_HEAD_PROBE_M ahead along the
// motion) out of the same colliders as the rider and moves the body with it.
func collideHead(g Ground, out State) State {
	c, ok := g.(Collider)
	if !ok || out.Flags&FlagMounted == 0 {
		return out
	}
	sp := math.Sqrt(float64(out.Vel.X*out.Vel.X) + float64(out.Vel.Z*out.Vel.Z))
	if sp < 0.1 {
		return out
	}
	px := out.Pos.X + float64(out.Vel.X/sp*constants.RideHeadProbeM)
	pz := out.Pos.Z + float64(out.Vel.Z/sp*constants.RideHeadProbeM)
	r := c.Collide(px, out.Pos.Y, pz)
	if r.PushX == 0 && r.PushZ == 0 {
		return out
	}
	l := math.Sqrt(float64(r.PushX*r.PushX) + float64(r.PushZ*r.PushZ))
	nx, nz := r.PushX/l, r.PushZ/l
	if vn := float64(out.Vel.X*nx) + float64(out.Vel.Z*nz); vn < 0 {
		out.Vel.X = out.Vel.X - float64(vn*nx)
		out.Vel.Z = out.Vel.Z - float64(vn*nz)
	}
	out.Pos = Vec3{out.Pos.X + (r.X - px), out.Pos.Y, out.Pos.Z + (r.Z - pz)}
	fy := g.HeightAt(out.Pos.X, out.Pos.Z)
	if out.Mode == ModeGround || out.Pos.Y < fy {
		out.Pos.Y = fy
		if out.Vel.Y < 0 {
			out.Vel.Y = 0
		}
	}
	return out
}

// MaxRideSpeed bounds a rider's horizontal speed (zone validation): the spur
// cap; carried speed (a slide, a fall) is bounded by the previous state's.
const MaxRideSpeed = constants.RideSpurMaxSpeed
