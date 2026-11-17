// Package palace is the sky palaces' interior (playtest 3, CR 044): the
// white-and-gold palace on each sky island (atlas structure kind 9, the
// vertical world's PALACE decoration) is a real building. Its walls, floors,
// ceilings and columns are collision boxes in the towns box layout, appended
// to the towns' list (AppendBoxes) before the collision is indexed, so
// players, enemies, shelter audio and the enemy blocker all see them with
// no new collision code. The layout is contracts/palace.yaml expanded by
// contracts/codegen/lib/palace.mjs (palace_gen.json, embedded); the TS twin
// is client/src/world/palace. The palace turns by quarter turns only, so
// cos and sin are exact and both sides agree to the bit.
package palace

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/vertical"
)

//go:embed palace_gen.json
var raw []byte

// Ward is one of the three wards of the trial (local frame).
type Ward struct {
	Key  string  `json:"key"`
	Name string  `json:"name"`
	Hint string  `json:"hint"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
	Y    float64 `json:"y"`
}

// Pack is a guard pack (local frame).
type Pack struct {
	Room  string   `json:"room"`
	X     float64  `json:"x"`
	Z     float64  `json:"z"`
	Y     float64  `json:"y"`
	Comp  []string `json:"comp"`
	Elite string   `json:"elite"`
}

// Defs is the palace table.
type Defs struct {
	Version        int     `json:"version"`
	FloorAboveTopM float64 `json:"floorAboveTopM"`
	ActiveM        float64 `json:"activeM"`
	ResetS         float64 `json:"resetS"`
	ReachM         float64 `json:"reachM"`
	Boss           string  `json:"boss"`
	Chest          struct {
		Gold      [2]int  `json:"gold"`
		MinRarity int     `json:"minRarity"`
		Items     int     `json:"items"`
		Luck      float64 `json:"luck"`
		CooldownH float64 `json:"cooldownH"`
		X         float64 `json:"x"`
		Z         float64 `json:"z"`
		Y         float64 `json:"y"`
	} `json:"chest"`
	Wards []Ward `json:"wards"`
	Packs []Pack `json:"packs"`
	Door  struct {
		X, Z, Y, W, H float64
	} `json:"door"`
	Shaft struct {
		X, Z, R, Top, Lift float64
	} `json:"shaft"`
	Arena struct {
		X, Z, Y, R float64
	} `json:"arena"`
	Half struct {
		X, Z float64
	} `json:"half"`
	RingY     float64     `json:"ringY"`
	AtriumTop float64     `json:"atriumTop"`
	ThroneTop float64     `json:"throneTop"`
	WallH     float64     `json:"wallH"`
	Boxes     [][]float64 `json:"boxes"`
}

// D is the loaded table.
var D = mustLoad()

func mustLoad() *Defs {
	var d Defs
	if err := json.Unmarshal(raw, &d); err != nil {
		panic(fmt.Sprintf("palace: palace_gen.json: %v", err))
	}
	return &d
}

// Site is one palace placed on its island: X, Z its centre, Floor the
// walkable floor height, Q the quarter turns (0-3), Index the atlas site.
type Site struct {
	Index   int
	X, Z    float64
	Floor   float64
	Q       int
	Cs, Sn  float64
	Visible bool
}

// NewSite places a palace from its decoration (x, y = island top, z, the
// 16-bit yaw, aux = the atlas site index).
func NewSite(index int, x, y, z float64, yaw16 int) Site {
	q := int(math.Round(float64(yaw16)/16384)) & 3
	cs := [4]float64{1, 0, -1, 0}[q]
	// Three's rotateY(a) sends local +x to (cos a, -sin a): towns c = cos a, s = -sin a.
	sn := [4]float64{0, -1, 0, 1}[q]
	return Site{Index: index, X: x, Z: z, Floor: y + D.FloorAboveTopM, Q: q, Cs: cs, Sn: sn}
}

// World maps a local (lx, lz) to world x, z.
func (s Site) World(lx, lz float64) (float64, float64) {
	return s.X + float64(lx*s.Cs) + float64(lz*-s.Sn), s.Z + float64(lx*s.Sn) + float64(lz*s.Cs)
}

// Local maps a world x, z to the palace's frame.
func (s Site) Local(x, z float64) (float64, float64) {
	dx, dz := x-s.X, z-s.Z
	return float64(dx*s.Cs) + float64(dz*s.Sn), float64(dz*s.Cs) - float64(dx*s.Sn)
}

// Inside reports a point within the palace's footprint (plinth), at any height up to the roof.
func (s Site) Inside(x, z float64) bool {
	lx, lz := s.Local(x, z)
	return math.Abs(lx) <= D.Half.X && math.Abs(lz) <= D.Half.Z
}

// AppendBoxes adds every palace's boxes to the towns' box list (indexes of
// the existing boxes never change). Call before indexing the collision.
func AppendBoxes(tw *towns.Towns, sites []Site) {
	b := &tw.Boxes
	for _, s := range sites {
		for _, r := range D.Boxes {
			x, z := s.World(r[2], r[3])
			b.F = append(b.F, x, z, s.Cs, s.Sn, r[4], r[5], r[6]+s.Floor, r[7]+s.Floor, r[8]+s.Floor)
			b.Kind = append(b.Kind, uint8(r[0]))
			b.Flags = append(b.Flags, uint8(r[1]))
			b.Owner = append(b.Owner, 0xFFFF)
		}
	}
}

// Wind is the palace atrium's updraft shaft, one column per palace.
func Wind(sites []Site) movement.Columns {
	cs := make(movement.Columns, 0, len(sites))
	for _, s := range sites {
		x, z := s.World(D.Shaft.X, D.Shaft.Z)
		cs = append(cs, movement.Column{X: x, Z: z, Radius: D.Shaft.R, Top: s.Floor + D.Shaft.Top, Lift: D.Shaft.Lift})
	}
	return cs
}

// DecoKind is the vertical world's PALACE decoration kind (worldgen dk::PALACE).
const DecoKind = 16

// SitesOf is every palace of a vertical world, in descriptor order.
func SitesOf(v *vertical.World) []Site {
	if v == nil {
		return nil
	}
	var out []Site
	for _, d := range v.Decos {
		if d.Kind == DecoKind {
			out = append(out, NewSite(d.Aux, d.X, d.Y, d.Z, d.Yaw))
		}
	}
	return out
}
