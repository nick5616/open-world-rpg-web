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
	Pieces []Piece `json:"pieces"`
}

// D is the parsed table.
var D = func() *Defs {
	var d Defs
	if err := json.Unmarshal(raw, &d); err != nil {
		panic(fmt.Sprintf("campdefs: %v", err))
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
func (d *Defs) ByID(id int) *Piece {
	if id < 1 || id > len(d.Pieces) {
		return nil
	}
	return &d.Pieces[id-1]
}

// ByKey is the piece with key k (nil if none).
func (d *Defs) ByKey(k string) *Piece {
	for i := range d.Pieces {
		if d.Pieces[i].Key == k {
			return &d.Pieces[i]
		}
	}
	return nil
}

// ByKit is the piece a kit item places (nil if none).
func (d *Defs) ByKit(item string) *Piece {
	for i := range d.Pieces {
		if d.Pieces[i].Kit == item {
			return &d.Pieces[i]
		}
	}
	return nil
}
