package npc

// Richer schedules (playtest 4, CR 050 "lively townsfolk"): a town should
// look inhabited at every hour, not only "at the post by day, indoors by
// night".
//
//   - Lunch: a third of the villagers and farmers eat at the inn between
//     12:30 and 13:30 (they walk in through its door and stand at its
//     tables).
//   - Evening: from 19:00 to 20:30 about two in five of the off-duty folk
//     gather at the square to talk, one in five at the inn, the rest go home.
//   - Market hours: merchants keep their stall from 08:00 to 18:00.
//   - Guards walk a beat: a third of the time (75 s at a stretch) a guard
//     walks to a street point 7-18 m from his post and stands watch there,
//     then returns.
//   - Neighbours: a quarter of a day-shift villager's time (again in 75 s
//     stretches) goes on strolling to a neighbour's spot, who is then
//     (idle, next to them) good for a chat; another eighth sitting on a doorstep.
//   - Rain: villagers and farmers go indoors; merchants, smiths, guards and
//     keepers stay under their awnings.
//
// Nothing here runs per tick beyond what Want did already: the places (inn
// spot, beat point, doorstep, neighbours) are chosen once in New; Want costs one
// hash and a few comparisons per NPC per tick, goalPoint runs when a goal
// changes (one route plan, as before).

import (
	"math"

	"lodestone/server/pkg/towns"
)

// Goals beyond work/home/wander (npc.go).
const (
	GoalInn    = iota + 3 // inside the settlement's inn (lunch, evening)
	GoalSquare            // the square (evening gathering)
	GoalBeat              // a guard's beat point
	GoalVisit             // beside a neighbour
	GoalStep              // sitting on a doorstep
)

const (
	lunchFrom, lunchTo     = 12.5, 13.5
	eveningFrom, eveningTo = 19.0, 20.5
	marketFrom, marketTo   = 8.0, 18.0
	stretchS               = 75.0 // a visit, doorstep rest or beat lasts one stretch (75 s: half an in-game hour)

	// StepOutM is how far outside its door the step is (the client sits NPCs found there: npcs.ts).
	StepOutM = 2.0
)

// extras are the places an NPC can go beyond its work spot and home, chosen
// once in New.
type extras struct {
	inn     int     // the settlement's inn building, -1 none
	stepX   float64 // a doorstep to sit on (just outside a building's door)
	stepZ   float64
	step    bool
	hasBeat bool
	beatX   float64
	beatZ   float64
	friends []int // NPC indexes of neighbours (same settlement, within 45 m of the work spot)
}

func (w *World) buildExtras() {
	t := w.T
	w.ex = make([]extras, len(t.NPCs))
	for si := range t.Settlements {
		st := &t.Settlements[si]
		inn := -1
		for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
			if t.Buildings[b].Role == towns.BuildingInn && t.Buildings[b].Floors > 0 {
				inn = b
				break
			}
		}
		var steps [][2]float64 // 2 m outside each door: the step (or the porch) people sit on
		for b := st.BuildingFirst; b < st.BuildingFirst+st.Buildings; b++ {
			if bd := &t.Buildings[b]; bd.Floors > 0 {
				x, z := bd.Door(StepOutM)
				steps = append(steps, [2]float64{x, z})
			}
		}
		g := w.graphs[si]
		for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
			d := &t.NPCs[i]
			e := &w.ex[i]
			e.inn = inn
			// The nearest doorstep 3-25 m from the work spot.
			bd := 25.0
			for _, b := range steps {
				if dd := math.Hypot(b[0]-d.WorkX, b[1]-d.WorkZ); dd < bd && dd > 3 {
					bd, e.stepX, e.stepZ, e.step = dd, b[0], b[1], true
				}
			}
			// A beat point on the street graph, 7-18 m from the post.
			if d.Role == towns.RoleGuard {
				var cand [][2]float64
				for _, p := range g.pts {
					if dd := math.Hypot(p[0]-d.WorkX, p[1]-d.WorkZ); dd >= 7 && dd <= 18 {
						cand = append(cand, p)
					}
				}
				if len(cand) > 0 {
					p := cand[mix(d.ID^0xB347)%uint64(len(cand))]
					e.hasBeat, e.beatX, e.beatZ = true, p[0], p[1]
				}
			}
			// Neighbours to stroll to: the four nearest working spots.
			type nb struct {
				i int
				d float64
			}
			var near []nb
			for j := st.NPCFirst; j < st.NPCFirst+st.NPCs; j++ {
				o := &t.NPCs[j]
				if j == i || o.Role == towns.RoleGuard {
					continue
				}
				if dd := math.Hypot(o.WorkX-d.WorkX, o.WorkZ-d.WorkZ); dd <= 45 && dd > 0.5 {
					near = append(near, nb{j, dd})
				}
			}
			for a := 1; a < len(near); a++ { // insertion sort: tiny lists
				for b := a; b > 0 && (near[b].d < near[b-1].d || (near[b].d == near[b-1].d && near[b].i < near[b-1].i)); b-- {
					near[b], near[b-1] = near[b-1], near[b]
				}
			}
			for k := 0; k < len(near) && k < 4; k++ {
				e.friends = append(e.friends, near[k].i)
			}
		}
	}
}

// slotFor is the time slot a goal's point depends on (a change re-plans the
// walk): wander points change every 25 s, beats, visits and bench rests every
// stretch; everything else is fixed.
func slotFor(g int, todS float64) int64 {
	switch g {
	case GoalWander:
		return int64(todS / 25)
	case GoalBeat, GoalVisit, GoalStep:
		return int64(todS / stretchS)
	}
	return 0
}

// roll is the NPC's number for the current stretch (75 s) of the day.
func (w *World) roll(i int, todS float64) uint64 {
	d := w.NPCs[i].Def
	return mix(d.ID*0x9E3779B97F4A7C15 ^ uint64(int64(todS/stretchS))*0xD6E8FEB86659FD93)
}

// shelters: who goes indoors when it rains (the rest stand under awnings).
func shelters(role uint8) bool { return role == towns.RoleVillager || role == towns.RoleFarmer }

// evening reports which gathering NPC i joins at hour h: GoalSquare, GoalInn
// or -1 (goes home). The pick is fixed per NPC (a regular), not per night.
func (w *World) evening(i int, h float64, d *towns.NPC) int {
	from := eveningFrom
	if d.Role == towns.RoleFarmer {
		from = 18 // their day ends an hour earlier
	}
	if h < from || h >= eveningTo || d.Role == towns.RoleInnkeeper || d.Role == towns.RoleGuard {
		return -1
	}
	k := mix(d.ID^0x51ED270B) % 10
	hasInn := w.ex[i].inn >= 0
	switch {
	case k < 4 && !w.Rain:
		return GoalSquare
	case k < 4 && hasInn: // rain: the regulars of the square squeeze into the inn
		return GoalInn
	case k >= 4 && k < 6 && hasInn:
		return GoalInn
	}
	return -1
}

// lifeWant is Want's day logic for an NPC that is working today.
func (w *World) lifeWant(i int, h, todS float64, d *towns.NPC) int {
	e := &w.ex[i]
	if w.Rain && shelters(d.Role) {
		return GoalHome
	}
	r := w.roll(i, todS)
	switch d.Role {
	case towns.RoleGuard:
		if e.hasBeat && r%3 == 0 {
			return GoalBeat
		}
		return GoalWork
	case towns.RoleVillager, towns.RoleFarmer:
		if h >= lunchFrom && h < lunchTo && e.inn >= 0 && mix(d.ID^0x10C4)%3 == 0 {
			return GoalInn
		}
		if d.Role == towns.RoleFarmer {
			return GoalWork
		}
		switch r % 8 {
		case 0, 1:
			if len(e.friends) > 0 {
				return GoalVisit
			}
		case 2:
			if e.step {
				return GoalStep
			}
		}
		return GoalWander
	}
	return GoalWork
}

// lifePoint is where NPC i goes for the new goals.
func (w *World) lifePoint(i, g int, todS float64) [2]float64 {
	d := w.NPCs[i].Def
	e := &w.ex[i]
	h := mix(d.ID ^ 0xA11CE)
	switch g {
	case GoalInn:
		if e.inn >= 0 {
			b := &w.T.Buildings[e.inn]
			u := (float64(h&0xFFFF)/65536*2 - 1) * b.HX * 0.55
			v := (float64((h>>16)&0xFFFF)/65536*2 - 1) * b.HZ * 0.45
			return [2]float64{b.X + u*b.C - v*b.S, b.Z + u*b.S + v*b.C}
		}
	case GoalSquare:
		st := &w.T.Settlements[d.Settlement]
		r := 2 + float64((h>>8)&0xFFFF)/65536*math.Max(1.5, math.Min(st.Square*0.7, 6))
		a := float64((h>>24)&0xFFFF) / 65536 * 2 * math.Pi
		return [2]float64{st.X + r*math.Cos(a), st.Z + r*math.Sin(a)}
	case GoalBeat:
		if e.hasBeat {
			return [2]float64{e.beatX, e.beatZ}
		}
	case GoalStep:
		if e.step {
			return [2]float64{e.stepX, e.stepZ}
		}
	case GoalVisit:
		if len(e.friends) > 0 {
			rr := w.roll(i, todS)
			f := w.T.NPCs[e.friends[int(rr>>8)%len(e.friends)]]
			a := float64((rr>>24)&0xFFFF) / 65536 * 2 * math.Pi
			return [2]float64{f.WorkX + 1.5*math.Cos(a), f.WorkZ + 1.5*math.Sin(a)}
		}
	}
	return [2]float64{d.WorkX, d.WorkZ}
}

// DuskLines are what a guard calls when the day's light goes (once per town
// per evening; the zone picks one by town and night).
var DuskLines = []string{
	"Lanterns! Light the lanterns!",
	"Gates close at nightfall!",
	"Lamps up, folks. Dusk is here.",
	"Off the roads before dark, all of you!",
	"Night watch to your posts!",
}

// DuskLine is the guard's call for settlement si on night idx (deterministic).
func DuskLine(si int, idx int64) string {
	return DuskLines[mix(uint64(si)*0x9E3779B97F4A7C15^uint64(idx)*0xD6E8FEB86659FD93)%uint64(len(DuskLines))]
}
