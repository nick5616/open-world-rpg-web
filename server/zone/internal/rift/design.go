package rift

// The volleys each archetype fires and the numbers a stage runs on
// (tuned by playing the harness: docs/cr/040-rift-runs.md "Tuning").

import "math"

// Tuning, depth 0 -> 1 (Depth).
const (
	speedRamp   = 0.35 // bullets up to 35 % faster
	cadenceRamp = 0.30 // volleys up to 30 % more often
	hpRamp      = 1.1  // enemies up to 2.1x health
	// HitGraceS: after a hit, bullets pass through you this long (no
	// shredding by a dense ring).
	HitGraceS = 0.7
	// IntroS: a new room fires nothing for this long.
	IntroS = 1.6
)

// Aim is what an enemy aims at: the nearest player's position (arena-local).
type Aim struct{ X, Z float64 }

// Design makes enemy e's next volley at tick now. target is the nearest
// living player; phase is a boss's phase (0 normal). The volley is
// quantized to wire precision.
func Design(kind int, ex, ez float64, tgt Aim, ch *Chapter, stage int, depth float64, now uint32, n uint32, seed uint32, boss int, phase int) Volley {
	f := depth
	sp := 1 + speedRamp*f
	if boss > 0 {
		sp *= 1 + 0.05*float64(phase)
	}
	aim := math.Atan2(tgt.Z-ez, tgt.X-ex)
	h := Hash(seed, n, uint32(stage))
	v := Volley{Kind: kind, OX: ex, OZ: ez, Windup: 650, Radius: 0.3, Life: 8, Seed: h}
	switch kind {
	case KindRing:
		v.Count = 9 + int(4*f) + 2*phase
		v.Radius = 0.28
		v.Speed = 3.4 * sp
		// alternate half a step so the gaps move between volleys
		v.Angle = aim + float64(n%2)*math.Pi/float64(v.Count)
	case KindSpiral:
		v.P3 = 2
		if f > 0.45 || boss > 0 {
			v.P3 = 3
		}
		per := 9 + int(5*f)
		v.Count = per * v.P3
		v.P1 = 170 - int(40*f)
		dir := 1
		if n%2 == 1 {
			dir = -1
		}
		v.P2 = dir * (9000 + int(4000*f)) // milli-degrees per shot
		v.Speed = 3.0 * sp
		v.Angle = Unit(h) * 2 * math.Pi
	case KindFan:
		v.Count = 5 + 2*int(math.Round(f*1.5))
		v.P1 = 500 + int(150*f) // 50-65 degrees
		v.P2 = 2 + int(math.Round(f))
		v.P3 = 320
		v.Speed = 4.2 * sp
		v.Angle = aim
		v.Windup = 600
	case KindWall:
		v.Count = 14
		v.P1 = 150 // cm apart: a wall across the room
		v.P2 = int(h%uint32(v.Count-2)) + 1
		v.Speed = 2.6 * sp
		v.Angle = math.Pi / 2 // toward the entrance
		v.OX = 0
		v.Windup = 800
		v.Radius = 0.34
	case KindBounce:
		v.Count = 3 + int(2*f)
		v.P1 = 3
		v.Speed = 4.0 * sp
		v.Radius = 0.38
		v.Angle = aim + Unit(h)*0.6
		v.Life = 7
	case KindLaser:
		v.Windup = 950
		v.P1 = 70
		v.P2 = 1100
		if f > 0.3 || boss > 0 {
			sweep := 22000 + int(14000*f)
			if n%2 == 1 {
				sweep = -sweep
			}
			v.P3 = sweep
			v.Angle = aim - float64(sweep)*math.Pi/180000*0.55 // the sweep crosses the target halfway
		} else {
			v.Angle = aim
		}
		v.Count = 1
	case KindSeeker:
		v.Count = 2 + int(math.Round(f))
		v.P1 = 70
		v.Speed = 2.3 * (1 + 0.2*f)
		v.Radius = 0.36
		v.Angle = aim
		v.Life = 6
	case KindRain:
		v.Count = 6 + int(6*f)
		v.P1 = 1100 // telegraph before each lands
		v.P2 = 130  // impact radius cm
		v.P3 = 260
		v.Windup = 500
		v.Life = 1
	}
	if boss > 0 {
		v.Radius += 0.04 // bigger, brighter, slower-turning
	}
	v.Fire = now + uint32(math.Round(float64(v.Windup)/1000*TickHz))
	v.Quantize()
	return v
}

// Cadence is the seconds between an archetype's volleys at depth f.
func Cadence(every, f float64) float64 { return every * (1 - cadenceRamp*f) }

// BossKinds is the pattern rotation of a boss: its own archetype's kind,
// rings and fans, the chapter's signature, and (phase 2+) rain.
func BossKinds(arch *Archetype, ch *Chapter, boss, phase int) []int {
	ks := []int{arch.Kind, KindRing, KindFan, ch.Special}
	if boss == 3 {
		ks = []int{KindRing, KindBounce, KindFan} // the gem golem throws shards
	}
	if phase >= 1 {
		ks = append(ks, KindSpiral)
	}
	if phase >= 2 {
		ks = append(ks, KindRain, KindLaser)
	}
	return ks
}

// Damage is one hit of a kind on a player, at the run's level and depth.
func Damage(kind, level int, depth float64, boss int) float64 {
	d := (6 + 1.3*float64(level)) * (1 + 0.5*depth)
	switch kind {
	case KindLaser:
		d *= 1.5
	case KindRain:
		d *= 1.4
	case 0: // spikes
		d *= 0.8
	}
	if boss > 0 {
		d *= 1.25
	}
	return math.Round(d)
}

// EnemyHP is a rift enemy's health for a party of n at the run's level.
func EnemyHP(a *Archetype, level, n int, depth float64, boss int) float64 {
	hp := 70 * (1 + 0.1*float64(level-1)) * a.HP * (1 + hpRamp*depth)
	switch boss {
	case 1:
		hp *= 9
	case 2:
		hp *= 22
	case 3:
		hp *= 7
	}
	return math.Round(hp * PartyScale(n))
}

// PartyScale is enemy health for a party of n (+60 % per extra player).
func PartyScale(n int) float64 { return 1 + 0.6*float64(max(1, n)-1) }

// BossPhase is a boss's phase by its health fraction.
func BossPhase(frac float64) int {
	switch {
	case frac <= 0.3:
		return 2
	case frac <= 0.6:
		return 1
	}
	return 0
}

// ---- loot ----

// LootOdds is what clearing stage s gives each player: the chance of a
// rolled item, its luck (rarity odds; items.RollEquipment), the lowest
// rarity it may be, and the gold into the spoils.
type LootOdds struct {
	Chance    float64
	Luck      float64
	MinRarity int
	Gold      int
	Items     int // guaranteed items (chests)
	Gems      int
}

// Loot is the reward for clearing stage s (of a kind) at level.
func Loot(chapter, s, kind, level int) LootOdds {
	d := float64(s)
	o := LootOdds{Chance: math.Min(0.85, 0.3+0.012*d), Luck: 1.2 + 0.07*d + 0.15*float64(chapter-1), Gold: int(math.Round((6 + 2*float64(level)) * (1 + d/12)))}
	switch {
	case s >= 35:
		o.MinRarity = 2 // rare+
	case s >= 15:
		o.MinRarity = 1 // uncommon+
	}
	switch kind {
	case StageMiniBoss:
		o.Items, o.Chance, o.Gems = 2, 0, 3
		o.MinRarity = max(o.MinRarity, 2)
		if s >= 30 {
			o.MinRarity = 3 // relic+
		}
		o.Gold *= 4
	case StageBoss:
		o.Items, o.Chance, o.Gems = 3, 0, 6
		o.MinRarity = 4 // legendary+
		o.Gold *= 10
	case StageGemVault, StageGemShower:
		o.Gems = 2 + s/12
	case StageGemGolem:
		o.Items, o.Chance, o.Gems = 1, 0, 6+s/10 // the golem's heart: a weapon with every socket
		o.MinRarity = max(o.MinRarity, 2)
	}
	return o
}
