package worldhost

import "math"

// SamplePoints returns n deterministic (x, z) points for cross-host height
// comparisons (Go fast path vs wasm vs Node vs Chromium). Most are uniform
// over the world at full f64 precision; every 8th point is an awkward case:
// an exact lattice point, a cell diagonal (fx + fz == 1, where the triangle
// choice flips), a chunk border, or a point just outside the world.
func SamplePoints(n int, seed uint64) [][2]float64 {
	const ws = float64(WorldChunks * ChunkSize)
	pts := make([][2]float64, 0, n)
	s := seed
	next := func() float64 {
		s = splitmix(s)
		return float64(s>>11) / (1 << 53) // [0, 1) with 53 random bits
	}
	for i := 0; i < n; i++ {
		x, z := next()*ws, next()*ws
		switch i % 8 {
		case 1:
			x, z = math.Floor(x), math.Floor(z)
		case 3:
			fx := next()
			x, z = math.Floor(x)+fx, math.Floor(z)+(1-fx)
		case 5:
			x = math.Floor(x/ChunkSize) * ChunkSize
		case 7:
			if i%16 == 7 {
				x = -x / 16 // up to 256 m west of the world
			} else {
				z = ws + z/16 // up to 256 m south of it
			}
		}
		pts = append(pts, [2]float64{x, z})
	}
	return pts
}
