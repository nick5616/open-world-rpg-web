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
	// MinChargeSteps (CR 033): a charged move released sooner is refused (the bow: a tap still draws this long).
	MinChargeSteps int     `json:"minChargeSteps"`
	ChargeMult     float64 `json:"chargeMult"`
	ChargeSpeed    float64 `json:"chargeSpeed"`
	PerMeter       float64 `json:"perMeter"`
	MaxBonus       float64 `json:"maxBonus"`
	Technique      string  `json:"technique"`
	CooldownSteps  int     `json:"cooldownSteps"`
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
	KillsDemons   bool    `json:"killsDemons"` // WP15: Light form
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
	// Playtest 2 dash overhaul (CR 021).
	Aim       string       `json:"aim"` // move | look (3D, yaw and pitch)
	ExitSpeed float64      `json:"exitSpeed"`
	Sustain   *DashSustain `json:"sustain"`
	Trail     *DashTrail   `json:"trail"`
	// CR 048 level tiers: the base dash and each row with TierOf = its key
	// carry MinLevel and a TierName (see ResolveDash).
	MinLevel int    `json:"minLevel"`
	TierName string `json:"tierName"`
	TierOf   string `json:"tierOf"`
}

// Sustain kinds (DashSustain.KindID; the movement twins switch on them).
const (
	SustainJet   = 1
	SustainDash  = 2
	SustainSkate = 3
	SustainBlink = 4
	SustainGlide = 5
	SustainPhase = 6
)

// DashSustain is a dash held by the channel flag (CR 021).
type DashSustain struct {
	Kind       string  `json:"kind"`
	KindID     int     `json:"kindId"`
	Speed      float64 `json:"speed"`
	Steer      float64 `json:"steer"`
	CarrySteps int     `json:"carrySteps"`
	BlinkSpeed float64 `json:"blinkSpeed"`
	BlinkEvery int     `json:"blinkEvery"`
	Sink       float64 `json:"sink"`
	ManaPerS   float64 `json:"manaPerS"`
	HealthPerS float64 `json:"healthPerS"`
}

// DashTrail is what a dash does to the world on its path (CR 021; the zone's).
type DashTrail struct {
	Radius     float64   `json:"radius"`
	Damage     float64   `json:"damage"`
	Lifesteal  float64   `json:"lifesteal"`
	Heal       float64   `json:"heal"`
	HealRadius float64   `json:"healRadius"`
	Status     string    `json:"status"`
	Chem       string    `json:"chem"` // ignite | freeze
	Slam       *DashSlam `json:"slam"`
}

// DashSlam is a dive into the ground at the end of a flight.
type DashSlam struct {
	MinFall float64 `json:"minFall"`
	Radius  float64 `json:"radius"`
	Damage  float64 `json:"damage"`
	Status  string  `json:"status"`
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
	SpreadDeg      float64        `json:"spreadDeg"`
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
	KillsDemons    bool           `json:"killsDemons"` // WP15: every spell of the Light tree
	Mana           float64        `json:"mana"`
	Dash           int            `json:"dash"`
	Status         string         `json:"status"`
	RequiresStatus string         `json:"requiresStatus"`
	BossDamage     float64        `json:"bossDamage"`
	VsStatus       *Rate          `json:"vsStatus"`
	LowTargetHP    *Rate          `json:"lowTargetHp"`
	Effect         map[string]any `json:"effect"`
	// CR 020 mechanics (contracts/combat.yaml spells header); nil when absent.
	Homing   *Homing      `json:"homing"`
	Auto     *Auto        `json:"auto"`
	Rain     *Rain        `json:"rain"`
	Charge   *Charge      `json:"charge"`
	Orbit    *Orbit       `json:"orbit"`
	Detonate *Detonate    `json:"detonate"`
	Summon   *SummonSpell `json:"summon"`
}

// Homing: a projectile that seeks (CR 020; spellsim in the zone and client).
type Homing struct {
	TurnDegS   float64 `json:"turnDegS"`
	AcquireM   float64 `json:"acquireM"`
	ConeDeg    float64 `json:"coneDeg"`
	DelaySteps int     `json:"delaySteps"`
	LoseDeg    float64 `json:"loseDeg"`
}

// Auto: hold to fire (CR 020).
type Auto struct {
	RateHz        float64 `json:"rateHz"`
	IntervalSteps int     `json:"intervalSteps"`
	ManaPerShot   float64 `json:"manaPerShot"`
	JitterDeg     float64 `json:"jitterDeg"`
}

// Rain: an auto spell's shots fall from above around the aim point (CR 020).
type Rain struct {
	Radius float64 `json:"radius"`
	Height float64 `json:"height"`
}

// Charge: hold to empower (CR 020).
type Charge struct {
	MaxSteps   int     `json:"maxSteps"`
	DamageMult float64 `json:"damageMult"`
	RadiusMult float64 `json:"radiusMult"`
	SpeedMult  float64 `json:"speedMult"`
}

// Orbit: orbs circling the caster (CR 020, spell type orbit).
type Orbit struct {
	Count         int     `json:"count"`
	Radius        float64 `json:"radius"`
	PeriodSteps   int     `json:"periodSteps"`
	HitEverySteps int     `json:"hitEverySteps"`
	OrbRadius     float64 `json:"orbRadius"`
}

// Detonate: a delayed burst on the target, or a brand that bursts on death (CR 020).
type Detonate struct {
	OnDeath    bool    `json:"onDeath"`
	DelaySteps int     `json:"delaySteps"`
	Radius     float64 `json:"radius"`
	Damage     float64 `json:"damage"`
	Status     string  `json:"status"`
	Mark       string  `json:"mark"`
}

// SummonSpell names the ally a summon spell calls (CR 020).
type SummonSpell struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
	Max   int    `json:"max"`
}

// SummonAttack is an ally's one attack.
type SummonAttack struct {
	Shape       string  `json:"shape"` // melee | bolt
	Reach       float64 `json:"reach"`
	Damage      float64 `json:"damage"`
	EverySteps  int     `json:"everySteps"`
	WindupSteps int     `json:"windupSteps"`
	Speed       float64 `json:"speed"`
	Radius      float64 `json:"radius"`
}

// Summon is an ally type (combat.yaml summons, CR 020).
type Summon struct {
	Key      string       `json:"key"`
	ID       int          `json:"id"`
	Name     string       `json:"name"`
	Family   string       `json:"family"`
	Behavior string       `json:"behavior"` // melee | ranged | turret
	Element  int          `json:"element"`
	Speed    float64      `json:"speed"`
	Size     float64      `json:"size"`
	Color    string       `json:"color"`
	Aggro    float64      `json:"aggro"`
	KeepAway float64      `json:"keepAway"`
	LeashM   float64      `json:"leashM"`
	Attack   SummonAttack `json:"attack"`
	// Body is an Enemy view of the ally for the zone's shared movement and
	// steering code (built at load; never in the enemy tables).
	Body *Enemy `json:"-"`
}

// SummonTypeID is an ally's wire typeId: id | (element + 1) << 8.
func SummonTypeID(s *Summon) uint16 { return uint16(s.ID&0xff) | uint16((s.Element+1)&0xf)<<8 }

// Equippable reports a spell that goes in one of the four slots.
func (s *Spell) Equippable() bool { return s.Type != "passive" }

// Node is one spell tree node.
type Node struct {
	Key     string   `json:"key"`
	Prereqs []string `json:"prereqs"`
}

// Tree is one spell tree.
type Tree struct {
	Key         string `json:"key"`
	Element     int    `json:"element"`
	KillsDemons bool   `json:"killsDemons"` // WP15
	Nodes       []Node `json:"nodes"`
}

// Material is a main-hand weapon material (WP15, CR 011). A loadout names
// its weapon's material by key; KillsDemons is the whole demon rule for
// weapons (sunsteel).
type Material struct {
	Key          string  `json:"key"`
	ID           int     `json:"id"`
	Mult         float64 `json:"mult"`
	DemonStagger bool    `json:"demonStagger"`
	KillsDemons  bool    `json:"killsDemons"`
}

// DemonTraits is a demon-family enemy's rank and regeneration (WP15).
type DemonTraits struct {
	Rank  string  `json:"rank"`  // lesser | greater | lord
	Regen float64 `json:"regen"` // fraction of max health per second from ordinary damage
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
	// Demon is set for family "demon" (WP15): rank and regeneration.
	Demon *DemonTraits `json:"demon"`
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
	Weapons   []Weapon   `json:"weapons"`
	Moves     []Move     `json:"moves"`
	Forms     []Form     `json:"forms"`
	Materials []Material `json:"materials"` // WP15
	Dashes    []Dash     `json:"dashes"`
	Mana      struct {
		Base          float64   `json:"base"`
		PerLevel      float64   `json:"perLevel"`
		RegenPerS     float64   `json:"regenPerS"`
		RegenPerLevel float64   `json:"regenPerLevel"`
		ByTier        []float64 `json:"byTier"`
	} `json:"mana"`
	Spells  []Spell  `json:"spells"`
	Trees   []Tree   `json:"trees"`
	Summons []Summon `json:"summons"` // CR 020
	Start   struct {
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
		// Beginner is the playtest-1 beginner table (CR 012): the Haven's
		// creatures, mixed into quiet lands.
		Beginner []string `json:"beginner"`
	} `json:"tables"`
	// Demons are the WP15 night spawn tables (Greater indexed by element).
	Demons struct {
		Regen   map[string]float64 `json:"regen"`
		Lesser  []string           `json:"lesser"`
		Greater []string           `json:"greater"`
		Lord    string             `json:"lord"`
		// Ordinary (CR 048): how ordinary (non-sunsteel, non-Light) damage treats a demon by level.
		Ordinary struct {
			HalfFrom   int     `json:"halfFrom"`
			ImmuneFrom int     `json:"immuneFrom"`
			HalfMult   float64 `json:"halfMult"`
		} `json:"ordinary"`
	} `json:"demons"`
	// Leveling and Difficulty are playtest 1's (CR 012, decision 0021).
	Leveling   Leveling   `json:"leveling"`
	Difficulty Difficulty `json:"difficulty"`
	// PvP is playtest 2's opt-in PvP and party duels (CR 019).
	PvP PvP `json:"pvp"`

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
	summonByKey map[string]*Summon
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
	d.summonByKey = map[string]*Summon{}
	for i := range d.Summons {
		s := &d.Summons[i]
		behavior := s.Behavior
		if behavior == "turret" {
			behavior = "melee" // never moves; the zone's steering only reads flyer
		}
		s.Body = &Enemy{Key: "summon_" + s.Key, ID: s.ID, Name: s.Name, Family: "summon", HP: 1, Speed: s.Speed, Aggro: s.Aggro, Behavior: behavior, KeepAway: s.KeepAway, Element: s.Element, Size: s.Size, Color: s.Color}
		d.summonByKey[s.Key] = s
	}
}

// SummonByKey is an ally type (CR 020), nil when unknown.
func (d *Defs) SummonByKey(k string) *Summon { return d.summonByKey[k] }

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

// ResolveDash is the dash variant a spell whose base dash is id runs at a
// character level (CR 048): the tier row with the highest MinLevel <= level
// among the base and the rows that name it; the lowest tier below every
// MinLevel. An untiered dash resolves to itself. The client twin is
// resolveDash in client/src/combat/dashes.ts.
func (d *Defs) ResolveDash(id, level int) int {
	base := d.dashByID[id]
	if base == nil || base.MinLevel == 0 {
		return id
	}
	best, lowest := id, id
	bestMin, lowMin := -1, 1<<30
	for i := range d.Dashes {
		t := &d.Dashes[i]
		if t.MinLevel == 0 || (t.ID != id && t.TierOf != base.Key) {
			continue
		}
		if t.MinLevel <= level && t.MinLevel > bestMin {
			best, bestMin = t.ID, t.MinLevel
		}
		if t.MinLevel < lowMin {
			lowest, lowMin = t.ID, t.MinLevel
		}
	}
	if bestMin < 0 {
		return lowest
	}
	return best
}
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

// Leveling is what a character level gives (combat.yaml leveling, CR 012).
type Leveling struct {
	Health struct {
		Base     float64 `json:"base"`
		PerLevel float64 `json:"perLevel"`
	} `json:"health"`
	DamagePctPerLevel float64 `json:"damagePctPerLevel"`
	Stamina           struct {
		PerLevel float64 `json:"perLevel"`
		Max      float64 `json:"max"`
	} `json:"stamina"`
	SkillPoints struct {
		Base     int `json:"base"`
		PerLevel int `json:"perLevel"`
	} `json:"skillPoints"`
	SpellTierLevels []struct {
		Tier  int `json:"tier"`
		Level int `json:"level"`
	} `json:"spellTierLevels"`
	Attune struct {
		Stamina     float64 `json:"stamina"`
		Health      float64 `json:"health"`
		SkillPoints int     `json:"skillPoints"`
		XP          int64   `json:"xp"`
	} `json:"attune"`
}

// DifficultyTier is one band of area levels (combat.yaml difficulty.tiers).
type DifficultyTier struct {
	Key        string  `json:"key"`
	Name       string  `json:"name"`
	MinLevel   int     `json:"minLevel"`
	Beginner   float64 `json:"beginner"`
	Elite      float64 `json:"elite"`
	Demons     float64 `json:"demons"`
	Greater    float64 `json:"greater"`
	DemonSpeed float64 `json:"demonSpeed"`
	Lords      bool    `json:"lords"`
	Bosses     bool    `json:"bosses"`
	Defense    bool    `json:"defense"`
}

// Difficulty is the discovery-stamped area difficulty (CR 012).
type Difficulty struct {
	CellM            float64          `json:"cellM"`
	HavenRadiusM     float64          `json:"havenRadiusM"`
	MaxStep          int              `json:"maxStep"`
	NeighbourWeight  float64          `json:"neighbourWeight"`
	DangerBonus      float64          `json:"dangerBonus"`
	MaxLevel         int              `json:"maxLevel"`
	StampReachM      float64          `json:"stampReachM"`
	DemonSafeBelow   int              `json:"demonSafeBelow"`
	DemonSafeMarginM float64          `json:"demonSafeMarginM"`
	Tiers            []DifficultyTier `json:"tiers"`
}

// PvP is combat.yaml's pvp block (playtest 2, CR 019): open PvP between
// flagged players outside safe zones, duels between party members.
type PvP struct {
	DamageMult        float64 `json:"damageMult"`
	FlagOffDelayS     float64 `json:"flagOffDelayS"`
	ToggleCooldownS   float64 `json:"toggleCooldownS"`
	CombatLockS       float64 `json:"combatLockS"`
	SettlementMarginM float64 `json:"settlementMarginM"`
	Duel              struct {
		ChallengeRangeM float64 `json:"challengeRangeM"`
		AnswerS         float64 `json:"answerS"`
		CountdownS      float64 `json:"countdownS"`
		RingRadiusM     float64 `json:"ringRadiusM"`
		OutsideForfeitS float64 `json:"outsideForfeitS"`
		MaxS            float64 `json:"maxS"`
	} `json:"duel"`
}

// Haven is the Haven tier (index 0).
func (f *Difficulty) Haven() *DifficultyTier { return &f.Tiers[0] }

// TierFor is the tier of a stamped (non-Haven) area level, and its index.
func (f *Difficulty) TierFor(level int) (*DifficultyTier, int) {
	idx := 1
	for i := 1; i < len(f.Tiers); i++ {
		if level >= f.Tiers[i].MinLevel {
			idx = i
		}
	}
	return &f.Tiers[idx], idx
}

// MaxHealth is a character's health pool at level (before gear and boons).
func (d *Defs) MaxHealth(level int) float64 {
	return d.Leveling.Health.Base + d.Leveling.Health.PerLevel*float64(max(0, level-1))
}

// DamageMult is the character level's multiplier on all player damage.
func (d *Defs) DamageMult(level int) float64 {
	return 1 + d.Leveling.DamagePctPerLevel/100*float64(max(0, level-1))
}

// StaminaBonus is the level's extra stamina wheel (points, before boons).
func (d *Defs) StaminaBonus(level int) float64 {
	return math.Min(d.Leveling.Stamina.Max, d.Leveling.Stamina.PerLevel*float64(max(0, level-1)))
}

// SkillPointsFor is the spell skill points a character level grants.
func (d *Defs) SkillPointsFor(level int) int {
	return d.Leveling.SkillPoints.Base + d.Leveling.SkillPoints.PerLevel*max(1, level)
}

// TierLevel is the character level a spell tree tier needs for skill-point
// learning (1 = always).
func (d *Defs) TierLevel(tier int) int {
	lvl := 1
	for _, t := range d.Leveling.SpellTierLevels {
		if tier >= t.Tier {
			lvl = t.Level
		}
	}
	return lvl
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

// MaterialByKey returns a weapon material or nil (WP15).
func (d *Defs) MaterialByKey(k string) *Material {
	for i := range d.Materials {
		if d.Materials[i].Key == k {
			return &d.Materials[i]
		}
	}
	return nil
}

// MaterialByID returns a weapon material by wire id or nil (WP15).
func (d *Defs) MaterialByID(id int) *Material {
	for i := range d.Materials {
		if d.Materials[i].ID == id {
			return &d.Materials[i]
		}
	}
	return nil
}
