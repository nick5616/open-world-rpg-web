package rift

// Where rifts open (CR 040). Time is cut into windows of WindowS seconds;
// in each window every 256 m area of the world draws a score from the
// world seed, the window and the area, weighted by how dangerous the area
// is, and the best ActivePortals spots that pass the zone's ground check
// open a rift for that window. Same seed, same window: same rifts, on every
// zone and after a restart (nothing is stored).

import (
	"math"
	"sort"
)

const (
	// WindowS is how long a set of rifts stays open.
	WindowS = 20 * 60
	// ActivePortals is how many rifts are open in the world at once.
	ActivePortals = 4
	// AreaM is the cell the draw is made in (the difficulty grid).
	AreaM = 256
	// PortalSepM keeps two rifts apart.
	PortalSepM = 600
)

// Candidate is one area's draw for a window.
type Candidate struct {
	Cell  int
	X, Z  float64
	Score float64
}

// Window is the window index of a unix time.
func Window(unixS int64) int64 { return unixS / WindowS }

// WindowEnds is when window w closes (unix seconds).
func WindowEnds(w int64) int64 { return (w + 1) * WindowS }

// Candidates draws every area of a world worldM wide for window w, best
// first. weight(cell) scales an area's chance (area difficulty; 0 = never,
// e.g. the Haven or water). Each candidate's spot is a point inside the
// area away from its edges; Alt gives other spots in the same area when the
// first fails the ground check.
func Candidates(seed uint64, w int64, worldM float64, weight func(x, z float64) float64) []Candidate {
	n := int(worldM / AreaM)
	var out []Candidate
	s0 := uint32(seed) ^ uint32(seed>>32)
	for cz := 0; cz < n; cz++ {
		for cx := 0; cx < n; cx++ {
			cell := cz*n + cx
			x, z := Alt(seed, w, cell, n, 0)
			wt := weight(x, z)
			if wt <= 0 {
				continue
			}
			h := Hash(s0, uint32(w), uint32(w>>32), uint32(cell), 0x417)
			// exponential race: the largest u^(1/wt) wins with probability wt / sum
			score := math.Pow(Unit(h)+1e-12, 1/wt)
			out = append(out, Candidate{Cell: cell, X: x, Z: z, Score: score})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Cell < out[j].Cell
	})
	return out
}

// Alt is try k's spot in an area (32-224 m into it).
func Alt(seed uint64, w int64, cell, n, k int) (float64, float64) {
	h := Hash(uint32(seed), uint32(w), uint32(cell), uint32(k), 0xa17)
	cx, cz := cell%n, cell/n
	return float64(cx*AreaM) + 32 + Unit(h)*(AreaM-64), float64(cz*AreaM) + 32 + Unit(Mix(h))*(AreaM-64)
}

// Pick takes the best candidates that pass ok (the ground check, possibly
// moving the spot) and lie PortalSepM apart, up to ActivePortals.
func Pick(cands []Candidate, ok func(c *Candidate) bool) []Candidate {
	var out []Candidate
	for i := range cands {
		if len(out) >= ActivePortals {
			break
		}
		c := cands[i]
		far := true
		for _, o := range out {
			if math.Hypot(o.X-c.X, o.Z-c.Z) < PortalSepM {
				far = false
				break
			}
		}
		if far && ok(&c) {
			out = append(out, c)
		}
	}
	return out
}

// TierWeight is an area's rift weight by its difficulty tier index
// (combat.yaml difficulty.tiers: 0 haven .. 5 deadlands): never in the
// Haven, more often where it is dangerous.
func TierWeight(tier int) float64 {
	if tier <= 0 {
		return 0
	}
	return 1 + 0.35*float64(tier-1)
}
