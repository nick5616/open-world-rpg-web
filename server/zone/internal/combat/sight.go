package combat

// Line of sight for monsters (playtest 5, CR 056). Nicole: "mobs can attack
// you through walls": they noticed, chased and hit a player standing behind
// a wall, and their shots flew through it.
//
// One query, rayClear(a, b), steps along the segment and asks what the zone
// already knows is solid, with the rules the movement step and the nav grid
// use:
//
//   - the surface heightfield (terrain, the terrain edits overlay of CR 040,
//     structures) where the point is on the open surface;
//   - cave rock, the Underground and Depths floors and ceilings and island
//     bodies (CaveTerrain.Sight, server/pkg/worldhost/caves.go) where it is
//     not;
//   - World.Obstacles: town building boxes (dwarven halls and sky palaces are
//     town boxes too), closed doors and a player's base pieces (CR 041).
//     An open door is no wall; a counter you can see over is no wall.
//
// It is used in three places: perception and aggro (acquire, chase: an enemy
// notices only what it sees or hears within sightHearM, and gives up on a
// target it has not noticed for sightMemoS; while it remembers it walks the
// nav path round the obstacle instead of standing at the wall), melee and
// area strikes (a strike is not queued on a player a wall hides from the
// strike's origin) and enemy projectiles (a shot ends where it enters a
// wall, with EvShotWall so the client stops the drawn shot there). The
// players' own ranged claims (validate.go lineOfSight) use the same query;
// melee claims keep reach as the check.
//
// Cost: an enemy's own look at one player is memoised for sightEveryTicks
// (per enemy, so AI workers never share state), a clear segment of 30 m is
// ~85 samples, strikes and shots are rare and unmemoised. A world with no
// walls near answers every sample with array reads (Blocker mask).

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

const (
	sightStep       = 0.35 // m between samples: with sightR a 0.1 m wall cannot be stepped over
	sightR          = 0.15 // m: radius of the sample body
	sightEveryTicks = 6    // an enemy's look at one player is good for 0.2 s
	sightHearM      = 7.0  // m: nearer than this an enemy hears you through a wall
	sightMemoS      = 6.0  // s an enemy keeps chasing a target it has not noticed
	sightPathMemoS  = 25.0 // s, once its straight way was refused and it asked for a nav path round what hides the target
	sightMaxM       = 400  // m: longer segments are not walked (read as clear; nothing aims that far)
)

// EvShotWall (CR 056, contracts/events.md 1990): an enemy projectile ended
// against a wall, rock or the ground. EntityID = the shooter, TargetID = the
// attack id (as Event 205), x/y/z = the impact (cm).
const EvShotWall = 1990

// sightQuery is the ground's solid-geometry side (worldhost.CaveTerrain):
// 1 solid, 0 open air with no heightfield (caves, layers), -1 the open
// surface. nil: heightfield only.
type sightQuery interface {
	Sight(x, y, z float64) int8
}

// sightMemo is one enemy's last answer about one player.
type sightMemo struct {
	id   uint32
	tick uint32
	ok   bool
}

// solidAt: is the point inside something a body or a shot cannot pass?
// slack is how far below the ground the heightfield counts as solid.
func (w *World) solidAt(x, y, z, slack float64) bool {
	kind := int8(-1)
	if w.sightQ != nil {
		kind = w.sightQ.Sight(x, y, z)
	}
	switch kind {
	case 1:
		return true
	case -1:
		if w.ground.HeightAt(x, z) > y+slack {
			return true
		}
	}
	// A body whose "feet" are a step below the sample: a box blocks when it
	// rises above the sample and starts below it.
	return w.Obstacles != nil && w.Obstacles(x, y-constants.MaxStepUpM, z, sightR, constants.MaxStepUpM+0.1)
}

// rayHit walks a to b and returns the last open sample before the first
// solid one (hit = true), or b (hit = false). The endpoints themselves are
// not tested: a body standing against a wall is pushed out of it, and a
// monster's eye may graze the box it stands next to.
func (w *World) rayHit(a, b movement.Vec3, slack float64) (movement.Vec3, bool) {
	dx, dy, dz := b.X-a.X, b.Y-a.Y, b.Z-a.Z
	d := math.Sqrt(dx*dx + dy*dy + dz*dz)
	if d < sightStep || d > sightMaxM {
		return b, false
	}
	n := int(d / sightStep)
	prev := a
	for i := 1; i < n; i++ {
		t := float64(i) / float64(n)
		p := movement.Vec3{X: a.X + dx*t, Y: a.Y + dy*t, Z: a.Z + dz*t}
		if w.solidAt(p.X, p.Y, p.Z, slack) {
			return prev, true
		}
		prev = p
	}
	return b, false
}

// rayClear: nothing solid on the segment (terrain slack of the players' line
// of sight, 0.3 m).
func (w *World) rayClear(a, b movement.Vec3) bool {
	_, hit := w.rayHit(a, b, 0.3)
	return !hit
}

// eyeOf is where an enemy looks from.
func (e *Enemy) eyeOf() movement.Vec3 {
	return movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + math.Min(math.Max(e.Height()*0.8, 0.6), 2.2), Z: e.Pos.Z}
}

// canSee is an unmemoised look from a point to a player's chest or head:
// either clear is a yes.
func (w *World) canSee(from movement.Vec3, p *Player) bool {
	if w.rayClear(from, movement.Vec3{X: p.Pos.X, Y: p.Pos.Y + 1.0, Z: p.Pos.Z}) {
		return true
	}
	return w.rayClear(from, movement.Vec3{X: p.Pos.X, Y: p.Pos.Y + 1.6, Z: p.Pos.Z})
}

// sees: the enemy has a clear line to the player, memoised for a few ticks.
func (w *World) sees(e *Enemy, p *Player) bool {
	if w.NoSight {
		return true
	}
	for i := range e.sight {
		if m := &e.sight[i]; m.id == p.ID && w.tick-m.tick < sightEveryTicks {
			return m.ok
		}
	}
	ok := w.canSee(e.eyeOf(), p)
	m := &e.sight[0]
	switch {
	case e.sight[1].id == p.ID:
		m = &e.sight[1]
	case e.sight[0].id != p.ID && e.sight[1].tick < e.sight[0].tick:
		m = &e.sight[1] // replace the older of two players
	}
	*m = sightMemo{p.ID, w.tick, ok}
	return ok
}

// notices: the enemy sees the player, or is close enough to hear them.
func (w *World) notices(e *Enemy, p *Player) bool {
	if w.NoSight {
		return true
	}
	if hdist(e.Pos, p.Pos) <= sightHearM && math.Abs(e.Pos.Y-p.Pos.Y) < 4 {
		return true
	}
	return w.sees(e, p)
}

// strikeBlocked: a wall hides the player from where a strike came from (its
// centre: the enemy for a swing, the aimed spot for a ground blast). Rare and
// unmemoised.
func (w *World) strikeBlocked(from movement.Vec3, p *Player) bool {
	if w.NoSight {
		return false
	}
	o := movement.Vec3{X: from.X, Y: from.Y + 1.0, Z: from.Z}
	return !w.canSee(o, p)
}

// LineClear: nothing solid between a and b (CR 056; tests and dev tools).
func (w *World) LineClear(a, b movement.Vec3) bool { return w.rayClear(a, b) }
