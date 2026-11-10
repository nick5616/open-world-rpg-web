package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// AI states (spec 8: idle, patrol, alert, chase, attack, flee, return).
type AIState uint8

const (
	Asleep AIState = iota
	Idle
	Alert
	Chase
	Windup
	Striking
	Recover
	Reposition
	Return
	Flee
	Dead
	Evade
)

func (s AIState) String() string {
	return [...]string{"asleep", "idle", "alert", "chase", "windup", "striking", "recover", "reposition", "return", "flee", "dead", "evade"}[s]
}

// statusInst is one status on an enemy.
type statusInst struct {
	def    *combatdefs.Status
	until  uint32 // tick
	stacks int
	next   uint32 // next DOT tick
	src    uint32 // player who applied it (DOT kill credit)
	// killing: applied by a demon-killing action (WP15: Light's burn sears demons)
	killing bool
	dmg     float64
	from    movement.Vec3 // pull target / knockback source
}

// histSample is one tick of an enemy's position (lenient hit validation).
type histSample struct {
	tick uint32
	pos  movement.Vec3
}

const histLen = 32 // ~1 s at 30 Hz

// Enemy is one spawned enemy.
type Enemy struct {
	ID      uint32 // entity id (allocated by the host)
	Def     *combatdefs.Enemy
	Level   int
	Element int // combatdefs element, Physical none
	Affix   *combatdefs.Affix
	Boss    *BossState
	Demon   *DemonState // WP15: demons regenerate and die only to KillsDemons (demon.go)
	Group   *Group
	Name    string // "" for commons; elites and bosses are named

	HP, HPMax         float64
	Shield, ShieldMax float64
	shieldHit         uint32
	DamageMult        float64
	SpeedMult         float64
	cooldownMult      float64
	baseHP            float64 // level+affix health before party scaling
	baseDmg           float64 // level+affix damage multiplier before party scaling
	scaleN            int

	Pos, Vel movement.Vec3
	Yaw      float64
	Home     movement.Vec3
	State    AIState
	stateAt  uint32
	Target   uint32
	threat   map[uint32]float64
	DamageBy map[uint32]float64
	engaged  map[uint32]bool

	attack     *combatdefs.EnemyAttack
	attackAim  movement.Vec3 // ground point / charge end
	attackYaw  float64
	attackFrom movement.Vec3
	cooldowns  map[int]uint32
	nextAttack uint32
	moveTo     movement.Vec3
	statuses   []statusInst
	hist       [histLen]histSample
	nHist      int
	split      bool // a split copy (doesn't split again)
	taunt      movement.Vec3
	lastHitBy  uint32
	diedTick   uint32
	chargeHit  map[uint32]bool
	// AggroTick is when it first noticed a player (fight-length measurements).
	AggroTick  uint32
	recentHits []uint32
	lastEvade  uint32
	inWinding  bool // WP19: listed in World.winding
	// WP19b partitioned AI (par.go): the tick this enemy thought on a
	// worker, where its outputs sit, its wind-up request, and the target it
	// was winding up on when the tick started.
	aiTick     uint32
	gone       bool // removed from the World (removeEnemy)
	aiOut      aiRange
	wantAttack *combatdefs.EnemyAttack
	windStart  uint32
	// CR 020: an ally (summon.go; never in World.enemies) and a brand (detonate.go).
	ally  *summonState
	brand *brandMark
	// CR 029 pets (pets.go): a tamed companion (an ally that persists:
	// real health, levels, an ability; never in World.enemies), and on a
	// wild creature the pet it fights (petTgt with the threat it built:
	// the pet draws it off its owner), the last pet that bit it (the pet's
	// XP when it falls) and taming's calm (it stands still, sniffing).
	pet        *petState
	petTgt     uint32
	petThreat  float64
	lastPetHit uint32
	calmUntil  uint32
	calmAgain  uint32 // a calm that ended: not again before this tick
}

// Typeid is the wire typeId (combatdefs.TypeID).
func (e *Enemy) TypeID() uint16 {
	if e.pet != nil {
		return e.pet.typeID // CR 029: drawn as EntityKind effect with the pet bit
	}
	if e.ally != nil {
		return combatdefs.SummonTypeID(e.ally.def) // CR 020: drawn as EntityKind effect
	}
	af := 0
	if e.Affix != nil {
		af = e.Affix.ID
	}
	if e.Boss != nil {
		af = combatdefs.AffixBoss
	}
	return combatdefs.TypeID(e.Def.ID, e.Element, af)
}

// Alive reports a living enemy.
func (e *Enemy) Alive() bool { return e.State != Dead }

// IsBoss reports a boss.
func (e *Enemy) IsBoss() bool { return e.Boss != nil }

// Elite reports an elite.
func (e *Enemy) Elite() bool { return e.Affix != nil }

// Radius is the enemy's body radius for hit tests.
func (e *Enemy) Radius() float64 { return 0.5 * e.Def.Size }

// Height is the centre height above the feet.
func (e *Enemy) Height() float64 { return 0.9 * e.Def.Size }

// Winding reports a telegraphed attack in progress (Activity casting bit).
func (e *Enemy) Winding() bool { return e.State == Windup }

// HealthPct is the 0..100 health percentage for snapshots.
func (e *Enemy) HealthPct() uint8 {
	if e.ally != nil && e.pet == nil {
		return e.ally.pct // CR 020: an ally shows the time it has left
	}
	if e.HPMax <= 0 || !e.Alive() {
		return 0
	}
	return uint8(math.Max(1, math.Round(e.HP*100/e.HPMax)))
}

// levelMults: health +10 % and damage +6 % per level (danger and depth make
// enemies tougher without new tables).
func levelMults(level int) (hp, dmg float64) {
	l := float64(max(0, level-1))
	return 1 + 0.1*l, 1 + 0.06*l
}

// newEnemy builds an enemy of def at level with an optional affix.
func newEnemy(def *combatdefs.Enemy, level, element int, affix *combatdefs.Affix, pos movement.Vec3) *Enemy {
	hpM, dmgM := levelMults(level)
	e := &Enemy{Def: def, Level: level, Element: element, Affix: affix, Pos: pos, Home: pos, State: Asleep,
		threat: map[uint32]float64{}, DamageBy: map[uint32]float64{}, engaged: map[uint32]bool{}, cooldowns: map[int]uint32{},
		SpeedMult: 1, cooldownMult: 1, scaleN: 1}
	if element == combatdefs.Physical && def.Element != combatdefs.Physical {
		e.Element = def.Element
	}
	e.baseHP = def.HP * hpM
	e.DamageMult = dmgM
	if affix != nil {
		e.baseHP *= affix.HPMult
		e.DamageMult *= affix.DamageMult
		e.SpeedMult = affix.SpeedMult
		e.cooldownMult = affix.CooldownMult
	}
	e.baseDmg = e.DamageMult
	e.HPMax, e.HP = e.baseHP, e.baseHP
	if affix != nil && affix.ShieldPct > 0 {
		e.ShieldMax = e.baseHP * affix.ShieldPct
		e.Shield = e.ShieldMax
	}
	return e
}

// partyScale applies spec 8's party scaling for n engaged players: health
// keeps its fraction, damage grows a little (constants.yaml combat group).
// It only ever grows during a fight, so leaving doesn't make it easier.
func (e *Enemy) partyScale(n int) {
	n = max(1, min(constants.PartyScaleMax, n))
	if n <= e.scaleN {
		return
	}
	frac := e.HP / e.HPMax
	hpMult := 1 + constants.PartyHpPerPlayer*float64(n-1)
	e.DamageMult = e.baseDmg * (1 + constants.PartyDmgPerPlayer*float64(n-1))
	e.HPMax = e.baseHP * hpMult
	e.HP = e.HPMax * frac
	if e.ShieldMax > 0 {
		sf := e.Shield / e.ShieldMax
		e.ShieldMax = e.HPMax * e.Affix.ShieldPct
		e.Shield = e.ShieldMax * sf
	}
	e.scaleN = n
}

// resetScale undoes party scaling (a reset boss, a returned camp).
func (e *Enemy) resetScale() {
	e.scaleN = 1
	e.HPMax, e.HP = e.baseHP, e.baseHP
	e.DamageMult = e.baseDmg
	if e.ShieldMax > 0 {
		e.ShieldMax = e.baseHP * e.Affix.ShieldPct
		e.Shield = e.ShieldMax
	}
}

// ScaleN is the party size the enemy is scaled for.
func (e *Enemy) ScaleN() int { return e.scaleN }

func (e *Enemy) record(tick uint32) {
	e.hist[e.nHist%histLen] = histSample{tick, e.Pos}
	e.nHist++
}

// samples calls fn for history samples with tick in [lo, hi] (and the
// current position if none match).
func (e *Enemy) samples(lo, hi uint32, fn func(movement.Vec3)) {
	n := 0
	for i := 0; i < min(e.nHist, histLen); i++ {
		s := e.hist[i]
		if s.tick >= lo && s.tick <= hi {
			fn(s.pos)
			n++
		}
	}
	if n == 0 {
		fn(e.Pos)
	}
}

// has reports an active status.
func (e *Enemy) has(key string, tick uint32) bool {
	for i := range e.statuses {
		if e.statuses[i].def.Key == key && e.statuses[i].until > tick {
			return true
		}
	}
	return false
}

// disabled reports a status that stops all action (stun, freeze, petrify,
// airborne) or a boss phase transition.
func (e *Enemy) disabled(tick uint32) bool {
	if e.Boss != nil && e.Boss.transitionUntil > tick {
		return true
	}
	return e.has("stun", tick) || e.has("freeze", tick) || e.has("petrify", tick) || e.has("airborne", tick)
}

// damageTakenMult from statuses (curse, airborne, shock).
func (e *Enemy) damageTakenMult(tick uint32) float64 {
	m := 1.0
	for i := range e.statuses {
		s := &e.statuses[i]
		if s.until > tick && s.def.DamageMult > 0 {
			m *= s.def.DamageMult
		}
	}
	return m
}

// applyStatus adds or refreshes a status; bosses shrug off hard control
// (stun/freeze/petrify last a quarter as long), so a boss fight stays a
// fight.
func (e *Enemy) applyStatus(key string, src uint32, from movement.Vec3, tick uint32, dotScale float64) *combatdefs.Status {
	def := D.StatusByKey(key)
	if def == nil {
		return nil
	}
	dur := uint32(math.Round(float64(def.DurationSteps) * constants.TickRateHz / float64(D.StepHz)))
	if e.Boss != nil && (key == "stun" || key == "freeze" || key == "petrify" || key == "airborne" || key == "pull" || key == "knockback" || key == "taunt") {
		dur /= 4
	}
	for i := range e.statuses {
		s := &e.statuses[i]
		if s.def == def {
			s.until = tick + dur
			if def.MaxStacks > 0 && s.stacks < def.MaxStacks {
				s.stacks++
			}
			s.src, s.from = src, from
			return def
		}
	}
	e.statuses = append(e.statuses, statusInst{def: def, until: tick + dur, stacks: 1, next: tick + ticksOf(def.TickSteps), src: src, from: from, dmg: def.TickDamage * dotScale})
	if e.State == Windup && (key == "stun" || key == "freeze" || key == "petrify" || key == "airborne") {
		e.State = Recover // interrupted wind-up (stagger)
		e.attack = nil
	}
	return def
}

// ticksOf converts 60 Hz steps to 30 Hz ticks (at least 1 when positive).
func ticksOf(steps int) uint32 {
	if steps <= 0 {
		return 0
	}
	return uint32(max(1, int(math.Round(float64(steps)*constants.TickRateHz/float64(D.StepHz)))))
}

// takeDamage applies damage (shield first). Returns damage dealt to health
// and whether the shield absorbed any.
func (e *Enemy) takeDamage(dmg float64, tick uint32) (dealt float64, shielded bool) {
	if e.Shield > 0 {
		shielded = true
		e.shieldHit = tick
		a := math.Min(e.Shield, dmg)
		e.Shield -= a
		dmg -= a
	}
	dealt = math.Min(e.HP, dmg)
	e.HP -= dealt
	// Damage breaks freeze (spec: freeze breakOnDamage).
	for i := range e.statuses {
		if e.statuses[i].def.BreakOnDamage && dealt > 0 {
			e.statuses[i].until = tick
		}
	}
	return dealt, shielded
}
