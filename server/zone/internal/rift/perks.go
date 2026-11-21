package rift

// Run perks (CR 040): after some stages each player picks one of three
// boons that last until the run ends. Original names, proposals.

// Perk is one boon.
type Perk struct {
	Key  string
	Name string
	Text string
	Max  int // how many times it can be taken
}

// Perks, in id order (the wire sends the index + 1).
var Perks = []Perk{
	{"keen_edge", "Keen Edge", "+18% damage", 3},
	{"deep_breath", "Deep Breath", "+25% max health, and heal a quarter now", 2},
	{"mending_door", "Mending Door", "Heal 15% of your health whenever a room is cleared", 2},
	{"slip_frame", "Slip Frame", "You are harder to hit: your hit circle shrinks by a quarter", 1},
	{"lull", "Lull", "Every shot in the rift flies 10% slower (your whole party)", 2},
	{"second_wind", "Second Wind", "Once: a blow that would drop you leaves you standing at 40%", 1},
	{"graze_spark", "Graze Spark", "A shot that passes close without hitting gives you 3 mana", 1},
	{"ward_shard", "Ward Shard", "Each room you enter, a ward eats the first shot that hits you", 1},
	{"fortune_thread", "Fortune Thread", "Better loot: +30% luck on every rift roll", 2},
	{"gem_sense", "Gem Sense", "Gem rooms and gem drops give one more gem each", 2},
	{"long_breath", "Long Breath", "After a hit, shots pass through you for longer (1.1 s instead of 0.7 s)", 1},
	{"glass_fury", "Glass Fury", "+40% damage, but -20% max health", 1},
}

// PerkIndex finds a perk by key (-1).
func PerkIndex(k string) int {
	for i := range Perks {
		if Perks[i].Key == k {
			return i
		}
	}
	return -1
}

// Offer picks three distinct perks a player can still take after stage s
// (seeded by the run, the stage and the player's place in the party).
func Offer(seed uint32, s, member int, have map[string]int) []int {
	var pool []int
	for i, p := range Perks {
		if have[p.Key] < p.Max {
			pool = append(pool, i)
		}
	}
	out := make([]int, 0, 3)
	for k := 0; len(pool) > 0 && len(out) < 3; k++ {
		j := int(Hash(seed, uint32(s), uint32(member), uint32(k), 0x9e7) % uint32(len(pool)))
		out = append(out, pool[j])
		pool = append(pool[:j], pool[j+1:]...)
	}
	return out
}

// Mods are what a player's perks add up to.
type Mods struct {
	DamageMult  float64 // x weapon and spell damage
	HealthMult  float64 // x max health
	HealOnClear float64 // fraction of max health
	HitScale    float64 // x hit radius
	BulletSlow  float64 // fraction slower (party-wide: the run takes the largest)
	SecondWind  bool
	Graze       bool
	Ward        bool
	Luck        float64 // added to rift loot luck (fraction)
	Gems        int
	GraceS      float64
}

// ModsOf adds up a perk set.
func ModsOf(have map[string]int) Mods {
	m := Mods{DamageMult: 1, HealthMult: 1, HitScale: 1, GraceS: HitGraceS}
	m.DamageMult *= 1 + 0.18*float64(have["keen_edge"])
	m.HealthMult *= 1 + 0.25*float64(have["deep_breath"])
	m.HealOnClear = 0.15 * float64(have["mending_door"])
	if have["slip_frame"] > 0 {
		m.HitScale = 0.75
	}
	m.BulletSlow = 0.1 * float64(have["lull"])
	m.SecondWind = have["second_wind"] > 0
	m.Graze = have["graze_spark"] > 0
	m.Ward = have["ward_shard"] > 0
	m.Luck = 0.3 * float64(have["fortune_thread"])
	m.Gems = have["gem_sense"]
	if have["long_breath"] > 0 {
		m.GraceS = 1.1
	}
	if have["glass_fury"] > 0 {
		m.DamageMult *= 1.4
		m.HealthMult *= 0.8
	}
	return m
}
