package combat

import (
	"encoding/binary"
	"math"
	"slices"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// Summons (playtest 2 spell mechanics, CR 020): allies a summon spell calls
// for durationMs. Each is a combat body owned by its caster, built on the
// Enemy struct so it walks with the enemies' steering (stepMove: terrain,
// water, cliffs, buildings) but kept OUT of the enemy tables: nothing that
// looks for enemies (claims, enemy AI, camps, night, quests, bots) ever
// sees one. The host draws it as EntityKind effect (typeId = summon id |
// (element + 1) << 8; health % = the time it has left).
//
// An ally picks the nearest living enemy within its aggro range (and its
// caster's leash), walks to its reach (a ranged one keeps keepAway, a
// turret never moves), winds up briefly and strikes: a melee bite lands at
// once if the target is still in reach, a bolt lands when it would arrive.
// Damage is its attack's number scaled like the caster's spells (spell
// power of the loadout, spellcraft, level, gear) and the elements; kills
// and XP are the caster's. It attacks players only when the game layer's
// PvP rules let the caster hurt them (SummonPvP), at PvP damage. Enemies
// ignore allies (apparitions take no damage); an ally leaves when its time
// is up, its caster goes down, leaves, or ends up beyond its leashM, and
// the oldest leaves when a new one passes summon.max of its kind or
// SUMMONS_PER_PLAYER in all. Each attack is one Event 225 to players
// within 64 m (about one a second per ally).

// summonState is an ally's part of the Enemy struct.
type summonState struct {
	def       *combatdefs.Summon
	spell     *combatdefs.Spell
	owner     uint32
	start     uint32
	end       uint32
	mult      float64 // damage scale at the cast
	killing   bool    // Light allies sear demons (WP15)
	target    uint32  // enemy or player id
	tPlayer   bool
	next      uint32 // tick the next attack may start
	windUntil uint32 // tick the current wind-up strikes (0 = none)
	slot      int
	pct       uint8 // time left 1..100 (HealthPct)
}

// pendingBolt is an ally bolt in flight (resolved when it would arrive).
type pendingBolt struct {
	ally   *Enemy
	target uint32
	player bool
	at     uint32
}

// Summon returns a live ally by entity id (the host mirrors it into its entity).
func (w *World) Summon(id uint32) *Enemy { return w.summonIdx[id] }

// Summons lists the live allies (tests, evidence).
func (w *World) Summons() []*Enemy { return w.summons }

// Owner is an ally's caster (0 for enemies).
func (e *Enemy) Owner() uint32 {
	if e.ally == nil {
		return 0
	}
	return e.ally.owner
}

// summonMult is how a player's spells scale (what damageOf applies to a
// spell, minus the per-target parts).
func summonMult(p *Player, a *Action) float64 {
	sc := p.Profile.SkillLevel("spellcraft")
	m := a.Weapon.SpellPower * (1 + 0.01*float64(sc)) * (1 + p.Gear.SpellPower/100) * D.DamageMult(p.Level)
	if D.HasTechnique("spellcraft", sc, "overflow") {
		m *= 1.15
	}
	return m
}

// summon calls a summon spell's allies (World.Frame, on a legal cast).
func (w *World) summon(p *Player, a *Action) {
	s := a.Spell
	def := D.SummonByKey(s.Summon.Key)
	if def == nil || p.Downed {
		return
	}
	if w.summonIdx == nil {
		w.summonIdx = map[uint32]*Enemy{}
	}
	for i := 0; i < max(1, s.Summon.Count); i++ {
		w.capSummons(p.ID, def, s.Summon.Max)
		// In front of the caster (a turret where the caster aims, within range).
		yaw := a.Yaw - 0.9 - float64(i)*0.8 // front right, out of the line of fire
		d := math.Min(2.5, s.Range)
		if def.Behavior == "turret" {
			d, yaw = w.aimDistance(a.Pos, a.Yaw, a.Pitch, s.Range), a.Yaw
		}
		x, z := a.Pos.X-math.Sin(yaw)*d, a.Pos.Z-math.Cos(yaw)*d
		e := newEnemy(def.Body, p.Level, def.Element, nil, w.place(x, z, def.Body))
		e.ally = &summonState{def: def, spell: s, owner: p.ID, start: w.tick, end: w.tick + ticksOf(s.DurationSteps), mult: summonMult(p, a), killing: s.KillsDemons, next: w.tick + ticksOf(def.Attack.WindupSteps), slot: w.summonCount(p.ID, nil), pct: 100}
		e.Yaw, e.State, e.Home = a.Yaw, Chase, e.Pos
		e.ID = w.alloc()
		e.record(w.tick)
		w.summons = append(w.summons, e)
		w.summonIdx[e.ID] = e
		w.Spawned = append(w.Spawned, e)
	}
}

// aimDistance: how far along the look ray (from the eye) the ground is, up to rng.
func (w *World) aimDistance(feet movement.Vec3, yaw, pitch, rng float64) float64 {
	cp := math.Cos(pitch)
	dx, dz, dy := -math.Sin(yaw)*cp, -math.Cos(yaw)*cp, math.Sin(pitch)
	eye := movement.Vec3{X: feet.X, Y: feet.Y + 1.6, Z: feet.Z}
	for d := 1.0; d <= rng; d += 0.5 {
		if eye.Y+dy*d <= w.ground.HeightAt(eye.X+dx*d, eye.Z+dz*d) {
			return math.Max(1, d*cp)
		}
	}
	return rng * cp
}

// summonCount: a player's live allies (of def, or all when def is nil).
func (w *World) summonCount(owner uint32, def *combatdefs.Summon) int {
	n := 0
	for _, e := range w.summons {
		if e.ally.owner == owner && (def == nil || e.ally.def == def) {
			n++
		}
	}
	return n
}

// capSummons makes room for one more ally of def: the oldest of its kind
// past maxOfKind, then the oldest of any past SUMMONS_PER_PLAYER.
func (w *World) capSummons(owner uint32, def *combatdefs.Summon, maxOfKind int) {
	for w.summonCount(owner, def) >= max(1, maxOfKind) {
		w.dismissOldest(owner, def)
	}
	for w.summonCount(owner, nil) >= constants.SummonsPerPlayer {
		w.dismissOldest(owner, nil)
	}
}

func (w *World) dismissOldest(owner uint32, def *combatdefs.Summon) {
	for _, e := range w.summons {
		if e.ally.owner == owner && (def == nil || e.ally.def == def) {
			w.dismiss(e)
			return
		}
	}
}

// dismiss removes an ally (time up, caster gone, cap).
func (w *World) dismiss(e *Enemy) {
	i := slices.Index(w.summons, e)
	if i < 0 {
		return
	}
	w.summons = slices.Delete(w.summons, i, i+1)
	delete(w.summonIdx, e.ID)
	e.State = Dead
	e.gone = true
	w.Removed = append(w.Removed, e)
}

// DismissSummons removes every ally of a player (leaving, tests).
func (w *World) DismissSummons(owner uint32) {
	for i := len(w.summons) - 1; i >= 0; i-- {
		if e := w.summons[i]; e.ally.owner == owner {
			w.dismiss(e)
		}
	}
}

// stepSummons runs every ally for one tick (World.Step, after the enemies
// thought: allies hurt enemies, so they never run on the AI workers).
func (w *World) stepSummons() {
	if len(w.summons) == 0 && len(w.bolts) == 0 {
		return
	}
	for _, e := range slices.Clone(w.summons) {
		st := e.ally
		owner := w.players[st.owner]
		if owner == nil || owner.Downed || w.tick >= st.end || hdist(owner.Pos, e.Pos) > st.def.LeashM+10 {
			w.dismiss(e)
			continue
		}
		w.allyThink(e, owner)
		st.pct = e.allyPct(w.tick)
		e.record(w.tick)
	}
	w.landBolts()
}

// allyTarget returns where the current target is, or false when it is gone.
func (w *World) allyTarget(st *summonState) (movement.Vec3, float64, bool) {
	if st.target == 0 {
		return movement.Vec3{}, 0, false
	}
	if st.tPlayer {
		q := w.players[st.target]
		if q == nil || q.Downed || q.Graced(w.tick) || w.SummonPvP == nil {
			return movement.Vec3{}, 0, false
		}
		if _, ok := w.SummonPvP(st.owner, q.ID); !ok {
			return movement.Vec3{}, 0, false
		}
		return q.Pos, playerRadius, true
	}
	t := w.enemies[st.target]
	if t == nil || !t.Alive() {
		return movement.Vec3{}, 0, false
	}
	return t.Pos, t.Radius(), true
}

// acquireFor picks an ally's target: the nearest living enemy within aggro
// (and the caster's leash), else a player the caster may fight.
func (w *World) acquireFor(e *Enemy, owner *Player) {
	st := e.ally
	st.target, st.tPlayer = 0, false
	best := math.MaxFloat64
	for _, id := range w.order {
		t := w.enemies[id]
		if t == nil || !t.Alive() || math.Abs(t.Pos.Y-e.Pos.Y) > 10 {
			continue
		}
		d := hdist(t.Pos, e.Pos)
		if d > st.def.Aggro || hdist(t.Pos, owner.Pos) > st.def.LeashM {
			continue
		}
		if d < best || (d == best && id < st.target) {
			best, st.target = d, id
		}
	}
	if st.target != 0 || w.SummonPvP == nil {
		return
	}
	for _, q := range w.playersNear(e.Pos, st.def.Aggro) {
		if q.ID == st.owner || q.Downed || q.Graced(w.tick) { // CR 024: not a just-respawned player
			continue
		}
		if _, ok := w.SummonPvP(st.owner, q.ID); !ok {
			continue
		}
		if d := hdist(q.Pos, e.Pos); d < best {
			best, st.target, st.tPlayer = d, q.ID, true
		}
	}
}

// allyThink: target, move, attack.
func (w *World) allyThink(e *Enemy, owner *Player) {
	st := e.ally
	def := st.def
	tp, tr, ok := w.allyTarget(st)
	if !ok || (w.tick+e.ID)%10 == 0 && st.windUntil == 0 {
		w.acquireFor(e, owner)
		tp, tr, ok = w.allyTarget(st)
	}
	if !ok {
		st.windUntil = 0
		if def.Behavior != "turret" {
			// Follow the caster, a little behind and to the side.
			side := float64(st.slot%3-1) * 1.6
			fx, fz := -math.Sin(owner.YawHint()), -math.Cos(owner.YawHint())
			spot := movement.Vec3{X: owner.Pos.X - fx*2.2 + fz*side, Z: owner.Pos.Z - fz*2.2 - fx*side}
			if hdist(spot, e.Pos) > 1.2 {
				w.moveToward(e, spot, math.Min(1.3, 0.5+hdist(spot, e.Pos)/6))
			} else {
				e.Vel = movement.Vec3{}
			}
		}
		return
	}
	d := hdist(tp, e.Pos)
	reach := def.Attack.Reach + tr
	w.face(e, tp)
	if st.windUntil != 0 {
		e.Vel = movement.Vec3{}
		if w.tick >= st.windUntil {
			st.windUntil = 0
			w.allyStrike(e, tp, tr)
		}
		return
	}
	switch {
	case def.Behavior == "turret":
		e.Vel = movement.Vec3{}
	case d > reach*0.9:
		w.moveToward(e, tp, 1)
	case def.Behavior == "ranged" && d < def.KeepAway:
		bx, bz := (e.Pos.X-tp.X)/math.Max(d, 0.01), (e.Pos.Z-tp.Z)/math.Max(d, 0.01)
		w.stepMove(e, bx*def.Speed*0.6*dt, bz*def.Speed*0.6*dt, true)
	default:
		e.Vel = movement.Vec3{}
	}
	if d <= reach && w.tick >= st.next {
		st.windUntil = w.tick + max(1, ticksOf(def.Attack.WindupSteps))
		st.next = w.tick + ticksOf(def.Attack.EverySteps)
		e.State = Windup // the casting bit for the drawn body
	} else {
		e.State = Chase
	}
}

// allyStrike: a melee bite lands now (if still in reach), a bolt flies.
func (w *World) allyStrike(e *Enemy, tp movement.Vec3, tr float64) {
	st := e.ally
	at := st.def.Attack
	e.State = Chase
	d := hdist(tp, e.Pos)
	data := binary.LittleEndian.AppendUint16(nil, uint16(st.def.ID))
	w.near(e.Pos, 64, 0, Out{Ev: ev(EvSummonAttack, e.ID, st.target, int32(st.spell.ID), movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + e.Height(), Z: e.Pos.Z}, data)})
	if at.Shape == "melee" {
		if d <= at.Reach+tr+0.5 {
			w.allyHit(e, st.target, st.tPlayer)
		}
		return
	}
	flight := secondsToTicks(d / math.Max(1, at.Speed))
	w.bolts = append(w.bolts, pendingBolt{ally: e, target: st.target, player: st.tPlayer, at: w.tick + max(1, flight)})
}

// landBolts resolves ally bolts that arrived (the target must still be
// alive and within reach + 2 m of the ally's line of fire).
func (w *World) landBolts() {
	keep := w.bolts[:0]
	for _, b := range w.bolts {
		if w.tick < b.at {
			keep = append(keep, b)
			continue
		}
		w.allyHit(b.ally, b.target, b.player)
	}
	w.bolts = keep
}

// allyHit lands one ally attack on an enemy (or a player, by the PvP rules).
func (w *World) allyHit(e *Enemy, target uint32, player bool) {
	st := e.ally
	owner := w.players[st.owner]
	if owner == nil {
		return
	}
	base := st.def.Attack.Damage * st.mult
	if player {
		q := w.players[target]
		if q == nil || q.Downed || w.SummonPvP == nil {
			return
		}
		how, ok := w.SummonPvP(st.owner, q.ID)
		if !ok {
			return
		}
		dealt, _ := w.hurtByPlayer(q, base*D.PvP.DamageMult, owner, how.Duel)
		owner.inCombatTick = w.tick
		if w.OnSummonPvP != nil {
			w.OnSummonPvP(st.owner, q.ID, PvPResult{Dealt: dealt, Downed: q.Downed, DuelFloor: how.Duel && q.HP <= 1})
		}
		return
	}
	t := w.enemies[target]
	if t == nil || !t.Alive() || (t.Boss != nil && t.Boss.transitionUntil > w.tick) {
		return
	}
	el := st.def.Element
	dmg := base * D.ElementMult(el, t.Element) * t.damageTakenMult(w.tick)
	dmg = math.Max(1, math.Round(dmg))
	at := movement.Vec3{X: t.Pos.X, Y: t.Pos.Y + t.Height(), Z: t.Pos.Z}
	w.applyDamage(t, owner.ID, dmg, el, at, 0, true, st.killing)
	// The caster sees the number too (applyDamage tells everyone else).
	w.toPlayer(owner.ID, Out{Ev: ev(EvDamage, owner.ID, t.ID, int32(dmg), at, []byte{0, t.HealthPct()})})
	owner.inCombatTick = w.tick
}

// allyPct is an ally's time left as 1..100 (its drawn "health").
func (e *Enemy) allyPct(tick uint32) uint8 {
	st := e.ally
	if st.end <= st.start || tick >= st.end {
		return 1
	}
	return uint8(math.Max(1, math.Round(float64(st.end-tick)*100/float64(st.end-st.start))))
}
