package combat

// Playtest 2 dev console (docs/cr/032-dev-console.md): what the zone's dev
// commands change in a player's combat state. Only the game package's dev
// console (internal/game/devconsole.go) calls these, and only on a zone
// started with LODESTONE_ZONE_DEV=1.

import (
	"slices"
)

// DevClearCooldowns forgets every spell, form and technique cooldown (the
// console's "no cooldowns", applied every tick).
func (p *Player) DevClearCooldowns() { clear(p.readyAt) }

// DevForget unlearns a spell (and takes it out of both loadouts); false if
// it was not known.
func (p *Profile) DevForget(key string) bool {
	i := slices.Index(p.Known, key)
	if i < 0 {
		return false
	}
	p.Known = slices.Delete(p.Known, i, i+1)
	for l := range p.Loadouts {
		for s, k := range p.Loadouts[l].Spells {
			if k == key {
				p.Loadouts[l].Spells[s] = ""
			}
		}
	}
	p.dirty = true
	return true
}

// DevForgetAll unlearns everything but the starting kit; returns how many.
func (p *Profile) DevForgetAll() int {
	n := 0
	for _, k := range slices.Clone(p.Known) {
		if !slices.Contains(D.Start.Spells, k) && p.DevForget(k) {
			n++
		}
	}
	return n
}

// DevSetSkillXP sets a weapon/craft skill track's XP.
func (p *Profile) DevSetSkillXP(skill string, xp int64) {
	if p.SkillXP == nil {
		p.SkillXP = map[string]int64{}
	}
	p.SkillXP[skill] = max(0, xp)
	p.dirty = true
}

// DevReset puts the profile back to a new character's kit (in place: the
// player and the session share this pointer).
func (p *Profile) DevReset() {
	*p = *NewProfile()
	p.dirty = true
}
