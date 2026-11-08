package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// Enemy AI: simple state machines on the zone tick (spec 8: idle, patrol,
// alert, chase, attack, flee, return), moving over the overworld heightfield
// (the "coarse overworld nav": straight steering with slope and water
// avoidance; WP09's cave graph can replace steer() underground).
//
// Fight pacing is designed against the feel targets: every attack is
// telegraphed 300-600 ms (combat.yaml, checked at build), melee enemies back
// off after striking (hit and run) so a common fight lasts seconds rather
// than one burst, and at most two enemies wind up on the same player at
// once so a camp is a fight, not a stun-lock.

const (
	dt              = 1.0 / float64(constants.TickRateHz)
	alertTicks      = 15 // 500 ms "noticed you" beat (a readable roar) before the first chase
	repositionTicks = 20 // hit-and-run back-off after a melee attack
	minAttackGap    = 18 // ticks between two attacks of one enemy (600 ms)
	maxWindupsOnOne = 2
	telegraphRadius = 70.0 // m: players who receive telegraphs and projectiles
	strikeSlack     = 0.4  // m added to a player's body for strike areas
	playerRadius    = 0.4
	enemySep        = 1.1
	evadeTicks      = 14  // 470 ms hop back
	evadeSpeed      = 9.5 // m/s: 4.4 m, out of a spear's reach plus a step
	evadeHits       = 2   // hits within evadeWindow that trigger the hop
	evadeWindow     = 45  // ticks (1.5 s)
	evadeCooldown   = 36  // ticks between hops (1.2 s)
)

// attackArea is a frozen strike shape (decided when the wind-up starts so
// the telegraph shows exactly what will hit).
type attackArea struct {
	shape  string
	center movement.Vec3 // cone/circle/line origin, ground centre
	yaw    float64
	radius float64
	reach  float64
	arc    float64 // degrees
	width  float64
}

func (a *attackArea) shapeCode() uint8 {
	switch a.shape {
	case "cone":
		return 0
	case "circle":
		return 1
	case "ground":
		return 2
	case "line":
		return 3
	}
	return 4
}

// contains reports whether a body of radius r at p is inside the area.
func (a *attackArea) contains(p movement.Vec3, r float64) bool {
	dx, dz := p.X-a.center.X, p.Z-a.center.Z
	if math.Abs(p.Y-a.center.Y) > 4 {
		return false
	}
	d := math.Hypot(dx, dz)
	switch a.shape {
	case "circle", "ground":
		return d <= a.radius+r
	case "cone":
		if d > a.reach+r {
			return false
		}
		if d < r+0.5 {
			return true
		}
		return angleDiff(yawTo(dx, dz), a.yaw) <= a.arc/2*math.Pi/180+math.Atan2(r, d)
	case "line":
		fx, fz := -math.Sin(a.yaw), -math.Cos(a.yaw)
		along := dx*fx + dz*fz
		if along < -r || along > a.reach+r {
			return false
		}
		side := math.Abs(dx*fz - dz*fx)
		return side <= a.width/2+r
	}
	return false
}

// yawTo is the yaw facing direction (dx, dz) (yaw 0 faces -Z).
func yawTo(dx, dz float64) float64 { return math.Atan2(-dx, -dz) }

func angleDiff(a, b float64) float64 {
	d := math.Mod(a-b+3*math.Pi, 2*math.Pi) - math.Pi
	return math.Abs(d)
}

func hdist(a, b movement.Vec3) float64 { return math.Hypot(a.X-b.X, a.Z-b.Z) }

// think runs one enemy for one tick.
func (w *World) think(e *Enemy) {
	tick := w.tick
	w.statusTick(e)
	if !e.Alive() {
		return
	}
	if e.Boss != nil {
		w.bossTick(e)
	}
	if e.Shield < e.ShieldMax && e.Affix != nil && e.Affix.ShieldRegenSteps > 0 && tick-e.shieldHit > ticksOf(e.Affix.ShieldRegenSteps) {
		e.Shield = e.ShieldMax // a warded elite re-raises its ward if left alone
	}
	if w.forcedMove(e) || e.disabled(tick) {
		return
	}
	switch e.State {
	case Idle:
		if t := w.acquire(e, 1); t != nil {
			e.Target = t.ID
			w.engage(e, t)
			e.State, e.stateAt = Alert, tick
			if e.AggroTick == 0 {
				e.AggroTick = tick
			}
		} else if hdist(e.Pos, e.Home) > 1.5 {
			w.moveToward(e, e.Home, 0.5)
		}
	case Alert:
		w.face(e, w.targetPos(e))
		if tick-e.stateAt >= alertTicks {
			e.State, e.stateAt = Chase, tick
		}
	case Chase, Reposition:
		w.chase(e)
	case Evade:
		// Hop back out of reach after being hit twice in a row (commons):
		// the player has to close in again, so a fight is a few seconds of
		// back and forth instead of one burst.
		if tick-e.stateAt >= evadeTicks {
			e.State, e.stateAt = Chase, tick
		} else {
			p := w.targetPos(e)
			if d := hdist(p, e.Pos); d > 0.01 {
				bx, bz := (e.Pos.X-p.X)/d, (e.Pos.Z-p.Z)/d
				if e.Def.Behavior != "melee" {
					side := 1.0
					if e.ID%2 == 0 {
						side = -1
					}
					bx, bz = (bx+bz*side)*0.7071, (bz-bx*side)*0.7071
				}
				w.stepMove(e, bx*evadeSpeed*dt, bz*evadeSpeed*dt, true)
			}
		}
	case Windup:
		if e.attack == nil {
			e.State, e.stateAt = Chase, tick
		} else if tick-e.stateAt >= ticksOf(e.attack.WindupSteps) {
			w.strikeStart(e)
		}
	case Striking:
		w.striking(e)
	case Recover:
		if e.attack == nil || tick-e.stateAt >= ticksOf(e.attack.RecoverySteps) {
			if e.Def.Behavior == "melee" && e.Boss == nil {
				e.State, e.stateAt = Reposition, tick
			} else {
				e.State, e.stateAt = Chase, tick
			}
			e.attack = nil
		}
	case Return:
		// A returning enemy turns on anyone who walks up to it near home,
		// and never gets stuck on the way (crowded home point, a ledge):
		// after 6 s it is simply home.
		if t := w.acquire(e, 1); t != nil && hdist(e.Pos, e.Home) <= e.leash()*0.5 {
			e.Target = t.ID
			w.engage(e, t)
			e.State, e.stateAt = Chase, tick
			return
		}
		if hdist(e.Pos, e.Home) < 2 || tick-e.stateAt > secondsToTicks(6) {
			e.Pos = w.place(e.Home.X, e.Home.Z, e.Def)
			e.State, e.stateAt = Idle, tick
			e.resetScale() // spec 8 "return": a reset enemy is a fresh fight
			clear(e.threat)
			clear(e.engaged)
			e.Target = 0
		} else {
			w.moveToward(e, e.Home, 1)
		}
	}
}

// leash is how far from home an enemy follows.
func (e *Enemy) leash() float64 {
	if e.Boss != nil && e.Boss.Arena != nil {
		return e.Boss.Arena.Radius + 4
	}
	return constants.EnemyLeashM
}

// acquire picks the player to fight: highest threat among nearby, else the
// nearest within aggro range (mult widens it for already-alert enemies).
func (w *World) acquire(e *Enemy, mult float64) *Player {
	var best *Player
	bestScore := -1.0
	for _, p := range w.players {
		if p.Downed {
			continue
		}
		d := hdist(p.Pos, e.Pos)
		if math.Abs(p.Pos.Y-e.Pos.Y) > 12 || hdist(p.Pos, e.Home) > e.leash()+e.Def.Aggro {
			continue
		}
		th := e.threat[p.ID]
		if d > e.Def.Aggro*mult && th == 0 {
			continue
		}
		score := th + 100/(d+1)
		if score > bestScore || (score == bestScore && best != nil && p.ID < best.ID) {
			best, bestScore = p, score
		}
	}
	return best
}

// engage counts players for party scaling: everyone within 30 m of the
// group's anchor (or the enemy) when the fight starts or someone joins.
func (w *World) engage(e *Enemy, by *Player) {
	e.engaged[by.ID] = true
	at := e.Pos
	if e.Group != nil {
		at = e.Group.Anchor
	}
	for _, p := range w.playersNear(at, 30+e.Def.Aggro) {
		e.engaged[p.ID] = true
	}
	n := 0
	for id := range e.engaged {
		if _, ok := w.players[id]; ok {
			n++
		}
	}
	e.partyScale(n)
	if e.Boss != nil && e.Boss.engagedAt == 0 {
		e.Boss.engagedAt = w.tick
		w.near(e.Pos, telegraphRadius, 0, Out{Ev: ev(EvBossEngaged, e.ID, uint32(e.Def.ID), int32(e.HPMax), e.Pos, []byte(e.Name))})
	}
}

func (w *World) targetPos(e *Enemy) movement.Vec3 {
	if p := w.players[e.Target]; p != nil {
		return p.Pos
	}
	return e.Home
}

func (w *World) face(e *Enemy, p movement.Vec3) {
	if dx, dz := p.X-e.Pos.X, p.Z-e.Pos.Z; dx*dx+dz*dz > 1e-6 {
		e.Yaw = yawTo(dx, dz)
	}
}

// chase approaches (or keeps range from) the target and starts attacks.
func (w *World) chase(e *Enemy) {
	tick := w.tick
	p := w.players[e.Target]
	if p == nil || p.Downed || hdist(p.Pos, e.Home) > e.leash()+e.Def.Aggro*0.5 || hdist(e.Pos, e.Home) > e.leash() {
		if np := w.acquire(e, 1.5); np != nil && hdist(e.Pos, e.Home) <= e.leash() {
			e.Target = np.ID
			w.engage(e, np)
			return
		}
		e.State, e.stateAt, e.Target = Return, tick, 0
		return
	}
	if e.taunt != (movement.Vec3{}) && e.has("taunt", tick) {
		w.moveToward(e, e.taunt, 1)
		return
	}
	d := hdist(p.Pos, e.Pos)
	w.face(e, p.Pos)
	if e.State == Reposition {
		if tick-e.stateAt >= repositionTicks {
			e.State, e.stateAt = Chase, tick
		} else {
			// back off and circle a little: you can always get a hit in
			// while it repositions, and it is never glued to you
			side := 1.0
			if e.ID%2 == 0 {
				side = -1
			}
			fx, fz := -math.Sin(e.Yaw), -math.Cos(e.Yaw)
			away := movement.Vec3{X: e.Pos.X - fx*3 + fz*side*1.5, Z: e.Pos.Z - fz*3 - fx*side*1.5}
			w.moveToward(e, away, 0.7)
			return
		}
	}
	if a := w.pickAttack(e, d); a != nil {
		w.windup(e, a, p)
		return
	}
	want := 1.4 + e.Radius()
	if e.Def.KeepAway > 0 {
		want = e.Def.KeepAway
	} else if a := w.closestAttack(e); a != nil {
		want = math.Max(want*0.8, a.Range()*0.8)
	}
	switch {
	case d > want+0.5:
		w.moveToward(e, p.Pos, 1)
	case e.Def.KeepAway > 0 && d < want-3:
		fx, fz := (e.Pos.X-p.Pos.X)/math.Max(d, 0.01), (e.Pos.Z-p.Pos.Z)/math.Max(d, 0.01)
		w.moveToward(e, movement.Vec3{X: e.Pos.X + fx*4, Z: e.Pos.Z + fz*4}, 0.8)
	default:
		e.Vel = movement.Vec3{}
	}
}

// attacksOf is the current attack set (a boss's phase decides it).
func (w *World) attacksOf(e *Enemy) []string {
	if e.Boss != nil {
		return e.Boss.Def.Phases[e.Boss.Phase].Attacks
	}
	return e.Def.Attacks
}

func (w *World) closestAttack(e *Enemy) *combatdefs.EnemyAttack {
	var best *combatdefs.EnemyAttack
	for _, k := range w.attacksOf(e) {
		a := D.AttackByKey(k)
		if best == nil || a.Range() < best.Range() {
			best = a
		}
	}
	return best
}

// pickAttack chooses a ready attack whose range fits d (the strongest one).
func (w *World) pickAttack(e *Enemy, d float64) *combatdefs.EnemyAttack {
	tick := w.tick
	if tick < e.nextAttack || w.windupsOn(e.Target) >= maxWindupsOnOne {
		return nil
	}
	var best *combatdefs.EnemyAttack
	for _, k := range w.attacksOf(e) {
		a := D.AttackByKey(k)
		if tick < e.cooldowns[a.ID] || d > a.Range()+e.Radius() || d < a.MinRange {
			continue
		}
		if best == nil || a.Damage > best.Damage {
			best = a
		}
	}
	return best
}

func (w *World) windupsOn(target uint32) int {
	n := 0
	for _, id := range w.order {
		if o := w.enemies[id]; o != nil && o.State == Windup && o.Target == target {
			n++
		}
	}
	return n
}

// windup starts a telegraphed attack: the shape is decided now and sent to
// nearby players, so what they see is exactly what will hit.
func (w *World) windup(e *Enemy, a *combatdefs.EnemyAttack, p *Player) {
	tick := w.tick
	e.attack = a
	e.State, e.stateAt = Windup, tick
	e.Vel = movement.Vec3{}
	w.face(e, p.Pos)
	e.attackYaw = e.Yaw
	e.attackFrom = e.Pos
	area := w.areaOf(e, a, p.Pos)
	e.attackAim = area.center
	cd := float64(a.CooldownSteps) * e.cooldownMult
	if e.Boss != nil {
		cd *= e.Boss.Def.Phases[e.Boss.Phase].CooldownMult
	}
	e.cooldowns[a.ID] = tick + ticksOf(int(cd))
	e.nextAttack = tick + minAttackGap
	windMs := int(math.Round(float64(a.WindupSteps) * 1000 / float64(D.StepHz)))
	activeMs := int(math.Round(float64(a.ActiveSteps) * 1000 / float64(D.StepHz)))
	w.near(e.Pos, telegraphRadius, 0, Out{Ev: ev(EvTelegraph, e.ID, uint32(a.ID), int32(windMs), area.center, telegraphData(&area, activeMs))})
}

// areaOf builds the strike shape for attack a aimed at target position t.
func (w *World) areaOf(e *Enemy, a *combatdefs.EnemyAttack, t movement.Vec3) attackArea {
	ar := attackArea{shape: a.Shape, center: e.Pos, yaw: e.attackYaw, radius: a.Radius, reach: a.Reach + e.Radius(), arc: a.Arc, width: a.Width}
	switch a.Shape {
	case "ground":
		c := t
		if d := hdist(t, e.Pos); d > a.Reach {
			k := a.Reach / d
			c = movement.Vec3{X: e.Pos.X + (t.X-e.Pos.X)*k, Z: e.Pos.Z + (t.Z-e.Pos.Z)*k}
		}
		c.Y = w.ground.HeightAt(c.X, c.Z)
		ar.center = c
	case "circle":
		ar.radius = a.Radius + e.Radius()*0.5
	case "projectile":
		ar.reach = a.Reach
	}
	ar.center.Y = math.Min(ar.center.Y, w.ground.HeightAt(ar.center.X, ar.center.Z)+2)
	return ar
}

// strikeStart: the wind-up ended; the attack happens now.
func (w *World) strikeStart(e *Enemy) {
	a := e.attack
	e.State, e.stateAt = Striking, w.tick
	if a.Shape == "projectile" {
		w.launch(e, a)
		return
	}
	if a.Charge {
		return // striking() moves along the line and hits as it goes
	}
	area := attackArea{shape: a.Shape, center: e.attackFrom, yaw: e.attackYaw, radius: a.Radius, reach: a.Reach + e.Radius(), arc: a.Arc, width: a.Width}
	if a.Shape == "ground" {
		area.center = e.attackAim
	}
	if a.Shape == "circle" {
		area.radius = a.Radius + e.Radius()*0.5
	}
	w.strikeArea(e, a, area, nil)
}

// strikeArea queues a strike on every player in the area (and, for
// "everyone" attacks, at each player's own position: meteors).
func (w *World) strikeArea(e *Enemy, a *combatdefs.EnemyAttack, area attackArea, already map[uint32]bool) {
	for _, p := range w.playersNear(area.center, area.reach+area.radius+12) {
		if p.Downed || (already != nil && already[p.ID]) {
			continue
		}
		if area.contains(p.Pos, playerRadius+strikeSlack) {
			w.queueStrike(e, a, p, area)
			if already != nil {
				already[p.ID] = true
			}
		}
	}
}

// striking runs the active window (charges travel and hit as they go).
func (w *World) striking(e *Enemy) {
	a := e.attack
	if a == nil {
		e.State, e.stateAt = Chase, w.tick
		return
	}
	tick := w.tick
	elapsed := tick - e.stateAt
	active := ticksOf(a.ActiveSteps)
	if a.Charge {
		speed := a.Reach / (float64(max(1, active)) * dt)
		fx, fz := -math.Sin(e.attackYaw), -math.Cos(e.attackYaw)
		w.stepMove(e, fx*speed*dt, fz*speed*dt, false)
		area := attackArea{shape: "circle", center: e.Pos, radius: a.Width/2 + e.Radius()}
		if e.chargeHit == nil {
			e.chargeHit = map[uint32]bool{}
		}
		w.strikeArea(e, a, area, e.chargeHit)
	}
	if elapsed >= active {
		e.chargeHit = nil
		e.State, e.stateAt = Recover, tick
	}
}

// moveToward walks an enemy toward t at speedFrac of its speed.
func (w *World) moveToward(e *Enemy, t movement.Vec3, speedFrac float64) {
	dx, dz := t.X-e.Pos.X, t.Z-e.Pos.Z
	d := math.Hypot(dx, dz)
	if d < 0.05 {
		e.Vel = movement.Vec3{}
		return
	}
	sp := e.Def.Speed * e.SpeedMult * speedFrac
	if e.Boss != nil {
		sp *= e.Boss.Def.Phases[e.Boss.Phase].SpeedMult
	}
	if e.has("slow", w.tick) {
		sp *= D.StatusByKey("slow").SpeedMult
	}
	step := math.Min(d, sp*dt)
	e.Yaw = yawTo(dx, dz)
	w.stepMove(e, dx/d*step, dz/d*step, true)
}

// stepMove moves by (mx, mz) over the terrain, steering around water and
// cliffs, separated from group mates, inside the arena for bosses.
func (w *World) stepMove(e *Enemy, mx, mz float64, steer bool) {
	try := func(ax, az float64) bool {
		nx, nz := e.Pos.X+ax, e.Pos.Z+az
		if nx < 1 || nz < 1 || nx > float64(constants.WorldSizeM)-1 || nz > float64(constants.WorldSizeM)-1 {
			return false
		}
		gy := w.ground.HeightAt(nx, nz)
		if movement.WaterAt(w.ground, nx, nz) > gy+0.6 {
			return false
		}
		cur := w.ground.HeightAt(e.Pos.X, e.Pos.Z)
		if gy-cur > math.Hypot(ax, az)*1.3+0.35 {
			return false // too steep to walk up
		}
		if e.Boss != nil && e.Boss.Arena != nil && hdist(movement.Vec3{X: nx, Z: nz}, e.Boss.Arena.Center) > e.Boss.Arena.Radius {
			return false
		}
		e.Pos.X, e.Pos.Z = nx, nz
		return true
	}
	ok := try(mx, mz)
	if !ok && steer {
		for _, ang := range []float64{0.6, -0.6, 1.2, -1.2} {
			c, s := math.Cos(ang), math.Sin(ang)
			if try(mx*c-mz*s, mx*s+mz*c) {
				ok = true
				break
			}
		}
	}
	// separation from group mates (no stacking in one spot)
	if e.Group != nil {
		for _, o := range e.Group.Members {
			if o == e || !o.Alive() {
				continue
			}
			dx, dz := e.Pos.X-o.Pos.X, e.Pos.Z-o.Pos.Z
			d := math.Hypot(dx, dz)
			min := enemySep * (e.Radius() + o.Radius() + 0.6)
			if d > 0.001 && d < min {
				push := (min - d) * 0.25
				try(dx/d*push, dz/d*push)
			}
		}
	}
	y := w.ground.HeightAt(e.Pos.X, e.Pos.Z)
	if e.Def.Behavior == "flyer" {
		y += 1.5
	}
	e.Pos.Y = y
	if ok {
		e.Vel = movement.Vec3{X: mx / dt, Z: mz / dt}
	} else {
		e.Vel = movement.Vec3{}
	}
}

// forcedMove applies pull and knockback (returns true while it controls the enemy).
func (w *World) forcedMove(e *Enemy) bool {
	tick := w.tick
	for i := range e.statuses {
		s := &e.statuses[i]
		if s.until <= tick {
			continue
		}
		switch s.def.Key {
		case "pull":
			if d := hdist(s.from, e.Pos); d > 1 {
				k := math.Min(d-1, 8*dt) / d
				w.stepMove(e, (s.from.X-e.Pos.X)*k, (s.from.Z-e.Pos.Z)*k, false)
			}
			return true
		case "knockback":
			dx, dz := e.Pos.X-s.from.X, e.Pos.Z-s.from.Z
			if d := math.Hypot(dx, dz); d > 0.01 {
				w.stepMove(e, dx/d*10*dt, dz/d*10*dt, false)
			}
			return true
		}
	}
	return false
}

// statusTick expires statuses and ticks DOTs.
func (w *World) statusTick(e *Enemy) {
	tick := w.tick
	keep := e.statuses[:0]
	for _, s := range e.statuses {
		if s.until <= tick {
			continue
		}
		if s.def.TickSteps > 0 && tick >= s.next {
			s.next = tick + ticksOf(s.def.TickSteps)
			dmg := s.dmg * float64(s.stacks)
			if dmg > 0 {
				w.applyDamage(e, s.src, dmg, combatdefs.Fire, e.Pos, 0, false)
				if !e.Alive() {
					return
				}
			}
		}
		keep = append(keep, s)
	}
	e.statuses = keep
}

// ---- strikes on players (favor the player: spec 9) ----

// strike is an enemy hit on a player that settles after the grace window.
type strike struct {
	enemy  *Enemy
	att    *combatdefs.EnemyAttack
	player uint32
	seq    uint32 // the player's newest applied frame when the strike happened
	tick   uint32
	area   attackArea
	damage float64
	shot   bool
}

// graceFrames: frames after the strike (in the player's own input timeline)
// that may still evade it. HIT_GRACE_MS covers the player's input travelling
// to us; INTERP_DELAY_NEAR_MS covers the client drawing enemies in the past.
var graceFrames = uint32((constants.HitGraceMs + constants.InterpDelayNearMs) * constants.MoveStepHz / 1000)

const preGraceFrames = 3

func (w *World) queueStrike(e *Enemy, a *combatdefs.EnemyAttack, p *Player, area attackArea) {
	w.strikes = append(w.strikes, &strike{enemy: e, att: a, player: p.ID, seq: p.LastSeq, tick: w.tick, area: area, damage: a.Damage * e.DamageMult})
}

// settleStrikes decides strikes whose grace window has passed: a dodge's
// i-frames, an open parry or being outside the area in ANY frame of the
// window evades it. Otherwise the player takes the damage.
func (w *World) settleStrikes() {
	tick := w.tick
	keep := w.strikes[:0]
	for _, s := range w.strikes {
		p := w.players[s.player]
		if p == nil {
			continue
		}
		hi := s.seq + graceFrames
		if p.LastSeq < hi && tick-s.tick < secondsToTicks(0.6) {
			keep = append(keep, s)
			continue
		}
		lo := s.seq - min(s.seq, preGraceFrames)
		var dodged, parried, outside bool
		n := p.forFrames(lo, hi, func(f frameRec) {
			dodged = dodged || f.iframes
			parried = parried || f.parry
			outside = outside || !s.area.contains(f.pos, playerRadius)
		})
		if n == 0 {
			outside = !s.area.contains(p.Pos, playerRadius)
		}
		switch {
		case p.Downed:
		case dodged:
			w.evade(p, s, 1)
		case parried && !s.shot && s.enemy.Boss == nil:
			w.evade(p, s, 2)
			if s.enemy.Alive() {
				s.enemy.applyStatus("stun", p.ID, p.Pos, tick, 0)
				if D.HasTechnique("swordsmanship", p.Profile.SkillLevel("swordsmanship"), "parry_riposte") {
					p.riposte = true
				}
			}
		case parried:
			w.evade(p, s, 2) // bosses can be parried but not staggered
		case outside:
			w.evade(p, s, 3)
		default:
			w.hurtPlayer(p, s.damage, s.enemy, s.att)
		}
	}
	w.strikes = keep
}

func (w *World) evade(p *Player, s *strike, how int32) {
	w.Stats.Evaded++
	w.toPlayer(p.ID, Out{Ev: ev(EvEvaded, p.ID, s.enemy.ID, how, p.Pos, nil)})
}

// hurtPlayer is THE ONLY way a player loses health, and its only callers are
// enemy strikes and enemy projectiles (spec 2: no PvP of any kind).
func (w *World) hurtPlayer(p *Player, dmg float64, src *Enemy, att *combatdefs.EnemyAttack) {
	if p.Downed || src == nil {
		return
	}
	if p.Profile.Knows("thick_bark") {
		dmg *= 0.95
	}
	if p.Profile.Knows("undergrowth") {
		dmg *= 0.95
	}
	if p.shield > 0 && w.tick < p.shieldEnd {
		a := math.Min(p.shield, dmg)
		p.shield -= a
		dmg -= a
		w.toPlayer(p.ID, Out{Ev: ev(EvShield, p.ID, 0, int32(math.Round(p.shield)), p.Pos, nil)})
	}
	dmg = math.Round(dmg)
	p.lastHurtTick = w.tick
	p.inCombatTick = w.tick
	w.Stats.PlayerHits++
	if dmg <= 0 {
		return
	}
	p.HP -= dmg
	aid := uint32(0)
	if att != nil {
		aid = uint32(att.ID)
	}
	w.toPlayer(p.ID, Out{Ev: ev(EvPlayerHurt, p.ID, src.ID, int32(dmg), src.Pos, []byte{byte(aid)})})
	w.near(p.Pos, 64, p.ID, Out{Ev: ev(EvStrikeHit, p.ID, src.ID, int32(dmg), p.Pos, nil)})
	if p.HP <= 0 {
		p.HP = 0
		p.Downed = true
		p.respawnTick = w.tick + secondsToTicks(constants.PlayerRespawnS)
		w.Stats.Downs++
		w.near(p.Pos, 64, 0, Out{Ev: ev(EvPlayerDowned, p.ID, src.ID, int32(constants.PlayerRespawnS*1000), p.Pos, nil)})
		for _, e := range w.enemies {
			delete(e.threat, p.ID)
			if e.Target == p.ID {
				e.Target = 0
			}
		}
	}
}

// playerUpkeep: mana regen, out-of-combat regen, heal-over-time,
// consumables, respawn timers.
func (w *World) playerUpkeep() {
	tick := w.tick
	for _, p := range w.players {
		if p.Downed {
			if tick >= p.respawnTick {
				p.Downed = false
				p.HP = p.HPMax
				p.Mana = p.ManaMax
				p.Charges = D.Start.Consumable.Charges
				w.Respawn = append(w.Respawn, p.ID)
				w.toPlayer(p.ID, Out{Ev: ev(EvRespawned, p.ID, 0, int32(p.HPMax), p.Pos, nil)})
			}
			continue
		}
		wpn := p.Weapon()
		regen := D.ManaRegen(p.Level) * wpn.ManaRegen
		if D.HasTechnique("spellcraft", p.Profile.SkillLevel("spellcraft"), "mana_flow") {
			regen *= 1.2
		}
		p.Mana = math.Min(p.ManaMax, p.Mana+regen*dt)
		if tick-p.lastHurtTick > secondsToTicks(constants.PlayerRegenDelayS) && p.HP < p.HPMax {
			p.HP = math.Min(p.HPMax, p.HP+constants.PlayerRegenPerS*dt)
		}
		if p.hotEnd > tick {
			p.HP = math.Min(p.HPMax, p.HP+p.hotPerTick)
		}
		if p.drinkTick != 0 && tick >= p.drinkTick {
			p.drinkTick = 0
			heal := D.Start.Consumable.Heal
			p.HP = math.Min(p.HPMax, p.HP+heal)
			w.toPlayer(p.ID, Out{Ev: ev(EvConsumable, p.ID, 0, int32(p.Charges), p.Pos, []byte{byte(heal)})})
		}
		// Mana for the HUD: on change, at most 5 Hz.
		if math.Abs(p.Mana-p.manaSent) >= 1 && tick-p.manaSentTick >= 6 || (p.Mana == p.ManaMax && p.manaSent != p.ManaMax && tick-p.manaSentTick >= 6) {
			p.manaSent, p.manaSentTick = p.Mana, tick
			w.toPlayer(p.ID, Out{Ev: ev(EvMana, p.ID, uint32(p.ManaMax*10), int32(math.Round(p.Mana*10)), p.Pos, nil)})
		}
	}
}

// ---- enemy projectiles ----

type shot struct {
	enemy  *Enemy
	att    *combatdefs.EnemyAttack
	pos    movement.Vec3
	vel    movement.Vec3
	left   float64 // m of range left
	radius float64
	hit    map[uint32]bool
}

func (w *World) launch(e *Enemy, a *combatdefs.EnemyAttack) {
	n := max(1, a.Volley)
	from := movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + e.Height(), Z: e.Pos.Z}
	for i := 0; i < n; i++ {
		yaw := e.attackYaw
		if n > 1 {
			yaw += (float64(i) - float64(n-1)/2) * a.SpreadDeg * math.Pi / 180
		}
		// aim slightly down/up at the target's chest
		t := w.targetPos(e)
		d := math.Max(1, hdist(t, from))
		vy := (t.Y + 1.0 - from.Y) / d * a.Speed
		v := movement.Vec3{X: -math.Sin(yaw) * a.Speed, Y: vy, Z: -math.Cos(yaw) * a.Speed}
		s := &shot{enemy: e, att: a, pos: from, vel: v, left: a.Reach, radius: a.Radius, hit: map[uint32]bool{}}
		w.shots = append(w.shots, s)
		w.near(from, telegraphRadius, 0, Out{Ev: ev(EvProjectile, e.ID, uint32(a.ID), 0, from, projectileData(v, a.Radius, a.Reach))})
	}
}

// stepShots advances enemy projectiles (two substeps per tick) and queues
// strikes on players they touch.
func (w *World) stepShots() {
	keep := w.shots[:0]
	for _, s := range w.shots {
		alive := true
		for sub := 0; sub < 2 && alive; sub++ {
			h := dt / 2
			s.pos.X += s.vel.X * h
			s.pos.Y += s.vel.Y * h
			s.pos.Z += s.vel.Z * h
			s.left -= math.Hypot(math.Hypot(s.vel.X, s.vel.Z), s.vel.Y) * h
			if s.left <= 0 || s.pos.Y < w.ground.HeightAt(s.pos.X, s.pos.Z) {
				alive = false
				break
			}
			for _, p := range w.playersNear(s.pos, 3) {
				if s.hit[p.ID] || p.Downed {
					continue
				}
				chest := movement.Vec3{X: p.Pos.X, Y: p.Pos.Y + 0.9, Z: p.Pos.Z}
				if hdist(chest, s.pos) <= s.radius+playerRadius+0.2 && math.Abs(chest.Y-s.pos.Y) < 1.2+s.radius {
					s.hit[p.ID] = true
					area := attackArea{shape: "circle", center: movement.Vec3{X: s.pos.X, Y: p.Pos.Y, Z: s.pos.Z}, radius: s.radius + 0.2}
					st := &strike{enemy: s.enemy, att: s.att, player: p.ID, seq: p.LastSeq, tick: w.tick, area: area, damage: s.att.Damage * s.enemy.DamageMult, shot: true}
					w.strikes = append(w.strikes, st)
					alive = false
				}
			}
		}
		if alive {
			keep = append(keep, s)
		}
	}
	w.shots = keep
}
