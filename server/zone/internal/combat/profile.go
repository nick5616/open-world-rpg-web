// Package combat is the zone's PvE combat (WP13, spec 8 and 9): weapons and
// spells validated from input frames and hit claims, enemies with AI on the
// server, camps, packs, elites and bosses with phases, party scaling, and
// player damage that only ever comes from enemies.
//
// Everything here is pure and tick-owned: no I/O, no clocks (time is the
// zone tick and the input frame seq), no goroutines. The game package feeds
// it input frames, hit claims and positions, and turns its outputs into
// entities, Events and HitResults (internal/game/combat.go). Numbers come
// from contracts/combat.yaml through server/pkg/combatdefs.
//
// PvE only (spec 2 non-goals, spec 8): there is no code path from a player's
// attack to a player's health. Claims name enemies; the only function that
// lowers a player's health is (*World).hurtPlayer, and only enemies call it.
package combat

import (
	"encoding/json"
	"slices"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
)

var D = combatdefs.D

// Loadout is one of the saved loadouts (spec 8; CR 039: two, a third from
// level 20): a weapon in the main hand, spells from the off hand (four, one
// more every ten levels up to MaxSpellSlots), the socketed gem's element
// for elemental forms and the arrows a bow fires (WP14 data hooks).
type Loadout struct {
	Weapon   string                          `json:"weapon"`
	Spells   [constants.MaxSpellSlots]string `json:"spells"` // "" = empty slot; only the first D.SpellSlots(level) are open
	Gem      int                             `json:"gem"`    // combatdefs element of the socketed gem, -1 none
	ArrowOre string                          `json:"arrowOre,omitempty"`
	ArrowGem int                             `json:"arrowGem"` // gem tip element, -1 none
	// Material is the main-hand weapon's material key (combat.yaml
	// materials; "" = ordinary). WP15: "sunsteel" kills demons. WP14 sets
	// it from the equipped item with SetMaterial.
	Material string `json:"material,omitempty"`
}

// Profile is a character's persistent combat state: loadouts, known spells
// and weapon skill XP. Stored in character_progress.skill_tree /
// spells_known / spells_equipped (spec 11) for accounts and in the same
// fields of a local profile's signed save (decision 0013).
type Profile struct {
	Loadouts [constants.MaxLoadouts]Loadout `json:"loadouts"`
	Active   int                            `json:"active"`
	Known    []string                       `json:"-"` // spells_known
	SkillXP  map[string]int64               `json:"weaponSkills"`
	// HotbarSeen (CR 039) is the character level whose hotbar unlocks (spell
	// slots, loadouts) the player was last told about: a level-up tells
	// them in the fanfare; a character saved before CR 039 above level 10
	// (HotbarSeen 0) hears it once on the next join (game.hotbarJoin).
	HotbarSeen int `json:"-"`
	dirty      bool
}

// skillTreeJSON is what skill_tree holds. v1 (before CR 039): two loadouts
// of four spells; v2: MaxLoadouts loadouts of MaxSpellSlots spells and
// hotbarSeen. A v1 row loads into the first slots and loadouts (Go arrays
// take a shorter JSON array) and is written back as v2.
type skillTreeJSON struct {
	V          int                            `json:"v"`
	Loadouts   [constants.MaxLoadouts]Loadout `json:"loadouts"`
	Active     int                            `json:"active"`
	SkillXP    map[string]int64               `json:"weaponSkills"`
	HotbarSeen int                            `json:"hotbarSeen,omitempty"`
}

// skillTreeVersion is the skill_tree layout written now (CR 039).
const skillTreeVersion = 2

// NewProfile is a new character's kit (combat.yaml `start`).
func NewProfile() *Profile {
	p := &Profile{SkillXP: map[string]int64{}, Known: slices.Clone(D.Start.Spells)}
	p.HotbarSeen = 1
	for i, l := range D.Start.Loadouts {
		if i >= constants.MaxLoadouts {
			break
		}
		lo := Loadout{Weapon: l.Weapon, Gem: -1, ArrowGem: -1, ArrowOre: "copper"}
		for k, s := range l.Spells {
			if k < constants.MaxSpellSlots && s != nil {
				lo.Spells[k] = *s
			}
		}
		p.Loadouts[i] = lo
	}
	return p
}

// MarshalSkillTree is the skill_tree jsonb value.
func (p *Profile) MarshalSkillTree() []byte {
	b, _ := json.Marshal(skillTreeJSON{V: skillTreeVersion, Loadouts: p.Loadouts, Active: p.Active, SkillXP: p.SkillXP, HotbarSeen: p.HotbarSeen})
	return b
}

// Equipped is the active loadout's spells (spells_equipped): every slot,
// open or not (a character levelled down by the dev console keeps them).
func (p *Profile) Equipped() []string { return p.Loadouts[p.Active].Spells[:] }

// SeeHotbar records that the player was told about level's hotbar unlocks;
// true when that is news (the level is past the last one told).
func (p *Profile) SeeHotbar(level int) bool {
	if level <= p.HotbarSeen {
		return false
	}
	p.HotbarSeen = level
	p.dirty = true
	return true
}

// LoadProfile rebuilds a profile from the stored columns; anything missing
// or invalid falls back to the starting kit so a bad row never blocks play.
func LoadProfile(skillTree []byte, known []string) *Profile {
	p := NewProfile()
	var st skillTreeJSON
	if len(skillTree) > 0 && json.Unmarshal(skillTree, &st) == nil && (st.V == 1 || st.V == skillTreeVersion) {
		for i := range st.Loadouts {
			if D.WeaponByKey(st.Loadouts[i].Weapon) != nil {
				p.Loadouts[i] = st.Loadouts[i]
			}
		}
		if st.Active >= 0 && st.Active < constants.MaxLoadouts {
			p.Active = st.Active
		}
		if st.SkillXP != nil {
			p.SkillXP = st.SkillXP
		}
		// CR 039 migration: a v1 row never heard about hotbar unlocks (0:
		// the next join tells a character past level 10 once).
		p.HotbarSeen = 0
		if st.V == skillTreeVersion {
			p.HotbarSeen = st.HotbarSeen
		}
	}
	for _, k := range known {
		if D.SpellByKey(k) != nil && !slices.Contains(p.Known, k) {
			p.Known = append(p.Known, k)
		}
	}
	// Never equip something the character doesn't know (a renamed or
	// removed spell, an edited row).
	for i := range p.Loadouts {
		for s := range p.Loadouts[i].Spells {
			if k := p.Loadouts[i].Spells[s]; k != "" && (!slices.Contains(p.Known, k) || !D.SpellByKey(k).Equippable()) {
				p.Loadouts[i].Spells[s] = ""
			}
		}
	}
	return p
}

// Dirty reports unsaved changes.
func (p *Profile) Dirty() bool { return p.dirty }

// MarkSaved clears the dirty flag.
func (p *Profile) MarkSaved() { p.dirty = false }

// Knows reports a learned spell or passive.
func (p *Profile) Knows(key string) bool { return slices.Contains(p.Known, key) }

// SkillPoints is how many points a character of `level` has to spend:
// two at level 1 plus one per level (spec 8: character level gives "spell
// skill points"); the starting kit is free.
func SkillPoints(level int) int { return D.SkillPointsFor(level) }

// Spent is the number of points spent on learned nodes.
func (p *Profile) Spent() int {
	n := 0
	for _, k := range p.Known {
		if !slices.Contains(D.Start.Spells, k) {
			n++
		}
	}
	return n
}

// Learn reasons.
const (
	LearnOK = iota
	LearnUnknown
	LearnKnown
	LearnPrereq
	LearnNoPoints
	LearnLevel // playtest 1: the spell's tree tier needs a higher character level (CR 012)
)

// Learn unlocks a tree node with a skill point (prereqs OR'd, as in
// wizard-wars canUnlockNode). Tomes (WP14) call Grant instead.
func (p *Profile) Learn(key string, level int) int { return p.LearnWith(key, level, 0) }

// LearnWith is Learn with extra skill points beyond the level's (playtest
// 1: tower attunement boons) and the tier gate (combat.yaml
// leveling.spellTierLevels).
func (p *Profile) LearnWith(key string, level, bonusPoints int) int {
	s := D.SpellByKey(key)
	if s == nil {
		return LearnUnknown
	}
	if p.Knows(key) {
		return LearnKnown
	}
	t := D.TreeByKey(s.Tree)
	var pre []string
	for _, n := range t.Nodes {
		if n.Key == key {
			pre = n.Prereqs
		}
	}
	if len(pre) > 0 && !slices.ContainsFunc(pre, p.Knows) {
		return LearnPrereq
	}
	if level < D.TierLevel(int(s.Tier)) {
		return LearnLevel
	}
	if p.Spent() >= SkillPoints(level)+bonusPoints {
		return LearnNoPoints
	}
	p.Known = append(p.Known, key)
	p.dirty = true
	return LearnOK
}

// Grant learns a spell without points or prereqs (tomes, bosses: the WP14
// loot hook).
func (p *Profile) Grant(key string) bool {
	if D.SpellByKey(key) == nil || p.Knows(key) {
		return false
	}
	p.Known = append(p.Known, key)
	p.dirty = true
	return true
}

// EquipSpellAt is EquipSpell for a character of level (CR 039): the slot
// and the loadout must be open at that level. The zone's Interact path.
func (p *Profile) EquipSpellAt(loadout, slot int, key string, level int) bool {
	if slot >= D.SpellSlots(level) || loadout >= D.LoadoutsOpen(level) {
		return false
	}
	return p.EquipSpell(loadout, slot, key)
}

// EquipSpell puts a known, equippable spell in a slot ("" clears it). It
// checks the layout only (MaxLoadouts x MaxSpellSlots); EquipSpellAt also
// checks what the character's level has opened.
func (p *Profile) EquipSpell(loadout, slot int, key string) bool {
	if loadout < 0 || loadout >= constants.MaxLoadouts || slot < 0 || slot >= constants.MaxSpellSlots {
		return false
	}
	if key != "" {
		s := D.SpellByKey(key)
		if s == nil || !s.Equippable() || !p.Knows(key) {
			return false
		}
		// one copy per loadout: move it rather than duplicate it
		for i, k := range p.Loadouts[loadout].Spells {
			if k == key {
				p.Loadouts[loadout].Spells[i] = ""
			}
		}
	}
	p.Loadouts[loadout].Spells[slot] = key
	p.dirty = true
	return true
}

// EquipWeapon sets a loadout's weapon. v1 has every weapon type available
// (WP14's forged weapons will gate this through the inventory).
func (p *Profile) EquipWeapon(loadout int, weapon string) bool {
	if loadout < 0 || loadout >= constants.MaxLoadouts || D.WeaponByKey(weapon) == nil {
		return false
	}
	p.Loadouts[loadout].Weapon = weapon
	p.dirty = true
	return true
}

// SetGem sets the element of the gem socketed in a loadout's weapon (WP14
// sockets call this; -1 removes it).
func (p *Profile) SetGem(loadout, element int) bool {
	if loadout < 0 || loadout >= constants.MaxLoadouts || element < -1 || element >= combatdefs.Physical {
		return false
	}
	p.Loadouts[loadout].Gem = element
	p.dirty = true
	return true
}

// SetMaterial sets the material of a loadout's weapon (WP15, CR 011): a
// combat.yaml materials key, or "" for an ordinary weapon. WP14 calls it
// when a forged weapon is equipped (a sunsteel blade -> "sunsteel"); dev
// builds also reach it through Interact 50 action 6.
func (p *Profile) SetMaterial(loadout int, key string) bool {
	if loadout < 0 || loadout >= constants.MaxLoadouts || (key != "" && D.MaterialByKey(key) == nil) {
		return false
	}
	p.Loadouts[loadout].Material = key
	p.dirty = true
	return true
}

// SwapAt is Swap for a character of level (CR 039): the third loadout
// opens at combat.yaml leveling.hotbar.loadoutLevels[2].
func (p *Profile) SwapAt(i, level int) bool {
	if i >= D.LoadoutsOpen(level) {
		return false
	}
	return p.Swap(i)
}

// Swap switches the active loadout (instant, spec 8).
func (p *Profile) Swap(i int) bool {
	if i < 0 || i >= constants.MaxLoadouts {
		return false
	}
	if p.Active != i {
		p.Active = i
		p.dirty = true
	}
	return true
}

// SkillLevel is the level of a skill track.
func (p *Profile) SkillLevel(skill string) int { return D.SkillLevel(p.SkillXP[skill]) }

// AddSkillXP grows a skill by use; returns the new level when it went up.
func (p *Profile) AddSkillXP(skill string, xp int64) (int, bool) {
	before := p.SkillLevel(skill)
	p.SkillXP[skill] += xp
	p.dirty = true
	after := p.SkillLevel(skill)
	return after, after > before
}
