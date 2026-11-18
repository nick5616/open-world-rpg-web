package worldedit

import "math"

// The dig/fill planner: given where a shovel struck, which vertices change.
//
//   - a brush of BrushR m around the strike: the middle takes 2 steps
//     (0.5 m), the rim 1 step (0.25 m), per swing;
//   - the surface keeps a walkable slope: neighbouring deltas differ by at
//     most MaxSlope steps per metre (3 = 37 degrees), so a pit is a bowl you
//     can climb out of and a mound is a cone, never a spike. A dig that
//     steepens a neighbour lowers it too, spreading outward (a cascade),
//     bounded by MaxChanged vertices;
//   - a dig never takes the ground below water + WaterMargin (holes stay
//     dry), never goes past +-MaxDelta, and the whole plan is refused if any
//     vertex it would touch is protected (towns, sites, roads, cave roofs:
//     World.Allowed) or off the world.
const (
	BrushR     = 1.6
	BrushCore  = 0.8
	MaxSlope   = 3 // steps per metre between 4-neighbours (36.9 degrees); diagonals get 4. Any cell triangle then stays under 47 degrees, walkable (WALKABLE_SLOPE_DEG 50)
	MaxChanged = 360
	// WaterMargin: a dug vertex stays this far above the water surface.
	WaterMargin = 0.3
	// StepsPerItem: this many steps of volume are one dirt (or stone).
	StepsPerItem = 6
)

// Op is what the shovel does.
type Op uint8

const (
	Dig  Op = 1
	Fill Op = 2
)

// Refusal reasons of a plan (the zone maps them to Event 1805 values).
type Refusal uint8

const (
	OK        Refusal = 0
	Forbidden Refusal = 1 // a town, site, road, cave roof or the edge of the world
	AtLimit   Refusal = 2 // already at the +-6 m cap or the water line: nothing would change
	TooBig    Refusal = 3 // the slope cascade would reach too far
	Full      Refusal = 4 // zone edit storage full (set by the caller)
	// Bedrock: a dig where the ground already sits at the -MaxDelta cap (6 m
	// down). The zone sends it as the same "no change" refusal (Event 1806
	// value 5); the client tells it from the water line by the delta it can
	// see, says so ("You have hit bedrock") and the terrain shows bedrock there.
	Bedrock Refusal = 5
)

// World is what the planner needs from the host.
type World interface {
	// Base is the generated f32 lattice height at the vertex.
	Base(x, z int32) float32
	// Water is the water surface at the vertex (sea level where there is none).
	Water(x, z int32) float64
	// Allowed reports whether the vertex may be edited.
	Allowed(x, z int32) bool
}

// Plan is the outcome of one swing.
type Plan struct {
	Changes []Change
	// Lowered and Raised: steps of volume removed and added (sums of |change|).
	Lowered, Raised int
	// Center is the vertex under the strike (the deepest for a dig), for debris and sounds.
	CenterX, CenterZ int32
}

type planner struct {
	o       *Overlay
	w       World
	op      Op
	cur     map[[2]int32]int8 // working deltas
	orig    map[[2]int32]int8
	queue   [][2]int32
	reason  Refusal
	changed int
}

func (p *planner) get(x, z int32) int8 {
	if d, ok := p.cur[[2]int32{x, z}]; ok {
		return d
	}
	return p.o.Delta(x, z)
}

func (p *planner) set(x, z int32, d int8) bool {
	k := [2]int32{x, z}
	if _, ok := p.orig[k]; !ok {
		if !p.w.Allowed(x, z) {
			p.reason = Forbidden
			return false
		}
		bx, bz := x>>6, z>>6
		if !inWorld(bx, bz) {
			p.reason = Forbidden
			return false
		}
		p.orig[k] = p.o.Delta(x, z)
		p.changed++
		if p.changed > MaxChanged {
			p.reason = TooBig
			return false
		}
	}
	p.cur[k] = d
	p.queue = append(p.queue, k)
	return true
}

// floor is the lowest delta a dig may leave at the vertex: above water +
// margin, within the cap, but never above where it already is (a vertex
// already low stays as it is).
func (p *planner) floor(x, z int32) int8 {
	cur := p.get(x, z)
	base := float64(p.w.Base(x, z))
	lowest := math.Ceil((p.w.Water(x, z)+WaterMargin-base)/StepM - 1e-9)
	if lowest < -MaxDelta {
		lowest = -MaxDelta
	}
	if lowest > float64(cur) {
		return cur
	}
	return int8(lowest)
}

// noChange is the refusal for a swing that would change nothing: a dig
// whose strike vertex is already at the cap is Bedrock, else AtLimit (the
// water line, or a fill at its cap).
func (p *planner) noChange(op Op, cx, cz int32) Refusal {
	if op == Dig && p.get(cx, cz) <= -MaxDelta {
		return Bedrock
	}
	return AtLimit
}

var nbrs = [8][3]int32{{1, 0, 3}, {-1, 0, 3}, {0, 1, 3}, {0, -1, 3}, {1, 1, 4}, {-1, 1, 4}, {1, -1, 4}, {-1, -1, 4}}

// Plan computes one swing at world point (px, pz). The Overlay is not
// changed; apply the returned Changes.
func PlanSwing(o *Overlay, w World, op Op, px, pz float64) (Plan, Refusal) {
	p := &planner{o: o, w: w, op: op, cur: map[[2]int32]int8{}, orig: map[[2]int32]int8{}}
	x0, x1 := int32(math.Floor(px-BrushR)), int32(math.Ceil(px+BrushR))
	z0, z1 := int32(math.Floor(pz-BrushR)), int32(math.Ceil(pz+BrushR))
	var cx, cz int32
	best := math.Inf(1)
	for z := z0; z <= z1; z++ {
		for x := x0; x <= x1; x++ {
			d := math.Hypot(float64(x)-px, float64(z)-pz)
			if d > BrushR {
				continue
			}
			if d < best {
				best, cx, cz = d, x, z
			}
			amt := int8(1)
			if d < BrushCore {
				amt = 2
			}
			cur := p.get(x, z)
			var nd int8
			if op == Dig {
				nd = max(cur-amt, p.floor(x, z))
				if nd > cur {
					nd = cur
				}
			} else {
				nd = min(cur+amt, MaxDelta)
			}
			if nd == cur {
				// still must be allowed to count as touched? no: untouched vertices are not edited
				continue
			}
			if !p.set(x, z, nd) {
				return Plan{}, p.reason
			}
		}
	}
	if len(p.queue) == 0 {
		return Plan{}, p.noChange(op, cx, cz)
	}
	// Slope cascade: spread the change outward until every neighbour pair is walkable.
	for len(p.queue) > 0 {
		k := p.queue[0]
		p.queue = p.queue[1:]
		d := p.cur[k]
		for _, n := range nbrs {
			nx, nz := k[0]+n[0], k[1]+n[1]
			lim := n[2]
			nd := p.get(nx, nz)
			var want int8
			if op == Dig {
				if int(nd) <= int(d)+int(lim) {
					continue
				}
				want = int8(int(d) + int(lim))
				if f := p.floor(nx, nz); want < f {
					p.reason = AtLimit
					return Plan{}, p.reason
				}
			} else {
				if int(nd) >= int(d)-int(lim) {
					continue
				}
				want = int8(int(d) - int(lim))
				if want > MaxDelta {
					want = MaxDelta
				}
			}
			if !p.set(nx, nz, want) {
				return Plan{}, p.reason
			}
		}
	}
	pl := Plan{CenterX: cx, CenterZ: cz}
	for k, nd := range p.cur {
		od := p.orig[k]
		if nd == od {
			continue
		}
		pl.Changes = append(pl.Changes, Change{X: k[0], Z: k[1], D: nd})
		if nd < od {
			pl.Lowered += int(od - nd)
		} else {
			pl.Raised += int(nd - od)
		}
	}
	if len(pl.Changes) == 0 {
		return Plan{}, p.noChange(op, cx, cz)
	}
	sortChanges(pl.Changes)
	return pl, OK
}

func sortChanges(c []Change) {
	// small insertion-friendly sort, deterministic (map order is random)
	for i := 1; i < len(c); i++ {
		for j := i; j > 0 && less(c[j], c[j-1]); j-- {
			c[j], c[j-1] = c[j-1], c[j]
		}
	}
}

func less(a, b Change) bool {
	if a.Z != b.Z {
		return a.Z < b.Z
	}
	return a.X < b.X
}

// ItemsFor converts steps of volume into whole items with a carried
// remainder (acc): yield = (steps + acc) / StepsPerItem.
func ItemsFor(steps, acc int) (items, rest int) {
	t := steps + acc
	return t / StepsPerItem, t % StepsPerItem
}

// CostFor is what a fill of this many raised steps costs (at least 1).
func CostFor(raised int) int {
	n := (raised + StepsPerItem - 1) / StepsPerItem
	if n < 1 {
		n = 1
	}
	return n
}
