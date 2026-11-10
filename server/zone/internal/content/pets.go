package content

import (
	"encoding/json"
	"hash/fnv"
	"math"
	"slices"

	"lodestone/server/pkg/contentdefs"
)

// Pets (playtest 2 taming and companions, CR 029): a character's tamed
// creatures, the pure part (records, the taming roll, levels and stats).
// The zone glue is internal/game/pets.go; the companion in the world is
// internal/combat/pets.go.

// Pet variants.
const (
	VariantPlain     = 0
	VariantShiny     = 1 // gold-touched: +10 % health and damage
	VariantElemental = 2 // takes an element: its bite and ability carry it
)

// variantMult is what a variant adds to health and damage.
func variantMult(v int) float64 {
	switch v {
	case VariantShiny:
		return 1.1
	case VariantElemental:
		return 1.05
	}
	return 1
}

// PetRec is one tamed creature (persisted).
type PetRec struct {
	ID      int     `json:"id"`
	Species string  `json:"sp"`
	Name    string  `json:"n"`
	Variant int     `json:"v,omitempty"`
	Element int     `json:"el"` // elemental variant: its element; else -1
	Level   int     `json:"lv"`
	XP      int     `json:"xp,omitempty"`
	HP      float64 `json:"hp"` // share of its health, 0..1
	KOUntil int64   `json:"ko,omitempty"` // unix ms: knocked out, recovering at home
	TamedAt int64   `json:"at"`
	Kills   int     `json:"k,omitempty"`
}

// Def is the species definition (nil if unknown).
func (r *PetRec) Def() *contentdefs.PetSpecies { return contentdefs.D.PetByKey(r.Species) }

// PetState is a character's pets: every tamed creature (one active, the
// rest in the stable), the next id, and how many taming rolls were made
// (the roll's seed counter).
type PetState struct {
	V      int      `json:"v"`
	Pets   []PetRec `json:"pets,omitempty"`
	Active int      `json:"active,omitempty"` // pet id out with you (0 none)
	Next   int      `json:"next,omitempty"`
	Rolls  int      `json:"rolls,omitempty"`
	Mode   int      `json:"mode,omitempty"` // the active pet's command mode (follow / stay)
}

// LoadPets parses a saved state (empty or bad JSON gives a new one).
func LoadPets(b []byte) *PetState {
	s := &PetState{V: 1}
	if len(b) == 0 || json.Unmarshal(b, s) != nil {
		return &PetState{V: 1}
	}
	s.V = 1
	return s
}

// JSON is the saved form.
func (s *PetState) JSON() []byte {
	b, _ := json.Marshal(s)
	return b
}

// Pet is pet id's record (nil if none).
func (s *PetState) Pet(id int) *PetRec {
	for i := range s.Pets {
		if s.Pets[i].ID == id {
			return &s.Pets[i]
		}
	}
	return nil
}

// ActivePet is the pet out with you (nil if none).
func (s *PetState) ActivePet() *PetRec {
	if s.Active == 0 {
		return nil
	}
	return s.Pet(s.Active)
}

// Full reports a stable with no room for another pet.
func (s *PetState) Full() bool { return len(s.Pets) >= contentdefs.D.Taming.MaxPets }

// Add records a newly tamed pet (it becomes the active one when none is
// out); false when the stable is full.
func (s *PetState) Add(r PetRec) (*PetRec, bool) {
	if s.Full() {
		return nil, false
	}
	s.Next = max(s.Next, maxID(s.Pets)) + 1
	r.ID = s.Next
	s.Pets = append(s.Pets, r)
	if s.Active == 0 {
		s.Active = r.ID
	}
	return &s.Pets[len(s.Pets)-1], true
}

// Release lets pet id go (it leaves the stable for good).
func (s *PetState) Release(id int) bool {
	i := slices.IndexFunc(s.Pets, func(r PetRec) bool { return r.ID == id })
	if i < 0 {
		return false
	}
	s.Pets = slices.Delete(s.Pets, i, i+1)
	if s.Active == id {
		s.Active = 0
	}
	return true
}

func maxID(ps []PetRec) int {
	m := 0
	for _, p := range ps {
		m = max(m, p.ID)
	}
	return m
}

// BestLevel is the highest level among the pets (feat stat petlevel).
func (s *PetState) BestLevel() int {
	m := 0
	for _, p := range s.Pets {
		m = max(m, p.Level)
	}
	return m
}

// PetStats are a pet's numbers at its level and variant.
func PetStats(sp *contentdefs.PetSpecies, level, variant int) (hpMax, damage float64) {
	t := &contentdefs.D.Taming
	l := float64(max(0, level-1))
	vm := variantMult(variant)
	return math.Round(sp.HP * (1 + t.HPPerLevel*l) * vm), sp.Damage * (1 + t.DamagePerLevel*l) * vm
}

// GainXP adds XP and levels up as far as it reaches (levelMax caps);
// it returns the levels gained.
func (r *PetRec) GainXP(xp int) int {
	lm := contentdefs.D.Taming.LevelMax
	if r.Level >= lm || xp <= 0 {
		return 0
	}
	r.XP += xp
	n := 0
	for r.Level < lm {
		need := contentdefs.D.PetXPToNext(r.Level)
		if r.XP < need {
			break
		}
		r.XP -= need
		r.Level++
		n++
	}
	if r.Level >= lm {
		r.XP = 0
	}
	return n
}

// TameRoll is the zone's taming roll: success, then the variant and (for
// an elemental) its element. Deterministic in its inputs: the world seed,
// the character, how many rolls the character made before, the creature
// (entity id) and the food (favourite or not).
type TameRoll struct {
	OK      bool
	Variant int
	Element int // VariantElemental: the element (0-7); else -1
}

// RollTame rolls a taming. regionElement is the element of the region the
// creature was tamed in (0-7, or -1 none: an elemental then rolls one).
func RollTame(worldSeed uint64, character string, rolls int, creature uint32, sp *contentdefs.PetSpecies, favourite bool, regionElement int) TameRoll {
	t := &contentdefs.D.Taming
	h := fnv.New64a()
	_, _ = h.Write([]byte(character))
	x := mix64(worldSeed ^ h.Sum64() ^ uint64(rolls)*0x9e3779b97f4a7c15 ^ uint64(creature)*0xbf58476d1ce4e5b9 ^ 0x7a3e)
	chance := sp.Chance
	if favourite {
		chance += t.FavouriteBonus
	}
	out := TameRoll{Element: -1}
	out.OK = unit64(x) < math.Min(0.99, chance)
	if !out.OK {
		return out
	}
	v := unit64(mix64(x + 1))
	switch {
	case v < t.ShinyChance:
		out.Variant = VariantShiny
	case v < t.ShinyChance+t.ElementalChance:
		out.Variant = VariantElemental
		out.Element = regionElement
		if out.Element < 0 || out.Element > 7 {
			out.Element = int(mix64(x+2) % 8)
		}
	}
	return out
}

// TameTime is how long the taming meter takes (favourite food: faster).
func TameTime(sp *contentdefs.PetSpecies, favourite bool) float64 {
	if favourite {
		return sp.TameS * contentdefs.D.Taming.FavouriteMult
	}
	return sp.TameS
}

// LikedFood is the best food in have (favourite first) the species likes
// ("" none); have reports how many of an item the character carries.
func LikedFood(sp *contentdefs.PetSpecies, have func(item string) int) (item string, favourite bool) {
	for i, f := range sp.Foods {
		if have(f) > 0 {
			return f, i == 0
		}
	}
	return "", false
}

func mix64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

func unit64(h uint64) float64 { return float64(h>>11) / float64(1<<53) }

// Tamed records a tame in the content state (feats: tamed, tamedspecies, shinytamed).
func (s *State) Tamed(species string, shiny bool) (first bool) {
	s.dirty = true
	if s.TamedKinds == nil {
		s.TamedKinds = map[string]int{}
	}
	first = s.TamedKinds[species] == 0
	s.TamedKinds[species]++
	bump(&s.Stats, "tamed", 1)
	if shiny {
		bump(&s.Stats, "shinytamed", 1)
	}
	return first
}
