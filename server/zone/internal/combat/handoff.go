package combat

// WP16 handoff: a player's combat state moving to another zone process
// (server/zone/internal/game/handoff.go). Timers kept in input seqs
// (cooldowns, attack/dash windows) carry over as they are, because the input
// seq continues on the new zone; timers kept in zone ticks (shield, heal over
// time, respawn, combat/drink clocks) carry over as time remaining, because
// each zone has its own tick counter. The action log and the frame ring
// (strike grace window, 250 ms) are not carried: a hit claim racing the
// switch is refused as stale, which favors nobody.

import "encoding/json"

// PlayerHandoff is the transferable part of a Player.
type PlayerHandoff struct {
	SkillTree  json.RawMessage `json:"skillTree"`
	Known      []string        `json:"known"`
	Dirty      bool            `json:"dirty,omitempty"`
	HP         float64         `json:"hp"`
	Mana       float64         `json:"mana"`
	Charges    int             `json:"charges"`
	Downed     bool            `json:"downed,omitempty"`
	ReadyAt    map[int]uint32  `json:"readyAt,omitempty"` // input seq each cooldown ends
	NextSeq    uint32          `json:"nextSeq,omitempty"`
	ActiveEnd  uint32          `json:"activeEnd,omitempty"`
	DodgeSeq   uint32          `json:"dodgeSeq,omitempty"`
	ParryEnd   uint32          `json:"parryEnd,omitempty"`
	Riposte    bool            `json:"riposte,omitempty"`
	AirTop     float64         `json:"airTop,omitempty"`
	WasAir     bool            `json:"wasAir,omitempty"`
	Shield     float64         `json:"shield,omitempty"`
	ShieldLeft uint32          `json:"shieldLeft,omitempty"` // ticks
	HotPerTick float64         `json:"hotPerTick,omitempty"`
	HotLeft    uint32          `json:"hotLeft,omitempty"`
	RespawnIn  uint32          `json:"respawnIn,omitempty"`
	HurtAgo    uint32          `json:"hurtAgo,omitempty"`
	CombatAgo  uint32          `json:"combatAgo,omitempty"`
	DrinkAgo   uint32          `json:"drinkAgo,omitempty"`
}

func left(end, now uint32) uint32 {
	if end > now {
		return end - now
	}
	return 0
}

func ago(at, now uint32) uint32 {
	if at == 0 || at > now {
		return 0
	}
	return now - at
}

// Export snapshots p at zone tick now.
func (p *Player) Export(now uint32) PlayerHandoff {
	h := PlayerHandoff{
		Known: append([]string(nil), p.Profile.Known...), Dirty: p.Profile.dirty,
		HP: p.HP, Mana: p.Mana, Charges: p.Charges, Downed: p.Downed,
		NextSeq: p.nextSeq, ActiveEnd: p.activeEnd, DodgeSeq: p.dodgeSeq, ParryEnd: p.parryEnd, Riposte: p.riposte,
		AirTop: p.airTop, WasAir: p.wasAir,
		Shield: p.shield, ShieldLeft: left(p.shieldEnd, now), HotPerTick: p.hotPerTick, HotLeft: left(p.hotEnd, now),
		RespawnIn: left(p.respawnTick, now), HurtAgo: ago(p.lastHurtTick, now), CombatAgo: ago(p.inCombatTick, now), DrinkAgo: ago(p.drinkTick, now),
	}
	h.SkillTree = p.Profile.MarshalSkillTree()
	if len(p.readyAt) > 0 {
		h.ReadyAt = make(map[int]uint32, len(p.readyAt))
		for k, v := range p.readyAt {
			h.ReadyAt[k] = v
		}
	}
	return h
}

// Profile rebuilds the persistent profile from a handoff.
func (h PlayerHandoff) Profile() *Profile {
	prof := LoadProfile(h.SkillTree, h.Known)
	prof.dirty = h.Dirty
	return prof
}

// Restore applies a handoff to a freshly built Player (same profile) at
// the new zone's tick now.
func (p *Player) Restore(h PlayerHandoff, now uint32) {
	p.HP, p.Mana, p.Charges, p.Downed = min(h.HP, p.HPMax), min(h.Mana, p.ManaMax), h.Charges, h.Downed
	p.readyAt = map[int]uint32{}
	for k, v := range h.ReadyAt {
		p.readyAt[k] = v
	}
	p.nextSeq, p.activeEnd, p.dodgeSeq, p.parryEnd, p.riposte = h.NextSeq, h.ActiveEnd, h.DodgeSeq, h.ParryEnd, h.Riposte
	p.airTop, p.wasAir = h.AirTop, h.WasAir
	p.shield, p.hotPerTick = h.Shield, h.HotPerTick
	at := func(d uint32) uint32 {
		if d == 0 {
			return 0
		}
		return now + d
	}
	back := func(d uint32) uint32 {
		if d == 0 || d > now {
			return 0
		}
		return now - d
	}
	p.shieldEnd, p.hotEnd, p.respawnTick = at(h.ShieldLeft), at(h.HotLeft), at(h.RespawnIn)
	p.lastHurtTick, p.inCombatTick, p.drinkTick = back(h.HurtAgo), back(h.CombatAgo), back(h.DrinkAgo)
	p.manaSent = -1
}
