package zoneregistry

// Load-aware region reassignment (WP19 second pass). Plan is sticky by
// design (moving a region hands off everyone in it), which left the WP19
// thailand failover run with one pool zone holding 612 players (tick p99
// 49 ms) while the others had 100-280: the dead zone's regions all went to
// whoever Plan's fallback picked and stayed there. Rebalance runs after Plan
// and moves at most ONE region per call from the busiest zone to the zone
// that ends up best balanced, when the busiest zone is clearly over its
// share. The zones then hand the region's players over exactly as for a
// border crossing (WP16): ownership changes, each player is pre-connected
// to the new owner and transferred, without a loading screen.
//
// It is pure (unit-tested, the same everywhere); the director adds the
// cooldown between moves so zones report their new load before the next one.

import (
	"fmt"
	"sort"

	"lodestone/server/pkg/constants"
)

// RegionLoad is one region's player count as a zone reports it (players it
// simulates standing in that region). Zones announce it in Entry.Load.
type RegionLoad struct {
	X       int `json:"x"`
	Z       int `json:"z"`
	Players int `json:"n"`
}

// RebalanceOptions tune Rebalance.
type RebalanceOptions struct {
	// Floor: a zone at or below this many players is never relieved
	// (spec 9's soft cap per region is 150; v1-capacity plans 300 per zone).
	Floor int
	// Ratio: the busiest zone is relieved only above Ratio x the mean load
	// of the zones that can take regions.
	Ratio float64
	// MinGain: a move must lower the busier side of the pair by at least
	// this many players (no shuffling for a handful).
	MinGain int
}

// DefaultRebalance is the director's default policy.
var DefaultRebalance = RebalanceOptions{Floor: 200, Ratio: 1.2, MinGain: 25}

// Move describes one reassignment.
type Move struct {
	Region   Region
	From, To string
	Players  int // players in the region when it moved
}

func (m Move) String() string {
	return fmt.Sprintf("region %d,%d (%d players) %s -> %s", m.Region.X, m.Region.Z, m.Players, m.From, m.To)
}

// Rebalance returns plan with at most one region moved to even out load,
// and the move (nil when none is worth it). plan is Plan's output for live;
// it is not modified.
func Rebalance(live []Entry, plan map[string][]Region, opt RebalanceOptions) (map[string][]Region, *Move) {
	primary := ""
	pools := map[string]bool{}
	pinned := map[Region]bool{}
	for _, e := range live {
		switch e.Role {
		case RolePrimary:
			if primary == "" || e.ZoneID < primary {
				primary = e.ZoneID
			}
		case RolePool:
			pools[e.ZoneID] = true
		default:
			for _, r := range e.Regions {
				pinned[r] = true
			}
		}
	}
	if primary == "" || len(pools) == 0 {
		return plan, nil
	}
	// Ownership under the plan: a live pool zone's assigned regions, pinned
	// regions are out of play, the primary owns the rest.
	owner := map[Region]string{}
	for z, rs := range plan {
		if !pools[z] {
			continue
		}
		for _, r := range rs {
			if !pinned[r] {
				owner[r] = z
			}
		}
	}
	var load [constants.WorldRegions][constants.WorldRegions]int
	for _, e := range live {
		for _, l := range e.Load {
			if l.X >= 0 && l.X < constants.WorldRegions && l.Z >= 0 && l.Z < constants.WorldRegions && l.Players > 0 {
				load[l.X][l.Z] += l.Players
			}
		}
	}
	zones := []string{primary}
	for z := range pools {
		zones = append(zones, z)
	}
	sort.Strings(zones)
	zoneLoad := map[string]int{}
	regions := map[string][]Region{}
	for x := 0; x < constants.WorldRegions; x++ {
		for z := 0; z < constants.WorldRegions; z++ {
			r := Region{X: x, Z: z}
			if pinned[r] {
				continue
			}
			o := owner[r]
			if o == "" {
				o = primary
			}
			zoneLoad[o] += load[x][z]
			regions[o] = append(regions[o], r)
		}
	}
	total := 0
	busiest := ""
	for _, z := range zones {
		total += zoneLoad[z]
		if busiest == "" || zoneLoad[z] > zoneLoad[busiest] {
			busiest = z
		}
	}
	hi := zoneLoad[busiest]
	mean := float64(total) / float64(len(zones))
	if hi <= opt.Floor || float64(hi) <= opt.Ratio*mean || len(regions[busiest]) < 2 {
		return plan, nil
	}
	// The single move that leaves the pair's busier side lowest; ties to a
	// region bordering the receiver (fewer new borders), then to the
	// receiver with the lower id and the region in x-major order.
	type cand struct {
		r      Region
		to     string
		after  int
		border bool
	}
	var best *cand
	for _, r := range regions[busiest] {
		n := load[r.X][r.Z]
		if n == 0 {
			continue
		}
		for _, to := range zones {
			if to == busiest {
				continue
			}
			after := max(hi-n, zoneLoad[to]+n)
			if after > hi-opt.MinGain {
				continue
			}
			c := cand{r: r, to: to, after: after, border: borders(regions[to], r)}
			if best == nil || c.after < best.after || (c.after == best.after && c.border && !best.border) {
				best = &c
			}
		}
	}
	if best == nil {
		return plan, nil
	}
	next := map[string][]Region{}
	for z, rs := range plan {
		for _, r := range rs {
			if !(z == busiest && r == best.r) {
				next[z] = append(next[z], r)
			}
		}
	}
	if best.to != primary { // the primary takes whatever no pool zone holds
		next[best.to] = append(next[best.to], best.r)
	}
	return next, &Move{Region: best.r, From: busiest, To: best.to, Players: load[best.r.X][best.r.Z]}
}

// borders reports whether r shares an edge with any region in rs.
func borders(rs []Region, r Region) bool {
	for _, o := range rs {
		dx, dz := o.X-r.X, o.Z-r.Z
		if dx*dx+dz*dz == 1 {
			return true
		}
	}
	return false
}
