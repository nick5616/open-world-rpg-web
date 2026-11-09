package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Hit validation (spec 9 "Combat validation (PvE, favor the player)"): the
// client predicts a hit, plays its feedback at once and claims it; the zone
// accepts it if the target was within reach (plus HIT_RANGE_SLACK_M) and in
// line of sight at ANY sample of its position over the last HIT_HISTORY_MS
// before what the client saw, plus the interpolation delay. A deliberately
// cheap cousin of lag compensation sized for monsters, not people: wizard-
// wars' LagCompensation.js is not ported (spec 2).

// HitResult flags (protocol.yaml HitResult.flags when accepted).
const (
	FlagCrit     = 1
	FlagKilled   = 2
	FlagWeak     = 4
	FlagResisted = 8
	FlagShielded = 16
)

// ClaimResult is the verdict on one HitClaim.
type ClaimResult struct {
	Accepted bool
	Pending  bool // the claimed attack's frame hasn't arrived yet: retry
	Reason   uint8
	Damage   uint16
	Flags    uint8
	HPPct    uint8
	Enemy    *Enemy
}

// historyTicks: HIT_HISTORY_MS of position samples before the client's
// snapshot tick, plus the near-ring interpolation delay it renders behind.
var historyTicks = uint32((constants.HitHistoryMs + constants.InterpDelayNearMs) * constants.TickRateHz / 1000)

const (
	futureTicks = 4 // the client's tick may lead what we applied by a few ticks
	arcSlack    = 25 * math.Pi / 180
	aimSlack    = 30 * math.Pi / 180
	losStep     = 1.5
	chainRange  = 10.0
	eyeHeight   = constants.PlayerHeight
)

func (w *World) refuse(r uint8) ClaimResult {
	w.Stats.ClaimsRefused++
	if int(r) < len(w.Stats.RefusedBy) {
		w.Stats.RefusedBy[r]++
	}
	return ClaimResult{Reason: r}
}

// RefusePlayerTarget is the verdict for a claim that names a player (the
// game layer calls it when the target id is a player entity): never.
func (w *World) RefusePlayerTarget() ClaimResult { return w.refuse(RefuseNotEnemy) }

// Claim validates and applies one hit claim from p.
func (w *World) Claim(p *Player, c *proto.HitClaim) ClaimResult {
	if p.Downed {
		return w.refuse(RefuseDowned)
	}
	e := w.enemies[c.TargetID]
	if e == nil {
		return w.refuse(RefuseNoTarget)
	}
	if !e.Alive() {
		return w.refuse(RefuseDead)
	}
	a := p.Action(c.AttackSeq, int(c.AttackID))
	if a == nil {
		if c.AttackSeq > p.LastSeq {
			return ClaimResult{Pending: true}
		}
		return w.refuse(RefuseUnknown)
	}
	if !a.Legal {
		return w.refuse(uint8(a.Refusal))
	}
	if w.tick-a.Tick > maxAgeTicks(a) {
		return w.refuse(RefuseStale)
	}
	allowed, maxTargets := hitLimits(a)
	if a.hits[e.ID] >= allowed || (a.hits[e.ID] == 0 && a.targets >= maxTargets) {
		return w.refuse(RefuseHits)
	}
	if e.Boss != nil && e.Boss.transitionUntil > w.tick {
		return w.refuse(RefuseInvulnerable)
	}
	if s := a.Spell; s != nil {
		if s.RequiresStatus != "" && !e.has(s.RequiresStatus, w.tick) {
			return w.refuse(RefuseStatus)
		}
		if s.NonBossOnly && e.Boss != nil {
			return w.refuse(RefuseIllegal)
		}
		if w.tick-a.Tick+2 < ticksOf(s.WindupSteps) || (s.Type == "rune" && w.tick-a.Tick+2 < ticksOf(s.ArmSteps)) {
			return w.refuse(RefuseIllegal) // hit before the wind-up/arming could finish
		}
	}
	impact := movement.Vec3{X: proto.CmToMeters(c.X), Y: proto.CmToMeters(c.Y), Z: proto.CmToMeters(c.Z)}
	ct := min(c.Tick, w.tick)
	lo, hi := ct-min(ct, historyTicks), min(w.tick, ct+futureTicks)
	inReach, sawLOS := false, false
	e.samples(lo, hi, func(tp movement.Vec3) {
		if inReach && sawLOS {
			return
		}
		if w.geometryOK(p, a, e, tp, impact) {
			inReach = true
			if !needsLOS(a, p.Pos, tp) || w.lineOfSight(a.Pos, p.Pos, tp, e.Height()) {
				sawLOS = true
			}
		}
	})
	if !inReach {
		return w.refuse(RefuseRange)
	}
	if !sawLOS {
		return w.refuse(RefuseLOS)
	}
	return w.applyHit(p, a, e, impact)
}

// maxAgeTicks bounds how late a claim for an action may arrive.
func maxAgeTicks(a *Action) uint32 {
	base := secondsToTicks(1.2)
	switch {
	case a.Move != nil && a.Move.Speed > 0:
		sp := a.Move.Speed
		if a.Move.ChargeSpeed > sp {
			sp = a.Move.ChargeSpeed
		}
		return base + secondsToTicks(a.Move.Reach/math.Max(1, sp)*1.5)
	case a.Spell != nil:
		s := a.Spell
		t := base + ticksOf(s.WindupSteps) + ticksOf(s.DurationSteps)
		if s.Speed > 0 {
			t += secondsToTicks(s.Range / s.Speed * 1.5)
		}
		return t
	}
	return base
}

// hitLimits: hits on one target and distinct targets per action.
func hitLimits(a *Action) (perTarget, targets int) {
	switch {
	case a.Move != nil:
		perTarget = max(1, a.Move.Hits)
		targets = MaxMeleeTargets
		if a.Move.Speed > 0 {
			targets = 1
			if a.Move.Kind == "charged" {
				targets = 3 // charged pierce
			}
		}
		if a.Move.Radius > 1 {
			targets = 12 // arrow rain
		}
	case a.Spell != nil:
		s := a.Spell
		perTarget = max(1, s.Hits)
		switch s.Type {
		case "aoe", "domain", "rune":
			targets = 16
		case "projectile", "arc":
			targets = 1
			if s.Pierce || s.Radius > 1 {
				targets = 8
			}
			if s.Spread > 1 {
				targets = s.Spread
			}
		case "hitscan":
			targets = 1 + s.Chain
			if s.Pierce {
				targets = 6
			}
		case "beam":
			targets = 3
		default:
			targets = 1
		}
	case a.Form != nil:
		perTarget, targets = 1, 12
	}
	return
}

func needsLOS(a *Action, from, to movement.Vec3) bool {
	if a.Move != nil && a.Move.Speed == 0 {
		return false // melee: reach is the check
	}
	if a.Spell != nil && (a.Spell.SelfCast || a.Spell.Type == "domain") {
		return false
	}
	return hdist(from, to) > 6
}

// lineOfSight: terrain doesn't block the segment from the attacker's eye
// (at the start or now) to the target's centre or top.
func (w *World) lineOfSight(start, now, tp movement.Vec3, h float64) bool {
	for _, o := range []movement.Vec3{start, now} {
		eye := movement.Vec3{X: o.X, Y: o.Y + eyeHeight, Z: o.Z}
		for _, top := range []float64{h, h * 2} {
			if w.clear(eye, movement.Vec3{X: tp.X, Y: tp.Y + top, Z: tp.Z}) {
				return true
			}
		}
	}
	return false
}

func (w *World) clear(a, b movement.Vec3) bool {
	d := hdist(a, b)
	n := int(d / losStep)
	for i := 1; i < n; i++ {
		t := float64(i) / float64(n)
		x, y, z := a.X+(b.X-a.X)*t, a.Y+(b.Y-a.Y)*t, a.Z+(b.Z-a.Z)*t
		if w.ground.HeightAt(x, z) > y+0.3 {
			return false
		}
	}
	return true
}

// geometryOK checks one target sample against the action's shape.
func (w *World) geometryOK(p *Player, a *Action, e *Enemy, tp movement.Vec3, impact movement.Vec3) bool {
	r := e.Radius() + constants.HitRangeSlackM
	vertical := func(o movement.Vec3, extra float64) bool { return math.Abs(tp.Y-o.Y) <= 3+e.Height()+extra }
	inCone := func(o movement.Vec3, yaw, reach, arcDeg float64) bool {
		d := hdist(o, tp)
		if d > reach+r || !vertical(o, 0) {
			return false
		}
		if arcDeg >= 360 || d < r {
			return true
		}
		return angleDiff(yawTo(tp.X-o.X, tp.Z-o.Z), yaw) <= arcDeg/2*math.Pi/180+arcSlack
	}
	inLine := func(o movement.Vec3, yaw, length, halfWidth float64) bool {
		fx, fz := -math.Sin(yaw), -math.Cos(yaw)
		dx, dz := tp.X-o.X, tp.Z-o.Z
		along := dx*fx + dz*fz
		return along >= -r && along <= length+r && math.Abs(dx*fz-dz*fx) <= halfWidth+r && vertical(o, 0)
	}
	aimed := func(o movement.Vec3, yaw, rng, slack float64) bool {
		d := hdist(o, tp)
		if d > rng+r {
			return false
		}
		if d < 3 {
			return true
		}
		return angleDiff(yawTo(tp.X-o.X, tp.Z-o.Z), yaw) <= slack+math.Atan2(r, d)
	}
	origins := [2]movement.Vec3{a.Pos, p.Pos} // where it started, where the attacker is now (dash cuts, lunges)
	any := func(fn func(o movement.Vec3) bool) bool { return fn(origins[0]) || fn(origins[1]) }
	switch {
	case a.Move != nil:
		m := a.Move
		switch {
		case m.Radius > 1: // arrow rain: an area at the impact point
			return hdist(impact, a.Pos) <= m.Reach+constants.HitRangeSlackM && hdist(impact, tp) <= m.Radius+r
		case m.Speed > 0:
			rng := m.Reach
			return aimed(a.Pos, a.Yaw, rng, aimSlack)
		case m.Kind == "plunge":
			return hdist(p.Pos, tp) <= m.Reach+r && vertical(p.Pos, 2)
		default:
			return any(func(o movement.Vec3) bool { return inCone(o, a.Yaw, m.Reach, m.Arc) })
		}
	case a.Spell != nil:
		s := a.Spell
		switch s.Type {
		case "projectile", "arc":
			slack := aimSlack + float64(max(0, s.Spread-1))*10*math.Pi/180
			return aimed(a.Pos, a.Yaw, s.Range, slack) || (s.Radius > 1 && hdist(impact, a.Pos) <= s.Range+r && hdist(impact, tp) <= s.Radius+r)
		case "hitscan", "beam":
			if a.targets > 0 && s.Chain > 0 {
				return hdist(impact, tp) <= chainRange+r // chains hop from the previous target (claim x/y/z)
			}
			return any(func(o movement.Vec3) bool { return aimed(o, a.Yaw, s.Range, 20*math.Pi/180) })
		case "direct":
			return hdist(a.Pos, tp) <= s.Range+r
		case "aoe", "domain":
			switch {
			case s.SelfCast || s.Type == "domain":
				return any(func(o movement.Vec3) bool { return hdist(o, tp) <= s.Radius+r && vertical(o, 0) })
			case s.Cone > 0:
				return any(func(o movement.Vec3) bool { return inCone(o, a.Yaw, s.Radius, s.Cone) })
			case s.Line > 0:
				return any(func(o movement.Vec3) bool { return inLine(o, a.Yaw, s.Line, s.Radius) })
			default:
				return hdist(impact, a.Pos) <= s.Range+constants.HitRangeSlackM && hdist(impact, tp) <= s.Radius+r
			}
		case "rune":
			return hdist(impact, a.Pos) <= s.Range+constants.HitRangeSlackM && hdist(impact, tp) <= s.Radius+r
		}
	case a.Form != nil:
		f := a.Form
		switch f.Shape {
		case "aoe":
			return any(func(o movement.Vec3) bool { return hdist(o, tp) <= f.Radius+r })
		case "cone":
			return any(func(o movement.Vec3) bool { return inCone(o, a.Yaw, f.Reach, f.Arc) })
		case "line":
			return any(func(o movement.Vec3) bool { return inLine(o, a.Yaw, f.Reach, f.Width/2) })
		}
	}
	return false
}

// critRoll is deterministic per (action, target, player) so a re-sent claim
// can never re-roll a crit.
func critRoll(seq, target, player uint32) float64 {
	return unit(mix(uint64(seq)<<32 ^ uint64(target)<<8 ^ uint64(player)*0x9e3779b1))
}

// damageOf computes an action's damage against e (before shields).
func (w *World) damageOf(p *Player, a *Action, e *Enemy) (dmg float64, element int, flags uint8) {
	pr := p.Profile
	lo := p.Loadout()
	element = combatdefs.Physical
	switch {
	case a.Move != nil:
		m := a.Move
		lvl := pr.SkillLevel(a.Weapon.Skill)
		dmg = m.Damage
		if m.Kind == "charged" && m.ChargeMult > 0 {
			dmg *= 1 + (m.ChargeMult-1)*a.Charge
		}
		if m.Kind == "plunge" {
			dmg += math.Min(m.MaxBonus, m.PerMeter*a.FallHeight)
		}
		if m.Kind == "sprint" && D.HasTechnique(a.Weapon.Skill, lvl, "dash_cut") {
			dmg *= 1.5
		}
		dmg *= 1 + 0.01*float64(lvl)
		if a.Weapon.Key == "bow" {
			for _, ar := range a.Weapon.Arrows {
				if ar.Key == lo.ArrowOre {
					dmg *= ar.Mult
				}
			}
			if lo.ArrowGem >= 0 && lo.ArrowGem < combatdefs.Physical {
				element = lo.ArrowGem
			}
		}
		if (a.Weapon.Key == "staff" || a.Weapon.Key == "wand") && m.Speed > 0 && lo.Gem >= 0 {
			element = lo.Gem
		}
		dmg *= orOne(p.Gear.WeaponMult) * (1 + p.Gear.DamagePct/100) // WP14 weapon item
	case a.Spell != nil:
		s := a.Spell
		element = s.Element
		dmg = s.Damage
		if e.Boss != nil && s.BossDamage > 0 {
			dmg = s.BossDamage
		}
		sc := pr.SkillLevel("spellcraft")
		dmg *= a.Weapon.SpellPower * (1 + 0.01*float64(sc))
		if D.HasTechnique("spellcraft", sc, "overflow") {
			dmg *= 1.15
		}
		if s.VsStatus != nil && e.has(s.VsStatus.Status, w.tick) {
			dmg *= s.VsStatus.Mult
		}
		if s.LowTargetHP != nil && e.HP/e.HPMax < s.LowTargetHP.Below {
			dmg *= s.LowTargetHP.Mult
		}
		dmg *= w.passiveMult(p, s, e)
		dmg *= 1 + p.Gear.SpellPower/100 // WP14
	case a.Form != nil:
		f := a.Form
		element = f.Element
		dmg = f.Damage * (1 + 0.01*float64(pr.SkillLevel(a.Weapon.Skill)))
		dmg *= orOne(p.Gear.WeaponMult) * (1 + p.Gear.DamagePct/100) * orOne(p.Gear.FormMult) // WP14: weapon + gem cut
	}
	dmg *= D.DamageMult(p.Level) // playtest 1: character level (combat.yaml leveling, CR 012)
	em := D.ElementMult(element, e.Element)
	if em > 1 {
		flags |= FlagWeak
	} else if em < 1 {
		flags |= FlagResisted
	}
	dmg *= em * e.damageTakenMult(w.tick)
	crit := 0.05 + p.Gear.CritPct/100 // WP14
	if pr.Knows("solar_flare") {
		crit += 0.1
	}
	if critRoll(a.Seq, e.ID, p.ID) < crit {
		dmg *= 1.5
		flags |= FlagCrit
	}
	return dmg, element, flags
}

// passiveMult applies known passives' damage effects to a spell.
func (w *World) passiveMult(p *Player, s *combatdefs.Spell, e *Enemy) float64 {
	m := 1.0
	for _, k := range p.Profile.Known {
		ps := D.SpellByKey(k)
		if ps == nil || ps.Type != "passive" || ps.Effect == nil {
			continue
		}
		if v, ok := ps.Effect["treeDamage"].(float64); ok && ps.Tree == s.Tree {
			m *= v
		}
		if v, ok := ps.Effect["lowHpDamage"].(float64); ok && ps.Tree == s.Tree && p.HP < p.HPMax*0.5 {
			m *= v
		}
		if vs, ok := ps.Effect["vsStatus"].(map[string]any); ok && ps.Tree == s.Tree {
			if st, _ := vs["status"].(string); st != "" && e.has(st, w.tick) {
				if mult, ok := vs["mult"].(float64); ok {
					m *= mult
				}
			}
		}
		if lt, ok := ps.Effect["lowTargetHp"].(map[string]any); ok && ps.Tree == s.Tree {
			below, _ := lt["below"].(float64)
			if mult, ok := lt["mult"].(float64); ok && e.HP/e.HPMax < below {
				m *= mult
			}
		}
		if ve, ok := ps.Effect["vsElement"].(map[string]any); ok && ps.Tree == s.Tree {
			if el, _ := ve["element"].(string); el != "" && e.Element < len(D.Elements) && D.Elements[e.Element] == el {
				if mult, ok := ve["mult"].(float64); ok {
					m *= mult
				}
			}
		}
	}
	return m
}

// statusOf is the status an action applies (plus tree passives).
func (w *World) statusOf(p *Player, a *Action) []string {
	var out []string
	switch {
	case a.Spell != nil:
		if a.Spell.Status != "" {
			out = append(out, a.Spell.Status)
		}
		for _, k := range p.Profile.Known {
			ps := D.SpellByKey(k)
			if ps == nil || ps.Type != "passive" || ps.Tree != a.Spell.Tree || ps.Effect == nil {
				continue
			}
			if st, ok := ps.Effect["treeStatus"].(string); ok {
				chance, _ := ps.Effect["chance"].(float64)
				if chance == 0 || critRoll(a.Seq+7, uint32(len(out)), p.ID) < chance {
					out = append(out, st)
				}
			}
		}
	case a.Form != nil:
		if a.Form.Status != "" {
			out = append(out, a.Form.Status)
		}
	}
	return out
}

// applyHit applies an accepted claim.
func (w *World) applyHit(p *Player, a *Action, e *Enemy, impact movement.Vec3) ClaimResult {
	dmg, element, flags := w.damageOf(p, a, e)
	killing := KillsDemons(p, a) // WP15 (demon.go)
	if e.Demon != nil && a.Form != nil && a.Form.DemonMult > 0 {
		dmg *= a.Form.DemonMult
	}
	if a.Spell != nil && a.Spell.StripShield {
		e.Shield = 0
	}
	a.hits[e.ID]++
	if a.hits[e.ID] == 1 {
		a.targets++
	}
	if a.Spell != nil && a.Spell.Damage == 0 {
		dmg = 0
	}
	dmg = math.Round(dmg)
	if dmg < 1 && (a.Spell == nil || a.Spell.Damage > 0) {
		dmg = 1
	}
	at := movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + e.Height(), Z: e.Pos.Z}
	dealt, shielded := w.applyDamage(e, p.ID, dmg, element, at, flags, true, killing)
	if element == combatdefs.Lightning {
		w.wetChain(p.ID, e, dmg, killing) // WP15: rain chains lightning across water
	}
	if shielded {
		flags |= FlagShielded
	}
	if !e.Alive() {
		flags |= FlagKilled
	}
	for _, st := range w.statusOf(p, a) {
		if !e.Alive() {
			break
		}
		from := p.Pos
		if st == "pull" {
			from = impact
			if a.Spell != nil && a.Spell.SelfCast {
				from = p.Pos
			}
		}
		if st == "taunt" {
			e.taunt = impact
		}
		if def := e.applyStatus(st, p.ID, from, w.tick, (1+0.01*float64(p.Profile.SkillLevel(a.SkillOf())))*D.DamageMult(p.Level)); def != nil {
			if killing {
				e.markKilling(def)
			}
			w.near(e.Pos, 64, 0, Out{Ev: ev(EvStatus, p.ID, e.ID, int32(def.ID), e.Pos, []byte{byte(min(255, ticksOf(def.DurationSteps)))})})
		}
	}
	// Lifesteal and kill heals (Dark tree).
	ls := 0.0
	if a.Spell != nil {
		ls = a.Spell.Lifesteal
	} else if a.Form != nil {
		ls = a.Form.Lifesteal
	}
	if ls > 0 && dealt > 0 {
		w.healPlayer(p, p, dealt*ls)
	}
	if a.Spell != nil && a.Spell.Heal > 0 && a.hits[e.ID] == 1 && a.targets == 1 {
		w.healArea(p, a.Spell.Heal, math.Max(a.Spell.Radius, 25))
	}
	// Skills grow by use (spec 8): every landed hit trains the skill that
	// made it; a kill trains it more.
	xp := int64(2)
	if !e.Alive() {
		xp += 6
	}
	if lvl, up := p.Profile.AddSkillXP(a.SkillOf(), xp); up {
		tech := ""
		for _, t := range D.SkillByKey(a.SkillOf()).Techniques {
			if t.Level == lvl {
				tech = t.Key
			}
		}
		w.toPlayer(p.ID, Out{Ev: ev(EvSkillUp, p.ID, uint32(D.SkillByKey(a.SkillOf()).ID), int32(lvl), p.Pos, []byte(tech))})
		w.Synced = append(w.Synced, p.ID)
	}
	p.inCombatTick = w.tick
	w.Stats.ClaimsAccepted++
	return ClaimResult{Accepted: true, Damage: uint16(min(65535, dmg)), Flags: flags, HPPct: e.HealthPct(), Enemy: e}
}

// applyDamage lowers an enemy's health (shield first), keeps threat and
// party scaling, tells observers, and handles death.
func (w *World) applyDamage(e *Enemy, src uint32, dmg float64, element int, at movement.Vec3, flags uint8, direct, killing bool) (float64, bool) {
	if !e.Alive() || (e.Boss != nil && e.Boss.transitionUntil > w.tick) {
		return 0, false
	}
	if p := w.players[src]; p != nil && !e.engaged[src] {
		w.engage(e, p)
	}
	var dealt float64
	var shielded bool
	if e.Demon != nil {
		dealt = w.demonDamage(e, src, dmg, killing) // WP15: wounds regenerate, only killing hits sear
	} else {
		dealt, shielded = e.takeDamage(dmg, w.tick)
	}
	e.threat[src] += dmg
	e.DamageBy[src] += dealt
	e.lastHitBy = src
	if direct {
		w.hitReaction(e)
	}
	if (e.State == Idle || e.State == Asleep || e.State == Alert || e.State == Return) && w.players[src] != nil {
		if e.State == Asleep && e.Group != nil {
			e.Group.Awake = true
		}
		e.Target = src
		e.State, e.stateAt = Chase, w.tick
	}
	if dmg > 0 {
		w.near(at, 64, src, Out{Ev: ev(EvDamage, src, e.ID, int32(math.Round(dmg)), at, []byte{flags, e.HealthPct()})})
	}
	if e.HP <= 0 {
		w.kill(e, src)
	} else if e.Boss != nil {
		w.checkPhase(e)
	}
	return dealt, shielded
}

// healPlayer heals a player (Light tree, lifesteal; players can help each
// other, never hurt each other).
func (w *World) healPlayer(by, p *Player, amount float64) {
	if p.Downed || amount <= 0 {
		return
	}
	p.HP = math.Min(p.HPMax, p.HP+amount)
	w.toPlayer(p.ID, Out{Ev: ev(EvHeal, by.ID, p.ID, int32(math.Round(amount)), p.Pos, nil)})
}

func (w *World) healArea(by *Player, amount, radius float64) {
	for _, q := range w.playersNear(by.Pos, radius) {
		w.healPlayer(by, q, amount)
	}
}

// kill finishes an enemy: XP to everyone who fought it (and their party
// nearby), the loot hook, splitting elites, group bookkeeping.
func (w *World) kill(e *Enemy, killer uint32) {
	e.HP = 0
	e.State = Dead
	e.diedTick = w.tick
	e.Vel = movement.Vec3{}
	w.Stats.Kills++
	hpM, _ := levelMults(e.Level)
	xp := e.Def.XP * hpM
	if e.Elite() {
		xp *= 4
	}
	eligible := map[uint32]bool{}
	for id := range e.DamageBy {
		if p := w.players[id]; p != nil {
			eligible[id] = true
			if p.PartyID != 0 {
				for _, q := range w.playersNear(e.Pos, 80) {
					if q.PartyID == p.PartyID {
						eligible[q.ID] = true
					}
				}
			}
		}
	}
	ids := make([]uint32, 0, len(eligible))
	for id := range eligible {
		ids = append(ids, id)
	}
	slicesSortU32(ids)
	for _, id := range ids {
		w.XP = append(w.XP, XPGrant{Player: id, XP: int64(math.Round(xp)), Reason: e.Def.Key})
	}
	if p := w.players[killer]; p != nil && p.Profile.Knows("crimson_hunger") {
		w.healPlayer(p, p, 15)
	}
	if p := w.players[killer]; p != nil && p.Profile.Knows("crimson_veil") {
		p.shield, p.shieldEnd = math.Max(p.shield, 30), w.tick+secondsToTicks(4)
	}
	w.near(e.Pos, 96, 0, Out{Ev: ev(EvEnemyDied, e.ID, killer, int32(math.Round(xp)), e.Pos, []byte(e.Name))})
	if w.OnKill != nil {
		w.OnKill(KillInfo{Enemy: e, Eligible: ids, Tick: w.tick})
	}
	if e.Affix != nil && e.Affix.SplitInto > 0 && !e.split {
		for i := 0; i < e.Affix.SplitInto; i++ {
			a := float64(i)*math.Pi + e.Yaw
			c := newEnemy(e.Def, e.Level, e.Element, nil, w.place(e.Pos.X+1.5*math.Cos(a), e.Pos.Z+1.5*math.Sin(a), e.Def))
			c.split = true
			c.baseHP = e.baseHP * e.Affix.SplitHPPct / e.Affix.HPMult * float64(max(1, e.scaleN))
			c.HPMax, c.HP = c.baseHP, c.baseHP
			c.Group, c.Home = e.Group, e.Home
			c.State, c.Target = Chase, killer
			c.Name = "Shard of " + e.Def.Name
			for id := range e.engaged {
				c.engaged[id] = true
			}
			w.addEnemy(c)
			c.State = Chase
			if e.Group != nil {
				e.Group.Members = append(e.Group.Members, c)
			}
		}
	}
	if e.Boss != nil {
		w.bossDefeated(e)
	}
	if e.Group != nil {
		w.groupCleared(e.Group)
	}
}

func slicesSortU32(s []uint32) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// hitReaction: a common enemy hit twice within 1.5 s hops out of reach
// (melee: straight back; ranged and flyers: back and to the side),
// interrupting a wind-up, unless it is disabled; elites and bosses stand
// their ground.
func (w *World) hitReaction(e *Enemy) {
	if e.Elite() || e.IsBoss() || e.disabled(w.tick) {
		return
	}
	keep := e.recentHits[:0]
	for _, t := range e.recentHits {
		if w.tick-t <= evadeWindow {
			keep = append(keep, t)
		}
	}
	e.recentHits = append(keep, w.tick)
	if len(e.recentHits) >= evadeHits && w.tick-e.lastEvade >= evadeCooldown && e.HP > 0 {
		e.State, e.stateAt, e.attack = Evade, w.tick, nil
		e.lastEvade = w.tick
		e.recentHits = e.recentHits[:0]
	}
}
