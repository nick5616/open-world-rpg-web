package combat

// Enemy pathfinding (playtest 2): requests, following and the serial nav
// pass (the grid and the search are nav.go, caves navcave.go).
//
// Paths are only for walkers whose direct step is refused: moveToward keeps
// the cheap straight steering (stepMove's +/-69 degree fan) and counts the
// ticks the straight step was refused by the ground's slope, water, a
// building, a closed door, a camp piece or a cave wall. After navBlockTicks
// in a row it asks for a path (want). The ask is only a flag on the enemy,
// so it is safe from the AI workers (par.go); the serial nav pass after the
// enemy loop (navTick) queues the asks in spawn order (then summons, then
// pets) and runs the searches FIFO within the tick budget. Same seed, same
// inputs: same queue, same budget slices, same paths.
//
// A walker with a path follows its waypoints with the same stepMove (the
// fan still smooths corners) and asks again when its target has moved away
// from where the path was planned (hysteresis: 2.5 m + a quarter of the
// distance), when it stops making progress, or when the path runs out and
// the straight step is still refused. Flyers never path (they float over
// ground obstacles), bosses neither (open arenas). Demons path like
// everyone else and still shadow-step. A walker following a path may stray
// navLeashMult x its leash from home (a detour around a building is not
// "too far"), and a returning one gets navReturnS instead of 6 s before it
// is put home. A chaser whose searches keep failing (no way in: a closed
// house) gives up and returns after navGiveUp attempts.

import (
	"math"

	"lodestone/server/pkg/movement"
)

const (
	navBlockTicks = 3     // refused straight steps in a row before a path is asked for
	navReqGap     = 15    // ticks between two asks of one walker
	navFailGap    = 30    // ticks after a failed search before the next ask
	navGiveUp     = 3     // failed searches in a row: a chaser returns home
	navStuckTicks = 30    // refused steps in a row while following: re-plan
	navMaxAge     = 450   // ticks a path is followed at most (15 s)
	navLeashMult  = 1.5   // leash allowance while following a path
	navReturnS    = 20.0  // a returning walker on a path is put home after this
	navMaxSpan    = 110.0 // m: start and goal farther apart than this are not searched
)

// stepMove's verdict on the straight step.
const (
	stepDirect   = 0 // the straight step was taken
	stepBlocked  = 1 // refused by slope, water, an obstacle or a cave wall (paths help)
	stepRefused  = 2 // refused otherwise (world edge, boss arena, a ward): no path
	stepSteered  = 3 // refused straight, taken at an angle (counts as blocked)
	stepNoMotion = 4
)

// navState is one walker's path and its asks (allocated the first time
// its straight step is refused).
type navState struct {
	path    []movement.Vec3
	idx     int
	goal    movement.Vec3 // where the target was when the path was planned
	planned uint32
	length  float64
	partial bool
	cave    bool // the path goes through a cave mouth (pets)
	blocked uint8
	stuck   uint8
	fails   uint8
	want    bool
	queued  bool
	wantTo  movement.Vec3
	nextReq uint32
}

func (n *navState) following() bool { return n != nil && n.idx < len(n.path) }

func (n *navState) clear() {
	n.path, n.idx = n.path[:0], 0
	n.stuck = 0
	n.cave = false
}

// navUses: walkers that path (flyers float over obstacles; bosses fight in
// open arenas; a training dummy never moves).
func (e *Enemy) navUses() bool {
	return e.Def.Behavior != "flyer" && e.Boss == nil
}

// navWant asks for a path to t (taken by the next nav pass).
func (w *World) navWant(e *Enemy, t movement.Vec3) {
	if e.nav == nil {
		e.nav = &navState{}
	}
	n := e.nav
	if n.queued || n.want || w.tick < n.nextReq {
		return
	}
	n.want, n.wantTo = true, t
	w.navWanted = true
}

// navLeash is the leash factor for e right now.
func (e *Enemy) navLeash() float64 {
	if e.nav.following() {
		return navLeashMult
	}
	return 1
}

// navUnreachable: a chaser whose searches keep failing while its straight
// step is refused (give up and go home).
func (e *Enemy) navUnreachable() bool {
	n := e.nav
	return n != nil && n.fails >= navGiveUp && n.blocked >= navBlockTicks && !n.following()
}

// walkToward is moveToward with pathfinding on or off.
func (w *World) walkToward(e *Enemy, t movement.Vec3, speedFrac float64, nav bool) {
	nav = nav && e.navUses() && !w.navOff
	if nav && e.ally != nil && w.caveQ != nil && (w.tick+e.ID)%10 == 0 {
		w.navCaveCheck(e, t) // pets and summons: the owner went in or out of a cave
	}
	if nav && e.nav.following() {
		if w.navFollow(e, t, speedFrac) {
			return
		}
	}
	dx, dz := t.X-e.Pos.X, t.Z-e.Pos.Z
	d := math.Hypot(dx, dz)
	if d < 0.05 {
		e.Vel = movement.Vec3{}
		return
	}
	step := math.Min(d, w.speedOf(e, speedFrac)*dt)
	e.Yaw = yawTo(dx, dz)
	r := w.stepMove(e, dx/d*step, dz/d*step, true)
	if !nav {
		return
	}
	switch r {
	case stepBlocked, stepSteered:
		if e.nav == nil {
			e.nav = &navState{}
		}
		if e.nav.blocked < 255 {
			e.nav.blocked++
		}
		if e.nav.blocked >= navBlockTicks && d > 1 {
			w.navWant(e, t)
		}
	case stepDirect:
		if e.nav != nil {
			e.nav.blocked = 0
		}
	}
}

// speedOf is e's walking speed at speedFrac (moveToward's rules).
func (w *World) speedOf(e *Enemy, speedFrac float64) float64 {
	sp := e.Def.Speed * e.SpeedMult * speedFrac
	if e.Boss != nil {
		sp *= e.Boss.Def.Phases[e.Boss.Phase].SpeedMult
	}
	if e.has("slow", w.tick) {
		sp *= D.StatusByKey("slow").SpeedMult
	}
	return sp
}

// navFollow walks e along its path toward t; false when the path is done
// (or dropped) and the straight walk should take over this tick.
func (w *World) navFollow(e *Enemy, t movement.Vec3, speedFrac float64) bool {
	n := e.nav
	moved := hdist(t, n.goal)
	if moved > 10 && !n.cave || w.tick-n.planned > navMaxAge {
		n.clear() // a different target altogether (home, another player): walk straight meanwhile
		w.navWant(e, t)
		return false
	}
	if !n.cave && (w.tick+e.ID)%4 == 0 && hdist(e.Pos, t) < 20 && w.navPeekLOS(e.Pos, t, navClassOf(e.Radius())) {
		n.clear() // the target came round into the open: straight at it
		n.blocked = 0
		return false
	}
	if moved > 2.5+0.25*hdist(e.Pos, t) {
		w.navWant(e, t) // keep following the old path until the new one arrives
	}
	sp := w.speedOf(e, speedFrac)
	reach := math.Max(0.45, sp*dt)
	for n.idx < len(n.path) && hdist(e.Pos, n.path[n.idx]) < reach {
		n.idx++
	}
	if n.idx >= len(n.path) {
		n.clear()
		return false
	}
	wp := n.path[n.idx]
	dx, dz := wp.X-e.Pos.X, wp.Z-e.Pos.Z
	d := math.Hypot(dx, dz)
	step := math.Min(d, sp*dt)
	e.Yaw = yawTo(dx, dz)
	switch w.stepMove(e, dx/d*step, dz/d*step, true) {
	case stepDirect:
		n.stuck = 0
	default:
		n.stuck++
		if n.stuck > navStuckTicks {
			n.clear()
			n.blocked = navBlockTicks
			if n.fails < 255 {
				n.fails++ // a path it cannot walk counts against it (no endless re-plans)
			}
			w.navWant(e, t)
		}
	}
	return true
}

// navLive: the walker a search is for still exists.
func (w *World) navLive(e *Enemy) bool {
	if !e.Alive() || e.gone {
		return false
	}
	if e.ally != nil {
		return w.summonIdx[e.ID] == e
	}
	return w.enemies[e.ID] == e
}

// navTick is the serial nav pass (Step, after the enemies, summons and
// pets moved): queue this tick's asks, run searches within the budget.
func (w *World) navTick() {
	if !w.navWanted && (w.nav == nil || (w.nav.cur == nil && len(w.nav.queue) == 0)) {
		return
	}
	if w.nav == nil {
		w.nav = newNavWorld()
	}
	n := w.nav
	if w.navWanted {
		w.navWanted = false
		take := func(e *Enemy) {
			if s := e.nav; s != nil && s.want {
				s.want, s.queued = false, true
				s.nextReq = w.tick + navReqGap
				n.queue = append(n.queue, e)
				n.Stats.Requests++
			}
		}
		for _, e := range w.aiList { // spawn order (thinkAll's list)
			take(e)
		}
		for _, e := range w.summons {
			take(e)
		}
		for _, e := range w.pets {
			take(e)
		}
		n.Stats.MaxQueue = max(n.Stats.MaxQueue, int64(len(n.queue)))
	}
	spent := 0
	for spent < navTickBudget {
		if n.cur == nil {
			if len(n.queue) == 0 {
				break
			}
			e := n.queue[0]
			n.queue[0] = nil
			n.queue = n.queue[1:]
			if len(n.queue) == 0 {
				n.queue = n.queue[:0:0]
			}
			if !w.navLive(e) {
				e.nav.queued = false
				continue
			}
			to := e.nav.wantTo
			var tail []movement.Vec3
			if w.caveQ != nil {
				var ok, grid bool
				to, tail, ok, grid = w.navCaveRoute(e, to)
				if !ok {
					w.navResult(e, nil, 0, false, false)
					continue
				}
				if !grid {
					w.navResult(e, tail, navPolyLen(e.Pos, tail), false, true)
					continue
				}
			}
			if hdist(e.Pos, to) > navMaxSpan {
				w.navResult(e, nil, 0, false, false)
				continue
			}
			class := navClassOf(e.Radius())
			if len(tail) == 0 {
				spent += 8
				if wps, hit, ok := w.navShared(class, e.Pos, to); hit {
					if ok {
						n.Stats.Shared++
						w.navResult(e, wps, navPolyLen(e.Pos, wps), false, false)
					} else {
						n.Stats.SharedFail++
						w.navResult(e, nil, 0, false, false)
					}
					continue
				}
			}
			if spent > navTickBudget-2*navChunkCost {
				// a new search may build its first chunks: next tick
				n.queue = append([]*Enemy{e}, n.queue...)
				break
			}
			s, ok := w.navBegin(e, e.Pos, to, class)
			if !ok || !w.navStart(s, &spent) {
				if ok && len(tail) == 0 {
					n.remember(class, w.tick, e.Pos, to, nil, false)
				}
				w.navResult(e, nil, 0, false, false)
				continue
			}
			s.tail = tail
			s.from = e.Pos
			n.cur = s
		}
		s := n.cur
		if !w.navLive(s.e) {
			s.e.nav.queued = false
			n.cur = nil
			continue
		}
		if !s.done {
			exp0 := s.expanded
			spent += w.navRun(s, navTickBudget-spent)
			n.Stats.Expanded += int64(s.expanded - exp0)
		}
		if s.done {
			if spent > navTickBudget*3/4 {
				break // smooth it next tick, with the budget to do it
			}
			wps, l, partial := w.navFinish(s, &spent)
			if len(s.tail) == 0 && (wps == nil || !partial) {
				n.remember(s.class, w.tick, s.from, s.goalPos, wps, wps != nil)
			}
			if wps != nil && len(s.tail) > 0 && !partial {
				wps = append(wps, s.tail...)
				l = navPolyLen(s.e.Pos, wps)
			}
			w.navResult(s.e, wps, l, partial, len(s.tail) > 0 && !partial)
			n.cur = nil
		}
	}
	n.Stats.MaxTickUnits = max(n.Stats.MaxTickUnits, int64(spent))
}

func navPolyLen(from movement.Vec3, wps []movement.Vec3) float64 {
	l := 0.0
	for _, p := range wps {
		l += hdist(from, p)
		from = p
	}
	return l
}

// navResult hands a finished search to its walker.
func (w *World) navResult(e *Enemy, wps []movement.Vec3, length float64, partial, cave bool) {
	n := e.nav
	n.queued = false
	st := &w.nav.Stats
	if len(wps) == 0 {
		st.Failed++
		if n.fails < 255 {
			n.fails++
		}
		n.nextReq = w.tick + navFailGap
		return
	}
	switch {
	case cave:
		st.CavePaths++
	case partial:
		st.Partial++
	default:
		st.Paths++
	}
	if partial {
		if n.fails < 255 {
			n.fails++
		}
	} else {
		n.fails = 0
	}
	n.path = append(n.path[:0], wps...)
	n.idx = 0
	n.goal = n.wantTo
	n.planned = w.tick
	n.length = length
	n.partial = partial
	n.cave = cave
	n.stuck = 0
	// the search may have taken a few ticks: skip a waypoint the walker has
	// already passed (it is on the leg after it)
	for n.idx+1 < len(n.path) && segDist(e.Pos, n.path[n.idx], n.path[n.idx+1]) < 0.6 {
		n.idx++
	}
}

// segDist is the horizontal distance from p to the segment ab.
func segDist(p, a, b movement.Vec3) float64 { return hdist(p, segPoint(p, a, b)) }

// segPoint is the point of the segment ab nearest p (horizontally).
func segPoint(p, a, b movement.Vec3) movement.Vec3 {
	dx, dz := b.X-a.X, b.Z-a.Z
	l := dx*dx + dz*dz
	t := 0.0
	if l > 1e-9 {
		t = math.Min(1, math.Max(0, ((p.X-a.X)*dx+(p.Z-a.Z)*dz)/l))
	}
	return movement.Vec3{X: a.X + dx*t, Z: a.Z + dz*t}
}

// navWalled: a melee walker whose straight line to its target is walled
// (refused steps, or a path much longer than the distance) does not strike
// through the wall; it walks round or gives up.
func (e *Enemy) navWalled(d float64) bool {
	n := e.nav
	if n == nil || e.Def.Behavior != "melee" {
		return false
	}
	if n.following() {
		return navPolyLen(e.Pos, n.path[n.idx:]) > d*1.4+2
	}
	return n.blocked >= navBlockTicks
}

// NavPath is e's current path (waypoints still ahead; tests and dev tools).
func (e *Enemy) NavPath() []movement.Vec3 {
	if !e.nav.following() {
		return nil
	}
	return e.nav.path[e.nav.idx:]
}
