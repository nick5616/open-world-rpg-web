package towns_test

import (
	"math"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/towns"
)

// The enemy blocker answers exactly what the players' push-out does for a
// player-sized body (Collide moves it iff Blocked says it overlaps), around
// every building of the official world, and its broadphase never hides a
// box: a body Near says is clear overlaps nothing.
func TestBlockerAgreesWithPlayerCollision(t *testing.T) {
	mod := loadModule(t)
	tw := doorTowns(t, mod, 20261108)
	c := towns.NewCollision(&tw.Boxes)
	b := towns.NewBlocker(c, float64(constants.WorldSizeM))
	per := int(math.Ceil(float64(constants.WorldSizeM) / towns.MaskCell))
	if m := b.Marked(); m == 0 || m > per*per/4 {
		t.Fatalf("mask marks %d of %d squares", m, per*per)
	}
	blocked, clear, far := 0, 0, 0
	for bi := range tw.Buildings {
		bd := &tw.Buildings[bi]
		for _, y := range []float64{bd.FloorY, bd.BaseY} {
			for u := -bd.HX - 3; u <= bd.HX+3; u += 0.37 {
				for v := -bd.HZ - 3; v <= bd.HZ+3; v += 0.41 {
					x, z := bd.Local(u, v)
					r := c.Collide(x, y, z)
					moved := r.PushX != 0 || r.PushZ != 0
					got := b.Blocked(x, y, z, constants.PlayerCapsuleRadius, towns.HeadM)
					if got != moved {
						t.Fatalf("building %d at (%.3f, %.3f, %.3f): Blocked %v, Collide push (%v, %v)", bi, x, y, z, got, r.PushX, r.PushZ)
					}
					if got {
						blocked++
					} else {
						clear++
					}
					// A wider body (an ogre-sized enemy) is blocked wherever a
					// player-sized one is.
					if got && !b.Blocked(x, y, z, 1.4, 3) {
						t.Fatalf("building %d at (%.3f, %.3f): a 1.4 m body passes where a player's is blocked", bi, x, z)
					}
				}
			}
		}
	}
	// The broadphase never hides a box: wherever Near says clear (sampled
	// on rings around every building, where it matters), every solid box
	// is more than MaskCell away.
	boxDist := func(i int, x, z float64) float64 {
		f := tw.Boxes.F
		o := i * 9
		dx, dz := x-f[o], z-f[o+1]
		u := dx*f[o+2] + dz*f[o+3]
		v := dz*f[o+2] - dx*f[o+3]
		du := u - min(max(u, -f[o+4]), f[o+4])
		dv := v - min(max(v, -f[o+5]), f[o+5])
		return math.Hypot(du, dv)
	}
	for bi := range tw.Buildings {
		bd := &tw.Buildings[bi]
		for ring := 4.0; ring <= 28; ring += 6 {
			for a := 0.0; a < 2*math.Pi; a += 0.3 {
				x, z := bd.X+(bd.HX+ring)*math.Cos(a), bd.Z+(bd.HZ+ring)*math.Sin(a)
				if b.Near(x, z) {
					continue
				}
				far++
				for _, i := range c.Candidates(x, z, 2*towns.MaskCell, nil) {
					if tw.Boxes.Flags[i]&towns.FlagSolid != 0 && boxDist(int(i), x, z) <= towns.MaskCell {
						t.Fatalf("(%.1f, %.1f): broadphase clear %.2f m from solid box %d", x, z, boxDist(int(i), x, z), i)
					}
				}
			}
		}
	}
	if blocked < 1000 || clear < 1000 || far < 1000 {
		t.Fatalf("too few samples: %d blocked, %d clear, %d far", blocked, clear, far)
	}
	t.Logf("%d blocked, %d clear around %d buildings; %d far samples; %d mask squares", blocked, clear, len(tw.Buildings), far, b.Marked())
}

// BenchmarkBlocker: one enemy movement query on the official world, far
// from towns (the broadphase answers) and hugging buildings (the narrow
// phase runs). The zone pays it per enemy step try (combat stepMove).
//
//	cd server/pkg && go test ./towns -run '^$' -bench Blocker
func BenchmarkBlocker(b *testing.B) {
	tw := doorTowns(b, loadModule(b), 20261108)
	bl := towns.NewBlocker(towns.NewCollision(&tw.Boxes), float64(constants.WorldSizeM))
	var far, near [][3]float64
	for x := 4.0; x < float64(constants.WorldSizeM) && len(far) < 4096; x += 37 {
		for z := 4.0; z < float64(constants.WorldSizeM) && len(far) < 4096; z += 41 {
			if !bl.Near(x, z) {
				far = append(far, [3]float64{x, 0, z})
			}
		}
	}
	for bi := 0; bi < len(tw.Buildings) && len(near) < 4096; bi++ {
		bd := &tw.Buildings[bi]
		for a := 0.0; a < 2*math.Pi; a += 0.7 {
			x, z := bd.Local((bd.HX+0.6)*math.Cos(a), (bd.HZ+0.6)*math.Sin(a))
			near = append(near, [3]float64{x, bd.FloorY, z})
		}
	}
	for _, c := range []struct {
		name string
		pts  [][3]float64
	}{{"far", far}, {"near", near}} {
		b.Run(c.name, func(b *testing.B) {
			n := 0
			for i := 0; i < b.N; i++ {
				p := c.pts[i%len(c.pts)]
				if bl.Blocked(p[0], p[1], p[2], 0.45, 1.6) {
					n++
				}
			}
			b.ReportMetric(float64(n)/float64(b.N), "blocked/op")
		})
	}
}
