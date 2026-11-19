package combat

// Rift runs (playtest 2, CR 040; the run is internal/rift, the glue
// internal/game/rift.go). A rift's enemies are ordinary combat enemies, so
// every weapon, spell, status and claim works on them, but they stand on a
// floor high above the world (no ground snap), never move or attack by
// themselves (the run moves them and fires their patterns) and keep the
// health the run gives them (no party scaling: the run scales by party).
// The run's shots hurt players through HurtPlayerRift.

import (
	"math"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
)

// RiftEnemy places one rift body of enemy key at exactly pos with hp
// health; elite gives it the elite aura (and nothing else).
func (w *World) RiftEnemy(pos movement.Vec3, key string, level int, elite bool, hp float64) *Enemy {
	if D.EnemyByKey(key) == nil {
		return nil
	}
	affix := ""
	if elite {
		affix = "fast"
	}
	g := w.AddGroup(&Group{Kind: GroupTest, Anchor: pos, Radius: 1, Comp: []string{key}, Level: max(1, level), Site: -1, Elite: affix, Element: 8, Dummy: true, Rift: true})
	w.SpawnNow(g)
	if len(g.Members) == 0 {
		return nil
	}
	e := g.Members[0]
	e.Pos, e.Home, e.Vel = pos, pos, movement.Vec3{}
	e.baseHP, e.HPMax, e.HP = hp, hp, hp
	e.Shield, e.ShieldMax = 0, 0
	e.scaleN = constants.PartyScaleMax // the run scaled it already
	e.record(w.tick)
	return e
}

// PlaceEnemy puts e at exactly pos (a rift body drifting on its floor).
func (w *World) PlaceEnemy(e *Enemy, pos movement.Vec3) {
	if e == nil {
		return
	}
	e.Pos, e.Home, e.Vel = pos, pos, movement.Vec3{}
	e.record(w.tick)
}

// RemoveRiftEnemy takes a rift body (dead or alive) out for good.
func (w *World) RemoveRiftEnemy(e *Enemy) {
	if e == nil {
		return
	}
	if g := e.Group; g != nil {
		w.RetireGroup(g)
		return
	}
	w.removeEnemy(e)
}

// HurtPlayerRift deals a rift shot's damage to player id (armor, shields
// and god mode apply). True when it downed them.
func (w *World) HurtPlayerRift(id uint32, dmg float64) bool {
	p := w.players[id]
	if p == nil || p.Downed {
		return false
	}
	dmg, _ = w.mitigate(p, dmg)
	dmg = math.Round(dmg)
	p.lastHurtTick = w.tick
	p.inCombatTick = w.tick
	w.Stats.PlayerHits++
	if dmg <= 0 {
		return false
	}
	p.HP -= dmg
	w.toPlayer(p.ID, Out{Ev: ev(EvPlayerHurt, p.ID, 0, int32(dmg), p.Pos, []byte{0})})
	if p.HP <= 0 {
		w.downPlayer(p, 0)
		return true
	}
	return false
}

// PlayerHP is a player's health and max health (0, 0 when unknown).
func (w *World) PlayerHP(id uint32) (float64, float64) {
	if p := w.players[id]; p != nil {
		return p.HP, p.HPMax
	}
	return 0, 0
}

// HealPlayer heals a player (not a downed one) by amount.
func (w *World) HealPlayer(id uint32, amount float64) {
	if p := w.players[id]; p != nil && !p.Downed && amount > 0 {
		p.HP = math.Min(p.HPMax, p.HP+amount)
	}
}

// AddMana gives a player mana (a rift graze).
func (w *World) AddMana(id uint32, amount float64) {
	if p := w.players[id]; p != nil {
		p.Mana = math.Min(p.ManaMax, p.Mana+amount)
	}
}

// RiftMods are a player's run perks on their damage and health (1, 1 when
// not in a run).
type RiftMods struct {
	DamageMult float64
	HealthMult float64
}

// SetRiftMods applies run perks (health max follows, keeping the fraction).
func (p *Player) SetRiftMods(m RiftMods) {
	if p.Rift == m {
		return
	}
	p.Rift = m
	p.SetLevel(p.Level)
}
