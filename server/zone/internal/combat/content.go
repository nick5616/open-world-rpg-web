package combat

import (
	"math"
	"slices"

	"lodestone/server/pkg/movement"
)

// Playtest 2 content (CR 022): what world events and sealed vaults need
// from combat. Groups they add are retired when the event ends (never
// respawn), a roaming group's anchor moves (re-indexed in the 256 m grid so
// spawning and despawning follow it), and the Glintfox flees.

// RetireGroup removes a group's members and keeps it from ever spawning
// again (a finished world event, a vault that reset).
func (w *World) RetireGroup(g *Group) {
	if g == nil || g.Retired {
		return
	}
	for _, e := range g.Members {
		w.removeEnemy(e)
	}
	g.Members = nil
	g.Spawned = false
	g.Retired = true
	c := [2]int{int(math.Floor(g.Anchor.X / cellM)), int(math.Floor(g.Anchor.Z / cellM))}
	w.groupAt[c] = slices.DeleteFunc(w.groupAt[c], func(x *Group) bool { return x == g })
	if len(w.groupAt[c]) == 0 {
		delete(w.groupAt, c)
	}
}

// MoveGroup moves a group's anchor (and its members' home) to p, keeping
// the spawn grid right.
func (w *World) MoveGroup(g *Group, p movement.Vec3) {
	if g == nil || g.Retired {
		return
	}
	old := [2]int{int(math.Floor(g.Anchor.X / cellM)), int(math.Floor(g.Anchor.Z / cellM))}
	nc := [2]int{int(math.Floor(p.X / cellM)), int(math.Floor(p.Z / cellM))}
	if old != nc {
		w.groupAt[old] = slices.DeleteFunc(w.groupAt[old], func(x *Group) bool { return x == g })
		if len(w.groupAt[old]) == 0 {
			delete(w.groupAt, old)
		}
		w.groupAt[nc] = append(w.groupAt[nc], g)
	}
	g.Anchor = p
	for _, e := range g.Members {
		e.Home = p
	}
	if g.Arena != nil {
		g.Arena.Center = p
	}
}

// flee (behavior "flee": the Glintfox) runs from the nearest player within
// its aggro at full speed, never attacks, and drifts back toward home when
// nobody is near. The world event that spawned it decides when it escapes
// (internal/game/worldevents.go).
func (w *World) flee(e *Enemy) {
	var near *Player
	nd := e.Def.Aggro
	w.eachPlayerNear(e.Pos.X, e.Pos.Z, e.Def.Aggro, func(p *Player) {
		if p.Downed {
			return
		}
		if d := hdist(p.Pos, e.Pos); d < nd || d == nd && near != nil && p.ID < near.ID {
			near, nd = p, d
		}
	})
	if near == nil {
		if hdist(e.Pos, e.Home) > 1.5 {
			w.moveToward(e, e.Home, 0.4)
		} else {
			e.Vel = movement.Vec3{}
		}
		return
	}
	if e.AggroTick == 0 {
		e.AggroTick = w.tick
	}
	dx, dz := e.Pos.X-near.Pos.X, e.Pos.Z-near.Pos.Z
	if d := math.Hypot(dx, dz); d > 1e-6 {
		dx, dz = dx/d, dz/d
	} else {
		dx, dz = 1, 0
	}
	// Zig-zag a little so a sprinting player can catch it.
	wob := math.Sin(float64(w.tick+e.ID*7) * 0.11)
	tx, tz := dx*0.94-dz*0.34*wob, dz*0.94+dx*0.34*wob
	w.moveAway(e, movement.Vec3{X: e.Pos.X + tx*8, Y: e.Pos.Y, Z: e.Pos.Z + tz*8}, 1)
}

// Slay kills e as if player by had struck it down (dev tools, evidence and
// tests: the kill path, XP and the loot hook run as for any kill).
func (w *World) Slay(e *Enemy, by uint32) {
	if e == nil || !e.Alive() {
		return
	}
	if by != 0 {
		if e.DamageBy == nil {
			e.DamageBy = map[uint32]float64{}
		}
		e.DamageBy[by] += e.HP
	}
	w.kill(e, by)
}
