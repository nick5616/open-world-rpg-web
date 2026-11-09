// Package towns reads worldgen's towns buffer (WP20: settlements,
// buildings, collision boxes, props, NPCs, roads, bridges, signposts,
// structures; layout in worldgen/README.md "Towns") and answers the
// building collision queries the zone's movement ground needs.
//
// The queries are a line-for-line port of worldgen/js/src/town.ts (client
// prediction runs that): same f64 operation order over the buffer's f32
// values widened exactly, every product feeding a sum wrapped in float64()
// so arm64/ppc64 never fuse it into an FMA, no host math beyond sqrt. The
// golden table's town floor/collide vectors pin both sides bit for bit
// (TestGoldenTownQueries).
package towns

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Magic is "LDTW" read as a little-endian u32.
const Magic = 0x5754444c

// Format is the towns buffer format this package reads.
const Format = 1

const (
	headerLen  = 64
	dirEntries = 16
	none       = 0xFFFF
)

// Section ids and record sizes (worldgen/README.md "Towns").
const (
	SecSettlements = iota
	SecBuildings
	SecBoxes
	SecProps
	SecNPCs
	SecRoads
	SecPoints
	SecBridges
	SecSigns
	SecStructures
	SecPieces
	SecVeins
	SecNames
)

var recSize = [13]int{64, 96, 40, 32, 40, 24, 12, 48, 32, 56, 40, 32, 0}

// Box flags.
const (
	FlagWalk  = 1
	FlagSolid = 2
	FlagCeil  = 4
)

// Prop kinds used by the zone (full table in worldgen/README.md).
const (
	PropDoor      = 0
	PropChest     = 5
	PropCounter   = 9
	PropForge     = 10
	PropAnvil     = 11
	PropWorkbench = 13
	PropStall     = 14
	PropBoard     = 15
	PropStarmetal = 24
)

// Prop flags.
const (
	PropInteract = 1
	PropLight    = 2
)

// NPC roles.
const (
	RoleVillager   = 0
	RoleMerchant   = 1
	RoleBlacksmith = 2
	RoleInnkeeper  = 3
	RoleBounty     = 4
	RoleFarmer     = 5
	RoleGuard      = 6
)

// RoleNames are the NPC role names by id.
var RoleNames = [7]string{"villager", "merchant", "blacksmith", "innkeeper", "bounty keeper", "farmer", "guard"}

// Building roles.
const (
	BuildingHouse      = 0
	BuildingInn        = 1
	BuildingForge      = 2
	BuildingStall      = 3
	BuildingGarden     = 4
	BuildingFarm       = 5
	BuildingWorkshop   = 6
	BuildingStorehouse = 7
)

// Structure kinds (atlas site kinds of category structure).
const (
	StructRuin = iota
	StructWatchtower
	StructMineshaft
	StructShrine
	StructBanditCamp
	StructWizardTower
	StructMeteorCrater
	StructSunkenTemple
	StructDemonLair
)

// Towns-buffer structure kinds beyond the atlas ones (genVersion 2:
// landmarks and enemy camps are built too).
const (
	StructLandmark  = 9
	StructEnemyCamp = 10
)

// StructureNames are the towns-buffer structure kind names by id.
var StructureNames = [11]string{"ruin", "watchtower", "mineshaft", "shrine", "bandit camp", "wizard tower", "meteor crater", "sunken temple", "demon lair", "landmark", "camp"}

// Road classes. A footpath (genVersion 2) has From = the building it serves
// (-1 none) and To = the footpath it joins (-1: it ends on a street or the
// square); its first point is the foot of the door steps.
const (
	ClassRoad   = 0
	ClassStreet = 1
	ClassPath   = 2
)

// Building flags (worldgen/README.md "Towns"); Stepped and Posts are the
// genVersion 2 foundations.
const (
	BuildingPorch   = 1
	BuildingStilts  = 4
	BuildingStepped = 64
	BuildingPosts   = 128
)

// Settlement is one settlement layout.
type Settlement struct {
	Index                    int
	ID                       uint64
	Site                     int
	Size, Style, Region      uint8
	Walled                   bool
	WallR                    float64 // town wall radius (m, 0 = none)
	X, Y, Z, Radius, Square  float64
	BuildingFirst, Buildings int
	NPCFirst, NPCs           int
	PropFirst, Props         int
	BoxFirst, Boxes          int
	RoadFirst, Roads         int
}

// Building is one building (local u along the frontage, v away from the
// street; the door is on the -v wall).
type Building struct {
	Index                 int
	ID                    uint64
	Settlement            int
	Role, Style           uint8
	X, Z, FloorY, BaseY   float64
	HX, HZ, C, S          float64
	Storey, RoofH         float64
	Floors, Roof, Flags   uint8
	RidgeU                bool
	DoorU, DoorW          float64
	BoxFirst, Boxes       int
	PropFirst, Props      int
	Street                int // road index the door faces, -1 the square
	FrontX, FrontZ, Along float64
}

// Door returns the world point just outside (out > 0) or inside (out < 0)
// the building's door, at floor height.
func (b *Building) Door(out float64) (x, z float64) {
	u, v := b.DoorU, -b.HZ-out
	return b.X + float64(u*b.C) - float64(v*b.S), b.Z + float64(u*b.S) + float64(v*b.C)
}

// Local returns the world point of local (u, v).
func (b *Building) Local(u, v float64) (x, z float64) {
	return b.X + float64(u*b.C) - float64(v*b.S), b.Z + float64(u*b.S) + float64(v*b.C)
}

// Prop is one prop (furniture, dressing, interaction point).
type Prop struct {
	Index                           int
	ID                              uint64
	X, Y, Z, Yaw                    float64
	Kind, Variant, Flags, Scale     uint8
	Building, Settlement, Structure int
}

// NPC is one townsperson.
type NPC struct {
	Index                      int
	ID                         uint64
	Settlement                 int
	Role, Variant, Merchant    uint8
	Name                       string
	Home, Work, WorkProp       int
	WorkX, WorkZ, HomeX, HomeZ float64
	WorkYaw                    float64
}

// Road is a road (Class 0), a town street (Class 1) or a footpath (Class 2):
// x, y, z points.
type Road struct {
	Index          int
	Points         [][3]float64
	From, To       int
	Width, Length  float64
	Class, Surface uint8
	Settlement     int
}

// Structure is one jigsaw structure.
type Structure struct {
	Index              int
	ID                 uint64
	Site               int
	Kind, Tier         uint8
	X, Y, Z, Radius    float64
	PieceFirst, Pieces int
	PropFirst, Props   int
	BoxFirst, Boxes    int
	Link               int // mineshafts: nearest cave-mouth site index, -1 none
}

// Vein is a starmetal cluster at a meteor crater (cave vein record).
type Vein struct {
	ID             uint64
	X, Y, Z        float64
	Material, Elem uint8
	HP             uint16
	Size           uint8
}

// Boxes holds the collision boxes: 9 f64 per box (cx, cz, c, s, hx, hz,
// y0, y1, y2; f32 values widened) and flags.
type Boxes struct {
	F     []float64
	Kind  []uint8
	Flags []uint8
	Owner []uint16
}

// Len is the number of boxes.
func (b *Boxes) Len() int { return len(b.Flags) }

// Towns is a parsed towns buffer.
type Towns struct {
	GenVersion  uint16
	Seed        uint64
	Settlements []Settlement
	Buildings   []Building
	Boxes       Boxes
	Props       []Prop
	NPCs        []NPC
	Roads       []Road
	Bridges     int
	Signs       int
	Structures  []Structure
	Pieces      int
	Veins       []Vein
	Names       []string
}

func opt(v uint16) int {
	if v == none {
		return -1
	}
	return int(v)
}

func turn(v uint16) float64 { return float64(v) / 65536 * 2 * math.Pi }

// Parse reads a towns buffer.
func Parse(b []byte) (*Towns, error) {
	if len(b) < headerLen+dirEntries*16 {
		return nil, errors.New("towns: buffer too short")
	}
	le := binary.LittleEndian
	if le.Uint32(b) != Magic {
		return nil, errors.New("towns: bad magic")
	}
	if f := le.Uint16(b[4:]); f != Format {
		return nil, fmt.Errorf("towns: format %d, this reader reads %d", f, Format)
	}
	if int(le.Uint32(b[8:])) > len(b) {
		return nil, errors.New("towns: truncated")
	}
	type sec struct{ off, count, n int }
	var secs [dirEntries]sec
	for i := range secs {
		p := headerLen + i*16
		secs[i] = sec{int(le.Uint32(b[p:])), int(le.Uint32(b[p+4:])), int(le.Uint32(b[p+8:]))}
		if secs[i].off+secs[i].n > len(b) {
			return nil, fmt.Errorf("towns: section %d out of bounds", i)
		}
	}
	u16 := func(o int) uint16 { return le.Uint16(b[o:]) }
	u32 := func(o int) int { return int(le.Uint32(b[o:])) }
	u64 := func(o int) uint64 { return le.Uint64(b[o:]) }
	f32 := func(o int) float64 { return float64(math.Float32frombits(le.Uint32(b[o:]))) }
	rec := func(id, i int) int { return secs[id].off + i*recSize[id] }

	t := &Towns{GenVersion: u16(6), Seed: u64(16)}
	nm := secs[SecNames]
	for i, o := 0, nm.off; i < nm.count; i++ {
		l := int(u16(o))
		t.Names = append(t.Names, string(b[o+2:o+2+l]))
		o += 2 + l
	}
	for i := 0; i < secs[SecSettlements].count; i++ {
		o := rec(SecSettlements, i)
		t.Settlements = append(t.Settlements, Settlement{
			Index: i, ID: u64(o), Site: int(u16(o + 8)), Size: b[o+10], Style: b[o+11], Walled: b[o+12] != 0, WallR: float64(b[o+13]), Region: b[o+14],
			X: f32(o + 16), Y: f32(o + 20), Z: f32(o + 24), Radius: f32(o + 28), Square: f32(o + 32),
			BuildingFirst: int(u16(o + 36)), Buildings: int(u16(o + 38)), NPCFirst: int(u16(o + 40)), NPCs: int(u16(o + 42)),
			PropFirst: u32(o + 44), Props: u32(o + 48), BoxFirst: u32(o + 52), Boxes: u32(o + 56), RoadFirst: int(u16(o + 60)), Roads: int(u16(o + 62)),
		})
	}
	for i := 0; i < secs[SecBuildings].count; i++ {
		o := rec(SecBuildings, i)
		t.Buildings = append(t.Buildings, Building{
			Index: i, ID: u64(o), Settlement: opt(u16(o + 8)), Role: b[o+10], Style: b[o+11],
			X: f32(o + 12), Z: f32(o + 16), FloorY: f32(o + 20), BaseY: f32(o + 24), HX: f32(o + 28), HZ: f32(o + 32), C: f32(o + 36), S: f32(o + 40),
			Storey: f32(o + 44), RoofH: f32(o + 48), Floors: b[o+52], Roof: b[o+53], RidgeU: b[o+54] != 0, Flags: b[o+55],
			DoorU: f32(o + 56), DoorW: f32(o + 60), Boxes: int(u16(o + 66)), BoxFirst: u32(o + 68), PropFirst: u32(o + 72), Props: int(u16(o + 76)),
			Street: opt(u16(o + 78)), FrontX: f32(o + 80), FrontZ: f32(o + 84), Along: f32(o + 88),
		})
	}
	nb := secs[SecBoxes].count
	t.Boxes = Boxes{F: make([]float64, nb*9), Kind: make([]uint8, nb), Flags: make([]uint8, nb), Owner: make([]uint16, nb)}
	for i := 0; i < nb; i++ {
		o := rec(SecBoxes, i)
		for k := 0; k < 9; k++ {
			t.Boxes.F[i*9+k] = f32(o + k*4)
		}
		t.Boxes.Kind[i] = b[o+36]
		t.Boxes.Flags[i] = b[o+37]
		t.Boxes.Owner[i] = u16(o + 38)
	}
	for i := 0; i < secs[SecProps].count; i++ {
		o := rec(SecProps, i)
		t.Props = append(t.Props, Prop{
			Index: i, ID: u64(o), X: f32(o + 8), Y: f32(o + 12), Z: f32(o + 16), Yaw: turn(u16(o + 20)), Kind: b[o+22], Variant: b[o+23],
			Building: opt(u16(o + 24)), Settlement: opt(u16(o + 26)), Flags: b[o+28], Scale: b[o+29], Structure: opt(u16(o + 30)),
		})
	}
	for i := 0; i < secs[SecNPCs].count; i++ {
		o := rec(SecNPCs, i)
		name := ""
		if n := int(u16(o + 12)); n < len(t.Names) {
			name = t.Names[n]
		}
		t.NPCs = append(t.NPCs, NPC{
			Index: i, ID: u64(o), Settlement: int(u16(o + 8)), Role: b[o+10], Variant: b[o+11], Name: name,
			Home: opt(u16(o + 14)), Work: opt(u16(o + 16)), WorkProp: opt(u16(o + 18)),
			WorkX: f32(o + 20), WorkZ: f32(o + 24), HomeX: f32(o + 28), HomeZ: f32(o + 32), WorkYaw: turn(u16(o + 36)), Merchant: b[o+38],
		})
	}
	pts := secs[SecPoints]
	for i := 0; i < secs[SecRoads].count; i++ {
		o := rec(SecRoads, i)
		first, n := u32(o), u32(o+4)
		r := Road{Index: i, From: opt(u16(o + 8)), To: opt(u16(o + 10)), Width: f32(o + 12), Class: b[o+16], Surface: b[o+17], Settlement: opt(u16(o + 18)), Length: f32(o + 20)}
		for k := 0; k < n; k++ {
			p := pts.off + (first+k)*12
			r.Points = append(r.Points, [3]float64{f32(p), f32(p + 4), f32(p + 8)})
		}
		t.Roads = append(t.Roads, r)
	}
	t.Bridges = secs[SecBridges].count
	t.Signs = secs[SecSigns].count
	t.Pieces = secs[SecPieces].count
	for i := 0; i < secs[SecStructures].count; i++ {
		o := rec(SecStructures, i)
		t.Structures = append(t.Structures, Structure{
			Index: i, ID: u64(o), Site: int(u16(o + 8)), Kind: b[o+10], Tier: b[o+11], X: f32(o + 12), Y: f32(o + 16), Z: f32(o + 20), Radius: f32(o + 24),
			PieceFirst: u32(o + 28), Pieces: int(u16(o + 32)), Props: int(u16(o + 34)), BoxFirst: u32(o + 36), Boxes: u32(o + 40), PropFirst: u32(o + 44), Link: opt(u16(o + 48)),
		})
	}
	for i := 0; i < secs[SecVeins].count; i++ {
		o := rec(SecVeins, i)
		t.Veins = append(t.Veins, Vein{ID: u64(o), X: f32(o + 8), Y: f32(o + 12), Z: f32(o + 16), Material: b[o+24], Elem: b[o+25], HP: u16(o + 26), Size: b[o+28]})
	}
	return t, nil
}
