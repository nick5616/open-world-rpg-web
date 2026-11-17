// Package campdefs is the Go view of contracts/camps.yaml (playtest 2,
// CR 025): camp pieces, placement rules, decay, the campfire and the Rested
// buff. `npm run gen` normalizes the YAML into camps_gen.json (embedded
// here) and into the client's contracts/ts/src/gen/camps.ts from the same
// object, so the zone, the placement preview and the collision twin agree on
// every number.
package campdefs

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed camps_gen.json
var raw []byte

// Piece is one placeable camp piece (ID = its 1-based order in camps.yaml).
type Piece struct {
	Key    string  `json:"key"`
	ID     int     `json:"id"`
	Name   string  `json:"name"`
	Kit    string  `json:"kit"`
	W      float64 `json:"w"` // footprint width (local x), m
	D      float64 `json:"d"` // footprint depth (local z), m
	Height float64 `json:"height"`
	Solid  bool    `json:"solid"`
	Max    int     `json:"max"`
	Desc   string  `json:"desc"`
	// Build is set for the building pieces (CR 041, contracts/build.yaml).
	Build *Shape `json:"build,omitempty"`
}

// Pt is a socket point in a piece's local frame: x, z, y in centimetres.
type Pt [3]int

// Box6 is a local box in centimetres: x0, x1, z0, z1, y0, y1.
type Box6 [6]int

// Cost is an item and how many.
type Cost struct {
	Item string `json:"item"`
	Qty  int    `json:"qty"`
}

// Shape is a building piece's grid class, sockets, boxes and costs (CR 041).
type Shape struct {
	Cat       string   `json:"cat"` // structure | furnish
	Base      string   `json:"base"`
	Mat       int      `json:"mat"` // index into Build.Materials, -1 none
	Par       *[2]int  `json:"par"` // cm parity of the position at rot 0 (0 even, 100 odd); nil: every 0.5 m
	Anchor    []string `json:"anchor"`
	Gpt       [2]int   `json:"gpt"`
	Boxes     []Box6   `json:"boxes"`
	OpenBoxes *[]Box6  `json:"openBoxes"`
	Door      bool     `json:"door"`
	Surface   *Box6    `json:"surface"` // walkable: x0, x1, z0, z1, y at x0, y at x1
	Occ       Box6     `json:"occ"`
	Up        []Pt     `json:"up"`
	Down      []Pt     `json:"down"`
	Side      []Pt     `json:"side"`
	Face      []Pt     `json:"face"`
	Reach     int      `json:"reach"`
	Coexist   []string `json:"coexist"`
	Cost      []Cost   `json:"cost"`
	Comfort   int      `json:"comfort"`
	Use       string   `json:"use"`
	Slots     int      `json:"slots"`
	Light     int      `json:"light"`
}

// Material is a building material (CR 041).
type Material struct {
	Key     string  `json:"key"`
	Index   int     `json:"index"`
	Name    string  `json:"name"`
	Weather float64 `json:"weather"`
}

// BuildCfg is build.yaml's numbers (CR 041).
type BuildCfg struct {
	Grid struct {
		CellM     float64 `json:"cellM"`
		LevelM    float64 `json:"levelM"`
		MaxLevels int     `json:"maxLevels"`
	} `json:"grid"`
	Budget       int     `json:"budget"`
	AreaBudget   int     `json:"areaBudget"`
	ReachM       float64 `json:"reachM"`
	TownMarginM  float64 `json:"townMarginM"`
	SiteMarginM  float64 `json:"siteMarginM"`
	RoadMarginM  float64 `json:"roadMarginM"`
	OtherBuildM  float64 `json:"otherBuildM"`
	RefundPct    float64 `json:"refundPct"`
	RepairPct    float64 `json:"repairPct"`
	WeatherFloor float64 `json:"weatherFloor"`
	MendPerDay   float64 `json:"mendPerDay"`
	DecayDays    float64 `json:"decayDays"`
	Foundation   struct {
		MaxSpreadM float64 `json:"maxSpreadM"`
		MaxBuriedM float64 `json:"maxBuriedM"`
		SkirtM     float64 `json:"skirtM"`
		SnapM      float64 `json:"snapM"`
	} `json:"foundation"`
	MaxHeightM float64 `json:"maxHeightM"`
	Hearth     struct {
		WardRadiusM float64 `json:"wardRadiusM"`
		WarmthM     float64 `json:"warmthM"`
	} `json:"hearth"`
	Comfort struct {
		RadiusM    float64 `json:"radiusM"`
		PerKindCap int     `json:"perKindCap"`
		MaxScore   int     `json:"maxScore"`
		Tiers      []struct {
			Score int    `json:"score"`
			Name  string `json:"name"`
		} `json:"tiers"`
		DurationPct float64 `json:"durationPct"`
		RegenPct    float64 `json:"regenPct"`
	} `json:"comfort"`
	Home struct {
		CooldownS float64 `json:"cooldownS"`
	} `json:"home"`
	Materials []Material `json:"materials"`
}

// Defs is the whole table.
type Defs struct {
	Version int `json:"version"`
	Limits  struct {
		MaxPieces   int     `json:"maxPieces"`
		CampRadiusM float64 `json:"campRadiusM"`
		ReachM      float64 `json:"reachM"`
	} `json:"limits"`
	Placement struct {
		RotSteps    int     `json:"rotSteps"`
		MaxSlopeDeg float64 `json:"maxSlopeDeg"`
		MaxSpreadM  float64 `json:"maxSpreadM"`
		TownMarginM float64 `json:"townMarginM"`
		OtherCampM  float64 `json:"otherCampM"`
		GapM        float64 `json:"gapM"`
		BodyClearM  float64 `json:"bodyClearM"`
		MaxDepthM   float64 `json:"maxDepthM"`
	} `json:"placement"`
	Decay struct {
		Days        float64 `json:"days"`
		VisitM      float64 `json:"visitM"`
		CheckEveryS float64 `json:"checkEveryS"`
	} `json:"decay"`
	Fire struct {
		Wood         string  `json:"wood"`
		KitHours     float64 `json:"kitHours"`
		HoursPerWood float64 `json:"hoursPerWood"`
		MaxHours     float64 `json:"maxHours"`
		SafeRadiusM  float64 `json:"safeRadiusM"`
		WarmthM      float64 `json:"warmthM"`
	} `json:"fire"`
	Rested struct {
		DurationS     float64 `json:"durationS"`
		FireBonusS    float64 `json:"fireBonusS"`
		StaminaBonus  float64 `json:"staminaBonus"`
		RegenMult     float64 `json:"regenMult"`
		ManaRegenMult float64 `json:"manaRegenMult"`
		CombatLockS   float64 `json:"combatLockS"`
	} `json:"rested"`
	Chest struct {
		Slots int `json:"slots"`
	} `json:"chest"`
	Build  BuildCfg `json:"build"`
	Pieces []Piece  `json:"pieces"`

	byID  map[int]*Piece
	byKey map[string]*Piece
}

// D is the parsed table.
var D = func() *Defs {
	var d Defs
	if err := json.Unmarshal(raw, &d); err != nil {
		panic(fmt.Sprintf("campdefs: %v", err))
	}
	d.byID = make(map[int]*Piece, len(d.Pieces))
	d.byKey = make(map[string]*Piece, len(d.Pieces))
	for i := range d.Pieces {
		d.byID[d.Pieces[i].ID] = &d.Pieces[i]
		d.byKey[d.Pieces[i].Key] = &d.Pieces[i]
	}
	return &d
}()

// Kind ids (camps.yaml order; the zone's rules name these five).
var (
	Campfire  = D.ByKey("campfire").ID
	Bedroll   = D.ByKey("bedroll").ID
	Chest     = D.ByKey("chest").ID
	Workbench = D.ByKey("workbench").ID
	Signpost  = D.ByKey("signpost").ID
)

// ByID is piece kind id's definition (nil if none).
func (d *Defs) ByID(id int) *Piece { return d.byID[id] }

// ByKey is the piece with key k (nil if none).
func (d *Defs) ByKey(k string) *Piece { return d.byKey[k] }

// ByKit is the piece a kit item places (nil if none).
func (d *Defs) ByKit(item string) *Piece {
	for i := range d.Pieces {
		if d.Pieces[i].Kit != "" && d.Pieces[i].Kit == item {
			return &d.Pieces[i]
		}
	}
	return nil
}
