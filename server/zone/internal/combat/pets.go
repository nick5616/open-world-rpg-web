package combat

import (
	"math"
	"slices"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Pets (playtest 2 taming and companions, CR 029; docs/cr/029-pets.md).
//
// A pet is a tamed creature that fights beside its owner. It is built on
// the CR 020 summon machinery (summon.go): an Enemy with an ally record,
// kept out of the enemy tables, steered by the enemies' movement code,
// striking with allyStrike / allyHit, and drawn by the host as EntityKind
// effect (typeId: PetTypeID). Unlike a summon it persists (the host owns
// the record: level, health, name), has real health that enemies take
// away, one ability, a command mode (follow, stay, attack an order), and
// goes down "knocked out" (PetOutputs.KO: the host sends it home) instead
// of timing out.
//
// Enemies: a pet's bites build petThreat on the creature it bites; while
// that beats the threat of the player it chases, the creature turns on the
// pet (chasePet, a serial-AI path), and its strikes and shots hit pets in
// their area like players (no dodges). The creature a pet bit last
// (lastPetHit) gives the pet XP when it falls.
//
// Taming's calm: a tameable creature (Tameable, the host's list) hurt below
// TameWeakenPct of its health is reported in PetOutputs.Weakened; the host
// decides (someone near carries a food it likes) and calls Calm: it stands
// still, sniffing, for the calm's length; a hit breaks it (CalmBroken) and
// it fights on. The host tames it with Tame (removed like a corpse, no XP,
// no loot) and spawns the pet in its place.
//
// Nothing here runs while there are no pets and nothing is calm: the scale
// scenario's bots never tame, so its tick and wire are unchanged.

// Pet command modes.
const (
	PetFollow = 0
	PetStay   = 1
)

// PetTypeBit marks a pet in an EntityKind effect typeId (bits 0-7 the
// combat.yaml enemy id, 8-11 element + 1 (0 none), bit 12 shiny).
const PetTypeBit uint16 = 1 << 15

// PetTypeShiny is the shiny variant's typeId bit.
const PetTypeShiny uint16 = 1 << 12

// PetTypeID is a pet's wire typeId.
func PetTypeID(enemyID, element int, shiny bool) uint16 {
	el := 0
	if element >= 0 && element < combatdefs.Physical {
		el = element + 1
	}
	t := PetTypeBit | uint16(enemyID&0xff) | uint16(el&0xf)<<8
	if shiny {
		t |= PetTypeShiny
	}
	return t
}

// PetAbility is a pet's one ability, resolved by the host from content.yaml.
type PetAbility struct {
	ID        int
	Kind      string // heal | buff | charge | strike
	CooldownS float64
	Power     float64
	HealBelow float64
	Party     bool
	DurationS float64
	RangeMin  float64
	RangeMax  float64
	RadiusM   float64
	Status    string
	Element   int // -1: the pet's own
}

// PetSpec is a pet the host puts in the world.
type PetSpec struct {
	Owner     uint32 // the owner's entity id
	Slot      int    // the host's pet id
	Enemy     string // combat.yaml creature (body, model)
	Level     int
	Element   int // -1: the creature's own
	Shiny     bool
	HPMax, HP float64
	Damage    float64 // one bite, level and variant applied
	Speed     float64
	Reach     float64
	EveryMs   float64
	WindupMs  float64
	Ability   PetAbility
	AggroM    float64
	LeashM    float64
	FollowM   float64
	WarpM     float64
	GuardM    float64 // stay: fights what comes this close to its spot
	RegenPctS float64
	Pos       movement.Vec3
	Mode      int
}

// petState is a pet's part of the Enemy struct.
type petState struct {
	spec      PetSpec
	typeID    uint16
	mode      int
	stay      movement.Vec3
	order     uint32 // attack this enemy (0 none)
	abilityAt uint32 // tick the ability is ready
	fightAt   uint32 // last tick it fought (regen waits)
	charge    *petCharge
	koed      bool
}

type petCharge struct {
	target uint32
	until  uint32
	yaw    float64
}

// PetKO is a pet knocked out this tick.
type PetKO struct {
	Owner uint32
	Slot  int
	By    uint32 // the enemy that downed it
}

// PetXP is XP a pet earned this tick (a creature it bit fell).
type PetXP struct {
	Owner uint32
	Slot  int
	XP    float64
	Enemy string
}

// PetAct is something a pet did others should see (Event 1205 is the host's).
type PetAct struct {
	Owner   uint32
	Slot    int
	Pet     uint32
	Ability int
	Target  uint32
	Pos     movement.Vec3
}

// Weakened is a tameable creature hurt below the weaken threshold.
type Weakened struct {
	Enemy *Enemy
	By    uint32 // the player whose hit (or whose pet's bite) did it
}

// PetOutputs is what pets and taming did this tick (DrainPets).
type PetOutputs struct {
	KO         []PetKO
	XP         []PetXP
	Acts       []PetAct
	Weakened   []Weakened
	CalmBroken []uint32 // creatures whose calm a hit broke (a calm that runs out: Enemy.Calm turns false)
}

// DrainPets returns and clears this tick's pet outputs.
func (w *World) DrainPets() PetOutputs {
	o := w.petOut
	w.petOut = PetOutputs{}
	return o
}

// Pets lists the live pets (tests, the host).
func (w *World) Pets() []*Enemy { return w.pets }

// PetOf is owner's live pet (nil if none).
func (w *World) PetOf(owner uint32) *Enemy {
	for _, e := range w.pets {
		if e.ally.owner == owner {
			return e
		}
	}
	return nil
}

// IsPet reports a pet.
func (e *Enemy) IsPet() bool { return e.pet != nil }

// PetSlot is a pet's host id (0 for anything else).
func (e *Enemy) PetSlot() int {
	if e.pet == nil {
		return 0
	}
	return e.pet.spec.Slot
}

// PetMode is a pet's command mode and its attack order.
func (e *Enemy) PetMode() (mode int, order uint32) {
	if e.pet == nil {
		return 0, 0
	}
	return e.pet.mode, e.pet.order
}

// Calm reports a creature calmed for taming.
func (e *Enemy) Calm(tick uint32) bool { return e.calmUntil != 0 && tick < e.calmUntil }

// SpawnPet puts a pet in the world beside its owner (one per owner: an
// older one is removed first). nil when the creature is unknown.
func (w *World) SpawnPet(sp PetSpec) *Enemy {
	def := D.EnemyByKey(sp.Enemy)
	if def == nil {
		return nil
	}
	if old := w.PetOf(sp.Owner); old != nil {
		w.RemovePet(old)
	}
	if w.summonIdx == nil {
		w.summonIdx = map[uint32]*Enemy{}
	}
	body := *def
	body.Speed, body.Behavior, body.KeepAway = sp.Speed, "melee", 0
	el := sp.Element
	if el < 0 || el >= combatdefs.Physical {
		el = def.Element
	}
	sum := &combatdefs.Summon{
		Key: "pet_" + def.Key, ID: def.ID, Name: def.Name, Family: def.Family, Behavior: "melee", Element: el,
		Speed: sp.Speed, Size: def.Size, Color: def.Color, Aggro: sp.AggroM, LeashM: sp.LeashM,
		Attack: combatdefs.SummonAttack{Shape: "melee", Reach: sp.Reach, Damage: sp.Damage, EverySteps: msSteps(sp.EveryMs), WindupSteps: msSteps(sp.WindupMs)},
		Body:   &body,
	}
	pos := w.place(sp.Pos.X, sp.Pos.Z, &body)
	e := newEnemy(&body, max(1, sp.Level), el, nil, pos)
	e.HPMax = math.Max(1, sp.HPMax)
	e.HP = math.Max(1, math.Min(e.HPMax, sp.HP))
	e.baseHP = e.HPMax
	e.ally = &summonState{def: sum, owner: sp.Owner, start: w.tick, end: math.MaxUint32, mult: 1, next: w.tick + ticksOf(sum.Attack.WindupSteps), pct: 100}
	e.pet = &petState{spec: sp, typeID: PetTypeID(def.ID, el, sp.Shiny), mode: sp.Mode, stay: pos, abilityAt: w.tick + secondsToTicks(2)}
	e.State = Chase
	e.Home = pos
	e.ID = w.alloc()
	e.record(w.tick)
	w.pets = append(w.pets, e)
	w.summonIdx[e.ID] = e
	w.Spawned = append(w.Spawned, e)
	return e
}

// msSteps converts milliseconds to 60 Hz definition steps.
func msSteps(ms float64) int { return int(math.Round(ms * float64(D.StepHz) / 1000)) }

// RemovePet takes a pet out of the world (stabled, its owner left, a
// handoff, knocked out). The host reads its health first.
func (w *World) RemovePet(e *Enemy) {
	i := slices.Index(w.pets, e)
	if i < 0 {
		return
	}
	w.pets = slices.Delete(w.pets, i, i+1)
	delete(w.summonIdx, e.ID)
	e.State = Dead
	e.gone = true
	w.Removed = append(w.Removed, e)
}

// DismissPets removes owner's pet (leaving).
func (w *World) DismissPets(owner uint32) {
	if p := w.PetOf(owner); p != nil {
		w.RemovePet(p)
	}
}

// CommandPet sets a pet's mode (follow / stay where it stands) and its
// attack order (an enemy id, 0 none: back to its mode).
func (w *World) CommandPet(e *Enemy, mode int, order uint32) {
	if e == nil || e.pet == nil {
		return
	}
	pt := e.pet
	if mode != pt.mode && mode == PetStay {
		pt.stay = e.Pos
	}
	pt.mode = mode
	pt.order = 0
	if t := w.enemies[order]; order != 0 && t != nil && t.Alive() && !t.Calm(w.tick) {
		pt.order = order
		e.ally.target, e.ally.tPlayer = order, false
	} else if order == 0 {
		e.ally.target = 0
		e.ally.windUntil = 0
	}
}

// RecallPet brings a pet to its owner's side at once (and back to following).
func (w *World) RecallPet(e *Enemy) {
	if e == nil || e.pet == nil {
		return
	}
	if owner := w.players[e.ally.owner]; owner != nil {
		w.warpPet(e, owner)
	}
	w.CommandPet(e, PetFollow, 0)
}

// HealPet heals a pet by a share of its health (feeding).
func (w *World) HealPet(e *Enemy, frac float64) {
	if e == nil || e.pet == nil || !e.Alive() {
		return
	}
	e.HP = math.Min(e.HPMax, e.HP+e.HPMax*frac)
}

// UpdatePet applies a new level's numbers to a live pet (health keeps its share).
func (w *World) UpdatePet(e *Enemy, sp PetSpec) {
	if e == nil || e.pet == nil {
		return
	}
	frac := e.HP / math.Max(1, e.HPMax)
	e.HPMax = math.Max(1, sp.HPMax)
	e.HP = math.Max(1, e.HPMax*frac)
	e.baseHP = e.HPMax
	e.Level = max(1, sp.Level)
	e.ally.def.Attack.Damage = sp.Damage
	sp.Owner, sp.Slot = e.pet.spec.Owner, e.pet.spec.Slot
	e.pet.spec = sp
}

// warpPet sets a pet down beside its owner (fast travel, a fall, a recall).
func (w *World) warpPet(e *Enemy, owner *Player) {
	yaw := owner.YawHint()
	x, z := owner.Pos.X+math.Sin(yaw)*2.2+math.Cos(yaw)*1.4, owner.Pos.Z+math.Cos(yaw)*2.2-math.Sin(yaw)*1.4
	e.Pos = w.place(x, z, e.Def)
	if math.Abs(e.Pos.Y-owner.Pos.Y) > 3 {
		e.Pos = owner.Pos // a cave, a roof: right at the owner's feet
	}
	e.Vel = movement.Vec3{}
	e.ally.target, e.ally.windUntil = 0, 0
	e.pet.charge = nil
	e.pet.stay = e.Pos
}

// stepPets runs every pet for one tick (after the summons).
func (w *World) stepPets() {
	if len(w.pets) == 0 {
		return
	}
	for _, e := range slices.Clone(w.pets) {
		owner := w.players[e.ally.owner]
		if owner == nil {
			w.RemovePet(e)
			continue
		}
		pt := e.pet
		if hdist(owner.Pos, e.Pos) > pt.spec.WarpM || math.Abs(owner.Pos.Y-e.Pos.Y) > 24 {
			w.warpPet(e, owner)
		}
		w.petThink(e, owner)
		e.record(w.tick)
	}
}

// petThink: the charge, the ability, a target, move, bite.
func (w *World) petThink(e *Enemy, owner *Player) {
	st, pt := e.ally, e.pet
	tick := w.tick
	if pt.charge != nil {
		w.petCharging(e, owner)
		return
	}
	if e.disabled(tick) {
		e.Vel = movement.Vec3{}
		return
	}
	center, guard := owner.Pos, pt.spec.LeashM
	if pt.mode == PetStay {
		center, guard = pt.stay, pt.spec.GuardM
	}
	tp, tr, ok := w.petTarget(e, center, guard)
	if !ok || (tick+e.ID)%10 == 0 && st.windUntil == 0 && pt.order == 0 {
		w.petAcquire(e, owner, center, guard)
		tp, tr, ok = w.petTarget(e, center, guard)
	}
	w.petAbility(e, owner, ok, tp, tr)
	if pt.charge != nil {
		return
	}
	if !ok {
		st.windUntil = 0
		e.State = Chase
		spot := center
		if pt.mode == PetFollow {
			// a little behind and to the side of its owner
			fx, fz := -math.Sin(owner.YawHint()), -math.Cos(owner.YawHint())
			side := 1.2
			if e.ID%2 == 0 {
				side = -1.2
			}
			spot = movement.Vec3{X: owner.Pos.X - fx*pt.spec.FollowM + fz*side, Z: owner.Pos.Z - fz*pt.spec.FollowM - fx*side}
		}
		if d := hdist(spot, e.Pos); d > 1.2 {
			w.moveToward(e, spot, math.Min(1.4, 0.45+d/5))
		} else {
			e.Vel = movement.Vec3{}
			if pt.mode == PetFollow && hdist(owner.Pos, e.Pos) > 0.5 {
				w.face(e, owner.Pos)
			}
		}
		if tick-pt.fightAt > secondsToTicks(5) && e.HP < e.HPMax {
			e.HP = math.Min(e.HPMax, e.HP+e.HPMax*pt.spec.RegenPctS*dt)
		}
		return
	}
	pt.fightAt = tick
	d := hdist(tp, e.Pos)
	reach := st.def.Attack.Reach + tr
	w.face(e, tp)
	if st.windUntil != 0 {
		e.Vel = movement.Vec3{}
		if tick >= st.windUntil {
			st.windUntil = 0
			w.allyStrike(e, tp, tr)
		}
		return
	}
	if d > reach*0.9 {
		w.moveToward(e, tp, 1.15)
	} else {
		e.Vel = movement.Vec3{}
	}
	if d <= reach && tick >= st.next {
		st.windUntil = tick + max(1, ticksOf(st.def.Attack.WindupSteps))
		st.next = tick + ticksOf(st.def.Attack.EverySteps)
		e.State = Windup
	} else {
		e.State = Chase
	}
}

// petTarget is where a pet's target is (an enemy), false when there is none
// worth fighting (dead, calm, or beyond its guard).
func (w *World) petTarget(e *Enemy, center movement.Vec3, guard float64) (movement.Vec3, float64, bool) {
	st, pt := e.ally, e.pet
	if st.target == 0 {
		return movement.Vec3{}, 0, false
	}
	t := w.enemies[st.target]
	if t == nil || !t.Alive() || t.Calm(w.tick) {
		st.target, pt.order = 0, 0
		return movement.Vec3{}, 0, false
	}
	limit := guard + 8
	if st.target == pt.order {
		limit = pt.spec.LeashM + 12
	}
	if hdist(t.Pos, center) > limit {
		st.target, pt.order = 0, 0
		return movement.Vec3{}, 0, false
	}
	return t.Pos, t.Radius(), true
}

// petAcquire picks a pet's target: its order, else the nearest creature
// that is fighting (its owner, it, or anyone) within its aggro and guard.
// Sleeping and idle creatures are left alone, so a pet never starts a fight.
func (w *World) petAcquire(e *Enemy, owner *Player, center movement.Vec3, guard float64) {
	st, pt := e.ally, e.pet
	if pt.order != 0 {
		if t := w.enemies[pt.order]; t != nil && t.Alive() && !t.Calm(w.tick) {
			st.target = pt.order
			return
		}
		pt.order = 0
	}
	st.target, st.tPlayer = 0, false
	best := math.MaxFloat64
	for _, id := range w.order {
		t := w.enemies[id]
		if t == nil || !t.Alive() || t.Calm(w.tick) || t.Def.Behavior == "flee" || math.Abs(t.Pos.Y-e.Pos.Y) > 8 {
			continue
		}
		switch t.State {
		case Asleep, Idle, Return, Dead:
			if t.petTgt != e.ID && t.Target != owner.ID {
				continue
			}
		}
		d := hdist(t.Pos, e.Pos)
		if d > pt.spec.AggroM || hdist(t.Pos, center) > guard {
			continue
		}
		// what fights its owner or itself comes first
		if t.Target == owner.ID || t.petTgt == e.ID {
			d -= 4
		}
		if d < best || (d == best && id < st.target) {
			best, st.target = d, id
		}
	}
}

// petAbility uses the pet's one ability when it fits.
func (w *World) petAbility(e *Enemy, owner *Player, hasTarget bool, tp movement.Vec3, tr float64) {
	pt := e.pet
	ab := &pt.spec.Ability
	tick := w.tick
	if ab.ID == 0 || tick < pt.abilityAt || owner.Downed {
		return
	}
	used := false
	target := uint32(0)
	switch ab.Kind {
	case "heal":
		hurt := owner.HP < owner.HPMax*ab.HealBelow
		if ab.Party && !hurt {
			for _, q := range w.playersNear(owner.Pos, 12) {
				if q.PartyID != 0 && q.PartyID == owner.PartyID && !q.Downed && q.HP < q.HPMax*ab.HealBelow {
					hurt = true
				}
			}
		}
		if !hurt || hdist(owner.Pos, e.Pos) > 14 {
			return
		}
		w.healPlayer(owner, owner, owner.HPMax*ab.Power)
		if ab.Party {
			for _, q := range w.playersNear(owner.Pos, 12) {
				if q != owner && q.PartyID != 0 && q.PartyID == owner.PartyID {
					w.healPlayer(owner, q, q.HPMax*ab.Power)
				}
			}
		}
		e.HP = math.Min(e.HPMax, e.HP+e.HPMax*ab.Power*1.5)
		target, used = owner.ID, true
	case "buff":
		if !hasTarget || hdist(owner.Pos, e.Pos) > 20 {
			return
		}
		owner.petBuffMult = 1 + ab.Power
		owner.petBuffEnd = tick + secondsToTicks(ab.DurationS)
		target, used = owner.ID, true
	case "charge":
		if !hasTarget || e.ally.windUntil != 0 {
			return
		}
		d := hdist(tp, e.Pos)
		if d < ab.RangeMin || d > ab.RangeMax {
			return
		}
		w.face(e, tp)
		pt.charge = &petCharge{target: e.ally.target, until: tick + secondsToTicks(math.Min(0.9, d/18+0.15)), yaw: e.Yaw}
		e.State = Striking
		target, used = e.ally.target, true
	case "strike":
		if !hasTarget || e.ally.windUntil != 0 || hdist(tp, e.Pos) > e.ally.def.Attack.Reach+tr+0.3 {
			return
		}
		t := w.enemies[e.ally.target]
		if t == nil {
			return
		}
		w.petSpecialHit(e, owner, t, ab)
		e.ally.next = tick + ticksOf(e.ally.def.Attack.EverySteps)
		target, used = t.ID, true
	}
	if used {
		pt.abilityAt = tick + secondsToTicks(ab.CooldownS)
		w.petOut.Acts = append(w.petOut.Acts, PetAct{Owner: owner.ID, Slot: pt.spec.Slot, Pet: e.ID, Ability: ab.ID, Target: target, Pos: e.Pos})
	}
}

// petCharging rushes along the charge line; the first touch hits and stuns.
func (w *World) petCharging(e *Enemy, owner *Player) {
	pt := e.pet
	c := pt.charge
	t := w.enemies[c.target]
	if t == nil || !t.Alive() || w.tick >= c.until {
		pt.charge = nil
		e.State = Chase
		return
	}
	w.face(e, t.Pos)
	sp := math.Max(16, pt.spec.Speed*2)
	fx, fz := -math.Sin(e.Yaw), -math.Cos(e.Yaw)
	w.stepMove(e, fx*sp*dt, fz*sp*dt, false)
	if hdist(t.Pos, e.Pos) <= e.ally.def.Attack.Reach+t.Radius()+0.4 {
		w.petSpecialHit(e, owner, t, &pt.spec.Ability)
		pt.charge = nil
		e.State = Chase
		e.ally.next = w.tick + ticksOf(e.ally.def.Attack.EverySteps)
	}
}

// petSpecialHit lands an ability hit: power x the bite (its element), the
// status, on the target and (radiusM) everything near it.
func (w *World) petSpecialHit(e *Enemy, owner *Player, t *Enemy, ab *PetAbility) {
	el := e.ally.def.Element
	if ab.Element >= 0 && ab.Element < combatdefs.Physical {
		el = ab.Element
	}
	victims := []*Enemy{t}
	if ab.RadiusM > 0 {
		for _, id := range w.order {
			o := w.enemies[id]
			if o != nil && o != t && o.Alive() && !o.Calm(w.tick) && hdist(o.Pos, t.Pos) <= ab.RadiusM && o.Def.Behavior != "flee" {
				victims = append(victims, o)
			}
		}
	}
	for _, v := range victims {
		dmg := math.Max(1, math.Round(e.ally.def.Attack.Damage*ab.Power*D.ElementMult(el, v.Element)*v.damageTakenMult(w.tick)))
		at := movement.Vec3{X: v.Pos.X, Y: v.Pos.Y + v.Height(), Z: v.Pos.Z}
		w.petBit(e, v, dmg)
		if ab.Status != "" && v.Alive() {
			v.applyStatus(ab.Status, owner.ID, e.Pos, w.tick, 1)
		}
		w.applyDamage(v, owner.ID, dmg, el, at, 0, true, false)
		w.toPlayer(owner.ID, Out{Ev: ev(EvDamage, owner.ID, v.ID, int32(dmg), at, []byte{0, v.HealthPct()})})
	}
	owner.inCombatTick = w.tick
}

// petBit: a pet's bite (or ability) on t builds threat that may turn t on
// the pet, and makes the pet the one that learns from t's fall.
func (w *World) petBit(e *Enemy, t *Enemy, dmg float64) {
	t.lastPetHit = e.ID
	if t.petTgt != 0 && t.petTgt != e.ID {
		if o := w.summonIdx[t.petTgt]; o != nil && o.pet != nil && o.Alive() {
			return // another pet holds it
		}
		t.petThreat = 0
	}
	t.petTgt = e.ID
	t.petThreat += dmg * 1.6
	if t.State == Idle || t.State == Asleep || t.State == Alert || t.State == Return {
		if t.State == Asleep && t.Group != nil {
			t.Group.Awake = true
		}
		t.State, t.stateAt = Chase, w.tick
	}
}

// chasePet: an enemy whose pet threat beats its player's chases the pet
// (true) instead. A gone pet (or a player that hurt it more) clears it.
func (w *World) chasePet(e *Enemy, p *Player) bool {
	pet := w.summonIdx[e.petTgt]
	if pet == nil || pet.pet == nil || !pet.Alive() || hdist(pet.Pos, e.Home) > e.leash()+e.Def.Aggro {
		e.petTgt, e.petThreat = 0, 0
		return false
	}
	if p != nil && !p.Downed && e.threat[p.ID] >= e.petThreat {
		return false
	}
	if hdist(e.Pos, e.Home) > e.leash() {
		e.petTgt, e.petThreat = 0, 0
		return false
	}
	tick := w.tick
	d := hdist(pet.Pos, e.Pos)
	w.face(e, pet.Pos)
	if e.State == Reposition && tick-e.stateAt >= repositionTicks {
		e.State, e.stateAt = Chase, tick
	}
	if tick >= e.nextAttack {
		var best *combatdefs.EnemyAttack
		for _, k := range w.attacksOf(e) {
			a := D.AttackByKey(k)
			if tick < e.cooldowns[a.ID] || d > a.Range()+e.Radius()+pet.Radius() || d < a.MinRange || a.Everyone {
				continue
			}
			if best == nil || a.Damage > best.Damage {
				best = a
			}
		}
		if best != nil {
			w.windupAt(e, best, pet.Pos)
			return true
		}
	}
	want := 1.2 + e.Radius() + pet.Radius()
	if e.Def.KeepAway > 0 {
		want = e.Def.KeepAway
	}
	if d > want+0.4 {
		w.moveToward(e, pet.Pos, 1)
	} else {
		e.Vel = movement.Vec3{}
	}
	return true
}

// strikePets lands an enemy strike on every pet in its area (no dodges).
func (w *World) strikePets(e *Enemy, a *combatdefs.EnemyAttack, area attackArea, already map[uint32]bool) {
	for _, p := range slices.Clone(w.pets) {
		if p.pet.koed || (already != nil && already[p.ID]) || e.pet != nil {
			continue
		}
		if hdist(p.Pos, area.center) > area.reach+area.radius+6 || !area.contains(p.Pos, p.Radius()+0.2) {
			continue
		}
		if already != nil {
			already[p.ID] = true
		}
		w.hurtPet(p, a.Damage*e.DamageMult*D.ElementMult(a.Element, p.Element), e.ID)
	}
}

// shotHitsPet: an enemy projectile touching a pet hits it (true: the shot is spent).
func (w *World) shotHitsPet(s *shot) bool {
	for _, p := range w.pets {
		if p.pet.koed || s.hit[p.ID] {
			continue
		}
		c := movement.Vec3{X: p.Pos.X, Y: p.Pos.Y + p.Height(), Z: p.Pos.Z}
		if hdist(c, s.pos) <= s.radius+p.Radius()+0.15 && math.Abs(c.Y-s.pos.Y) < p.Height()+s.radius+0.3 {
			if s.hit == nil {
				s.hit = map[uint32]bool{}
			}
			s.hit[p.ID] = true
			w.hurtPet(p, s.att.Damage*s.enemy.DamageMult*D.ElementMult(s.att.Element, p.Element), s.enemy.ID)
			return true
		}
	}
	return false
}

// hurtPet takes health from a pet; at 0 it is knocked out (the host sends it home).
func (w *World) hurtPet(pe *Enemy, dmg float64, by uint32) {
	if pe.pet == nil || pe.pet.koed || dmg <= 0 {
		return
	}
	dmg = math.Max(1, math.Round(dmg))
	pe.HP -= dmg
	pe.pet.fightAt = w.tick
	at := movement.Vec3{X: pe.Pos.X, Y: pe.Pos.Y + pe.Height(), Z: pe.Pos.Z}
	// The owner sees the number (taken: the red style), everyone near the flash.
	w.toPlayer(pe.ally.owner, Out{Ev: ev(EvDamage, by, pe.ID, int32(dmg), at, []byte{0, pe.HealthPct()})})
	if pe.HP > 0 {
		return
	}
	pe.HP = 0
	pe.pet.koed = true
	w.petOut.KO = append(w.petOut.KO, PetKO{Owner: pe.ally.owner, Slot: pe.pet.spec.Slot, By: by})
	for _, id := range w.order {
		if t := w.enemies[id]; t != nil && t.petTgt == pe.ID {
			t.petTgt, t.petThreat = 0, 0
		}
	}
	w.RemovePet(pe)
}

// HurtPet hurts a pet (tests and dev tools: what an enemy strike does).
func (w *World) HurtPet(e *Enemy, dmg float64, by uint32) { w.hurtPet(e, dmg, by) }

// petKill: e fell; the pet that bit it last (still out) earns its XP.
func (w *World) petKill(e *Enemy, xp float64) {
	p := w.summonIdx[e.lastPetHit]
	if p == nil || p.pet == nil || !p.Alive() || hdist(p.Pos, e.Pos) > 40 {
		return
	}
	if p.pet.order == e.ID {
		p.pet.order = 0
	}
	w.petOut.XP = append(w.petOut.XP, PetXP{Owner: p.ally.owner, Slot: p.pet.spec.Slot, XP: xp, Enemy: e.Def.Key})
}

// ---- taming's calm ----

// noteWeakened reports a tameable creature hurt below the weaken share.
func (w *World) noteWeakened(e *Enemy, by uint32) {
	if !w.Tameable[e.Def.ID] || e.Boss != nil || e.Demon != nil || e.ally != nil || e.HP > e.HPMax*w.TameWeakenPct || w.tick < e.calmAgain {
		return
	}
	if p := w.summonIdx[by]; p != nil && p.ally != nil {
		by = p.ally.owner
	}
	e.calmAgain = w.tick + secondsToTicks(4) // asked once; the host answers this tick
	w.petOut.Weakened = append(w.petOut.Weakened, Weakened{Enemy: e, By: by})
}

// Calm makes a creature stand and sniff for seconds (the host's taming).
func (w *World) Calm(e *Enemy, seconds float64) {
	if e == nil || !e.Alive() {
		return
	}
	e.calmUntil = w.tick + max(1, secondsToTicks(seconds))
	e.State, e.stateAt = Idle, w.tick
	e.Target = 0
	e.attack = nil
	e.Vel = movement.Vec3{}
	e.petTgt, e.petThreat = 0, 0
	clear(e.threat)
	for _, p := range w.pets { // pets leave it alone
		if p.ally.target == e.ID {
			p.ally.target, p.ally.windUntil = 0, 0
		}
		if p.pet.order == e.ID {
			p.pet.order = 0
		}
	}
}

// ExtendCalm keeps a calm going (while the taming meter fills).
func (w *World) ExtendCalm(e *Enemy, seconds float64) {
	if e != nil && e.calmUntil != 0 {
		e.calmUntil = max(e.calmUntil, w.tick+secondsToTicks(seconds))
	}
}

// EndCalm ends a calm; with angryAt it turns on that player.
func (w *World) EndCalm(e *Enemy, angryAt uint32) {
	if e == nil || e.calmUntil == 0 {
		return
	}
	e.calmUntil = 0
	e.calmAgain = w.tick + secondsToTicks(10)
	if p := w.players[angryAt]; p != nil && e.Alive() {
		e.Target = p.ID
		e.threat[p.ID] += 1
		e.State, e.stateAt = Chase, w.tick
	}
}

// breakCalm: a hit broke a calm (applyDamage).
func (w *World) breakCalm(e *Enemy) {
	e.calmUntil = 0
	e.calmAgain = w.tick + secondsToTicks(10)
	w.petOut.CalmBroken = append(w.petOut.CalmBroken, e.ID)
}

// calmThink: a calm creature stands, turning to the nearest player (true
// while calm; false when it ran out: it fights on as usual).
func (w *World) calmThink(e *Enemy) bool {
	if w.tick >= e.calmUntil {
		e.calmUntil = 0
		e.calmAgain = w.tick + secondsToTicks(10)
		return false
	}
	e.Vel = movement.Vec3{}
	if e.State != Idle {
		e.State, e.stateAt = Idle, w.tick
	}
	var near *Player
	nd := 12.0
	w.eachPlayerNear(e.Pos.X, e.Pos.Z, nd, func(p *Player) {
		if d := hdist(p.Pos, e.Pos); d < nd || d == nd && near != nil && p.ID < near.ID {
			near, nd = p, d
		}
	})
	if near != nil {
		w.face(e, near.Pos)
	}
	return true
}

// Tame takes a calm creature out of the world for good (it becomes a pet:
// the host spawns that). No XP, no loot; its group counts it as gone.
func (w *World) Tame(e *Enemy) bool {
	if e == nil || !e.Alive() || w.enemies[e.ID] != e {
		return false
	}
	e.HP = 0
	e.State = Dead
	e.calmUntil = 0
	e.diedTick = w.tick
	w.removeEnemy(e)
	if g := e.Group; g != nil {
		w.quietClear = true
		w.groupCleared(g)
		w.quietClear = false
	}
	return true
}
