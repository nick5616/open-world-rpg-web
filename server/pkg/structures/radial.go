package structures

import (
	"math"

	"lodestone/server/pkg/movement"
)

// Radial is a solid of revolution around a vertical axis: its top surface
// is a piecewise-linear profile of drop below TopY against the distance r
// from the axis. Flat segments are platforms and ledges, steep ones walls.
// Beyond the last breakpoint the profile continues down at Tail (m of drop
// per m of r) until MaxR, so a wall always reaches the terrain however the
// ground falls away around it.
//
// TS twin: client/src/world/structures/overlay.ts `RadialStructure`; the
// arithmetic below is mirrored operation for operation.
type Radial struct {
	CX, CZ float64
	TopY   float64
	// R are increasing breakpoint radii (R[0] = top platform radius) and
	// Drop the drop below TopY at each (Drop[0] = 0, non-decreasing).
	R, Drop []float64
	Tail    float64
	MaxR    float64

	slope []float64 // per segment, computed once (same op in TS)
	maxR2 float64
}

// NewRadial validates and prepares a profile. Breakpoints must be
// increasing in r and non-decreasing in drop; Tail > 0; MaxR >= last R.
func NewRadial(cx, cz, topY float64, r, drop []float64, tail, maxR float64) *Radial {
	if len(r) == 0 || len(r) != len(drop) || tail <= 0 {
		panic("structures: bad radial profile")
	}
	p := &Radial{CX: cx, CZ: cz, TopY: topY, R: append([]float64(nil), r...), Drop: append([]float64(nil), drop...), Tail: tail, MaxR: math.Max(maxR, r[len(r)-1])}
	p.slope = make([]float64, len(r)-1)
	for i := range p.slope {
		if !(r[i+1] > r[i]) || drop[i+1] < drop[i] {
			panic("structures: radial profile must increase in r and not rise")
		}
		p.slope[i] = (drop[i+1] - drop[i]) / (r[i+1] - r[i])
	}
	p.maxR2 = float64(p.MaxR * p.MaxR)
	return p
}

// Bounds implements Structure.
func (p *Radial) Bounds() (float64, float64, float64, float64) {
	return p.CX - p.MaxR, p.CZ - p.MaxR, p.CX + p.MaxR, p.CZ + p.MaxR
}

// dropAt is the profile's drop at radius r and the slope there (0 on the
// platform). Shared by Top and Normal so both read one profile.
func (p *Radial) dropAt(r float64) (drop, slope float64) {
	if r <= p.R[0] {
		return 0, 0
	}
	n := len(p.R)
	for i := 0; i < n-1; i++ {
		if r <= p.R[i+1] {
			return p.Drop[i] + float64((r-p.R[i])*p.slope[i]), p.slope[i]
		}
	}
	return p.Drop[n-1] + float64((r-p.R[n-1])*p.Tail), p.Tail
}

// Top implements Structure.
func (p *Radial) Top(x, z float64) (float64, bool) {
	dx, dz := x-p.CX, z-p.CZ
	d2 := float64(dx*dx) + float64(dz*dz)
	if d2 > p.maxR2 {
		return 0, false
	}
	drop, _ := p.dropAt(math.Sqrt(d2))
	return p.TopY - drop, true
}

// Normal implements Structure: for h = TopY - drop(r), grad h = -s (dx, dz)/r,
// so the normal is (s dx/r, 1, s dz/r) normalized.
func (p *Radial) Normal(x, z float64) movement.Vec3 {
	dx, dz := x-p.CX, z-p.CZ
	r := math.Sqrt(float64(dx*dx) + float64(dz*dz))
	_, s := p.dropAt(r)
	if s == 0 || r == 0 {
		return movement.Vec3{Y: 1}
	}
	nx, nz := float64(s*dx)/r, float64(s*dz)/r
	l := math.Sqrt(float64(nx*nx) + float64(nz*nz) + 1)
	return movement.Vec3{X: nx / l, Y: 1 / l, Z: nz / l}
}
