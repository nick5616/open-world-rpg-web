package combat

import (
	"math"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/movement"
)

// Playtest 2 weather (CR 030): lightning is the one environmental source of
// damage to players. The zone (internal/game/weather.go) decides where a
// bolt lands and calls these; nobody is credited.

// HurtByWeather lowers a player's health by a lightning bolt (armor and
// shields apply; a respawn grace protects). Returns the damage dealt.
func (w *World) HurtByWeather(p *Player, dmg float64) float64 {
	if p == nil || p.Downed || p.Graced(w.tick) {
		return 0
	}
	dmg, _ = w.mitigate(p, dmg)
	dmg = math.Round(dmg)
	if dmg <= 0 {
		return 0
	}
	p.HP -= dmg
	p.lastHurtTick = w.tick
	w.Stats.PlayerHits++
	if p.HP <= 0 {
		w.downPlayer(p, 0)
	}
	return dmg
}

// EnemiesNear lists living enemies within r of (x, z) (id order).
func (w *World) EnemiesNear(x, z, r float64) []*Enemy {
	var out []*Enemy
	for _, e := range w.enemies {
		if e.Alive() && math.Hypot(e.Pos.X-x, e.Pos.Z-z) <= r {
			out = append(out, e)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// StrikeEnemy deals lightning damage to an enemy (no player credit; demons
// shrug it off like any ordinary damage).
func (w *World) StrikeEnemy(e *Enemy, dmg float64, at movement.Vec3) float64 {
	d, _ := w.applyDamage(e, 0, dmg, combatdefs.Lightning, at, 0, true, false)
	return d
}
