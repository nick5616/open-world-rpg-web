// Package combatdefs is the Go view of contracts/combat.yaml (WP13, CR 009):
// weapons and their moves, spells and trees, elemental forms, dash variants,
// enemies, enemy attacks, bosses, affixes and spawn tables. `npm run gen`
// normalizes the YAML into combat_gen.json (embedded here) and into the
// client's contracts/ts/src/gen/combat.ts from the same object, so the zone
// and the client always read identical numbers. Nothing here is hand-tuned:
// change the YAML and regenerate.
package combatdefs

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
)

//go:embed combat_gen.json
var raw []byte

// Element indices follow worldgen (0 fire .. 7 void); Physical is 8.
const (
	Fire = iota
	Ice
	Lightning
	Earth
	Wind
	Light
	Dark
	Void
	Physical
)

// Status is one enemy status effect.
type Status struct {
	Key           string  `json:"key"`
	ID            int     `json:"id"`
	DurationSteps int     `json:"durationSteps"`
	TickSteps     int     `json:"tickSteps"`
	TickDamage    float64 `json:"tickDamage"`
	MaxStacks     int     `json:"maxStacks"`
	SpeedMult     float64 `json:"speedMult"`
	DamageMult    float64 `json:"damageMult"`
	BreakOnDamage bool    `json:"breakOnDamage"`
}

// Technique is a skill unlock (every 10 levels).
type Technique struct {
	Level int    `json:"level"`
	Key   string `json:"key"`
	Name  string `json:"name"`
}

// Skill is a use-based skill track.
type Skill struct {
	Key        string      `json:"key"`
	ID         int         `json:"id"`
	Techniques []Technique `json:"techniques"`
}

// Move is one weapon move (HitClaim.attackId).
type Move struct {
	Key           string  `json:"key"`
	ID            int     `json:"id"`
	Weapon        string  `json:"weapon"`
	Kind          string  `json:"kind"`
	Combo         int     `json:"combo"`
	StartupSteps  int     `json:"startupSteps"`
	ActiveSteps   int     `json:"activeSteps"`
	RecoverySteps int     `json:"recoverySteps"`
	Damage        float64 `json:"damage"`
	Reach         float64 `json:"reach"`
	Arc           float64 `json:"arc"`
	Hits          int     `json:"hits"`
	Speed         float64 `json:"speed"`
	Gravity       float64 `json:"gravity"`
	Radius        float64 `json:"radius"`
	ChargeSteps   int     `json:"chargeSteps"`
	ChargeMult    float64 `json:"chargeMult"`
	ChargeSpeed   float64 `json:"chargeSpeed"`
	PerMeter      float64 `json:"perMeter"`
	MaxBonus      float64 `json:"maxBonus"`
	Technique     string  `json:"technique"`
	CooldownSteps int     `json:"cooldownSteps"`
}

// Ranged reports a projectile move (bow, bolts).
func (m *Move) Ranged() bool { return m.Speed > 0 }

// Arrow is an arrowhead ore (WP14 data hook).
type Arrow struct {
	Key          string  `json:"key"`
	Mult         float64 `json:"mult"`
	DemonStagger bool    `json:"demonStagger"`
	KillsDemons  bool    `json:"killsDemons"`
}

// Weapon is one weapon type.
type Weapon struct {
	Key          string   `json:"key"`
	ID           int      `json:"id"`
	Skill        string   `json:"skill"`
	SpellPower   float64  `json:"spellPower"`
	ManaRegen    float64  `json:"manaRegen"`
	CooldownMult float64  `json:"cooldownMult"`
	Moves        []string `json:"moves"`
	ParrySteps   int      `json:"parrySteps"`
	Arrows       []Arrow  `json:"arrows"`
}

// Form is an elemental form (weapon technique by gem element).
type Form struct {
	Key           string  `json:"key"`
	ID            int     `json:"id"`
	Element       int     `json:"element"`
	Name          string  `json:"name"`
	Shape         string  `json:"shape"`
	Radius        float64 `json:"radius"`
	Reach         float64 `json:"reach"`
	Arc           float64 `json:"arc"`
	Width         float64 `json:"width"`
	Chain         int     `json:"chain"`
	Lifesteal     float64 `json:"lifesteal"`
	DemonMult     float64 `json:"demonMult"`
	Dash          int     `json:"dash"`
	SelfCast      bool    `json:"selfCast"`
	Damage        float64 `json:"damage"`
	Status        string  `json:"status"`
	CooldownSteps int     `json:"cooldownSteps"`
	Stamina       float64 `json:"stamina"`
}

// Dash is a movement variant of the shared dodge step (id 1..15).
type Dash struct {
	Key     string  `json:"key"`
	ID      int     `json:"id"`
	Speed   float64 `json:"speed"`
	Steps   int     `json:"steps"`
	IFrames int     `json:"iframes"`
	Lift    float64 `json:"lift"`
}

// Rate is a status-conditional multiplier.
type Rate struct {
	Status string  `json:"status"`
	Below  float64 `json:"below"`
	Mult   float64 `json:"mult"`
}

// Spell is one spell, passive included.
type Spell struct {
	Key            string         `json:"key"`
	ID             int            `json:"id"`
	Name           string         `json:"name"`
	Pending        bool           `json:"pending"`
	Tree           string         `json:"tree"`
	Tier           float64        `json:"tier"`
	Type           string         `json:"type"`
	Element        int            `json:"element"`
	Damage         float64        `json:"damage"`
	CooldownSteps  int            `json:"cooldownSteps"`
	WindupSteps    int            `json:"windupSteps"`
	DurationSteps  int            `json:"durationSteps"`
	ArmSteps       int            `json:"armSteps"`
	Radius         float64        `json:"radius"`
	Range          float64        `json:"range"`
	Speed          float64        `json:"speed"`
	Gravity        float64        `json:"gravity"`
	Hits           int            `json:"hits"`
	Spread         int            `json:"spread"`
	Cone           float64        `json:"cone"`
	Line           float64        `json:"line"`
	Chain          int            `json:"chain"`
	Lifesteal      float64        `json:"lifesteal"`
	Heal           float64        `json:"heal"`
	HealRadius     float64        `json:"healRadius"`
	Absorb         float64        `json:"absorb"`
	Pierce         bool           `json:"pierce"`
	SelfCast       bool           `json:"selfCast"`
	NonBossOnly    bool           `json:"nonBossOnly"`
	StripShield    bool           `json:"stripShield"`
	Mana           float64        `json:"mana"`
	Dash           int            `json:"dash"`
	Status         string         `json:"status"`
	RequiresStatus string         `json:"requiresStatus"`
	BossDamage     float64        `json:"bossDamage"`
	VsStatus       *Rate          `json:"vsStatus"`
	LowTargetHP    *Rate          `json:"lowTargetHp"`
	Effect         map[string]any `json:"effect"`
}

// Equippable reports a spell that goes in one of the four slots.
func (s *Spell) Equippable() bool { return s.Type != "passive" }

// Node is one spell tree node.
type Node struct {
	Key     string   `json:"key"`
	Prereqs []string `json:"prereqs"`
}

// Tree is one spell tree.
type Tree struct {
	Key     string `json:"key"`
	Element int    `json:"element"`
	Nodes   []Node `json:"nodes"`
}

// EnemyAttack is one enemy attack (always telegraphed 300-600 ms).
type EnemyAttack struct {
	Key           string  `json:"key"`
	ID            int     `json:"id"`
	Shape         string  `json:"shape"`
	Element       int     `json:"element"`
	WindupSteps   int     `json:"windupSteps"`
	ActiveSteps   int     `json:"activeSteps"`
	RecoverySteps int     `json:"recoverySteps"`
	CooldownSteps int     `json:"cooldownSteps"`
	Damage        float64 `json:"damage"`
	Radius        float64 `json:"radius"`
	Reach         float64 `json:"reach"`
	Arc           float64 `json:"arc"`
	Width         float64 `json:"width"`
	Speed         float64 `json:"speed"`
	MinRange      float64 `json:"minRange"`
	Volley        int     `json:"volley"`
	SpreadDeg     float64 `json:"spreadDeg"`
	Charge        bool    `json:"charge"`
	Everyone      bool    `json:"everyone"`
}

// Range is how far away the attack can be started from.
func (a *EnemyAttack) Range() float64 {
	switch a.Shape {
	case "circle":
		return a.Radius * 0.8
	case "cone":
		return a.Reach * 0.9
	case "line":
		return a.Reach * 0.9
	}
	return a.Reach
}

// Enemy is one enemy type.
type Enemy struct {
	Key      string   `json:"key"`
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	Family   string   `json:"family"`
	HP       float64  `json:"hp"`
	Speed    float64  `json:"speed"`
	Aggro    float64  `json:"aggro"`
	Attacks  []string `json:"attacks"`
	Behavior string   `json:"behavior"`
	KeepAway float64  `json:"keepAway"`
	Element  int      `json:"element"`
	XP       float64  `json:"xp"`
	Size     float64  `json:"size"`
	Color    string   `json:"color"`
}

// BossPhase is one boss phase.
type BossPhase struct {
	At           float64  `json:"at"`
	Attacks      []string `json:"attacks"`
	Adds         int      `json:"adds"`
	SpeedMult    float64  `json:"speedMult"`
	CooldownMult float64  `json:"cooldownMult"`
}

// Boss is a boss's phase script.
type Boss struct {
	Key             string      `json:"key"`
	TransitionSteps int         `json:"transitionSteps"`
	ArenaRadius     float64     `json:"arenaRadius"`
	Phases          []BossPhase `json:"phases"`
}

// Affix is an elite affix.
type Affix struct {
	Key              string  `json:"key"`
	ID               int     `json:"id"`
	HPMult           float64 `json:"hpMult"`
	DamageMult       float64 `json:"damageMult"`
	SpeedMult        float64 `json:"speedMult"`
	CooldownMult     float64 `json:"cooldownMult"`
	ShieldPct        float64 `json:"shieldPct"`
	ShieldRegenSteps int     `json:"shieldRegenSteps"`
	SplitInto        int     `json:"splitInto"`
	SplitHPPct       float64 `json:"splitHpPct"`
}

// DepthBand is a cave depth band's table modifier.
type DepthBand struct {
	Extra       []string `json:"extra"`
	LevelBonus  int      `json:"levelBonus"`
	EliteChance float64  `json:"eliteChance"`
}

// Loadout is a start loadout.
type Loadout struct {
	Weapon string    `json:"weapon"`
	Spells []*string `json:"spells"`
}

// Defs is the whole table set.
type Defs struct {
	Version       int      `json:"version"`
	StepHz        int      `json:"stepHz"`
	Elements      []string `json:"elements"`
	Effectiveness struct {
		Strong  float64          `json:"strong"`
		Resist  float64          `json:"resist"`
		VoidAll float64          `json:"voidAll"`
		Pairs   map[string][]int `json:"pairs"`
	} `json:"effectiveness"`
	Statuses []Status `json:"statuses"`
	Skills   struct {
		XPBase float64 `json:"xpBase"`
		XPExp  float64 `json:"xpExp"`
		List   []Skill `json:"list"`
	} `json:"skills"`
	Weapons []Weapon `json:"weapons"`
	Moves   []Move   `json:"moves"`
	Forms   []Form   `json:"forms"`
	Dashes  []Dash   `json:"dashes"`
	Mana    struct {
		Base          float64   `json:"base"`
		PerLevel      float64   `json:"perLevel"`
		RegenPerS     float64   `json:"regenPerS"`
		RegenPerLevel float64   `json:"regenPerLevel"`
		ByTier        []float64 `json:"byTier"`
	} `json:"mana"`
	Spells []Spell `json:"spells"`
	Trees  []Tree  `json:"trees"`
	Start  struct {
		Spells     []string  `json:"spells"`
		Loadouts   []Loadout `json:"loadouts"`
		Consumable struct {
			Charges int     `json:"charges"`
			Heal    float64 `json:"heal"`
		} `json:"consumable"`
	} `json:"start"`
	Names        map[string]string `json:"names"`
	Pending      []string          `json:"pending"`
	EnemyAttacks []EnemyAttack     `json:"enemyAttacks"`
	Enemies      []Enemy           `json:"enemies"`
	Bosses       []Boss            `json:"bosses"`
	BossTitles   map[string]string `json:"bossTitles"`
	BossNames    map[string]string `json:"bossNames"`
	Affixes      []Affix           `json:"affixes"`
	Tables       struct {
		Biome   [][]string           `json:"biome"`
		Element []string             `json:"element"`
		Site    map[string][]string  `json:"site"`
		Depth   map[string]DepthBand `json:"depth"`
	} `json:"tables"`

	// Indexes (built at load).
	moveByID    map[int]*Move
	moveByKey   map[string]*Move
	spellByID   map[int]*Spell
	spellByKey  map[string]*Spell
	weaponByKey map[string]*Weapon
	weaponByID  map[int]*Weapon
	enemyByKey  map[string]*Enemy
	enemyByID   map[int]*Enemy
	attackByKey map[string]*EnemyAttack
	attackByID  map[int]*EnemyAttack
	statusByKey map[string]*Status
	bossByKey   map[string]*Boss
	affixByKey  map[string]*Affix
	affixByID   map[int]*Affix
	formByEl    map[int]*Form
	formByID    map[int]*Form
	dashByID    map[int]*Dash
	treeByKey   map[string]*Tree
	skillByKey  map[string]*Skill
}

// D is the loaded table set (read-only after init; safe from any goroutine).
var D = mustLoad(raw)

func mustLoad(b []byte) *Defs {
	d := &Defs{}
	if err := json.Unmarshal(b, d); err != nil {
		panic(fmt.Sprintf("combatdefs: combat_gen.json: %v (run npm run gen)", err))
	}
	d.index()
	return d
}

func (d *Defs) index() {
	d.moveByID, d.moveByKey = map[int]*Move{}, map[string]*Move{}
	for i := range d.Moves {
		m := &d.Moves[i]
		d.moveByID[m.ID], d.moveByKey[m.Key] = m, m
	}
	d.spellByID, d.spellByKey = map[int]*Spell{}, map[string]*Spell{}
	for i := range d.Spells {
		s := &d.Spells[i]
		d.spellByID[s.ID], d.spellByKey[s.Key] = s, s
	}
	d.weaponByKey, d.weaponByID = map[string]*Weapon{}, map[int]*Weapon{}
	for i := range d.Weapons {
		w := &d.Weapons[i]
		d.weaponByKey[w.Key], d.weaponByID[w.ID] = w, w
	}
	d.enemyByKey, d.enemyByID = map[string]*Enemy{}, map[int]*Enemy{}
	for i := range d.Enemies {
		e := &d.Enemies[i]
		d.enemyByKey[e.Key], d.enemyByID[e.ID] = e, e
	}
	d.attackByKey, d.attackByID = map[string]*EnemyAttack{}, map[int]*EnemyAttack{}
	for i := range d.EnemyAttacks {
		a := &d.EnemyAttacks[i]
		d.attackByKey[a.Key], d.attackByID[a.ID] = a, a
	}
	d.statusByKey = map[string]*Status{}
	for i := range d.Statuses {
		d.statusByKey[d.Statuses[i].Key] = &d.Statuses[i]
	}
	d.bossByKey = map[string]*Boss{}
	for i := range d.Bosses {
		d.bossByKey[d.Bosses[i].Key] = &d.Bosses[i]
	}
	d.affixByKey, d.affixByID = map[string]*Affix{}, map[int]*Affix{}
	for i := range d.Affixes {
		a := &d.Affixes[i]
		d.affixByKey[a.Key], d.affixByID[a.ID] = a, a
	}
	d.formByEl, d.formByID = map[int]*Form{}, map[int]*Form{}
	for i := range d.Forms {
		f := &d.Forms[i]
		d.formByEl[f.Element], d.formByID[f.ID] = f, f
	}
	d.dashByID = map[int]*Dash{}
	for i := range d.Dashes {
		d.dashByID[d.Dashes[i].ID] = &d.Dashes[i]
	}
	d.treeByKey = map[string]*Tree{}
	for i := range d.Trees {
		d.treeByKey[d.Trees[i].Key] = &d.Trees[i]
	}
	d.skillByKey = map[string]*Skill{}
	for i := range d.Skills.List {
		d.skillByKey[d.Skills.List[i].Key] = &d.Skills.List[i]
	}
}

// Lookups (nil when unknown).
func (d *Defs) MoveByID(id int) *Move             { return d.moveByID[id] }
func (d *Defs) MoveByKey(k string) *Move          { return d.moveByKey[k] }
func (d *Defs) SpellByID(id int) *Spell           { return d.spellByID[id] }
func (d *Defs) SpellByKey(k string) *Spell        { return d.spellByKey[k] }
func (d *Defs) WeaponByKey(k string) *Weapon      { return d.weaponByKey[k] }
func (d *Defs) WeaponByID(id int) *Weapon         { return d.weaponByID[id] }
func (d *Defs) EnemyByKey(k string) *Enemy        { return d.enemyByKey[k] }
func (d *Defs) EnemyByID(id int) *Enemy           { return d.enemyByID[id] }
func (d *Defs) AttackByKey(k string) *EnemyAttack { return d.attackByKey[k] }
func (d *Defs) AttackByID(id int) *EnemyAttack    { return d.attackByID[id] }
func (d *Defs) StatusByKey(k string) *Status      { return d.statusByKey[k] }
func (d *Defs) BossByKey(k string) *Boss          { return d.bossByKey[k] }
func (d *Defs) AffixByKey(k string) *Affix        { return d.affixByKey[k] }
func (d *Defs) AffixByID(id int) *Affix           { return d.affixByID[id] }
func (d *Defs) FormByElement(el int) *Form        { return d.formByEl[el] }
func (d *Defs) FormByID(id int) *Form             { return d.formByID[id] }
func (d *Defs) DashByID(id int) *Dash             { return d.dashByID[id] }
func (d *Defs) TreeByKey(k string) *Tree          { return d.treeByKey[k] }
func (d *Defs) SkillByKey(k string) *Skill        { return d.skillByKey[k] }

// WeaponMoves returns the moves of a weapon in table order.
func (d *Defs) WeaponMoves(w *Weapon) []*Move {
	out := make([]*Move, 0, len(w.Moves))
	for _, k := range w.Moves {
		out = append(out, d.moveByKey[k])
	}
	return out
}

// MoveOf finds a weapon's move by kind and combo index (nil if none).
func (d *Defs) MoveOf(w *Weapon, kind string, combo int) *Move {
	for _, k := range w.Moves {
		m := d.moveByKey[k]
		if m.Kind == kind && m.Combo == combo {
			return m
		}
	}
	return nil
}

// ComboLength is how many light moves a weapon chains.
func (d *Defs) ComboLength(w *Weapon) int {
	n := 0
	for _, k := range w.Moves {
		if d.moveByKey[k].Kind == "light" {
			n++
		}
	}
	return max(1, n)
}

// ElementMult is the damage multiplier of an attack element against a
// defender element (spec 7 elements; Physical is neutral both ways).
func (d *Defs) ElementMult(attack, defend int) float64 {
	if attack == Physical || defend == Physical {
		return 1
	}
	if attack == defend {
		return d.Effectiveness.Resist
	}
	for _, x := range d.Effectiveness.Pairs[fmt.Sprint(attack)] {
		if x == defend {
			return d.Effectiveness.Strong
		}
	}
	if attack == Void {
		return d.Effectiveness.VoidAll
	}
	return 1
}

// XPForLevel is the cumulative skill XP needed to reach level n (1..100).
func (d *Defs) XPForLevel(n int) int64 {
	if n <= 1 {
		return 0
	}
	return int64(math.Round(d.Skills.XPBase * math.Pow(float64(n-1), d.Skills.XPExp)))
}

// SkillLevel is the level (1..100) for cumulative skill XP.
func (d *Defs) SkillLevel(xp int64) int {
	lv := 1
	for lv < 100 && xp >= d.XPForLevel(lv+1) {
		lv++
	}
	return lv
}

// HasTechnique reports whether a skill level has unlocked a technique.
func (d *Defs) HasTechnique(skill string, level int, technique string) bool {
	s := d.skillByKey[skill]
	if s == nil {
		return false
	}
	for _, t := range s.Techniques {
		if t.Key == technique {
			return level >= t.Level
		}
	}
	return false
}

// ManaCost is a spell's mana cost.
func (d *Defs) ManaCost(s *Spell) float64 { return s.Mana }

// MaxMana for a character level (wizard-wars maxManaFor shape).
func (d *Defs) MaxMana(level int) float64 {
	return math.Round(d.Mana.Base + d.Mana.PerLevel*float64(max(0, level-1)))
}

// ManaRegen per second for a character level.
func (d *Defs) ManaRegen(level int) float64 {
	return d.Mana.RegenPerS + d.Mana.RegenPerLevel*float64(max(0, level-1))
}

// TypeID packs an enemy's wire typeId (EntityRecord.typeId): bits 0-7 enemy
// id, 8-11 element (0 none, else 1 + worldgen element), 12-14 affix (0 none,
// 1..3 elite affix id, 7 boss).
func TypeID(enemyID, element, affix int) uint16 {
	el := 0
	if element >= 0 && element < Physical {
		el = element + 1
	}
	return uint16(enemyID&0xff) | uint16(el&0xf)<<8 | uint16(affix&0x7)<<12
}

// AffixBoss is the typeId affix value of a boss.
const AffixBoss = 7

// UnpackTypeID reverses TypeID (element Physical when none).
func UnpackTypeID(t uint16) (enemyID, element, affix int) {
	enemyID = int(t & 0xff)
	element = int(t>>8&0xf) - 1
	if element < 0 {
		element = Physical
	}
	return enemyID, element, int(t >> 12 & 0x7)
}
