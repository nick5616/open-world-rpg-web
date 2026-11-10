package content

import (
	"math"
	"sort"
	"strings"

	"lodestone/server/pkg/contentdefs"
)

// Sealed vaults (CR 022 dungeons): one per atlas region, under the smaller
// ruin nearest the region's middle (else a shrine). A vault has a seal (a
// puzzle: three levers in an order its inscription gives, three pressure
// stones held at once, two braziers lit with fire magic, or a weeping font
// stilled with ice magic), elite packs in its yard, a keeper (a boss with
// a telegraphed sigil) that wakes when the seal opens, and a chest with a
// guaranteed rare. Everything here is the plan (pure, seeded); the live
// state is the glue's (internal/game/dungeons.go).

// Part kinds.
const (
	PartLever   = "lever"
	PartPlate   = "plate"
	PartBrazier = "brazier"
	PartFont    = "font"
	PartDoor    = "door"
	PartChest   = "chest"
)

// Part is a thing in a vault yard you use or stand on.
type Part struct {
	ID    int // 1-based within the vault
	Kind  string
	Label string
	X, Z  float64
	Glyph int // levers: 0 sun, 1 moon, 2 star
}

// Vault is one dungeon's plan.
type Vault struct {
	Site   Site
	Name   string
	Puzzle *contentdefs.Puzzle
	Hint   string
	Order  []int // levers: the glyph order that opens the seal
	Parts  []Part
	Door   Part // the vault door: the keeper rises here
	Chest  Part
	Packs  [][2]float64
	Region int
}

// Glyphs name the levers.
var Glyphs = [3]string{"the sun", "the moon", "the star"}

// PickVaultSites chooses one vault site per region: the ruin smaller than a
// boss ruin nearest the region's middle, else the nearest shrine.
func PickVaultSites(sites []Site, regionCentre func(r int) (float64, float64), regions int) []Site {
	var out []Site
	for r := 0; r < regions; r++ {
		cx, cz := regionCentre(r)
		best := -1
		bd := math.Inf(1)
		for pass := 0; pass < 2 && best < 0; pass++ {
			for i, s := range sites {
				if s.Region != r {
					continue
				}
				if pass == 0 && !(s.Kind == SiteRuin && s.Size < 2) || pass == 1 && s.Kind != SiteShrine {
					continue
				}
				if d := math.Hypot(s.X-cx, s.Z-cz); d < bd || d == bd && s.Index < sites[best].Index {
					best, bd = i, d
				}
			}
		}
		if best >= 0 {
			out = append(out, sites[best])
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

// PlanVault lays out site's vault (deterministic per world seed and site).
func PlanVault(seed uint64, s Site) *Vault {
	dg := &contentdefs.D.Dungeons
	h := mix(seed ^ 0x7a017 ^ uint64(s.Index)*0x9e3779b97f4a7c15)
	pz := &dg.Puzzles[int(h%uint64(len(dg.Puzzles)))]
	v := &Vault{Site: s, Puzzle: pz, Region: s.Region}
	v.Name = Fill(dg.Names[int(mix(h+1)%uint64(len(dg.Names)))], map[string]string{"site": placeName(s)})
	base := mix(h+2) % 628
	rot := float64(base) / 100
	ring := math.Max(s.R*0.55, 7) + 3
	at := func(a, r float64) (float64, float64) { return s.X + r*math.Cos(rot+a), s.Z + r*math.Sin(rot+a) }
	v.Door = Part{ID: 100, Kind: PartDoor, Label: "Vault door"}
	v.Door.X, v.Door.Z = at(0, ring*0.35)
	v.Chest = Part{ID: 101, Kind: PartChest, Label: "Vault chest"}
	v.Chest.X, v.Chest.Z = at(math.Pi, ring*0.35)
	n := pz.Parts
	for i := 0; i < n; i++ {
		a := math.Pi/2 + float64(i)*(math.Pi/float64(max(1, n)))
		if n == 1 {
			a = math.Pi / 2
		}
		p := Part{ID: i + 1, Label: ""}
		p.X, p.Z = at(a, ring)
		switch pz.Key {
		case "levers":
			p.Kind, p.Glyph = PartLever, i
			p.Label = "Lever of " + strings.TrimPrefix(Glyphs[i], "the ")
		case "plates":
			p.Kind, p.Label = PartPlate, "Pressure stone"
		case "braziers":
			p.Kind, p.Label = PartBrazier, "Cold brazier"
		case "font":
			p.Kind, p.Label = PartFont, "Weeping font"
			p.X, p.Z = at(0, ring*0.8)
		}
		v.Parts = append(v.Parts, p)
	}
	if pz.Key == "levers" {
		v.Order = []int{0, 1, 2}
		for i := 2; i > 0; i-- {
			j := int(mix(h+uint64(10+i)) % uint64(i+1))
			v.Order[i], v.Order[j] = v.Order[j], v.Order[i]
		}
		words := make([]string, 3)
		for i, g := range v.Order {
			words[i] = Glyphs[g]
		}
		order := capFirst(words[0]) + ", then " + words[1] + ", then " + words[2]
		v.Hint = strings.ReplaceAll(pz.Hint, "{order}", order)
	} else {
		v.Hint = strings.ReplaceAll(pz.Hint, "{hold}", strconvF(pz.HoldS))
	}
	for i := 0; i < 2; i++ {
		x, z := at(float64(i)*math.Pi+math.Pi/4, ring+9)
		v.Packs = append(v.Packs, [2]float64{x, z})
	}
	return v
}

func strconvF(v float64) string {
	if v == math.Trunc(v) {
		return itoa(int(v))
	}
	return itoa(int(math.Round(v)))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// Part returns the vault part with id (nil if none).
func (v *Vault) Part(id int) *Part {
	for i := range v.Parts {
		if v.Parts[i].ID == id {
			return &v.Parts[i]
		}
	}
	switch id {
	case v.Door.ID:
		return &v.Door
	case v.Chest.ID:
		return &v.Chest
	}
	return nil
}

// Seal is a vault seal's live state (the glue owns one per active vault).
type Seal struct {
	V       *Vault
	Pulled  []int     // levers pulled so far (glyphs)
	Until   []float64 // plates: down until (s); braziers/font: lit/stilled
	Lit     []bool
	Open    bool
	Changed bool // something visible changed since the last Take
}

// NewSeal is a closed seal.
func NewSeal(v *Vault) *Seal {
	return &Seal{V: v, Until: make([]float64, len(v.Parts)), Lit: make([]bool, len(v.Parts))}
}

// Lever pulls lever part id; wrong reports a wrong order (the levers reset).
func (s *Seal) Lever(id int) (ok, wrong bool) {
	p := s.V.Part(id)
	if s.Open || p == nil || p.Kind != PartLever {
		return false, false
	}
	for _, g := range s.Pulled {
		if g == p.Glyph {
			return false, false
		}
	}
	s.Changed = true
	if s.V.Order[len(s.Pulled)] != p.Glyph {
		s.Pulled = s.Pulled[:0]
		return true, true
	}
	s.Pulled = append(s.Pulled, p.Glyph)
	if len(s.Pulled) == len(s.V.Order) {
		s.Open = true
	}
	return true, false
}

// Press holds plate id down until now + holdS (someone stands on it).
func (s *Seal) Press(id int, now float64) {
	p := s.V.Part(id)
	if s.Open || p == nil || p.Kind != PartPlate {
		return
	}
	i := id - 1
	if s.Until[i] < now {
		s.Changed = true
	}
	s.Until[i] = now + s.V.Puzzle.HoldS
	all := true
	for k := range s.V.Parts {
		all = all && s.Until[k] >= now
	}
	if all {
		s.Open, s.Changed = true, true
	}
}

// Down reports plate id held at now.
func (s *Seal) Down(id int, now float64) bool {
	i := id - 1
	return i >= 0 && i < len(s.Until) && s.Until[i] >= now
}

// Kindle lights brazier / stills font id with element ("fire" / "ice").
func (s *Seal) Kindle(id int, element string) bool {
	p := s.V.Part(id)
	if s.Open || p == nil || (p.Kind != PartBrazier && p.Kind != PartFont) || element != s.V.Puzzle.Element || s.Lit[id-1] {
		return false
	}
	s.Lit[id-1], s.Changed = true, true
	all := true
	for _, l := range s.Lit {
		all = all && l
	}
	if all {
		s.Open = true
	}
	return true
}

// Lowered reports plates that rose since now-1 s (a re-send for clients).
func (s *Seal) Lowered(now float64) bool {
	for i := range s.Until {
		if s.Until[i] > 0 && s.Until[i] < now && s.Until[i] >= now-1.0/15 {
			return true
		}
	}
	return false
}
