// Package contentdefs is the Go view of contracts/content.yaml (playtest 2,
// CR 022): town reputation, side quest templates, story quests, world
// events, dungeons, lore tablets, the creature codex, feats and herbs.
// `npm run gen` normalizes the YAML into content_gen.json (embedded here)
// and into the client's contracts/ts/src/gen/content.ts from the same
// object, so the zone and the client agree on every name and number.
package contentdefs

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
)

//go:embed content_gen.json
var raw []byte

// Ware is an extra item a reputation tier unlocks in a shop.
type Ware struct {
	Item  string `json:"item"`
	Price uint32 `json:"price"`
	Stock uint16 `json:"stock"`
}

// RepTier is a reputation tier (reached at Min).
type RepTier struct {
	Key  string `json:"key"`
	ID   int    `json:"id"`
	Name string `json:"name"`
	Min  int    `json:"min"`
}

// Reputation: tiers and, per tier and shop (Shops order), extra wares.
type Reputation struct {
	Tiers []RepTier  `json:"tiers"`
	Shops []string   `json:"shops"`
	Wares [][][]Ware `json:"wares"`
}

// GatherItem is something a gathering quest may ask for.
type GatherItem struct {
	Item string `json:"item"`
	Qty  [2]int `json:"qty"`
}

// SideKind is one side quest template.
type SideKind struct {
	Key        string       `json:"key"`
	Weight     float64      `json:"weight"`
	Titles     []string     `json:"titles"`
	Offer      []string     `json:"offer"`
	Step       string       `json:"step"`
	Note       string       `json:"note"`
	Back       string       `json:"back"`
	Thanks     []string     `json:"thanks"`
	Gold       [2]int       `json:"gold"`
	XP         [2]int       `json:"xp"`
	Rep        int          `json:"rep"`
	N          [2]int       `json:"n"`
	Radius     float64      `json:"radius"`
	Items      []GatherItem `json:"items"`
	Escort     string       `json:"escort"`
	EscortNote string       `json:"escortNote"`
	Found      string       `json:"found"`
}

// SideQuests is the per-town generator's data.
type SideQuests struct {
	Givers struct {
		Min   int   `json:"min"`
		Max   int   `json:"max"`
		Roles []int `json:"roles"`
	} `json:"givers"`
	Near struct {
		Min float64 `json:"min"`
		Max float64 `json:"max"`
	} `json:"near"`
	Creatures []string   `json:"creatures"`
	Villagers []string   `json:"villagers"`
	Kinds     []SideKind `json:"kinds"`
}

// StoryStep is one authored step; places resolve around the towns.
type StoryStep struct {
	Kind  string `json:"kind"`
	Site  string `json:"site"`
	Near  string `json:"near"`
	Town  string `json:"town"`
	Role  int    `json:"role"`
	N     int    `json:"n"`
	Item  string `json:"item"`
	Grant string `json:"grant"`
	Text  string `json:"text"`
	Note  string `json:"note"`
	Say   string `json:"say"`
}

// Story is a handcrafted multi-step quest.
type Story struct {
	Key     string      `json:"key"`
	ID      int         `json:"id"`
	Title   string      `json:"title"`
	Role    int         `json:"role"`
	AltRole int         `json:"altRole"`
	Offer   string      `json:"offer"`
	Gold    int         `json:"gold"`
	XP      int64       `json:"xp"`
	Rep     int         `json:"rep"`
	Items   int         `json:"items"`
	Steps   []StoryStep `json:"steps"`
}

// Scheduler tunes world event scheduling.
type Scheduler struct {
	EveryS          float64 `json:"everyS"`
	ChancePerPlayer float64 `json:"chancePerPlayer"`
	MaxActive       int     `json:"maxActive"`
	MinGapM         float64 `json:"minGapM"`
	SpawnMinM       float64 `json:"spawnMinM"`
	SpawnMaxM       float64 `json:"spawnMaxM"`
	AnnounceM       float64 `json:"announceM"`
	PlayerCooldownS float64 `json:"playerCooldownS"`
}

// EventReward is what each participant of a won event gets.
type EventReward struct {
	Gold   [2]int  `json:"gold"`
	XP     int64   `json:"xp"`
	Items  int     `json:"items"`
	Luck   float64 `json:"luck"`
	Ore    string  `json:"ore"`
	OreQty [2]int  `json:"oreQty"`
	Gems   [2]int  `json:"gems"`
}

// EventKind is one world event.
type EventKind struct {
	Key             string      `json:"key"`
	ID              int         `json:"id"`
	Name            string      `json:"name"`
	Weight          float64     `json:"weight"`
	Night           bool        `json:"night"`
	Announce        string      `json:"announce"`
	Success         string      `json:"success"`
	Fail            string      `json:"fail"`
	DurationS       float64     `json:"durationS"`
	Comp            []string    `json:"comp"`
	Elite           string      `json:"elite"`
	Radius          float64     `json:"radius"`
	Waves           [][]string  `json:"waves"`
	CaravanHP       float64     `json:"caravanHp"`
	DamagePerBandit float64     `json:"damagePerBandit"`
	RoamSpeed       float64     `json:"roamSpeed"`
	RoamLegM        float64     `json:"roamLegM"`
	Reward          EventReward `json:"reward"`
}

// Events: the scheduler and the kinds.
type Events struct {
	Scheduler Scheduler   `json:"scheduler"`
	Kinds     []EventKind `json:"kinds"`
}

// Puzzle is a vault seal.
type Puzzle struct {
	Key     string  `json:"key"`
	ID      int     `json:"id"`
	Name    string  `json:"name"`
	Hint    string  `json:"hint"`
	Wrong   string  `json:"wrong"`
	Parts   int     `json:"parts"`
	HoldS   float64 `json:"holdS"`
	Element string  `json:"element"`
}

// Dungeons: the sealed vaults.
type Dungeons struct {
	DiscoverM float64    `json:"discoverM"`
	ActiveM   float64    `json:"activeM"`
	ResetS    float64    `json:"resetS"`
	Names     []string   `json:"names"`
	Door      string     `json:"door"`
	Puzzles   []Puzzle   `json:"puzzles"`
	Packs     [][]string `json:"packs"`
	Boss      string     `json:"boss"`
	Chest     struct {
		Gold      [2]int  `json:"gold"`
		MinRarity int     `json:"minRarity"`
		Items     int     `json:"items"`
		Luck      float64 `json:"luck"`
		CooldownH float64 `json:"cooldownH"`
	} `json:"chest"`
}

// Tablet is a readable lore tablet.
type Tablet struct {
	Key   string `json:"key"`
	ID    int    `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

// Codex is a creature entry (one per combat.yaml enemy).
type Codex struct {
	Key     string `json:"key"`
	EnemyID int    `json:"enemyId"`
	Habitat string `json:"habitat"`
	Lore    string `json:"lore"`
}

// Feat is an achievement; Title (optional) is shown on nameplates.
type Feat struct {
	Key   string `json:"key"`
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Desc  string `json:"desc"`
	Stat  string `json:"stat"`
	N     int    `json:"n"`
	Gold  int    `json:"gold"`
	XP    int64  `json:"xp"`
	Title string `json:"title"`
}

// Herb is a foraging plant.
type Herb struct {
	Key    string  `json:"key"`
	ID     int     `json:"id"`
	Item   string  `json:"item"`
	Name   string  `json:"name"`
	Biomes []int   `json:"biomes"`
	Color  string  `json:"color"`
	Weight float64 `json:"weight"`
}

// Forage tunes herb patches.
type Forage struct {
	CellM   float64 `json:"cellM"`
	Chance  float64 `json:"chance"`
	RegrowS float64 `json:"regrowS"`
	ReachM  float64 `json:"reachM"`
	Herbs   []Herb  `json:"herbs"`
}

// Fish is one fish species (playtest 2 fishing, CR 026).
type Fish struct {
	Key     string     `json:"key"`
	ID      int        `json:"id"`
	Name    string     `json:"name"`
	Item    string     `json:"item"`
	Rarity  int        `json:"rarity"` // 0 common .. 3 legendary
	Water   []int      `json:"water"`  // Fishing.Waters indices
	Biomes  []int      `json:"biomes"` // empty: any
	Time    string     `json:"time"`
	Weather string     `json:"weather"`
	Weight  [2]float64 `json:"weight"`
	Fight   FishFight  `json:"fight"`
	Habitat string     `json:"habitat"`
	Lore    string     `json:"lore"`
}

// FishFight tunes the reel minigame for a species.
type FishFight struct {
	Strength float64 `json:"strength"`
	Erratic  float64 `json:"erratic"`
	Stamina  float64 `json:"stamina"`
}

// FishRarity is a rarity's roll weight.
type FishRarity struct {
	Key    string  `json:"key"`
	ID     int     `json:"id"`
	Weight float64 `json:"weight"`
	Color  string  `json:"color"`
}

// Fishing tunes casting, bites, rate limits and the species.
type Fishing struct {
	Rod           string       `json:"rod"`
	CastM         [2]float64   `json:"castM"`
	MinDepthM     float64      `json:"minDepthM"`
	BiteS         [2]float64   `json:"biteS"`
	HookWindowMs  int          `json:"hookWindowMs"`
	MaxFightS     float64      `json:"maxFightS"`
	CastCooldownS float64      `json:"castCooldownS"`
	CastBurst     float64      `json:"castBurst"`
	CastEveryS    float64      `json:"castEveryS"`
	WalkAwayM     float64      `json:"walkAwayM"`
	SeeM          float64      `json:"seeM"`
	Waters        []string     `json:"waters"`
	Times         []string     `json:"times"`
	Rarities      []FishRarity `json:"rarities"`
	Species       []Fish       `json:"species"`
}

// Emote is one emote (playtest 2, CR 026).
type Emote struct {
	Key    string  `json:"key"`
	ID     int     `json:"id"`
	Name   string  `json:"name"`
	DurS   float64 `json:"durS"`
	Loop   bool    `json:"loop"`
	System bool    `json:"system"`
}

// Emotes tunes emote replication.
type Emotes struct {
	SeeM   float64 `json:"seeM"`
	Burst  float64 `json:"burst"`
	EveryS float64 `json:"everyS"`
	List   []Emote `json:"list"`
}

// PetAbility is a pet species' one ability (playtest 2 pets, CR 029).
type PetAbility struct {
	Key       string     `json:"key"`
	ID        int        `json:"id"`
	Name      string     `json:"name"`
	Kind      string     `json:"kind"` // heal | buff | charge | strike
	CooldownS float64    `json:"cooldownS"`
	Power     float64    `json:"power"`
	HealBelow float64    `json:"healBelow"`
	Party     bool       `json:"party"`
	DurationS float64    `json:"durationS"`
	RangeM    [2]float64 `json:"rangeM"`
	RadiusM   float64    `json:"radiusM"`
	Status    string     `json:"status"`
	Element   int        `json:"element"` // combat element index, -1 = the pet's own
	Desc      string     `json:"desc"`
}

// PetAttack is a pet's bite.
type PetAttack struct {
	Reach    float64 `json:"reach"`
	EveryMs  float64 `json:"everyMs"`
	WindupMs float64 `json:"windupMs"`
}

// PetSpecies is a tameable creature (playtest 2 pets, CR 029).
type PetSpecies struct {
	Key     string    `json:"key"`
	ID      int       `json:"id"`
	Enemy   string    `json:"enemy"`
	EnemyID int       `json:"enemyId"`
	Foods   []string  `json:"foods"` // the first is its favourite
	TameS   float64   `json:"tameS"`
	Chance  float64   `json:"chance"`
	HP      float64   `json:"hp"`
	Damage  float64   `json:"damage"`
	Speed   float64   `json:"speed"`
	Attack  PetAttack `json:"attack"`
	Ability int       `json:"ability"`
	Blurb   string    `json:"blurb"`
}

// Taming tunes taming and pets.
type Taming struct {
	WeakenPct       float64      `json:"weakenPct"`
	CalmS           float64      `json:"calmS"`
	SmellM          float64      `json:"smellM"`
	FeedReachM      float64      `json:"feedReachM"`
	StayM           float64      `json:"stayM"`
	FavouriteMult   float64      `json:"favouriteMult"`
	FavouriteBonus  float64      `json:"favouriteBonus"`
	ShinyChance     float64      `json:"shinyChance"`
	ElementalChance float64      `json:"elementalChance"`
	MaxPets         int          `json:"maxPets"`
	KORecoverS      float64      `json:"koRecoverS"`
	StableM         float64      `json:"stableM"`
	LevelMax        int          `json:"levelMax"`
	XPBase          float64      `json:"xpBase"`
	XPGrowth        float64      `json:"xpGrowth"`
	HPPerLevel      float64      `json:"hpPerLevel"`
	DamagePerLevel  float64      `json:"damagePerLevel"`
	RegenPctS       float64      `json:"regenPctS"`
	FeedHealPct     float64      `json:"feedHealPct"`
	FollowM         float64      `json:"followM"`
	WarpM           float64      `json:"warpM"`
	StayGuardM      float64      `json:"stayGuardM"`
	AggroM          float64      `json:"aggroM"`
	LeashM          float64      `json:"leashM"`
	Abilities       []PetAbility `json:"abilities"`
	Species         []PetSpecies `json:"species"`
}

// Defs is the whole table.
type Defs struct {
	Version    int        `json:"version"`
	Reputation Reputation `json:"reputation"`
	SideQuests SideQuests `json:"sidequests"`
	Stories    []Story    `json:"stories"`
	Events     Events     `json:"events"`
	Dungeons   Dungeons   `json:"dungeons"`
	Tablets    []Tablet   `json:"tablets"`
	Codex      []Codex    `json:"codex"`
	Feats      []Feat     `json:"feats"`
	Forage     Forage     `json:"forage"`
	Fishing    Fishing    `json:"fishing"`
	Emotes     Emotes     `json:"emotes"`
	Taming     Taming     `json:"taming"`
	Roles      []string   `json:"roles"`
}

// PetByID is pet species id's definition (nil if none).
func (d *Defs) PetByID(id int) *PetSpecies {
	for i := range d.Taming.Species {
		if d.Taming.Species[i].ID == id {
			return &d.Taming.Species[i]
		}
	}
	return nil
}

// PetByKey is the species by key (nil if none).
func (d *Defs) PetByKey(key string) *PetSpecies {
	for i := range d.Taming.Species {
		if d.Taming.Species[i].Key == key {
			return &d.Taming.Species[i]
		}
	}
	return nil
}

// PetByEnemy is the species that tames combat enemy key (nil: not tameable).
func (d *Defs) PetByEnemy(enemy string) *PetSpecies {
	for i := range d.Taming.Species {
		if d.Taming.Species[i].Enemy == enemy {
			return &d.Taming.Species[i]
		}
	}
	return nil
}

// PetAbility is ability id's definition (nil if none).
func (d *Defs) PetAbility(id int) *PetAbility {
	for i := range d.Taming.Abilities {
		if d.Taming.Abilities[i].ID == id {
			return &d.Taming.Abilities[i]
		}
	}
	return nil
}

// PetXPToNext is the XP a pet of level needs for the next level.
func (d *Defs) PetXPToNext(level int) int {
	t := &d.Taming
	return int(math.Round(t.XPBase * math.Pow(t.XPGrowth, float64(max(0, level-1)))))
}

// D is the embedded table.
var D = mustLoad()

func mustLoad() *Defs {
	d := &Defs{}
	if err := json.Unmarshal(raw, d); err != nil {
		panic(fmt.Sprintf("contentdefs: %v", err))
	}
	return d
}

// SideKind returns the template by key (nil if none).
func (d *Defs) SideKind(key string) *SideKind {
	for i := range d.SideQuests.Kinds {
		if d.SideQuests.Kinds[i].Key == key {
			return &d.SideQuests.Kinds[i]
		}
	}
	return nil
}

// EventKind returns the world event by key (nil if none).
func (d *Defs) EventKind(key string) *EventKind {
	for i := range d.Events.Kinds {
		if d.Events.Kinds[i].Key == key {
			return &d.Events.Kinds[i]
		}
	}
	return nil
}

// Story returns the story by key (nil if none).
func (d *Defs) Story(key string) *Story {
	for i := range d.Stories {
		if d.Stories[i].Key == key {
			return &d.Stories[i]
		}
	}
	return nil
}

// Feat returns the feat by key (nil if none).
func (d *Defs) Feat(key string) *Feat {
	for i := range d.Feats {
		if d.Feats[i].Key == key {
			return &d.Feats[i]
		}
	}
	return nil
}

// TierOf is the reputation tier index for rep.
func (d *Defs) TierOf(rep int) int {
	t := 0
	for i, x := range d.Reputation.Tiers {
		if rep >= x.Min {
			t = i
		}
	}
	return t
}

// Puzzle returns the puzzle by key (nil if none).
func (d *Defs) Puzzle(key string) *Puzzle {
	for i := range d.Dungeons.Puzzles {
		if d.Dungeons.Puzzles[i].Key == key {
			return &d.Dungeons.Puzzles[i]
		}
	}
	return nil
}

// FishByID is fish species id's definition (nil if none).
func (d *Defs) FishByID(id int) *Fish {
	if id < 1 || id > len(d.Fishing.Species) {
		return nil
	}
	return &d.Fishing.Species[id-1]
}

// Emote is the emote with this id (nil if none).
func (d *Defs) Emote(id int) *Emote {
	for i := range d.Emotes.List {
		if d.Emotes.List[i].ID == id {
			return &d.Emotes.List[i]
		}
	}
	return nil
}
