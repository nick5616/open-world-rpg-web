package combat

import (
	"encoding/binary"
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Delayed charges and chain-reaction brands (playtest 2 spell mechanics,
// CR 020: a spell's `detonate` block). Both are the zone's own hits: no
// client claims them, so they cannot be faked or doubled.
//
//   - delayMs: an accepted hit plants a charge in the target; delayMs later
//     it bursts around wherever the target is (or where it died) for
//     detonate.damage within detonate.radius, applying detonate.status.
//     At most maxCharges live charges per target.
//   - onDeath: an accepted hit brands the target (statuses.<mark>, its
//     duration); a branded enemy that dies bursts a few ticks later. The
//     burst can kill other branded enemies, which burst in turn: a chain
//     reaction through a branded pack.
//
// Burst damage scales like the caster's spells (summonMult) and the
// elements; kills and XP are the caster's. Bursts hurt enemies only. Each
// burst is one Event 224 to players within 64 m.

const (
	maxCharges     = 3
	brandChainTick = 4 // ~130 ms between links of a chain reaction (readable)
)

// burst is a scheduled detonation.
type burst struct {
	at      uint32
	owner   uint32
	spell   *combatdefs.Spell
	host    uint32        // the enemy it is planted in / that died
	pos     movement.Vec3 // its last known position
	mult    float64
	killing bool
}

// brandMark is a live brand on an enemy.
type brandMark struct {
	owner   uint32
	spell   *combatdefs.Spell
	until   uint32
	mult    float64
	killing bool
}

// plantDetonation runs after an accepted hit of a spell with `detonate`.
func (w *World) plantDetonation(p *Player, a *Action, e *Enemy) {
	d := a.Spell.Detonate
	mult := summonMult(p, a)
	if d.OnDeath {
		st := D.StatusByKey(d.Mark)
		until := w.tick + ticksOf(st.DurationSteps)
		e.brand = &brandMark{owner: p.ID, spell: a.Spell, until: until, mult: mult, killing: KillsDemons(p, a)}
		e.applyStatus(d.Mark, p.ID, p.Pos, w.tick, 1)
		w.near(e.Pos, 64, 0, Out{Ev: ev(EvStatus, p.ID, e.ID, int32(st.ID), e.Pos, []byte{byte(min(255, ticksOf(st.DurationSteps)))})})
		return
	}
	n := 0
	for _, b := range w.bursts {
		if b.host == e.ID && b.spell == a.Spell {
			n++
		}
	}
	if n >= maxCharges {
		return
	}
	w.bursts = append(w.bursts, burst{at: w.tick + max(1, ticksOf(d.DelaySteps)), owner: p.ID, spell: a.Spell, host: e.ID, pos: e.Pos, mult: mult, killing: KillsDemons(p, a)})
}

// brandOnDeath schedules a dying enemy's brand burst (World.kill).
func (w *World) brandOnDeath(e *Enemy) {
	b := e.brand
	e.brand = nil
	if b == nil || w.tick > b.until {
		return
	}
	w.bursts = append(w.bursts, burst{at: w.tick + brandChainTick, owner: b.owner, spell: b.spell, host: e.ID, pos: e.Pos, mult: b.mult, killing: b.killing})
}

// stepBursts fires the bursts that are due (World.Step).
func (w *World) stepBursts() {
	if len(w.bursts) == 0 {
		return
	}
	var due []burst
	keep := w.bursts[:0]
	for _, b := range w.bursts {
		if w.tick >= b.at {
			due = append(due, b)
		} else {
			keep = append(keep, b)
		}
	}
	w.bursts = keep
	for _, b := range due {
		w.fireBurst(b)
	}
}

func (w *World) fireBurst(b burst) {
	d := b.spell.Detonate
	at := b.pos
	if h := w.enemies[b.host]; h != nil && h.Alive() {
		at = h.Pos
	}
	data := binary.LittleEndian.AppendUint16(nil, uint16(math.Min(65535, d.Radius*100)))
	w.near(at, 64, 0, Out{Ev: ev(EvDetonate, b.owner, b.host, int32(b.spell.ID), at, data)})
	owner := w.players[b.owner]
	if owner == nil {
		return
	}
	for _, id := range append([]uint32(nil), w.order...) {
		e := w.enemies[id]
		if e == nil || !e.Alive() || hdist(e.Pos, at) > d.Radius+e.Radius() || math.Abs(e.Pos.Y-at.Y) > 4 {
			continue
		}
		dmg := math.Max(1, math.Round(d.Damage*b.mult*D.ElementMult(b.spell.Element, e.Element)*e.damageTakenMult(w.tick)))
		hit := movement.Vec3{X: e.Pos.X, Y: e.Pos.Y + e.Height(), Z: e.Pos.Z}
		w.applyDamage(e, owner.ID, dmg, b.spell.Element, hit, 0, true, b.killing)
		w.toPlayer(owner.ID, Out{Ev: ev(EvDamage, owner.ID, e.ID, int32(dmg), hit, []byte{0, e.HealthPct()})})
		if d.Status != "" && e.Alive() {
			if def := e.applyStatus(d.Status, owner.ID, at, w.tick, D.DamageMult(owner.Level)); def != nil {
				w.near(e.Pos, 64, 0, Out{Ev: ev(EvStatus, owner.ID, e.ID, int32(def.ID), e.Pos, []byte{byte(min(255, ticksOf(def.DurationSteps)))})})
			}
		}
	}
	owner.inCombatTick = w.tick
}
