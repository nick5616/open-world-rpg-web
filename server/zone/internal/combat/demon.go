package combat

// Demons (WP15, spec 8 "Night and demons"; CR 011). Demons are enemies of
// family "demon" in combat.yaml and use everything else here unchanged
// (AI, telegraphs, strikes, hit validation, snapshots). What differs:
//
//   - They regenerate from ordinary damage. Health is HPMax - Seared -
//     Wounds: ordinary hits add Wounds (which close at the rank's regen rate
//     and can never take the last point), hits that kill demons add Seared
//     (which never heals). A demon dies only when Seared reaches HPMax, so
//     softening one up with an ordinary blade does not help the sunsteel.
//   - "Kills demons" is one rule (KillsDemons): a weapon whose material has
//     killsDemons (sunsteel: WP14's equipped item gear, Player.Gear.KillsDemons,
//     or the loadout's material key, Loadout.Material, set by dev builds), a sunsteel arrowhead, any spell of a killsDemons tree (Light)
//     or the Light elemental form (which also deals demonMult x2).
//   - Ordinary hits stagger them (interrupt a wind-up, push back) at most
//     every DEMON_STAGGER_COOLDOWN_S: other weapons only stagger and push
//     them back.
//   - Sunrise burns those in the open (KillDemon: no XP, no loot); the rest
//     flee (Despawn). Wards keep them out of towns (Blocked) and players
//     inside a ward are not hunted (Sheltered); both hooks come from the
//     night glue (internal/game/night.go).

import (
	"math"
	"slices"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// GroupDemon is a night spawn (a pack, a greater demon, a lord, a defense wave).
const GroupDemon GroupKind = GroupTest + 1

// EvDemonShrugged is Event 504: to the attacker, an ordinary hit on a demon
// that will regenerate (value = the damage that closes again).
const EvDemonShrugged = 504

// DemonState is a demon's night bookkeeping.
type DemonState struct {
	Rank   string
	Regen  float64 // fraction of max health per second (combat.yaml demons.regen)
	Seared float64 // health lost to demon-killing damage (never heals)
	Wounds float64 // health lost to ordinary damage (heals at Regen)
	// Goal is where a defense-wave demon heads when it has nobody to fight
	// (the ward garden); AtGoal is set while it stands there.
	Goal        *movement.Vec3
	AtGoal      bool
	DefenseID   int
	lastStagger uint32
	// stuck detection (shadow step): where it was at checkAt.
	checkPos movement.Vec3
	checkAt  uint32
	Steps    int // shadow steps taken (debug)
}

// DemonHooks are the night glue's callbacks (nil = no wards).
type DemonHooks struct {
	// Blocked reports a point a demon may not step on (an active ward, a
	// lantern for lesser demons).
	Blocked func(e *Enemy, x, z float64) bool
	// Sheltered reports a player demons leave alone (inside an active ward).
	Sheltered func(e *Enemy, p *Player) bool
	// Wet reports a position standing in water while it rains (lightning chains).
	Wet func(p movement.Vec3) bool
}

// IsDemon reports a demon.
func (e *Enemy) IsDemon() bool { return e.Demon != nil }

// KillsDemons is the demon rule: does this action's damage kill demons?
func KillsDemons(p *Player, a *Action) bool {
	switch {
	case a.Spell != nil:
		return a.Spell.KillsDemons
	case a.Form != nil:
		return a.Form.KillsDemons
	case a.Move != nil && a.Weapon != nil:
		lo := p.Loadout()
		if a.Weapon.Key == "bow" && !p.Gear.KillsDemons {
			for _, ar := range a.Weapon.Arrows {
				if ar.Key == lo.ArrowOre {
					return ar.KillsDemons
				}
			}
			return false
		}
		if p.Gear.KillsDemons {
			return true // WP14: the equipped item's material (a forged sunsteel blade)
		}
		m := D.MaterialByKey(lo.Material)
		return m != nil && m.KillsDemons
	}
	return false
}

// SpawnDemons adds a group of demons at anchor and spawns it at once
// (night spawns are placed near players, so the 1 Hz spawn check would
// only delay them). keys are combat.yaml demon keys.
func (w *World) SpawnDemons(anchor movement.Vec3, keys []string, level int) *Group {
	anchor.Y = w.ground.HeightAt(anchor.X, anchor.Z)
	g := w.AddGroup(&Group{Kind: GroupDemon, Anchor: anchor, Radius: 6, Comp: keys, Level: max(1, level), Site: -1, Element: 8})
	g.lastNear = w.tick
	w.spawnGroup(g)
	return g
}

// newDemonState is set on every demon-family enemy when it spawns.
func newDemonState(def *combatdefs.Enemy) *DemonState {
	d := &DemonState{Rank: def.Demon.Rank, Regen: def.Demon.Regen}
	return d
}

// RemoveGroup drops a group and its members (night groups at dawn, waves).
func (w *World) RemoveGroup(g *Group) {
	for _, e := range g.Members {
		w.removeEnemy(e)
	}
	g.Members = nil
	g.Spawned = false
	if i := slices.Index(w.Groups, g); i >= 0 {
		w.Groups = slices.Delete(w.Groups, i, i+1)
	}
	c := [2]int{int(math.Floor(g.Anchor.X / cellM)), int(math.Floor(g.Anchor.Z / cellM))}
	if i := slices.Index(w.groupAt[c], g); i >= 0 {
		w.groupAt[c] = slices.Delete(w.groupAt[c], i, i+1)
	}
}

// KillDemon finishes a demon without a killer (sunrise): no XP, no loot.
func (w *World) KillDemon(e *Enemy) {
	if !e.Alive() {
		return
	}
	e.HP = 0
	e.State = Dead
	e.diedTick = w.tick
	e.Vel = movement.Vec3{}
	w.Stats.Kills++
	w.near(e.Pos, 96, 0, Out{Ev: ev(EvEnemyDied, e.ID, 0, 0, e.Pos, []byte(e.Name))})
}

// Despawn removes a living enemy at once (demons fleeing at dawn).
func (w *World) Despawn(e *Enemy) { w.removeEnemy(e) }

// Burn sets an enemy alight (standing in a burning chemistry cell). An
// environmental source: no player credit.
func (w *World) Burn(e *Enemy) {
	if e.Alive() {
		e.applyStatus("burn", 0, e.Pos, w.tick, 1)
	}
}

// demonDamage applies damage to a demon (instead of takeDamage). Returns
// the health it took.
func (w *World) demonDamage(e *Enemy, src uint32, dmg float64, killing bool) float64 {
	d := e.Demon
	var dealt float64
	if killing {
		dealt = math.Max(0, math.Min(dmg, e.HPMax-d.Seared))
		d.Seared += dealt
	} else {
		dealt = math.Max(0, math.Min(dmg, e.HPMax-d.Seared-d.Wounds-1))
		d.Wounds += dealt
		if dmg > 0 {
			if p := w.players[src]; p != nil {
				w.toPlayer(src, Out{Ev: ev(EvDemonShrugged, src, e.ID, int32(math.Round(dmg)), e.Pos, nil)})
			}
			w.stagger(e, src)
		}
	}
	w.demonHealth(e)
	for i := range e.statuses {
		if e.statuses[i].def.BreakOnDamage && dealt > 0 {
			e.statuses[i].until = w.tick
		}
	}
	return dealt
}

func (w *World) demonHealth(e *Enemy) {
	d := e.Demon
	if d.Seared >= e.HPMax-1e-9 {
		e.HP = 0
		return
	}
	d.Wounds = math.Max(0, math.Min(d.Wounds, e.HPMax-d.Seared-1))
	e.HP = math.Max(1, e.HPMax-d.Seared-d.Wounds)
}

// stagger: an ordinary hit interrupts a wind-up and pushes the demon back.
func (w *World) stagger(e *Enemy, src uint32) {
	d := e.Demon
	if d.Rank == "lord" || w.tick-d.lastStagger < secondsToTicks(constants.DemonStaggerCooldownS) {
		return
	}
	d.lastStagger = w.tick
	from := e.Pos
	if p := w.players[src]; p != nil {
		from = p.Pos
	}
	e.applyStatus("knockback", src, from, w.tick, 0)
	if e.State == Windup {
		e.State, e.stateAt, e.attack = Recover, w.tick, nil
	}
}

// demonRegen closes a demon's wounds (every tick, even while staggered)
// and shadow-steps a stuck one.
func (w *World) demonRegen(e *Enemy) {
	d := e.Demon
	if d.Wounds > 0 {
		d.Wounds = math.Max(0, d.Wounds-d.Regen*e.HPMax*dt)
	}
	w.demonHealth(e)
	w.shadowStep(e)
}

// shadowStep: enemies steer straight over the heightfield (WP13), so a
// cliff or a terrace can strand one. A demon that wants to go somewhere
// (its target or its ward garden, more than 5 m away) and has not moved a
// metre in 4 s steps through the shadows: 6-20 m toward it, onto dry
// ground outside any active ward (rivers and cliff bands strand them). Thematic, and it keeps defense waves arriving.
func (w *World) shadowStep(e *Enemy) {
	d := e.Demon
	if w.tick-d.checkAt < secondsToTicks(4) {
		return
	}
	moved := hdist(e.Pos, d.checkPos)
	d.checkPos, d.checkAt = e.Pos, w.tick
	var want *movement.Vec3
	if p := w.players[e.Target]; p != nil && (e.State == Chase || e.State == Reposition) {
		t := p.Pos
		want = &t
	} else if d.Goal != nil && !d.AtGoal {
		want = d.Goal
	}
	if want == nil || moved > 1 || hdist(e.Pos, *want) < 5 || e.disabled(w.tick) {
		return
	}
	base := math.Atan2(want.Z-e.Pos.Z, want.X-e.Pos.X)
	l := hdist(e.Pos, *want)
	// Straight at it first; then a little to either side; farther each ring
	// (a river or a cliff band can be wider than one step).
	for _, step := range []float64{6, 10, 14, 20} {
		step = math.Min(step, l-2)
		for _, da := range []float64{0, 0.5, -0.5, 1, -1} {
			nx, nz := e.Pos.X+step*math.Cos(base+da), e.Pos.Z+step*math.Sin(base+da)
			y := w.ground.HeightAt(nx, nz)
			if movement.WaterAt(w.ground, nx, nz) > y-0.3 || (w.DemonHooks.Blocked != nil && w.DemonHooks.Blocked(e, nx, nz)) {
				continue
			}
			e.Pos = w.place(nx, nz, e.Def)
			d.Steps++
			d.checkPos = e.Pos
			return
		}
	}
}

// markKilling flags a status applied by a demon-killing action (its DOT sears).
func (e *Enemy) markKilling(def *combatdefs.Status) {
	for i := range e.statuses {
		if e.statuses[i].def == def {
			e.statuses[i].killing = true
		}
	}
}

// demonGoal: a defense-wave demon with nobody to fight walks to its ward
// garden. Returns true when it handled the tick.
func (w *World) demonGoal(e *Enemy) bool {
	d := e.Demon
	if d.Goal == nil || (e.State != Idle && e.State != Return && e.State != Asleep) {
		d.AtGoal = false
		return false
	}
	if t := w.acquire(e, 1); t != nil {
		e.Target = t.ID
		w.engage(e, t)
		e.State, e.stateAt = Chase, w.tick
		d.AtGoal = false
		return true
	}
	if hdist(e.Pos, *d.Goal) > 2.5 {
		e.State = Idle
		w.moveToward(e, *d.Goal, 1)
		d.AtGoal = false
	} else {
		e.Vel = movement.Vec3{}
		d.AtGoal = true
	}
	return true
}

// demonLeash: hunting demons follow far; defense demons never give up.
func (e *Enemy) demonLeash() float64 {
	if e.Demon.Goal != nil {
		return 1e6
	}
	return constants.DemonHuntLeashM
}

// wetChain: lightning on an enemy standing in water in the rain arcs to
// the others in the same water (spec 8: rain makes lightning-type effects
// chain across water), at half damage.
func (w *World) wetChain(src uint32, from *Enemy, dmg float64, killing bool) {
	if w.DemonHooks.Wet == nil || !w.DemonHooks.Wet(from.Pos) {
		return
	}
	for _, id := range slices.Clone(w.order) {
		o := w.enemies[id]
		if o == nil || o == from || !o.Alive() || hdist(o.Pos, from.Pos) > 8 || !w.DemonHooks.Wet(o.Pos) {
			continue
		}
		at := movement.Vec3{X: o.Pos.X, Y: o.Pos.Y + o.Height(), Z: o.Pos.Z}
		w.applyDamage(o, src, math.Round(dmg*0.5), combatdefs.Lightning, at, 0, false, killing)
	}
}

// LevelAt is the enemy level of a position (region danger, like camps).
func (w *World) LevelAt(x, z float64) int {
	if w.Atlas == nil {
		return 1
	}
	d := w.Atlas.Region(w.Atlas.RegionAt(x, z)).Danger
	return 1 + int(math.Round(math.Max(0, math.Min(1, d))*24))
}

// ElementAt is the region element of a position (Physical without an atlas).
func (w *World) ElementAt(x, z float64) int {
	if w.Atlas == nil {
		return combatdefs.Physical
	}
	return w.Atlas.Region(w.Atlas.RegionAt(x, z)).Element
}
