package combat

// Partitioned enemy AI (WP19 second pass). At spec 14 scenario 1's size
// (2,000 awake enemies around 300 players) the enemy loop was 2-3 ms of a
// zone tick on ONE goroutine. Step now runs it in three passes:
//
//  1. classify (tick goroutine): expired corpses are removed, every awake
//     enemy is put in its group's partition. A group is "serial" when any
//     member is a boss or a demon, has a damage-over-time status (its tick
//     can kill: loot, XP, group cleared), or has no group: those keep the
//     old code path.
//  2. think (workers): each simple group's members think in spawn order on
//     a worker's private World copy (aiWorker). Shared state is only READ
//     (players, the player grid, the ground, definitions); everything an
//     enemy's think would append to the World (events, strikes, enemy
//     projectiles, counters) lands in the worker's copy, and the enemy
//     notes which slice ranges are its own. A group's members only read each
//     other (separation), and a group is never split across workers, so no
//     enemy is read while another goroutine writes it.
//  3. merge (tick goroutine, spawn order): each enemy's outputs are appended
//     to the World exactly where the serial loop would have appended them;
//     serial groups think right there; wind-up requests are admitted.
//
// Wind-ups are the one rule that couples groups: "at most two enemies wind
// up on one player" (maxWindupsOnOne). During pass 2 an enemy counts other
// groups' wind-ups as they were when the tick started (windAt, frozen) and
// its own group's live; an enemy that would start one records a request
// instead. Pass 3 admits requests in spawn order against the live count, so
// the cap holds exactly; a refused enemy stands still for that tick and
// sees the real count on the next. That (other groups' wind-ups seen at the
// start of the tick, not mid-loop) is the only difference from the old
// single loop, and it is a fixed rule: the outcome is the same for any
// number of workers, including one (tests run it that way: TestPartitioned*).

import "lodestone/server/pkg/movement"

// aiWorker is one worker's private World for pass 2: a shallow copy of the
// real World (maps and pointers shared, read-only during the pass) whose
// output slices and counters are its own.
type aiWorker struct {
	World
}

// aiRange is where one enemy's pass-2 outputs sit in its worker's slices.
type aiRange struct {
	worker           int32
	ev0, ev1         int32
	st0, st1         int32
	sh0, sh1         int32
	wantAttackTarget *Player // wind-up request (pass 3 admits it)
}

// aiPart is one simple group's awake members, in spawn order (a range of
// World.aiFlat).
type aiPart struct{ off, n int32 }

// Parallel runs fn(worker, i) for every i in [0, n) on up to workers
// goroutines and returns when all are done; worker is in [0, workers). The
// zone sets it to its tick pool; nil runs everything on the caller.
type Parallel func(n, workers int, fn func(worker, i int))

// SetParallel installs the host's worker pool for the enemy loop.
func (w *World) SetParallel(p Parallel, workers int) {
	w.par, w.parWorkers = p, max(1, workers)
}

// serialAI reports an enemy whose think may touch other enemies, players or
// the world's lists directly (see the file comment).
func (e *Enemy) serialAI() bool {
	if e.Boss != nil || e.Demon != nil || e.Group == nil || e.petTgt != 0 { // CR 029: chasing a pet winds up on it directly
		return true
	}
	for i := range e.statuses {
		if e.statuses[i].def.TickSteps > 0 {
			return true
		}
	}
	return false
}

// thinkAll is Step's enemy loop (the three passes above).
func (w *World) thinkAll(tick uint32) {
	// Pass 1a: the enemies as the tick starts (spawn order), corpses, and
	// groups that must stay serial this tick.
	list := w.aiList[:0]
	for _, id := range w.order {
		if e := w.enemies[id]; e != nil {
			list = append(list, e)
		}
	}
	w.aiList = list
	for _, e := range list {
		e.windStart, e.aiTick = 0, 0
		if e.State == Dead {
			if tick-e.diedTick > secondsToTicks(1.5) {
				w.removeEnemy(e)
			}
			continue
		}
		if g := e.Group; g != nil && g.aiTick != tick {
			g.aiTick, g.aiSerial, g.aiPart = tick, false, -1
		}
		if e.State != Asleep && e.serialAI() && e.Group != nil {
			e.Group.aiSerial = true
		}
	}
	// Pass 1b: partitions of simple groups' awake members (counting sort,
	// members keep spawn order).
	parts := w.aiParts[:0]
	for _, e := range list {
		if e.State == Dead || e.State == Asleep || e.serialAI() || e.Group.aiSerial {
			continue
		}
		g := e.Group
		if g.aiPart < 0 {
			g.aiPart = int32(len(parts))
			parts = append(parts, aiPart{})
		}
		parts[g.aiPart].n++
		e.aiTick = tick
	}
	off := int32(0)
	for i := range parts {
		parts[i].off = off
		off += parts[i].n
		parts[i].n = 0
	}
	if cap(w.aiFlat) < int(off) {
		w.aiFlat = make([]*Enemy, off, off+off/4)
	}
	flat := w.aiFlat[:off]
	for _, e := range list {
		if e.aiTick == tick {
			p := &parts[e.Group.aiPart]
			flat[p.off+p.n] = e
			p.n++
		}
	}
	w.aiParts = parts
	// Wind-ups as the tick starts, per target (pass 2 counts other groups'
	// from here). pruneWinding just ran: every listed enemy is winding up.
	clear(w.windAt)
	if w.windAt == nil {
		w.windAt = map[uint32]int{}
	}
	for _, o := range w.winding {
		if o.State == Windup && o.Target != 0 && w.enemies[o.ID] == o {
			o.windStart = o.Target
			w.windAt[o.Target]++
		}
	}

	// Pass 2: simple groups think on the workers.
	workers := 1
	if w.par != nil && len(parts) > 1 {
		workers = min(w.parWorkers, len(parts))
	}
	for len(w.aiw) < workers {
		w.aiw = append(w.aiw, &aiWorker{})
	}
	for _, wk := range w.aiw[:workers] {
		evs, sts, shs := wk.Events[:0], wk.strikes[:0], wk.shots[:0]
		wk.World = *w
		wk.Events, wk.strikes, wk.shots = evs, sts, shs
		wk.Spawned, wk.Removed, wk.XP, wk.Respawn, wk.Synced = nil, nil, nil, nil, nil
		wk.Stats = Stats{}
		wk.aiPar = true
		wk.aiw = nil
	}
	run := func(worker, pi int) {
		wk := &w.aiw[worker].World
		p := parts[pi]
		for _, e := range flat[p.off : p.off+p.n] {
			r := &e.aiOut
			r.worker = int32(worker)
			r.ev0, r.st0, r.sh0 = int32(len(wk.Events)), int32(len(wk.strikes)), int32(len(wk.shots))
			r.wantAttackTarget = nil
			e.wantAttack = nil
			wk.think(e)
			e.record(tick)
			r.ev1, r.st1, r.sh1 = int32(len(wk.Events)), int32(len(wk.strikes)), int32(len(wk.shots))
		}
	}
	if workers > 1 {
		w.par(len(parts), workers, run)
	} else {
		for pi := range parts {
			run(0, pi)
		}
	}
	for _, wk := range w.aiw[:workers] {
		w.Stats.add(&wk.Stats)
		// Pass 2 must not spawn, remove, grant or respawn (serialAI keeps
		// every enemy that can on the serial path); if it ever did, the
		// result would still be kept, appended here.
		w.Spawned = append(w.Spawned, wk.Spawned...)
		w.Removed = append(w.Removed, wk.Removed...)
		w.XP = append(w.XP, wk.XP...)
		w.Respawn = append(w.Respawn, wk.Respawn...)
		w.Synced = append(w.Synced, wk.Synced...)
	}

	// Pass 3: merge in spawn order; serial groups think in place.
	for _, e := range list {
		if e.gone {
			continue // removed this tick (a corpse above, or by a serial group's think)
		}
		if e.aiTick == tick {
			r := &e.aiOut
			wk := &w.aiw[r.worker].World
			w.Events = append(w.Events, wk.Events[r.ev0:r.ev1]...)
			w.strikes = append(w.strikes, wk.strikes[r.st0:r.st1]...)
			w.shots = append(w.shots, wk.shots[r.sh0:r.sh1]...)
			if a, p := e.wantAttack, r.wantAttackTarget; a != nil {
				e.wantAttack, r.wantAttackTarget = nil, nil
				if w.players[p.ID] == p && e.State == Chase && w.windupsOn(p.ID) < maxWindupsOnOne {
					w.windup(e, a, p)
				} else {
					e.Vel = movement.Vec3{}
				}
			}
			continue
		}
		if e.State == Dead {
			continue
		}
		if e.State != Asleep {
			w.think(e)
		}
		e.record(tick)
	}
	for _, wk := range w.aiw[:workers] {
		// Drop references into enemies/strikes so the next tick's copy
		// starts clean (the backing arrays are reused).
		clear(wk.Events)
		clear(wk.strikes)
		clear(wk.shots)
		wk.Events, wk.strikes, wk.shots = wk.Events[:0], wk.strikes[:0], wk.shots[:0]
	}
}

// windupsSeen is pickAttack's wind-up count for target: the live count on
// the serial path; during pass 2 other groups' wind-ups as the tick started
// plus this group's own, live (including requests made earlier this tick).
func (w *World) windupsSeen(e *Enemy, target uint32) int {
	if !w.aiPar {
		return w.windupsOn(target)
	}
	n := w.windAt[target]
	for _, o := range e.Group.Members {
		if o.windStart == target {
			n-- // counted in windAt; its live state is counted below
		}
		if w.enemies[o.ID] != o {
			continue
		}
		if (o.State == Windup && o.Target == target) || (o.wantAttack != nil && o.aiOut.wantAttackTarget != nil && o.aiOut.wantAttackTarget.ID == target) {
			n++
		}
	}
	return n
}

// add sums counters (pass 2 workers into the World).
func (s *Stats) add(o *Stats) {
	s.ClaimsAccepted += o.ClaimsAccepted
	s.ClaimsRefused += o.ClaimsRefused
	s.Kills += o.Kills
	s.PlayerHits += o.PlayerHits
	s.Evaded += o.Evaded
	s.Downs += o.Downs
	for i := range s.RefusedBy {
		s.RefusedBy[i] += o.RefusedBy[i]
	}
}
