package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Shared spell simulation (playtest 2 spell mechanics, CR 020): the twin of
// client/src/combat/spellsim.ts, line for line, pinned by its golden vectors
// (spellsim_golden_test.go replays client/src/combat/golden/
// spellsim_golden.json to 1e-6 m). The client flies a homing shot and claims
// what it hit; validate.go re-flies the same path in the same 1/60 s steps
// against the target's recorded positions. The seeded patterns (stream
// jitter, rain offsets), orbit positions and charge fractions are here for
// the same reason: both sides must agree exactly.

const (
	simHz = 60.0
	simDT = 1.0 / simHz
)

// homingShot is a homing projectile's state (m, m/s, age in steps).
type homingShot struct {
	pos, vel movement.Vec3
	age      int
	state    int // 0 seeking, 1 locked, 2 lost
}

// homingParams are a spell's homing numbers in step units.
type homingParams struct {
	turn, acquire, coneCos float64
	delay                  int
	loseCos, gravity       float64
}

func homingParamsOf(s *combatdefs.Spell) *homingParams {
	h := s.Homing
	if h == nil {
		return nil
	}
	rad := math.Pi / 180
	return &homingParams{turn: h.TurnDegS * rad * simDT, acquire: h.AcquireM, coneCos: math.Cos(h.ConeDeg / 2 * rad), delay: h.DelaySteps, loseCos: math.Cos(h.LoseDeg * rad), gravity: s.Gravity}
}

// canAcquire: may this shot lock onto a target centred at t now?
func (s *homingShot) canAcquire(t movement.Vec3, p *homingParams) bool {
	if s.state != 0 || s.age < p.delay {
		return false
	}
	wx, wy, wz := t.X-s.pos.X, t.Y-s.pos.Y, t.Z-s.pos.Z
	d := math.Sqrt(wx*wx + wy*wy + wz*wz)
	if d > p.acquire {
		return false
	}
	if d < 1e-6 {
		return true
	}
	sp := math.Sqrt(s.vel.X*s.vel.X + s.vel.Y*s.vel.Y + s.vel.Z*s.vel.Z)
	if sp < 1e-9 {
		return false
	}
	return (wx*s.vel.X+wy*s.vel.Y+wz*s.vel.Z)/(d*sp) >= p.coneCos
}

// step advances one 1/60 s step; t is the locked target's centre (nil: none).
func (s *homingShot) step(t *movement.Vec3, p *homingParams) {
	if s.state == 1 {
		if t == nil {
			s.state = 2
		} else if s.age >= p.delay {
			sp := math.Sqrt(s.vel.X*s.vel.X + s.vel.Y*s.vel.Y + s.vel.Z*s.vel.Z)
			wx, wy, wz := t.X-s.pos.X, t.Y-s.pos.Y, t.Z-s.pos.Z
			d := math.Sqrt(wx*wx + wy*wy + wz*wz)
			if sp > 1e-9 && d > 1e-6 {
				dx, dy, dz := s.vel.X/sp, s.vel.Y/sp, s.vel.Z/sp
				ux, uy, uz := wx/d, wy/d, wz/d
				c := dx*ux + dy*uy + dz*uz
				if c > 1 {
					c = 1
				} else if c < -1 {
					c = -1
				}
				if c < p.loseCos {
					s.state = 2
				} else {
					ang := math.Acos(c)
					var nx, ny, nz float64
					if ang <= p.turn {
						nx, ny, nz = ux, uy, uz
					} else {
						sn := math.Sin(ang)
						a := math.Sin(ang-p.turn) / sn
						b := math.Sin(p.turn) / sn
						nx, ny, nz = a*dx+b*ux, a*dy+b*uy, a*dz+b*uz
						n := math.Sqrt(nx*nx + ny*ny + nz*nz)
						nx, ny, nz = nx/n, ny/n, nz/n
					}
					s.vel = movement.Vec3{X: nx * sp, Y: ny * sp, Z: nz * sp}
				}
			}
		}
	}
	s.vel.Y -= p.gravity * simDT
	s.pos.X += s.vel.X * simDT
	s.pos.Y += s.vel.Y * simDT
	s.pos.Z += s.vel.Z * simDT
	s.age++
}

// launchShot leaves eye along yaw/pitch at speed (yaw 0 looks down -Z).
func launchShot(eye movement.Vec3, yaw, pitch, speed float64) homingShot {
	cp := math.Cos(pitch)
	return homingShot{pos: eye, vel: movement.Vec3{X: -math.Sin(yaw) * cp * speed, Y: math.Sin(pitch) * speed, Z: -math.Cos(yaw) * cp * speed}}
}

// hash32 is the client's hash32 (uint32 arithmetic wraps the same way).
func hash32(a, b uint32) uint32 {
	h := a*0x9e3779b1 ^ b
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

func unit32(h uint32) float64 { return float64(h>>8) / 16777216 }

// streamSeed: a stream's seed from its start seq and spell id.
func streamSeed(startSeq uint32, spellID int) uint32 { return hash32(startSeq, uint32(spellID)) }

// shotJitter: how far shot k leans off the aim (radians).
func shotJitter(seed uint32, k int, jitterDeg float64) (dyaw, dpitch float64) {
	j := jitterDeg * math.Pi / 180
	u1 := unit32(hash32(seed, uint32(2*k)))
	u2 := unit32(hash32(seed, uint32(2*k+1)))
	return (2*u1 - 1) * j, (2*u2 - 1) * j * 0.5
}

// rainOffset: where shot k of a rain stream lands relative to the aim point.
func rainOffset(seed uint32, k int, radius float64) (dx, dz float64) {
	s := seed ^ 0x5bd1e995
	r := radius * math.Sqrt(unit32(hash32(s, uint32(2*k))))
	th := 2 * math.Pi * unit32(hash32(s, uint32(2*k+1)))
	return r * math.Cos(th), r * math.Sin(th)
}

// orbOffset: orb i's offset from the caster's feet `steps` after the cast.
func orbOffset(i, count, steps, periodSteps int, radius float64) movement.Vec3 {
	th := 2*math.Pi*float64(steps)/float64(periodSteps) + 2*math.Pi*float64(i)/float64(count)
	return movement.Vec3{X: radius * math.Sin(th), Y: 1, Z: radius * math.Cos(th)}
}

// chargeFrac is 0..1 of a held charge.
func chargeFrac(held, maxSteps int) float64 {
	return math.Max(0, math.Min(1, float64(held)/float64(max(1, maxSteps))))
}

// chargeMult is a charge multiplier at fraction f.
func chargeMult(mult, f float64) float64 { return 1 + (mult-1)*f }

// ShotSpeed is a projectile move's launch speed at draw fraction c (a
// charged bow shot speeds up to chargeSpeed). Client: timeline.ts shotSpeed.
func ShotSpeed(m *combatdefs.Move, c float64) float64 {
	if m.ChargeSpeed > 0 && c > 0 {
		return m.Speed + (m.ChargeSpeed-m.Speed)*c
	}
	return m.Speed
}

// ShotRange (CR 033) is how far a projectile move reaches at draw fraction
// c: a charged shot has its full reach at full draw and proportionally less
// the slower it flies (the same flight time). Client: timeline.ts shotRange.
func ShotRange(m *combatdefs.Move, c float64) float64 {
	if m.ChargeSpeed > m.Speed && m.Speed > 0 {
		return m.Reach * ShotSpeed(m, c) / m.ChargeSpeed
	}
	return m.Reach
}
