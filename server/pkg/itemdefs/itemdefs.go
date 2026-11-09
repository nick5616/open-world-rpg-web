// Package itemdefs is the Go view of contracts/items.yaml (WP14, CR 010):
// rarities with their odds, materials, gems and cuts, ores, every base
// item, affixes, uniques, recipes, the starter kit and the loot tables.
// `npm run gen` normalizes the YAML into items_gen.json (embedded here) and
// into the client's contracts/ts/src/gen/items.ts from the same object, so
// the zone and the client always agree on what an item is.
//
// Item keys are a contract (see the header of items.yaml): WP15 reads
// Material(...).KillsDemons for the sunsteel rule.
package itemdefs

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed items_gen.json
var raw []byte

// Rarity is one of the eight spec 8 tiers (ID 0 common .. 7 Bitchin').
type Rarity struct {
	Key      string   `json:"key"`
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	Color    string   `json:"color"`
	Affixes  int      `json:"affixes"`
	Uniques  int      `json:"uniques"`
	Named    bool     `json:"named"`
	Odds     float64  `json:"odds"`
	Lucky    bool     `json:"lucky"`
	Announce bool     `json:"announce"`
	Bases    []string `json:"bases"`
}

// Material scales weapons and armor; KillsDemons/DemonStagger are WP15 data.
type Material struct {
	Key          string  `json:"key"`
	Name         string  `json:"name"`
	Mult         float64 `json:"mult"`
	Tier         int     `json:"tier"`
	KillsDemons  bool    `json:"killsDemons"`
	DemonStagger bool    `json:"demonStagger"`
}

// Gem is one of the ten gems; Element -1 for the utility gems.
type Gem struct {
	Key     string `json:"key"`
	Name    string `json:"name"`
	Element int    `json:"element"`
	Stat    string `json:"stat"`
}

// Cut is rough, cut or brilliant.
type Cut struct {
	Key      string  `json:"key"`
	Name     string  `json:"name"`
	FormMult float64 `json:"formMult"`
	Utility  float64 `json:"utility"`
	Value    int     `json:"value"`
	Tier     int     `json:"tier"`
}

// Ore smelts into the ingot of the same metal.
type Ore struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Smelt int    `json:"smelt"`
}

// Item is a base item.
type Item struct {
	Key      string  `json:"key"`
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Kind     string  `json:"kind"`
	Stack    int     `json:"stack"`
	Pouch    string  `json:"pouch"`
	Level    int     `json:"level"`
	Value    int     `json:"value"`
	Sockets  int     `json:"sockets"`
	Weapon   string  `json:"weapon"`
	Armor    string  `json:"armor"`
	Material string  `json:"material"`
	Health   float64 `json:"health"`
	ArmorPct float64 `json:"armorPct"`
	Heal     float64 `json:"heal"`
	Arrow    string  `json:"arrow"`
	Gem      string  `json:"gem"`
	Cut      string  `json:"cut"`
	Element  int     `json:"element"`
	Metal    string  `json:"metal"`
	Recipe   string  `json:"recipe"`
}

// Affix is a rollable stat line.
type Affix struct {
	Key      string   `json:"key"`
	Name     string   `json:"name"`
	Stat     string   `json:"stat"`
	Min      float64  `json:"min"`
	Max      float64  `json:"max"`
	Slots    []string `json:"slots"`
	Weight   float64  `json:"weight"`
	Elements []int    `json:"elements"`
	Themes   []string `json:"themes"`
}

// Unique is a named bundle of stats (legendary and above).
type Unique struct {
	Key   string             `json:"key"`
	Name  string             `json:"name"`
	Stats map[string]float64 `json:"stats"`
}

// Qty is an item key with a quantity.
type Qty struct {
	Item string `json:"item"`
	Qty  int    `json:"qty"`
}

// Recipe is a smelting, forging or cooking recipe.
type Recipe struct {
	Key       string `json:"key"`
	ID        int    `json:"id"`
	Station   string `json:"station"`
	Inputs    []Qty  `json:"inputs"`
	Output    string `json:"output"`
	Qty       int    `json:"qty"`
	Sockets   int    `json:"sockets"`
	Blueprint string `json:"blueprint"`
	XP        int    `json:"xp"`
}

// FamilyDrops are per-kill drop chances for an enemy family.
type FamilyDrops struct {
	Item       float64 `json:"item"`
	Meat       float64 `json:"meat"`
	Hide       float64 `json:"hide"`
	Gem        float64 `json:"gem"`
	Ore        float64 `json:"ore"`
	Blueprint  float64 `json:"blueprint"`
	Consumable float64 `json:"consumable"`
	Food       float64 `json:"food"`
}

// ContainerLoot is one container kind's table.
type ContainerLoot struct {
	Coins      [2]int  `json:"coins"`
	Items      [2]int  `json:"items"`
	Luck       float64 `json:"luck"`
	Gem        float64 `json:"gem"`
	Blueprint  float64 `json:"blueprint"`
	Consumable float64 `json:"consumable"`
}

// Loot holds the loot tables.
type Loot struct {
	Coins struct {
		Common   [2]int  `json:"common"`
		Elite    [2]int  `json:"elite"`
		Boss     [2]int  `json:"boss"`
		PerLevel float64 `json:"perLevel"`
	} `json:"coins"`
	Families map[string]FamilyDrops `json:"families"`
	Elite    struct {
		Items int     `json:"items"`
		Luck  float64 `json:"luck"`
	} `json:"elite"`
	Boss struct {
		Items       int     `json:"items"`
		Luck        float64 `json:"luck"`
		Tomes       int     `json:"tomes"`
		LockoutDays int     `json:"lockoutDays"`
	} `json:"boss"`
	Containers   map[string]ContainerLoot `json:"containers"`
	Sockets      []float64                `json:"sockets"`
	DeepCaveLuck float64                  `json:"deepCaveLuck"`
}

// Defs is the whole table.
type Defs struct {
	Version      int               `json:"version"`
	Rarities     []Rarity          `json:"rarities"`
	LuckCap      float64           `json:"luckCap"`
	Materials    []Material        `json:"materials"`
	Gems         []Gem             `json:"gems"`
	Cuts         []Cut             `json:"cuts"`
	CombineCount int               `json:"combineCount"`
	Ores         []Ore             `json:"ores"`
	Stacks       map[string]int    `json:"stacks"`
	Pouches      map[string]string `json:"pouches"`
	Items        []Item            `json:"items"`
	Tome         struct {
		Name  string `json:"name"`
		Value int    `json:"value"`
	} `json:"tome"`
	Affixes []Affix  `json:"affixes"`
	Uniques []Unique `json:"uniques"`
	Names   struct {
		First  []string `json:"first"`
		Second []string `json:"second"`
	} `json:"names"`
	Recipes []Recipe `json:"recipes"`
	Starter []Qty    `json:"starter"`
	Loot    Loot     `json:"loot"`

	items     map[string]*Item
	materials map[string]*Material
	gems      map[string]*Gem
	cuts      map[string]*Cut
	recipes   map[string]*Recipe
	recipeIDs map[int]*Recipe
	uniques   map[string]*Unique
	affixes   map[string]*Affix
}

// D is the loaded table.
var D = mustLoad()

func mustLoad() *Defs {
	d := &Defs{}
	if err := json.Unmarshal(raw, d); err != nil {
		panic(fmt.Sprintf("itemdefs: %v", err))
	}
	d.items = map[string]*Item{}
	for i := range d.Items {
		d.items[d.Items[i].Key] = &d.Items[i]
	}
	d.materials = map[string]*Material{}
	for i := range d.Materials {
		d.materials[d.Materials[i].Key] = &d.Materials[i]
	}
	d.gems = map[string]*Gem{}
	for i := range d.Gems {
		d.gems[d.Gems[i].Key] = &d.Gems[i]
	}
	d.cuts = map[string]*Cut{}
	for i := range d.Cuts {
		d.cuts[d.Cuts[i].Key] = &d.Cuts[i]
	}
	d.recipes = map[string]*Recipe{}
	d.recipeIDs = map[int]*Recipe{}
	for i := range d.Recipes {
		d.recipes[d.Recipes[i].Key] = &d.Recipes[i]
		d.recipeIDs[d.Recipes[i].ID] = &d.Recipes[i]
	}
	d.uniques = map[string]*Unique{}
	for i := range d.Uniques {
		d.uniques[d.Uniques[i].Key] = &d.Uniques[i]
	}
	d.affixes = map[string]*Affix{}
	for i := range d.Affixes {
		d.affixes[d.Affixes[i].Key] = &d.Affixes[i]
	}
	return d
}

// Item returns a base item by key. Tomes ("tome:<spell>") are a family
// resolved by the caller against combatdefs; Item returns a shared tome
// record for any of them.
func (d *Defs) Item(key string) *Item {
	if it := d.items[key]; it != nil {
		return it
	}
	if strings.HasPrefix(key, "tome:") && len(key) > 5 {
		return &Item{Key: key, Name: strings.ReplaceAll(d.Tome.Name, "{spell}", key[5:]), Category: "tome", Kind: "tome", Stack: d.Stacks["tome"], Pouch: "inv", Level: 1, Value: d.Tome.Value, Element: -1}
	}
	return nil
}

// Material by key (nil if unknown).
func (d *Defs) Material(key string) *Material { return d.materials[key] }

// Gem by key.
func (d *Defs) Gem(key string) *Gem { return d.gems[key] }

// Cut by key.
func (d *Defs) Cut(key string) *Cut { return d.cuts[key] }

// CutAfter is the next cut up (nil after brilliant).
func (d *Defs) CutAfter(key string) *Cut {
	c := d.cuts[key]
	if c == nil || c.Tier+1 >= len(d.Cuts) {
		return nil
	}
	return &d.Cuts[c.Tier+1]
}

// Recipe by key.
func (d *Defs) Recipe(key string) *Recipe { return d.recipes[key] }

// RecipeByID by numeric id (the wire uses ids).
func (d *Defs) RecipeByID(id int) *Recipe { return d.recipeIDs[id] }

// Unique by key.
func (d *Defs) Unique(key string) *Unique { return d.uniques[key] }

// Affix by key.
func (d *Defs) Affix(key string) *Affix { return d.affixes[key] }

// RarityByKey returns the tier index (-1 unknown).
func (d *Defs) RarityByKey(key string) int {
	for i, r := range d.Rarities {
		if r.Key == key {
			return i
		}
	}
	return -1
}

// KillsDemons reports whether a weapon or arrow item is made of a material
// that kills demons (spec 8: only sunsteel). WP15's rule check.
func (d *Defs) KillsDemons(itemKey string) bool {
	it := d.Item(itemKey)
	if it == nil {
		return false
	}
	m := it.Material
	if it.Arrow != "" {
		m = it.Arrow
	}
	mat := d.materials[m]
	return mat != nil && mat.KillsDemons
}
