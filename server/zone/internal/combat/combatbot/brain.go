// Package combatbot is a headless fighter: it walks to enemies, attacks
// with the real weapon timelines (the same start rules as the client's
// combat timeline), claims the hits it predicts, dodges telegraphed
// attacks and drinks when hurt. The same Brain drives the in-process fight
// simulations (internal/combat tests: time-to-kill against the spec 8 feel
// targets) and the networked acceptance bots against a real zone process
// (server/zone/cmd/combatbots: a party of two clears a camp and a boss).
//
// It knows only what a client knows: its own predicted movement state, the
// enemies it can see (position, health %, typeId) and the telegraph Events.
package combatbot

import (
	"math"
	"sort"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

var D = combatdefs.D

// EnemyView is an enemy as the bot sees it.
type EnemyView struct {
	ID     uint32
	Pos    movement.Vec3
	HPPct  uint8
	TypeID uint16
}

// Telegraph is a wind-up the bot saw (Event 204), in the bot's step clock.
type Telegraph struct {
	Enemy     uint32
	Attack    int
	SeenStep  uint32
	Windup    int // steps
	Shape     uint8
	Center    movement.Vec3
	Yaw       float64
	Radius    float64
	Reach     float64
	Arc       float64
	Width     float64
	Projected bool
}

// Brain is one bot fighter.
type Brain struct {
	Name   string
	Weapon *combatdefs.Weapon
	Ground movement.Ground
	State  movement.State // predicted own movement state
	Seq    uint32
	HP     float64 // own health fraction 0..1 (from SelfState / the world)
	Goal   *movement.Vec3
	// Avoid lets the bot keep away from points (e.g. "don't pull the boss
	// yet"); nil = none.
	Leash     float64
	Charges   int
	PreferIDs func(EnemyView) bool // optional target filter (camp members only, the boss...)

	target    uint32
	nextSeq   uint32
	lastLight struct {
		seq   uint32
		move  *combatdefs.Move
		combo int
	}
	pend      []pending
	dodgeAt   uint32
	dodgeDir  float64
	altLeft   int // bow: steps of draw left
	tele      []Telegraph
	drinkSeq  uint32
	strafeDir float64
	// Spell is the slot-0 spell (the start kit's Ember Flick) the bot casts at
	// targets its weapon can't reach: flyers, kiting archers, enemies on a
	// ledge above it.
	Spell     *combatdefs.Spell
	spellNext uint32
	Casts     int
	// Safe is where the bot backs off to when hurt with no draughts left,
	// until out-of-combat regeneration has it back above 80 % (nil = never).
	Safe       *movement.Vec3
	retreating bool
	Retreats   int

	// Stats
	Attacks, Claims, Dodges, Drinks int
	FightStart                      map[uint32]uint32 // enemy -> step the bot first attacked it
}

type pending struct {
	at     uint32 // step the hit frames start (claim then)
	start  uint32 // the attack's start seq (HitClaim.attackSeq)
	move   *combatdefs.Move
	spell  *combatdefs.Spell
	target uint32
	yaw    float64
}

// New makes a brain at state s with a weapon.
func New(name string, weapon string, g movement.Ground, s movement.State) *Brain {
	return &Brain{Name: name, Weapon: D.WeaponByKey(weapon), Ground: g, State: s, HP: 1, Leash: 1e9, Charges: D.Start.Consumable.Charges,
		FightStart: map[uint32]uint32{}, strafeDir: 1, Spell: D.SpellByKey(D.Start.Spells[0])}
}

// SeeTelegraph records a wind-up Event (call when it arrives).
func (b *Brain) SeeTelegraph(t Telegraph) {
	t.SeenStep = b.Seq
	b.tele = append(b.tele, t)
}

// Claim is one predicted hit to send.
type Claim = proto.HitClaim

func yawTo(dx, dz float64) float64 { return math.Atan2(-dx, -dz) }

func hdist(a, b movement.Vec3) float64 { return math.Hypot(a.X-b.X, a.Z-b.Z) }

func angleDiff(a, b float64) float64 {
	d := math.Mod(a-b+3*math.Pi, 2*math.Pi) - math.Pi
	return math.Abs(d)
}

// threatened reports a telegraph whose area will contain the bot, and when
// (in steps from now) it strikes.
func (b *Brain) threatened() (in int, area *Telegraph) {
	best := 1 << 30
	var bt *Telegraph
	keep := b.tele[:0]
	for i := range b.tele {
		t := b.tele[i]
		left := int(t.SeenStep) + t.Windup - int(b.Seq)
		if left < -8 {
			continue
		}
		keep = append(keep, t)
		if t.Shape == 4 { // projectile: dodge when the volley is launched toward us
			continue
		}
		if contains(&t, b.State.Pos, 0.9) && left < best {
			best, bt = left, &keep[len(keep)-1]
		}
	}
	b.tele = keep
	return best, bt
}

func contains(t *Telegraph, p movement.Vec3, r float64) bool {
	dx, dz := p.X-t.Center.X, p.Z-t.Center.Z
	d := math.Hypot(dx, dz)
	switch t.Shape {
	case 1, 2:
		return d <= t.Radius+r
	case 0:
		if d > t.Reach+r {
			return false
		}
		return d < r+0.5 || angleDiff(yawTo(dx, dz), t.Yaw) <= t.Arc/2*math.Pi/180+math.Atan2(r, math.Max(d, 0.1))
	case 3:
		fx, fz := -math.Sin(t.Yaw), -math.Cos(t.Yaw)
		along := dx*fx + dz*fz
		return along >= -r && along <= t.Reach+r && math.Abs(dx*fz-dz*fx) <= t.Width/2+r
	}
	return false
}

// pickTarget: keep the current one while alive, else the nearest allowed.
func (b *Brain) pickTarget(es []EnemyView) *EnemyView {
	var cur *EnemyView
	cands := make([]EnemyView, 0, len(es))
	for _, e := range es {
		if e.HPPct == 0 {
			continue
		}
		if b.PreferIDs != nil && !b.PreferIDs(e) {
			continue
		}
		cands = append(cands, e)
	}
	sort.Slice(cands, func(i, j int) bool {
		di, dj := hdist(cands[i].Pos, b.State.Pos), hdist(cands[j].Pos, b.State.Pos)
		if di != dj {
			return di < dj
		}
		return cands[i].ID < cands[j].ID
	})
	for i := range cands {
		if cands[i].ID == b.target {
			cur = &cands[i]
		}
	}
	if cur != nil {
		return cur
	}
	if len(cands) == 0 {
		b.target = 0
		return nil
	}
	b.target = cands[0].ID
	return &cands[0]
}

// reachOf is the reach the bot fights at.
func (b *Brain) reachOf() float64 {
	m := D.MoveOf(b.Weapon, "light", 0)
	if b.Weapon.Key == "bow" {
		return 18
	}
	if m.Speed > 0 {
		return 14
	}
	return m.Reach + 0.2
}

// Step produces this step's input frame and any hit claims (claims go out
// for hits whose active frames start now, as the client does).
func (b *Brain) Step(es []EnemyView, serverTick uint32) (proto.InputFrame, []Claim) {
	b.Seq++
	seq := b.Seq
	f := proto.InputFrame{Seq: seq, Yaw: proto.YawToU16(0)}
	yaw := 0.0
	var claims []Claim
	t := b.pickTarget(es)
	var tpos movement.Vec3
	if t != nil {
		tpos = t.Pos
	}

	// Hits whose active frames start now: claim if the target is in reach.
	keep := b.pend[:0]
	for _, p := range b.pend {
		if p.at > seq {
			keep = append(keep, p)
			continue
		}
		for _, e := range es {
			if e.ID != p.target || e.HPPct == 0 {
				continue
			}
			if p.spell != nil {
				o := b.State.Pos
				claims = append(claims, Claim{AttackSeq: p.start, AttackID: uint16(p.spell.ID), TargetID: e.ID, Tick: serverTick,
					X: proto.MetersToCm(o.X), Y: proto.MetersToCm(o.Y), Z: proto.MetersToCm(o.Z), Yaw: proto.YawToU16(p.yaw)})
				b.Claims++
				continue
			}
			if p.move.Speed > 0 || hdist(e.Pos, b.State.Pos) <= p.move.Reach+0.6+0.5*sizeOf(e.TypeID) {
				o := b.State.Pos
				claims = append(claims, Claim{AttackSeq: p.start, AttackID: uint16(p.move.ID), TargetID: e.ID, Tick: serverTick,
					X: proto.MetersToCm(o.X), Y: proto.MetersToCm(o.Y), Z: proto.MetersToCm(o.Z), Yaw: proto.YawToU16(p.yaw)})
				b.Claims++
			}
		}
	}
	b.pend = keep

	in, threat := b.threatened()
	if b.Safe != nil {
		if !b.retreating && b.HP < 0.3 && b.Charges == 0 {
			b.retreating = true
			b.Retreats++
		}
		if b.retreating && b.HP > 0.8 {
			b.retreating = false
		}
	}
	switch {
	case b.retreating:
		yaw = yawTo(b.Safe.X-b.State.Pos.X, b.Safe.Z-b.State.Pos.Z)
		if hdist(*b.Safe, b.State.Pos) > 2 {
			f.Flags |= proto.InputFlagForward | proto.InputFlagSprint
		}
	case b.Goal != nil && (t == nil || hdist(*b.Goal, b.State.Pos) > b.Leash):
		yaw = yawTo(b.Goal.X-b.State.Pos.X, b.Goal.Z-b.State.Pos.Z)
		if hdist(*b.Goal, b.State.Pos) > 1.5 {
			f.Flags |= proto.InputFlagForward
			if hdist(*b.Goal, b.State.Pos) > 20 {
				f.Flags |= proto.InputFlagSprint
			}
		}
	case t != nil:
		d := hdist(tpos, b.State.Pos)
		yaw = yawTo(tpos.X-b.State.Pos.X, tpos.Z-b.State.Pos.Z)
		reach := b.reachOf()
		if d > reach {
			f.Flags |= proto.InputFlagForward
			if d > 12 {
				f.Flags |= proto.InputFlagSprint
			}
		} else if d < reach*0.45 && b.Weapon.Key != "sword" && b.Weapon.Key != "spear" {
			f.Flags |= proto.InputFlagBack
		}
		// Attack when ready and in reach; cast at what the weapon can't reach.
		dy := t.Pos.Y - b.State.Pos.Y
		melee := b.Weapon.Key == "sword" || b.Weapon.Key == "spear"
		switch {
		case seq >= b.nextSeq && d <= reach+0.3 && dy < 2.5 && seq > b.dodgeAt+2:
			b.attack(&f, t, yaw, d)
		case melee && b.Spell != nil && seq >= b.spellNext && seq > b.dodgeAt+2 && d < b.Spell.Range*0.8 && (dy >= 2.5 || d > reach+3):
			f.Flags |= proto.InputFlagCast
			f.CastSlot = 0
			b.spellNext = seq + uint32(max(b.Spell.CooldownSteps, 50))
			b.Casts++
			at := seq + uint32(b.Spell.WindupSteps) + 1 + uint32(math.Round(math.Hypot(d, dy)/math.Max(1, b.Spell.Speed)*float64(constants.MoveStepHz)))
			b.pend = append(b.pend, pending{at: at, start: seq, spell: b.Spell, target: t.ID, yaw: yaw})
		}
	}

	// Dodge a telegraphed strike: i-frames from now cover the next 9 steps,
	// and the dodge carries us 2.4 m out of most shapes as well.
	if threat != nil && in <= 4 && seq >= b.dodgeAt+14 && !movement.Dashing(b.State) && b.State.IFrames == 0 {
		f.Flags |= proto.InputFlagDodge
		f.CastSlot = 0
		f.Flags &^= proto.InputFlagForward | proto.InputFlagSprint
		// dodge sideways relative to the attacker
		away := yawTo(b.State.Pos.X-threat.Center.X, b.State.Pos.Z-threat.Center.Z)
		if threat.Shape == 0 || threat.Shape == 3 {
			away = threat.Yaw + math.Pi/2*b.strafeDir
			b.strafeDir = -b.strafeDir
		}
		yaw = away
		f.Flags |= proto.InputFlagForward
		b.dodgeAt = seq
		b.Dodges++
	}

	// Drink when low (spec 8: walk while using).
	if b.HP < 0.4 && b.Charges > 0 && seq > b.drinkSeq+60 {
		f.Flags |= proto.InputFlagInteract
		b.Charges--
		b.drinkSeq = seq
		b.Drinks++
	}

	f.Yaw = proto.YawToU16(yaw)
	b.State = movement.StepFrame(b.State, f, b.Ground)
	return f, claims
}

func sizeOf(typeID uint16) float64 {
	id, _, _ := combatdefs.UnpackTypeID(typeID)
	if e := D.EnemyByID(id); e != nil {
		return e.Size
	}
	return 1
}

// attack starts the weapon's next move (combo rules as the client).
func (b *Brain) attack(f *proto.InputFrame, t *EnemyView, yaw float64, d float64) {
	w := b.Weapon
	seq := f.Seq
	var m *combatdefs.Move
	if w.Key == "bow" {
		// Draw (alt held) for the full charge, then release: one attack
		// per draw. altLeft counts the draw down.
		cm := D.MoveOf(w, "charged", 0)
		if b.altLeft == 0 {
			b.altLeft = cm.ChargeSteps + 1
		}
		b.altLeft--
		if b.altLeft > 0 {
			f.Flags |= proto.InputFlagAltAttack
			return
		}
		m = cm
	} else {
		combo := 0
		if l := b.lastLight; l.move != nil {
			end := l.seq + uint32(l.move.StartupSteps+l.move.ActiveSteps+l.move.RecoverySteps)
			if seq <= end+24 {
				combo = (l.combo + 1) % D.ComboLength(w)
			}
		}
		m = D.MoveOf(w, "light", combo)
		b.lastLight.seq, b.lastLight.move, b.lastLight.combo = seq, m, combo
	}
	f.Flags |= proto.InputFlagAttack
	b.Attacks++
	if _, ok := b.FightStart[t.ID]; !ok {
		b.FightStart[t.ID] = seq
	}
	b.nextSeq = seq + uint32(m.StartupSteps+m.ActiveSteps+m.RecoverySteps)
	at := seq + uint32(m.StartupSteps)
	if m.Speed > 0 {
		at += uint32(math.Round(d / math.Max(1, m.Speed*(1+(m.ChargeMult-1))) * float64(constants.MoveStepHz)))
	}
	b.pend = append(b.pend, pending{at: at, start: seq, move: m, target: t.ID, yaw: yaw})
}

// Rebase replaces the predicted state with the server's (on a correction).
func (b *Brain) Rebase(s movement.State) { b.State = s }
