package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Combo and timing rules shared with the client's timeline
// (client/src/combat/timeline.ts). The client decides WHEN an action
// starts (input buffer, cancels); the zone re-derives WHICH move it is from
// the same frames and movement state, and refuses starts that come faster
// than the move allows.
const (
	// ComboWindowSteps: a light attack that starts within this many steps
	// after the previous light attack's recovery ended continues the combo.
	ComboWindowSteps = 24 // 400 ms
	// PlungeMinHeight: an attack in the air this far above the ground is a
	// plunge (spec 8: "a plunge attack from any height").
	PlungeMinHeight = 3.0
	// SprintAttackSpeed: grounded horizontal speed above which an attack
	// with the sprint key held is a sprint attack.
	SprintAttackSpeed = constants.BaseMoveSpeed * 0.75
	// startTolerance absorbs one step of disagreement on a start's legality.
	startTolerance = 1
	// actionRing is how many recent actions a player keeps for claims
	// (claims for a projectile can arrive ~2 s after the cast).
	actionRing = 48
	// frameRing: recent frames kept for the strike grace window.
	frameRing = 64
	// FormSlot and TechniqueSlot are the castSlot values of the elemental
	// form and the weapon's heavy technique (beyond the four spell slots).
	FormSlot      = 4
	TechniqueSlot = 5
	// MaxMeleeTargets caps how many enemies one swing can hit.
	MaxMeleeTargets = 5
)

// ActKind is what an Action is.
type ActKind uint8

const (
	ActMove ActKind = iota + 1
	ActSpell
	ActForm
)

// Action is one logged attack, cast or form start: the server's record a
// HitClaim must match (attackSeq + attackId).
type Action struct {
	Seq        uint32
	Tick       uint32
	Kind       ActKind
	ID         int // move, spell or form id (HitClaim.attackId)
	Move       *combatdefs.Move
	Spell      *combatdefs.Spell
	Form       *combatdefs.Form
	Weapon     *combatdefs.Weapon
	Pos        movement.Vec3 // attacker feet at the start
	Yaw, Pitch float64
	Charge     float64 // 0..1 of a charged move's draw
	FallHeight float64 // plunge
	Combo      int
	Legal      bool
	Refusal    int
	hits       map[uint32]int
	targets    int
	// CR 020: a stream's fired shots (stream.go), per-shot hits, the orbs of
	// a homing volley spent per target, an orbit's last hit per target.
	shots    [streamRing]shotRec
	nShots   int
	shotHits map[uint64]bool
	shotTgts map[int]int
	orbUsed  map[uint32]uint32
	lastHit  map[uint32]uint32
	critSeq  uint32 // the seq a stream shot's crit is rolled on (0 = Seq)
}

// frameRec is one applied input frame's outcome (strike grace window).
type frameRec struct {
	seq     uint32
	pos     movement.Vec3
	iframes bool
	parry   bool
}

// Player is a connected character's combat state (tick-owned).
type Player struct {
	ID      uint32
	Name    string
	Profile *Profile
	Level   int
	PartyID uint32

	HP, HPMax     float64
	Mana, ManaMax float64
	Pos           movement.Vec3 // authoritative feet position (game updates per tick)
	LastSeq       uint32
	// WP14: what the equipped items add (internal/items Gear; the zero
	// value is the WP13 training kit) and the inventory-backed consumable
	// (nil: WP13's stand-in draught with refilling charges).
	Gear Gear
	// Boons are permanent rewards outside the level curve (playtest 1:
	// tower attunements add health and skill points; CR 012).
	Boons     Boons
	OnDrink   func() (heal float64, ok bool)
	drinkHeal float64
	// Playtest 2 camps (CR 025): the Rested buff multiplies health and mana
	// regeneration (0 = 1; the zone sets and clears them, camps.go).
	RegenMult, ManaRegenMult float64
	// Playtest 2 weather (CR 030): Chilled stops health regeneration and
	// slows mana (COLD_MANA_REGEN_MULT); the zone sets and clears it.
	Chilled bool
	// CR 029: a pet's buff (the wolf's howl): damage x petBuffMult until petBuffEnd.
	petBuffMult float64
	petBuffEnd  uint32

	readyAt   map[int]uint32 // spell/form/technique id -> seq it is ready
	actions   [actionRing]Action
	nAct      int
	nextSeq   uint32 // earliest seq the next attack may start (no cancel)
	activeEnd uint32 // seq the last attack's hit frames end (dodge cancel point)
	lastLight *Action
	dodgeSeq  uint32 // newest dodge/dash start
	altHeld   int
	altPrev   bool
	parryEnd  uint32
	riposte   bool
	airTop    float64 // highest feet y since leaving the ground (plunge height)
	wasAir    bool
	ch        *channel // CR 020: a running stream or gathering charge (stream.go)
	yaw       float64  // CR 020: the newest frame's view yaw (allies follow behind it)

	frames [frameRing]frameRec
	nFrame int
	// Playtest 2 (CR 019): positions by zone tick, for PvP hit claims
	// (ClaimPlayer looks back like Claim does over an enemy's history).
	hist  [pvpHist]posRec
	nHist int

	lastHurtTick uint32
	Downed       bool
	respawnTick  uint32
	// graceTick: until this tick a just-respawned player is left alone
	// (playtest 2, CR 024: PLAYER_RESPAWN_GRACE_S; ended by landing a hit).
	graceTick    uint32
	shield       float64
	shieldEnd    uint32
	hotPerTick   float64
	hotEnd       uint32
	Charges      int
	drinkTick    uint32
	manaSent     float64
	manaSentTick uint32
	inCombatTick uint32
	dash         dashState // CR 021: the dash allowDash allowed (dashes.go)
	// Dashes, Slams (CR 031 achievements): dashes started and magma dives
	// that landed; the zone reads them once a second (never sent).
	Dashes, Slams int
	// CR 022 (held.go): what the player holds, for other clients' visuals.
	held      heldState
	beam      beamRun
	aimYaw    uint16 // the newest frame's look, exactly as sent
	aimPitch  int16
	guardHeld bool
}

// InCombatWithin reports whether the player hurt something or was hurt in
// the last seconds (at combat tick now). Playtest 2's friend travel uses it.
func (p *Player) InCombatWithin(now uint32, seconds float64) bool {
	return p.inCombatTick != 0 && now-p.inCombatTick < secondsToTicks(seconds)
}

// NewPlayer builds the runtime state for a joining character.
func NewPlayer(id uint32, name string, prof *Profile, level int) *Player {
	p := &Player{ID: id, Name: name, Profile: prof, readyAt: map[int]uint32{}, Charges: D.Start.Consumable.Charges}
	p.SetLevel(level)
	p.HP = p.HPMax
	p.Mana = p.ManaMax
	p.manaSent = -1
	return p
}

// Gear is what equipped items add to a player (WP14 sets it from the
// inventory; zero = no items, the WP13 numbers exactly).
type Gear struct {
	WeaponMult  float64 // weapon moves and forms (0 = 1)
	DamagePct   float64 // weapon moves and forms
	SpellPower  float64 // spells, %
	CritPct     float64
	Health      float64 // added to the level's max health
	ArmorPct    float64 // enemy damage reduction, %
	FormMult    float64 // socketed gem cut (0 = 1)
	KillsDemons bool    // WP15: sunsteel weapon
	Stagger     bool    // WP15: silver weapon
}

func orOne(v float64) float64 {
	if v <= 0 {
		return 1
	}
	return v
}

// Boons are permanent character rewards (playtest 1, CR 012): each first
// tower attunement adds combat.yaml leveling.attune health and skill points.
type Boons struct {
	Health      float64
	SkillPoints int
}

// SetBoons applies new boons (health max follows, keeping the fraction).
func (p *Player) SetBoons(b Boons) {
	if p.Boons == b {
		return
	}
	p.Boons = b
	p.SetLevel(p.Level)
}

// SkillPointsTotal is every spell skill point the character has: the
// level's plus boons.
func (p *Player) SkillPointsTotal() int { return SkillPoints(p.Level) + p.Boons.SkillPoints }

// SetGear applies new gear (health max follows, keeping the health fraction).
func (p *Player) SetGear(g Gear) {
	if p.Gear == g {
		return
	}
	p.Gear = g
	p.SetLevel(p.Level)
}

// spendDrink asks the inventory for one consumable (WP14); the WP13
// stand-in always succeeds with combat.yaml's heal.
func (p *Player) spendDrink() bool {
	p.drinkHeal = D.Start.Consumable.Heal
	if p.OnDrink == nil {
		return true
	}
	h, ok := p.OnDrink()
	if ok {
		p.drinkHeal = h
	}
	return ok
}

// SetLevel applies a character level (health and mana pools grow with it;
// spec 8: "character level still exists for health and spell skill points";
// playtest 1: combat.yaml leveling, CR 012).
func (p *Player) SetLevel(level int) {
	p.Level = max(1, level)
	frac := 1.0
	if p.HPMax > 0 {
		frac = p.HP / p.HPMax
	}
	p.HPMax = D.MaxHealth(p.Level) + p.Gear.Health + p.Boons.Health
	p.HP = math.Min(p.HPMax, p.HPMax*frac)
	p.ManaMax = D.MaxMana(p.Level)
	p.Mana = math.Min(p.Mana, p.ManaMax)
}

// Weapon is the active loadout's weapon.
func (p *Player) Weapon() *combatdefs.Weapon {
	return D.WeaponByKey(p.Profile.Loadouts[p.Profile.Active].Weapon)
}

// Loadout is the active loadout.
func (p *Player) Loadout() *Loadout { return &p.Profile.Loadouts[p.Profile.Active] }

// Action finds a logged action by start seq and attack id.
func (p *Player) Action(seq uint32, id int) *Action {
	for i := 0; i < min(p.nAct, actionRing); i++ {
		a := &p.actions[i]
		if a.Seq == seq && a.ID == id {
			return a
		}
	}
	return nil
}

func (p *Player) log(a Action) *Action {
	slot := &p.actions[p.nAct%actionRing]
	*slot = a
	slot.hits = map[uint32]int{}
	p.nAct++
	return slot
}

// Refusal reasons for HitResult.flags and the cast_refused Event
// (contracts/events.md).
const (
	RefuseNotEnemy     = 1 // not an enemy, and not a player you may fight (one of you is not flagged for PvP: CR 019)
	RefuseNoTarget     = 2
	RefuseDead         = 3
	RefuseUnknown      = 4
	RefuseRange        = 5
	RefuseLOS          = 6
	RefuseHits         = 7
	RefuseStale        = 8
	RefuseIllegal      = 9
	RefuseInvulnerable = 10
	RefuseStatus       = 11
	RefuseCooldown     = 12
	RefuseMana         = 13
	RefuseNotKnown     = 14
	RefuseDowned       = 15
)

// FrameResult is what Frame did with one input frame.
type FrameResult struct {
	Frame   proto.InputFrame // possibly with an illegal dash removed
	Started *Action          // an attack/cast/form that started this frame (legal or not)
	Spent   bool             // mana changed
	Drink   bool             // a consumable use started
	Guard   bool             // CR 018: the secondary button went down (sword parry, spear charge, bow draw)
	// CR 020 (stream.go): a stream or charge started / stopped this frame
	// (Channel*), the stream's shots fired this frame, and the stream that
	// stopped (its Action).
	Channel int
	Shots   int
	Stopped *Action
	StopID  int // the spell id of what stopped
}

// Frame processes one input frame BEFORE the movement step runs on it
// (before = the state the step starts from): logs attack, cast and form
// starts, opens parry windows, starts consumable uses, and strips the dodge
// flag from a dash variant the player may not use right now so the step
// never applies it (the client is corrected instead).
func (p *Player) Frame(f proto.InputFrame, before movement.State, g movement.Ground, tick uint32) FrameResult {
	r := FrameResult{Frame: f}
	if p.Downed {
		// Down: no actions, no movement (the client stops sending keys too).
		r.Frame.Flags = 0
		if p.ch != nil {
			p.endStream(f.Seq, &r)
		}
		return r
	}
	seq := f.Seq
	p.yaw = proto.U16ToYaw(f.Yaw)
	if p.ch != nil {
		p.channelFrame(f, before, tick, &r) // CR 020: a running stream or charge first (stream.go)
	}
	alt := f.Flags&proto.InputFlagAltAttack != 0
	w := p.Weapon()
	ground := g.HeightAt(before.Pos.X, before.Pos.Z)
	air := before.Mode == movement.ModeAir || before.Mode == movement.ModeGlide
	if air {
		if !p.wasAir {
			p.airTop = before.Pos.Y
		}
		p.airTop = math.Max(p.airTop, before.Pos.Y)
	}
	p.wasAir = air

	// Dodge / mobility dash: variant 0 always (the step charges stamina);
	// other variants need an equipped mobility spell (or the wind form).
	if f.Flags&proto.InputFlagDodge != 0 && f.CastSlot != 0 {
		if !p.allowDash(int(f.CastSlot), seq, &r) {
			r.Frame.Flags &^= proto.InputFlagDodge
			r.Frame.CastSlot = 0
		}
	}
	p.sustainDash(&r, before) // CR 021: pay for (or strip) a held dash step (dashes.go)
	if r.Frame.Flags&proto.InputFlagDodge != 0 && before.Dash == 0 && before.IFrames == 0 {
		p.dodgeSeq = seq
	}

	// Sword parry: the secondary button's rising step opens the window.
	if alt && !p.altPrev && w.ParrySteps > 0 {
		p.parryEnd = seq + uint32(w.ParrySteps)
	}
	// CR 018: others see the guard / charge / draw start (staff and wand use
	// the secondary as a heavy attack, which is an EvCast of its own).
	if alt && !p.altPrev && w.Key != "staff" && w.Key != "wand" {
		r.Guard = true
	}

	if f.Flags&proto.InputFlagAttack != 0 {
		r.Started = p.startMove(f, before, w, alt, false, ground, air, tick)
	}
	if f.Flags&proto.InputFlagCast != 0 {
		r.Started = p.startCast(f, before, w, tick, &r)
	}
	if f.Flags&proto.InputFlagInteract != 0 && p.Charges > 0 && p.drinkTick == 0 && p.spendDrink() {
		p.Charges--
		p.drinkTick = tick + uint32(math.Round(float64(constants.ConsumableUseMs)*constants.TickRateHz/1000))
		r.Drink = true
	}

	if alt {
		p.altHeld++
	} else {
		p.altHeld = 0
	}
	p.altPrev = alt
	p.noteHeldFrame(f, alt && w.Key != "staff" && w.Key != "wand") // CR 022 (held.go)
	return r
}

// allowDash checks (and pays for) a mobility dash variant.
func (p *Player) allowDash(variant int, seq uint32, r *FrameResult) bool {
	lo := p.Loadout()
	for _, k := range lo.Spells {
		s := D.SpellByKey(k)
		if s == nil || s.Type != "mobility" || s.Dash != variant || !p.Profile.Knows(k) {
			continue
		}
		cd := p.cooldownSteps(s.CooldownSteps)
		if seq < p.readyAt[s.ID] || p.Mana < s.Mana {
			return false
		}
		p.Mana -= s.Mana
		p.readyAt[s.ID] = seq + uint32(cd)
		p.dashBegin(variant, s) // CR 021: the dash a hold may sustain (dashes.go)
		r.Spent = r.Spent || s.Mana > 0
		return true
	}
	// The wind form's dash follows the form's own start (startCast) on one
	// of the next two steps (a frame has one castSlot: form first, dash next).
	if f := D.FormByElement(lo.Gem); f != nil && f.Dash == variant && p.readyAt[f.ID] >= uint32(f.CooldownSteps) {
		start := p.readyAt[f.ID] - uint32(f.CooldownSteps)
		if seq >= start && seq <= start+2 {
			p.dashBegin(variant, nil) // CR 021 (dashes.go)
			return true
		}
	}
	return false
}

func (p *Player) cooldownSteps(base int) int {
	m := p.Weapon().CooldownMult
	if p.Profile.SkillLevel("spellcraft") >= 20 && D.HasTechnique("spellcraft", p.Profile.SkillLevel("spellcraft"), "quick_cast") {
		m *= 0.9
	}
	return int(math.Round(float64(base) * m))
}

// startMove derives and logs a weapon move (the same rules as the client's
// timeline, so both name the same move).
func (p *Player) startMove(f proto.InputFrame, before movement.State, w *combatdefs.Weapon, alt, heavy bool, ground float64, air bool, tick uint32) *Action {
	seq := f.Seq
	var m *combatdefs.Move
	charge := 0.0
	combo := 0
	hs := math.Hypot(before.Vel.X, before.Vel.Z)
	switch {
	case heavy:
		m = D.MoveOf(w, "heavy", 0)
	case p.riposte && w.ParrySteps > 0:
		m = D.MoveOf(w, "riposte", 0)
		p.riposte = false
	case alt && (w.Key == "staff" || w.Key == "wand"):
		m = D.MoveOf(w, "heavy", 0)
	case !alt && p.altHeld > 0 && D.MoveOf(w, "charged", 0) != nil:
		m = D.MoveOf(w, "charged", 0)
		charge = math.Min(1, float64(p.altHeld)/float64(max(1, m.ChargeSteps)))
	case air && before.Pos.Y-ground >= PlungeMinHeight && before.Vel.Y < 0 && D.MoveOf(w, "plunge", 0) != nil:
		m = D.MoveOf(w, "plunge", 0)
	case air && D.MoveOf(w, "air", 0) != nil:
		m = D.MoveOf(w, "air", 0)
	case !air && f.Flags&proto.InputFlagSprint != 0 && hs > SprintAttackSpeed && D.MoveOf(w, "sprint", 0) != nil:
		m = D.MoveOf(w, "sprint", 0)
	default:
		n := D.ComboLength(w)
		if l := p.lastLight; l != nil && l.Legal && l.Weapon == w {
			end := l.Seq + uint32(l.Move.StartupSteps+l.Move.ActiveSteps+l.Move.RecoverySteps)
			if seq <= end+ComboWindowSteps {
				combo = (l.Combo + 1) % n
			}
		}
		m = D.MoveOf(w, "light", combo)
	}
	if m == nil {
		return nil
	}
	a := Action{Seq: seq, Tick: tick, Kind: ActMove, ID: m.ID, Move: m, Weapon: w, Pos: before.Pos,
		Yaw: proto.U16ToYaw(f.Yaw), Pitch: proto.I16ToPitch(f.Pitch), Charge: charge, Combo: combo, Legal: true}
	if m.Kind == "plunge" {
		a.FallHeight = math.Max(0, p.airTop-ground)
	}
	// Legality: no faster than the previous move allows; a dodge after its
	// hit frames cancels the recovery (spec 8).
	cancel := p.dodgeSeq >= p.activeEnd && p.activeEnd > 0 && p.dodgeSeq <= seq
	if seq+startTolerance < p.nextSeq && !(cancel && seq+startTolerance >= p.activeEnd) {
		a.Legal, a.Refusal = false, RefuseIllegal
		return p.log(a)
	}
	if m.CooldownSteps > 0 {
		if seq < p.readyAt[m.ID] {
			a.Legal, a.Refusal = false, RefuseCooldown
			return p.log(a)
		}
		p.readyAt[m.ID] = seq + uint32(m.CooldownSteps)
	}
	if m.Technique != "" && !D.HasTechnique(w.Skill, p.Profile.SkillLevel(w.Skill), m.Technique) {
		a.Legal, a.Refusal = false, RefuseIllegal
		return p.log(a)
	}
	p.activeEnd = seq + uint32(m.StartupSteps+m.ActiveSteps)
	p.nextSeq = p.activeEnd + uint32(m.RecoverySteps)
	la := p.log(a)
	if m.Kind == "light" {
		p.lastLight = la
	}
	return la
}

// startCast logs a spell (slots 0..3), the elemental form (FormSlot) or the
// weapon's heavy technique (TechniqueSlot).
func (p *Player) startCast(f proto.InputFrame, before movement.State, w *combatdefs.Weapon, tick uint32, r *FrameResult) *Action {
	seq := f.Seq
	a := Action{Seq: seq, Tick: tick, Weapon: w, Pos: before.Pos, Yaw: proto.U16ToYaw(f.Yaw), Pitch: proto.I16ToPitch(f.Pitch), Legal: true}
	switch slot := int(f.CastSlot); {
	case slot < 4:
		key := p.Loadout().Spells[slot]
		s := D.SpellByKey(key)
		if s == nil {
			return nil
		}
		a.Kind, a.ID, a.Spell = ActSpell, s.ID, s
		switch {
		case !p.Profile.Knows(key):
			a.Legal, a.Refusal = false, RefuseNotKnown
		case s.Type == "passive" || s.Type == "mobility":
			return nil // mobility casts arrive as dodge + variant
		case seq < p.readyAt[s.ID]:
			a.Legal, a.Refusal = false, RefuseCooldown
		case p.Mana < s.Mana:
			a.Legal, a.Refusal = false, RefuseMana
		case (s.Auto != nil || s.Charge != nil) && before.Dash > 0:
			a.Legal, a.Refusal = false, RefuseIllegal // CR 020 x 021: its channel bit would hold the running dash (the client waits)
		case s.Auto != nil:
			// CR 020: a stream logs its one Action now; its shots pay as they fire.
			la := p.log(a)
			p.beginChannel(s, la, f, before, tick, r)
			return la
		case s.Charge != nil:
			p.beginChannel(s, nil, f, before, tick, r)
			return nil // the release logs the Action (stream.go)
		default:
			p.Mana -= s.Mana
			p.readyAt[s.ID] = seq + uint32(p.cooldownSteps(s.CooldownSteps))
			r.Spent = r.Spent || s.Mana > 0
		}
	case slot == FormSlot:
		fm := D.FormByElement(p.Loadout().Gem)
		if fm == nil {
			return nil
		}
		a.Kind, a.ID, a.Form = ActForm, fm.ID, fm
		tech := "sword_form"
		if w.Key == "spear" {
			tech = "spear_form"
		}
		switch {
		case w.Key != "sword" && w.Key != "spear":
			a.Legal, a.Refusal = false, RefuseIllegal
		case !D.HasTechnique(w.Skill, p.Profile.SkillLevel(w.Skill), tech):
			a.Legal, a.Refusal = false, RefuseIllegal
		case seq < p.readyAt[fm.ID]:
			a.Legal, a.Refusal = false, RefuseCooldown
		default:
			p.readyAt[fm.ID] = seq + uint32(fm.CooldownSteps)
		}
	case slot == TechniqueSlot:
		m := D.MoveOf(w, "heavy", 0)
		if m == nil || m.Technique == "" {
			return nil
		}
		return p.startMove(f, before, w, false, true, before.Pos.Y, false, tick)
	default:
		return nil
	}
	return p.log(a)
}

// RecordFrame stores the outcome of an applied frame (after the step).
func (p *Player) RecordFrame(seq uint32, s movement.State) {
	p.frames[p.nFrame%frameRing] = frameRec{seq: seq, pos: s.Pos, iframes: movement.Invulnerable(s), parry: seq <= p.parryEnd}
	p.nFrame++
	p.LastSeq = seq
	p.Pos = s.Pos
	p.noteDash(s) // CR 021 (dashes.go)
}

// forFrames calls fn for recorded frames with seq in [lo, hi].
func (p *Player) forFrames(lo, hi uint32, fn func(frameRec)) int {
	n := 0
	for i := 0; i < min(p.nFrame, frameRing); i++ {
		fr := p.frames[i]
		if fr.seq >= lo && fr.seq <= hi {
			fn(fr)
			n++
		}
	}
	return n
}

// SkillOf is the skill an action trains.
func (a *Action) SkillOf() string {
	if a.Kind == ActSpell {
		return "spellcraft"
	}
	return a.Weapon.Skill
}
