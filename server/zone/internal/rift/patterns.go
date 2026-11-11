package rift

// Bullet patterns (CR 040). A volley is a handful of integers (Event 1702):
// a kind, the tick its bullets leave, an origin, an angle, a count, a speed,
// a core radius and three kind parameters. Every bullet's path is a closed
// form of the time since the volley fired (seekers excepted: they steer at
// a capped turn rate toward a player, stepped at 30 Hz from the same
// numbers), so the zone sends no bullet state at all and the client draws
// what the zone checks. The TS twin is client/src/rift/patterns.ts.
//
// Readability rules the generator keeps (patterns.go Design* and
// schedule.go): every volley is telegraphed (wind-up >= 450 ms, lasers
// >= 800 ms), bullets are slow (<= 8.5 m/s), rings and walls always leave
// a gap a body fits through, and the hit radius is the bright core only.

import (
	"math"
)

// Volley kinds (Event 1702 data byte 0).
const (
	KindRing   = 1 // n bullets in a circle
	KindSpiral = 2 // P3 arms, one shot each every P1 ms, turning P2 milli-degrees per shot
	KindFan    = 3 // P2 waves of n bullets spread P1/10 degrees around the angle, P3 ms apart
	KindWall   = 4 // a line of n bullets P1 cm apart moving along the angle, a two-bullet gap at P2
	KindBounce = 5 // n orbs that bounce off the walls up to P1 times
	KindLaser  = 6 // a beam P1 cm wide, live for P2 ms, sweeping P3 milli-degrees per second
	KindSeeker = 7 // n slow orbs that turn at P1 degrees per second toward entity Seed
	KindRain   = 8 // n impacts of radius P2 cm, P3 ms apart, each telegraphed P1 ms before it lands
)

// TickHz is the zone tick (volley times are ticks).
const TickHz = 30.0

// Volley is one telegraphed burst of bullets, in wire precision.
type Volley struct {
	ID     uint32
	Kind   int
	Fire   uint32 // tick the bullets leave (the telegraph runs Windup ms before)
	Windup int    // ms
	OX, OZ float64
	Angle  float64 // radians (yaw 0 = +x, counter-clockwise in x/z: the arena's own convention)
	Count  int
	Speed  float64 // m/s
	Radius float64 // core (hit) radius, m
	P1, P2 int
	P3     int
	Seed   uint32
	Life   float64 // s after Fire

	dead []float64 // per bullet: time it hits a pillar or leaves the room (lazy; bounce and straight kinds)
}

// Quantize rounds every number to its wire precision (cm, u16 turns,
// cm/s, ms), so the zone simulates exactly what the client decodes.
func (v *Volley) Quantize() {
	v.OX = math.Round(v.OX*100) / 100
	v.OZ = math.Round(v.OZ*100) / 100
	a := math.Mod(v.Angle, 2*math.Pi)
	if a < 0 {
		a += 2 * math.Pi
	}
	v.Angle = float64(AngleU16(a)) * 2 * math.Pi / 65536
	v.Speed = math.Round(v.Speed*100) / 100
	v.Radius = math.Round(v.Radius*100) / 100
	v.Life = math.Round(v.Life*1000) / 1000
	v.dead = nil
}

// AngleU16 is a yaw as a u16 turn (the wire).
func AngleU16(a float64) uint16 {
	n := int64(math.Round(a/(2*math.Pi)*65536)) % 65536
	if n < 0 {
		n += 65536
	}
	return uint16(n)
}

// Bullets is how many bullets the volley has (0 for a laser).
func (v *Volley) Bullets() int {
	switch v.Kind {
	case KindFan:
		return v.Count * max(1, v.P2)
	case KindLaser:
		return 0
	case KindWall:
		return v.Count
	}
	return v.Count
}

// born is when bullet i leaves, seconds after Fire, and its heading.
func (v *Volley) born(i int) (t, a float64) {
	switch v.Kind {
	case KindRing, KindBounce, KindSeeker:
		return 0, v.Angle + 2*math.Pi*float64(i)/float64(max(1, v.Count))
	case KindSpiral:
		arms := max(1, v.P3)
		j, arm := i/arms, i%arms
		return float64(j*v.P1) / 1000, v.Angle + float64(j)*float64(v.P2)*math.Pi/180000 + 2*math.Pi*float64(arm)/float64(arms)
	case KindFan:
		n := max(1, v.Count)
		w, k := i/n, i%n
		spread := float64(v.P1) / 10 * math.Pi / 180
		off := 0.0
		if n > 1 {
			off = spread * (float64(k)/float64(n-1) - 0.5)
		}
		return float64(w*v.P3) / 1000, v.Angle + off
	case KindWall:
		return 0, v.Angle
	}
	return 0, v.Angle
}

// wallSkip reports the wall bullets left out for the gap.
func (v *Volley) wallSkip(i int) bool {
	return v.P2 >= 0 && v.P2 < v.Count && (i == v.P2 || i == v.P2+1)
}

// start is bullet i's start point.
func (v *Volley) start(i int) (x, z float64) {
	if v.Kind == KindWall {
		// perpendicular offset from the origin
		off := (float64(i) - float64(v.Count-1)/2) * float64(v.P1) / 100
		return v.OX - math.Sin(v.Angle)*off, v.OZ + math.Cos(v.Angle)*off
	}
	return v.OX, v.OZ
}

// fold reflects an unbounded coordinate into [-L, L]; n = walls touched.
func fold(u, L float64) (float64, int) {
	p := u + L
	w := 2 * L
	k := math.Floor(p / w)
	r := p - k*w
	n := int(math.Abs(k))
	if int(k)%2 != 0 {
		return L - r, n
	}
	return r - L, n
}

// Pos is bullet i at t seconds after Fire on layout l: where it is and
// whether it is flying (born, not yet stopped). Seekers use SeekerPos.
func (v *Volley) Pos(i int, t float64, l *Layout) (x, z float64, alive bool) {
	b, a := v.born(i)
	if t < b || t > v.Life || v.Kind == KindLaser || v.Kind == KindRain || (v.Kind == KindWall && v.wallSkip(i)) {
		return 0, 0, false
	}
	if v.dead == nil {
		v.dead = make([]float64, v.Bullets())
		for k := range v.dead {
			v.dead[k] = -1
		}
	}
	if i < len(v.dead) && v.dead[i] < 0 {
		v.dead[i] = v.deathTime(i, l)
	}
	if i < len(v.dead) && t >= v.dead[i] {
		return 0, 0, false
	}
	x, z = v.at(i, b, a, t)
	return x, z, true
}

// at is the unobstructed position of bullet i (born b, heading a) at t.
func (v *Volley) at(i int, b, a, t float64) (float64, float64) {
	x0, z0 := v.start(i)
	d := (t - b) * v.Speed
	ux, uz := x0+math.Cos(a)*d, z0+math.Sin(a)*d
	if v.Kind == KindBounce {
		ux, _ = fold(ux, HalfX-v.Radius)
		uz, _ = fold(uz, HalfZ-v.Radius)
	}
	return ux, uz
}

// deathTime: straight bullets end at the first pillar or wall on their line
// (closed form); bouncing orbs are marched at 30 Hz (both sides the same
// steps) until a pillar or their bounce budget.
func (v *Volley) deathTime(i int, l *Layout) float64 {
	b, a := v.born(i)
	x0, z0 := v.start(i)
	if v.Kind == KindBounce {
		for k := 0; ; k++ {
			t := b + float64(k)/TickHz
			if t > v.Life {
				return v.Life + 1
			}
			d := (t - b) * v.Speed
			ux, uz := x0+math.Cos(a)*d, z0+math.Sin(a)*d
			fx, nx := fold(ux, HalfX-v.Radius)
			fz, nz := fold(uz, HalfZ-v.Radius)
			if nx+nz > v.P1 {
				return t
			}
			for _, o := range l.Obstacles {
				if o.Kind == Pillar && (fx-o.X)*(fx-o.X)+(fz-o.Z)*(fz-o.Z) < (o.R+v.Radius)*(o.R+v.Radius) {
					return t
				}
			}
		}
	}
	dx, dz := math.Cos(a), math.Sin(a)
	end := math.Inf(1)
	// walls: leave the room
	if dx > 1e-9 {
		end = math.Min(end, (HalfX+v.Radius-x0)/dx)
	} else if dx < -1e-9 {
		end = math.Min(end, (-HalfX-v.Radius-x0)/dx)
	}
	if dz > 1e-9 {
		end = math.Min(end, (HalfZ+v.Radius-z0)/dz)
	} else if dz < -1e-9 {
		end = math.Min(end, (-HalfZ-v.Radius-z0)/dz)
	}
	for _, o := range l.Obstacles {
		if o.Kind != Pillar {
			continue
		}
		if s, ok := rayCircle(x0, z0, dx, dz, o.X, o.Z, o.R+v.Radius); ok && s < end {
			end = s
		}
	}
	if math.IsInf(end, 1) || v.Speed <= 0 {
		return v.Life + 1
	}
	return b + math.Max(0, end)/v.Speed
}

// rayCircle is the first distance s >= 0 along the unit ray where it enters
// the circle (0 when it starts inside).
func rayCircle(x0, z0, dx, dz, cx, cz, r float64) (float64, bool) {
	fx, fz := x0-cx, z0-cz
	c := fx*fx + fz*fz - r*r
	if c <= 0 {
		return 0, true
	}
	bb := fx*dx + fz*dz
	disc := bb*bb - c
	if bb > 0 || disc < 0 {
		return 0, false
	}
	return -bb - math.Sqrt(disc), true
}

// LaserAt is the beam at t seconds after Fire: its yaw, its length (to the
// first pillar or wall) and whether it is live (false during the wind-up
// telegraph and after it ends).
func (v *Volley) LaserAt(t float64, l *Layout) (a, length float64, live bool) {
	a = v.Angle + float64(v.P3)*math.Pi/180000*math.Max(0, t)
	dx, dz := math.Cos(a), math.Sin(a)
	length = 60
	if dx > 1e-9 {
		length = math.Min(length, (HalfX-v.OX)/dx)
	} else if dx < -1e-9 {
		length = math.Min(length, (-HalfX-v.OX)/dx)
	}
	if dz > 1e-9 {
		length = math.Min(length, (HalfZ-v.OZ)/dz)
	} else if dz < -1e-9 {
		length = math.Min(length, (-HalfZ-v.OZ)/dz)
	}
	for _, o := range l.Obstacles {
		if o.Kind == Pillar {
			if s, ok := rayCircle(v.OX, v.OZ, dx, dz, o.X, o.Z, o.R); ok && s < length {
				length = s
			}
		}
	}
	return a, length, t >= 0 && t <= float64(v.P2)/1000
}

// RainAt is impact i: its centre, radius, when it lands (s after Fire).
func (v *Volley) RainAt(i int) (x, z, r, land float64) {
	h := Hash(v.Seed, uint32(i))
	x = (Unit(h)*2 - 1) * (HalfX - 1)
	z = (Unit(Mix(h))*2 - 1) * (HalfZ - 1)
	return x, z, float64(v.P2) / 100, float64(i*v.P3) / 1000
}

// Seeker is one homing orb's state (stepped at 30 Hz).
type Seeker struct {
	X, Z, A float64
	Dead    bool
}

// SeekerStep advances orb s by one tick toward (tx, tz): turn at most
// P1 degrees per second, then move; stops on a pillar or wall.
func (v *Volley) SeekerStep(s *Seeker, tx, tz float64, l *Layout) {
	if s.Dead {
		return
	}
	want := math.Atan2(tz-s.Z, tx-s.X)
	d := math.Mod(want-s.A+3*math.Pi, 2*math.Pi) - math.Pi
	maxTurn := float64(v.P1) * math.Pi / 180 / TickHz
	if d > maxTurn {
		d = maxTurn
	} else if d < -maxTurn {
		d = -maxTurn
	}
	s.A += d
	s.X += math.Cos(s.A) * v.Speed / TickHz
	s.Z += math.Sin(s.A) * v.Speed / TickHz
	if math.Abs(s.X) > HalfX || math.Abs(s.Z) > HalfZ {
		s.Dead = true
	}
	for _, o := range l.Obstacles {
		if o.Kind == Pillar && math.Hypot(s.X-o.X, s.Z-o.Z) < o.R+v.Radius {
			s.Dead = true
		}
	}
}

// Seekers starts a seeker volley's orbs.
func (v *Volley) Seekers() []Seeker {
	out := make([]Seeker, v.Count)
	for i := range out {
		_, a := v.born(i)
		out[i] = Seeker{X: v.OX + math.Cos(a)*0.6, Z: v.OZ + math.Sin(a)*0.6, A: a}
	}
	return out
}

// Ends is the last second after Fire anything of the volley can still hit.
func (v *Volley) Ends() float64 {
	switch v.Kind {
	case KindLaser:
		return float64(v.P2) / 1000
	case KindRain:
		return float64(max(0, v.Count-1)*v.P3)/1000 + 0.3
	}
	return v.Life
}
