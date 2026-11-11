package combat

// Main story hooks (playtest 2, CR 035; the glue is internal/game/finale.go,
// story.go and revive.go). Kept apart from the AI and hit paths: an enemy
// may carry a Guard that decides what a hit does to it (the Hush's shroud
// that only sunsteel and Light can break, its invulnerable choir phase, its
// staggered damage window), HeldUntil stops it acting (a stagger the zone
// times), StoryStrike telegraphs an area strike that is not one of the
// enemy's own wind-ups (the chorus falling on every player at once), and
// downed players can be held for a revive and revived.

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Guard decides a hit on an enemy that carries one: dmg is the hit after
// mitigation, killing whether it kills demons (sunsteel, Light). It returns
// the damage to apply (0: the hit does nothing; the guard tells the player
// why).
type Guard func(e *Enemy, src uint32, dmg float64, killing bool) float64

type storyStrike struct {
	src  *Enemy
	att  *combatdefs.EnemyAttack
	area attackArea
	at   uint32
}

// StoryStrike telegraphs attack key of src as a ground circle at center now
// and strikes every player inside it when the wind-up ends (dodges and
// parries evade it like any strike). False for an unknown attack or a dead
// source. The zone calls SettleStoryStrikes every tick.
func (w *World) StoryStrike(src *Enemy, key string, center movement.Vec3, radius float64) bool {
	a := D.AttackByKey(key)
	if a == nil || src == nil || !src.Alive() {
		return false
	}
	if radius <= 0 {
		radius = a.Radius
	}
	center.Y = w.ground.HeightAt(center.X, center.Z)
	area := attackArea{shape: "ground", center: center, radius: radius}
	windMs := int(math.Round(float64(a.WindupSteps) * 1000 / float64(D.StepHz)))
	activeMs := int(math.Round(float64(a.ActiveSteps) * 1000 / float64(D.StepHz)))
	w.near(center, telegraphRadius, 0, Out{Ev: ev(EvTelegraph, src.ID, uint32(a.ID), int32(windMs), center, telegraphData(&area, activeMs))})
	w.story = append(w.story, storyStrike{src: src, att: a, area: area, at: w.tick + ticksOf(a.WindupSteps)})
	return true
}

// SettleStoryStrikes strikes the story strikes whose wind-up ended.
func (w *World) SettleStoryStrikes() {
	keep := w.story[:0]
	for _, s := range w.story {
		if w.tick < s.at {
			keep = append(keep, s)
			continue
		}
		if s.src.Alive() {
			w.strikeArea(s.src, s.att, s.area, nil)
		}
	}
	clear(w.story[len(keep):])
	w.story = keep
}

// HurtPlayerBy deals dmg from enemy to player id as an attack of key would
// (armor, shields and god mode apply; downs at 0). For the finale's
// arena-wide night that no dodge escapes, only a well of dawn.
func (w *World) HurtPlayerBy(id uint32, enemy *Enemy, key string, dmg float64) {
	p := w.players[id]
	if p == nil || enemy == nil {
		return
	}
	w.hurtPlayer(p, dmg, enemy, D.AttackByKey(key))
}

// Hold stops e acting until tick (a stagger); HeldUntil is checked with
// the other disabling statuses.
func (w *World) Hold(e *Enemy, seconds float64) {
	if e == nil {
		return
	}
	e.HeldUntil = w.tick + secondsToTicks(seconds)
	if e.State == Windup {
		e.State, e.stateAt, e.attack = Recover, w.tick, nil
	}
	e.Vel = movement.Vec3{}
}

// MoveEnemy puts e at p (the Hush returning to the heart of its arena).
func (w *World) MoveEnemy(e *Enemy, p movement.Vec3) {
	p.Y = w.ground.HeightAt(p.X, p.Z)
	e.Pos, e.Vel, e.Home = p, movement.Vec3{}, p
	e.record(w.tick)
}

// Revive window (CR 035): a downed player can be held for a revive.

// HoldDowned keeps a downed player down for seconds from now instead of the
// respawn (a friend is near). False when the player is not down.
func (w *World) HoldDowned(id uint32, seconds float64) bool {
	p := w.players[id]
	if p == nil || !p.Downed {
		return false
	}
	p.respawnTick = w.tick + secondsToTicks(seconds)
	return true
}

// RespawnNow ends a downed player's wait (they chose to respawn).
func (w *World) RespawnNow(id uint32) bool {
	p := w.players[id]
	if p == nil || !p.Downed {
		return false
	}
	p.respawnTick = w.tick
	return true
}

// DownedLeft is how long a downed player has before the respawn (0 when
// not down).
func (w *World) DownedLeft(id uint32) float64 {
	p := w.players[id]
	if p == nil || !p.Downed || p.respawnTick <= w.tick {
		return 0
	}
	return float64(p.respawnTick-w.tick) / 30
}

// Revive raises a downed player where they lie with frac of their health
// and a short grace (CR 024's): no respawn, no teleport.
func (w *World) Revive(id uint32, frac float64) bool {
	p := w.players[id]
	if p == nil || !p.Downed {
		return false
	}
	p.Downed = false
	p.HP = math.Max(1, math.Round(p.HPMax*frac))
	p.graceTick = w.tick + secondsToTicks(2)
	p.lastHurtTick = w.tick
	w.toPlayer(p.ID, Out{Ev: ev(EvRespawned, p.ID, 1, int32(p.HPMax), p.Pos, nil)})
	return true
}

// SpawnNow spawns a group's members at once (a story arena; the 1 Hz spawn
// check would wait for a player within ENEMY_SPAWN_M).
func (w *World) SpawnNow(g *Group) {
	if g == nil || g.Spawned {
		return
	}
	g.lastNear = w.tick
	w.spawnGroup(g)
}

// ApplyDevDamage deals dmg from src to e as a demon-killing hit (dev
// console and tests: set a boss's health, end a fight).
func (w *World) ApplyDevDamage(e *Enemy, src uint32, dmg float64) {
	if e == nil || !e.Alive() {
		return
	}
	if e.Boss != nil {
		e.Boss.transitionUntil = 0 // a phase change's roar would swallow it
	}
	w.applyDamage(e, src, dmg, combatdefs.Physical, e.Pos, 0, false, true)
}
