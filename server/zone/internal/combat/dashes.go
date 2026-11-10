package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
)

// Playtest 2 dash overhaul (CR 021, docs/cr/021-dash-overhaul.md): the
// zone's half of held dashes and what dashes do to the world.
//
//   - allowDash (player.go) records the dash variant it allowed and paid for
//     (dashBegin).
//   - sustainDash runs on every frame BEFORE the movement step. The client
//     names the running variant in castSlot on every step of the dash (with
//     InputFlag.channel while the key is held). A frame that names a variant
//     that is not the dash this player is running, or names one when no dash
//     runs, has its castSlot zeroed; a held step (movement.Holding) is paid
//     here (mana per step, and health for the blood dash) and, when the player
//     cannot pay or no longer has the spell equipped, also zeroed. The shared
//     step then never sustains a dash the zone did not pay for: it counts
//     down and ends with the plain exit clamp, the same on both sides once
//     the client reconciles.
//   - noteDash (RecordFrame) follows the dash after each applied step (still
//     running, landing from a dive), and dashTick (World.Step, once a tick)
//     applies the trail: damage and a status on enemies the dasher passes
//     through (each once per dash), lifesteal, the heal trail, the landing
//     slam (Event 230). The game layer schedules the chemistry along the
//     path (internal/game/dashes.go: DashChem).
//
// Players who never dash cost one field test per tick and nothing on the
// wire.

// EvDashSlam (contracts/events.md 230): a flight dived into the ground.
// Within 64 m: entityId = player, targetId = dash variant, value = radius cm,
// x/y/z = where.
const EvDashSlam = 230

// dashLinger: ticks a finished dash is still followed (a dive after the
// carry lands within it).
const dashLinger = 90

type dashState struct {
	variant int
	def     *combatdefs.Dash
	spell   *combatdefs.Spell
	moving  int    // State.Dash after the last applied step
	ended   uint32 // tick the movement dash ran out (0 while it runs)
	velY    float64
	air     bool
	slam    bool
	slamAt  movement.Vec3
	hit     map[uint32]bool
	healAt  uint32
	held    int // held steps paid (tests, metrics)
	// holding: the newest dash step was a paid hold (CR 022: the casting bit,
	// so other clients see the thrust stop where it stopped).
	holding bool
}

// dashBegin: allowDash allowed and paid for this variant (spell nil for a form's dash).
func (p *Player) dashBegin(variant int, s *combatdefs.Spell) {
	d := D.DashByID(variant)
	p.dash = dashState{variant: variant, def: d, spell: s, moving: 1, hit: map[uint32]bool{}}
	if d != nil {
		p.dash.moving = d.Steps
	}
}

// dashEquipped: the running dash's spell is still in the active loadout and known.
func (p *Player) dashEquipped() bool {
	if p.dash.spell == nil {
		return false
	}
	for _, k := range p.Loadout().Spells {
		if k == p.dash.spell.Key {
			return p.Profile.Knows(k)
		}
	}
	return false
}

// sustainDash validates and pays the frame's hold (see the file comment).
func (p *Player) sustainDash(r *FrameResult, before movement.State) {
	f := &r.Frame
	p.dash.holding = false
	if f.Flags&(proto.InputFlagDodge|proto.InputFlagCast|proto.InputFlagAttack) != 0 || f.CastSlot == 0 {
		return // a dash start, a cast (castSlot = spell slot) or an attack: not a dash step
	}
	if p.dash.variant != int(f.CastSlot) || before.Dash <= 0 || p.dash.def == nil {
		f.CastSlot = 0
		return
	}
	if !movement.Holding(before, f.Flags, f.CastSlot) {
		return // a carry step: free
	}
	su := p.dash.def.Sustain
	mana, hp := su.ManaPerS/60, su.HealthPerS/60
	if !p.dashEquipped() || p.Mana < mana || (hp > 0 && p.HP-hp < 1) {
		f.CastSlot = 0
		return
	}
	p.Mana -= mana
	if hp > 0 {
		p.payBlood(hp)
	}
	p.dash.held++
	p.dash.holding = true
	r.Spent = r.Spent || mana > 0
}

// payBlood: the blood dash (phase slip) costs the dasher's own health,
// never below 1 (the only health a player spends on themselves).
func (p *Player) payBlood(hp float64) {
	p.HP -= hp
	if p.HP < 1 {
		p.HP = 1
	}
}

// noteDash follows the dash after an applied step (RecordFrame).
func (p *Player) noteDash(s movement.State) {
	d := &p.dash
	if d.variant == 0 {
		return
	}
	if d.def != nil && d.def.Trail != nil && d.def.Trail.Slam != nil && d.air && s.Mode == movement.ModeGround && d.velY < -d.def.Trail.Slam.MinFall {
		d.slam, d.slamAt = true, s.Pos
	}
	d.velY = s.Vel.Y
	d.air = s.Mode == movement.ModeAir
	d.moving = s.Dash
}

// DashTrail reports the dash this player is running (variant and its table
// row) while it moves: the game layer schedules its chemistry.
func (p *Player) DashTrail() (*combatdefs.Dash, bool) {
	d := p.dash
	if d.variant == 0 || d.def == nil || d.moving <= 0 {
		return nil, false
	}
	return d.def, true
}

// DashHeldSteps is how many held steps of the current dash were paid.
func (p *Player) DashHeldSteps() int { return p.dash.held }

// dashTick applies every running dash's trail (World.Step, once a tick).
func (w *World) dashTick() {
	for _, p := range w.playerList {
		d := &p.dash
		if d.variant == 0 {
			continue
		}
		if d.moving == 0 && d.ended == 0 {
			d.ended = max(1, w.tick)
		}
		if p.Downed || (d.ended != 0 && w.tick-d.ended > dashLinger) || (d.ended != 0 && !d.air && !d.slam) {
			p.dash = dashState{}
			continue
		}
		t := (*combatdefs.DashTrail)(nil)
		if d.def != nil {
			t = d.def.Trail
		}
		if t == nil {
			continue
		}
		element, killing := combatdefs.Physical, false
		if d.spell != nil {
			element, killing = d.spell.Element, d.spell.KillsDemons
		}
		if d.moving > 0 && t.Damage > 0 {
			for _, id := range w.order {
				e := w.enemies[id]
				if e == nil || !e.Alive() || d.hit[e.ID] || hdist(e.Pos, p.Pos) > t.Radius+e.Radius() || math.Abs(e.Pos.Y-p.Pos.Y) > 3+e.Height() {
					continue
				}
				d.hit[e.ID] = true
				dealt := w.dashHit(p, e, t.Damage, element, t.Status, killing)
				if t.Lifesteal > 0 && dealt > 0 {
					w.healPlayer(p, p, dealt*t.Lifesteal)
				}
			}
		}
		if d.moving > 0 && t.Heal > 0 && w.tick >= d.healAt {
			d.healAt = w.tick + secondsToTicks(0.5)
			for _, q := range w.playersNear(p.Pos, math.Max(t.HealRadius, 1)) {
				if q == p || (p.PartyID != 0 && q.PartyID == p.PartyID) {
					w.healPlayer(p, q, t.Heal)
				}
			}
		}
		if d.slam && t.Slam != nil {
			d.slam = false
			sl := t.Slam
			for _, id := range w.order {
				e := w.enemies[id]
				if e == nil || !e.Alive() || hdist(e.Pos, d.slamAt) > sl.Radius+e.Radius() || math.Abs(e.Pos.Y-d.slamAt.Y) > 4+e.Height() {
					continue
				}
				w.dashHit(p, e, sl.Damage, element, sl.Status, killing)
			}
			w.near(d.slamAt, 64, 0, Out{Ev: ev(EvDashSlam, p.ID, uint32(d.variant), int32(math.Round(sl.Radius*100)), d.slamAt, nil)})
		}
	}
}

// dashHit lands a dash's damage (scaled like the dasher's spells) and status on e.
func (w *World) dashHit(p *Player, e *Enemy, base float64, element int, status string, killing bool) float64 {
	dmg := base * p.Weapon().SpellPower * (1 + 0.01*float64(p.Profile.SkillLevel("spellcraft"))) * (1 + p.Gear.SpellPower/100)
	dmg *= D.DamageMult(p.Level) * D.ElementMult(element, e.Element) * e.damageTakenMult(w.tick)
	dmg = math.Max(1, math.Round(dmg))
	at := movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + e.Height(), Z: e.Pos.Z}
	dealt, _ := w.applyDamage(e, p.ID, dmg, element, at, 0, true, killing)
	if status != "" && e.Alive() {
		if def := e.applyStatus(status, p.ID, p.Pos, w.tick, (1+0.01*float64(p.Profile.SkillLevel("spellcraft")))*D.DamageMult(p.Level)); def != nil {
			if killing {
				e.markKilling(def)
			}
			w.near(e.Pos, 64, 0, Out{Ev: ev(EvStatus, p.ID, e.ID, int32(def.ID), e.Pos, []byte{byte(min(255, ticksOf(def.DurationSteps)))})})
		}
	}
	p.inCombatTick = w.tick
	return dealt
}
