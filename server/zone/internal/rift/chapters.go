package rift

// Chapters, enemy archetypes and how a stage is made (CR 040). Every name
// here is an original proposal awaiting Nicole's approval (the CR lists
// them); renaming is one string.

import "math"

// Stages per chapter; a mini-boss every BossEvery, the chapter boss last.
const (
	Stages    = 50
	BossEvery = 10
)

// Chapter is one themed run of 50 stages.
type Chapter struct {
	N        int
	Key      string
	Name     string
	MinLevel int    // the run's enemy level is at least this
	Color    string // the client's accent (portal, room light)
	Bodies   [3]string
	MiniBoss [4]string // stages 10, 20, 30, 40
	Boss     string    // stage 50
	BossBody string
	Special  int // the chapter's signature pattern kind (bosses lean on it)
}

// Chapters, by area difficulty (a portal's chapter is its area's tier).
var Chapters = []Chapter{
	{1, "emberglass", "Emberglass Steps", 1, "#ff8a3d", [3]string{"ember_imp", "spark_wisp", "sentinel"}, [4]string{"Kiln Warden", "Slag Herald", "Bellows Matron", "Furnace Choir"}, "The Cinder Orrery", "starfall_sentinel", KindSpiral},
	{2, "drowned", "The Drowned Atrium", 5, "#5cc8ff", [3]string{"frost_mote", "wisp", "sentinel"}, [4]string{"Tidebell Keeper", "Brine Lantern", "Undertow Sister", "The Pale Current"}, "The Sunken Chime", "starfall_sentinel", KindBounce},
	{3, "thornvault", "Thornvault", 9, "#8fdc6a", [3]string{"lumen_moth", "moss_slime", "mud_golem"}, [4]string{"Briar Matron", "Seedcaller", "Root Regent", "The Green Knot"}, "The Rootcrown", "starfall_sentinel", KindWall},
	{4, "stormcrown", "Stormcrown Spire", 14, "#c9a6ff", [3]string{"spark_wisp", "gale_harpy", "sentinel"}, [4]string{"Thunder Loom", "Static Abbot", "Gale Weaver", "The Bright Coil"}, "The Storm Engine", "starfall_sentinel", KindLaser},
	{5, "hollowstar", "The Hollow Star", 20, "#ff6bd5", [3]string{"void_mite", "shade", "starfall_sentinel"}, [4]string{"Null Choir", "Quiet Prism", "Hollow Regent", "The Last Facet"}, "The Starless Lens", "starfall_sentinel", KindSeeker},
}

// ChapterFor is the chapter a portal in an area of this level opens onto.
func ChapterFor(areaLevel int) int {
	switch {
	case areaLevel >= 20:
		return 5
	case areaLevel >= 14:
		return 4
	case areaLevel >= 9:
		return 3
	case areaLevel >= 5:
		return 2
	}
	return 1
}

// ChapterByN is chapter n (1-based), nil when out of range.
func ChapterByN(n int) *Chapter {
	if n < 1 || n > len(Chapters) {
		return nil
	}
	return &Chapters[n-1]
}

// Archetype is a rift enemy: a body (a combat.yaml enemy key, for the
// model) and how it shoots.
type Archetype struct {
	Key     string
	Name    string
	Body    int     // index into Chapter.Bodies
	Kind    int     // volley kind (0: never shoots)
	Every   float64 // seconds between volleys at depth 0
	HP      float64 // health factor
	Unlock  int     // first effective depth it appears at
	Sway    float64 // metres it drifts side to side (0: stands still)
	Weight  float64
	GemDrop int // gems it drops when it breaks (geodes)
}

// Archetypes (the rift's own names).
var Archetypes = []Archetype{
	{Key: "ringbell", Name: "Ringbell", Body: 0, Kind: KindRing, Every: 2.7, HP: 1.2, Unlock: 1, Weight: 3},
	{Key: "volley_eye", Name: "Volley Eye", Body: 1, Kind: KindFan, Every: 2.9, HP: 1.0, Unlock: 1, Sway: 2.5, Weight: 3},
	{Key: "spindle", Name: "Spindle", Body: 0, Kind: KindSpiral, Every: 3.6, HP: 1.4, Unlock: 5, Weight: 2},
	{Key: "rampart", Name: "Rampart", Body: 2, Kind: KindWall, Every: 3.8, HP: 1.7, Unlock: 9, Weight: 1.5},
	{Key: "skipper", Name: "Skipper", Body: 1, Kind: KindBounce, Every: 4.2, HP: 1.0, Unlock: 12, Sway: 2, Weight: 1.5},
	{Key: "glare_totem", Name: "Glare Totem", Body: 2, Kind: KindLaser, Every: 4.4, HP: 1.3, Unlock: 16, Weight: 1.2},
	{Key: "lurk_lamp", Name: "Lurk Lamp", Body: 1, Kind: KindSeeker, Every: 4.8, HP: 1.1, Unlock: 20, Weight: 1.2},
	{Key: "geode", Name: "Singing Geode", Body: -1, Kind: 0, HP: 0.6, GemDrop: 2},
}

// ArchetypeByKey finds an archetype.
func ArchetypeByKey(k string) *Archetype {
	for i := range Archetypes {
		if Archetypes[i].Key == k {
			return &Archetypes[i]
		}
	}
	return nil
}

// Stage kinds.
const (
	StageFight     = 0
	StageMiniBoss  = 1
	StageBoss      = 2
	StageGemVault  = 3 // geodes to break under a guard's fire
	StageGemShower = 4 // survive a falling shower and catch the gems
	StageGemGolem  = 5 // a golem made of gems
)

// StageKindNames are the names the HUD shows.
var StageKindNames = []string{"", "Mini-boss", "Chapter boss", "Gem vault", "Gem shower", "Gem golem"}

// Depth is how far into the ramp a stage is (0 at stage 1 of chapter 1, 1
// at stage 50 of chapter 5): the chapter starts where the last left off.
func Depth(chapter, stage int) float64 {
	return math.Min(1, (float64(chapter-1)*0.12)+float64(stage-1)/float64(Stages-1)*0.5)
}

// EffDepth is the depth in stages for archetype unlocks.
func EffDepth(chapter, stage int) int { return stage + 8*(chapter-1) }

// StageKind decides what stage s of a run (seed) is.
func StageKind(seed uint32, s int) int {
	switch {
	case s == Stages:
		return StageBoss
	case s%BossEvery == 0:
		return StageMiniBoss
	case s%BossEvery == 6:
		return StageGemVault + int((uint32(s/BossEvery)+seed)%3) // one gem event in every ten stages
	case s%BossEvery == 3 && s > 10 && Unit(Hash(seed, uint32(s), 0x9e3)) < 0.35:
		return StageGemVault // a bonus vault, deeper in
	}
	return StageFight
}

// PerkAfter reports whether clearing stage s offers a perk choice.
func PerkAfter(s int) bool {
	r := s % BossEvery
	return s < Stages && (r == 2 || r == 5 || r == 8 || r == 0)
}

// Checkpoint reports whether clearing stage s banks the spoils and opens
// the way out (after every mini-boss, and the end).
func Checkpoint(s int) bool { return s%BossEvery == 0 }

// Spawn is one enemy of a stage.
type Spawn struct {
	Arch  *Archetype
	X, Z  float64
	Boss  int // 0 common, 1 mini-boss, 2 chapter boss, 3 gem golem
	Elite bool
}

// Composition is the enemies of stage s of chapter c (run seed).
func Composition(c, s int, seed uint32, l *Layout) []Spawn {
	kind := StageKind(seed, s)
	d := EffDepth(c, s)
	slot := func(i int) (float64, float64) {
		if len(l.Slots) == 0 {
			return 0, -HalfZ * 0.5
		}
		p := l.Slots[i%len(l.Slots)]
		return p[0], p[1]
	}
	pick := func(i int) *Archetype {
		total := 0.0
		for k := range Archetypes {
			a := &Archetypes[k]
			if a.Kind != 0 && a.Unlock <= d {
				total += a.Weight
			}
		}
		u := Unit(Hash(seed, uint32(s), uint32(i), 0xc0a)) * total
		for k := range Archetypes {
			a := &Archetypes[k]
			if a.Kind == 0 || a.Unlock > d {
				continue
			}
			if u < a.Weight {
				return a
			}
			u -= a.Weight
		}
		return &Archetypes[0]
	}
	var out []Spawn
	switch kind {
	case StageMiniBoss, StageBoss, StageGemGolem:
		b := 1
		arch := pick(0)
		if kind == StageBoss {
			b = 2
		} else if kind == StageGemGolem {
			b = 3
		}
		out = append(out, Spawn{Arch: arch, X: 0, Z: -HalfZ * 0.45, Boss: b, Elite: true})
		adds := 1 + s/20
		if kind == StageGemGolem {
			adds = 0
		}
		for i := 0; i < adds; i++ {
			x, z := slot(i + 1)
			out = append(out, Spawn{Arch: pick(i + 1), X: x, Z: z})
		}
	case StageGemVault:
		x, z := slot(0)
		out = append(out, Spawn{Arch: pick(0), X: x, Z: z})
		geode := ArchetypeByKey("geode")
		n := 4 + s/15
		for i := 0; i < n; i++ {
			h := Hash(seed, uint32(s), uint32(i), 0x6e0)
			gx := (Unit(h)*2 - 1) * (HalfX - 2)
			gz := (Unit(Mix(h))*1.4 - 0.6) * (HalfZ - 3)
			if l.blocked(gx, gz, 1.0) {
				gx, gz = slot(i + 2)
			}
			out = append(out, Spawn{Arch: geode, X: gx, Z: gz})
		}
	case StageGemShower:
		// nobody to fight: the room rains (schedule.go)
	default:
		n := min(6, 2+d/9+int(Hash(seed, uint32(s), 0x7a1)%2))
		for i := 0; i < n; i++ {
			x, z := slot(i)
			out = append(out, Spawn{Arch: pick(i), X: x, Z: z, Elite: d > 30 && i == 0})
		}
	}
	return out
}
