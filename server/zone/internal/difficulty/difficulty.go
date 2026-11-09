// Package difficulty is playtest 1's discovery-stamped area difficulty
// (docs/decisions/0021-discovery-difficulty.md, CR 012).
//
// The world is cut into square areas of combat.yaml difficulty.cellM metres
// (256 m: 4 x 4 chunks, the zone's combat group grid). An area's level is
// server state, not generator output: the first player to come near an
// unstamped area stamps it from their character level, pulled toward the
// already-stamped neighbours and clamped to within maxStep of them, plus a
// little of the generator's region danger. The stamp is written to Postgres
// with a first-writer-wins insert (area_difficulty, migration 0021), so
// every zone of a world (WP16) agrees, and it never changes afterwards.
// Areas around the world spawn are the Haven: level 1 forever, beginner
// creatures only, no demons, never stamped.
//
// Map is the tick's O(1) view (a flat array of levels per area); Store is
// the persistence (PGStore, MemStore), always called off the tick.
package difficulty

import (
	"math"
	"time"

	"lodestone/server/pkg/combatdefs"
)

// Stamp is one area's persistent difficulty.
type Stamp struct {
	Cell    int       // cz * PerEdge + cx
	Level   int       // area level (1..maxLevel)
	By      string    // character id of the discoverer ("" for the Haven)
	ByName  string    // their name at the time
	ByLevel int       // their character level at the time
	At      time.Time // when it was stamped
	// Provisional: the store failed; the level is this zone's own proposal,
	// used until a later claim succeeds (never persisted as such).
	Provisional bool
	// Won: this claim wrote the stamp (false: someone stamped it earlier).
	Won bool
}

// Map is a world's area levels as one zone knows them. Tick-owned.
type Map struct {
	Def     *combatdefs.Difficulty
	PerEdge int
	CellM   float64
	level   []int16 // 0 unknown, > 0 stamped (or the Haven's 1)
	pending []bool
	prov    []bool
	retryAt []uint32 // tick a provisional area may be claimed again
	haven   []bool
	by      []string // discoverer names (display)
	danger  func(x, z float64) float64
}

// New builds the map of a worldSize-metre world whose spawn is (sx, sz).
// danger is the generator's region danger (0..1) at a position (nil: 0).
func New(def *combatdefs.Difficulty, worldSize, sx, sz float64, danger func(x, z float64) float64) *Map {
	per := max(1, int(math.Round(worldSize/def.CellM)))
	m := &Map{Def: def, PerEdge: per, CellM: def.CellM, level: make([]int16, per*per), pending: make([]bool, per*per), prov: make([]bool, per*per),
		retryAt: make([]uint32, per*per), haven: make([]bool, per*per), by: make([]string, per*per), danger: danger}
	for c := range m.level {
		x, z := m.Center(c)
		if math.Hypot(x-sx, z-sz) <= def.HavenRadiusM {
			m.haven[c] = true
			m.level[c] = 1
		}
	}
	return m
}

// Cells is the number of areas.
func (m *Map) Cells() int { return len(m.level) }

// Cell is the area index of a position (clamped into the world).
func (m *Map) Cell(x, z float64) int {
	cx := min(m.PerEdge-1, max(0, int(math.Floor(x/m.CellM))))
	cz := min(m.PerEdge-1, max(0, int(math.Floor(z/m.CellM))))
	return cz*m.PerEdge + cx
}

// XZ is an area's grid coordinates.
func (m *Map) XZ(c int) (cx, cz int) { return c % m.PerEdge, c / m.PerEdge }

// Center is an area's centre in metres.
func (m *Map) Center(c int) (x, z float64) {
	cx, cz := m.XZ(c)
	return (float64(cx) + 0.5) * m.CellM, (float64(cz) + 0.5) * m.CellM
}

// Haven reports an area of the Haven.
func (m *Map) Haven(c int) bool { return c >= 0 && c < len(m.haven) && m.haven[c] }

// Level is an area's level and whether it is known (the Haven always is).
func (m *Map) Level(c int) (int, bool) {
	if c < 0 || c >= len(m.level) || m.level[c] <= 0 {
		return 0, false
	}
	return int(m.level[c]), true
}

// Stamped reports a known area that is not provisional.
func (m *Map) Stamped(c int) bool { l, ok := m.Level(c); return ok && l > 0 && !m.prov[c] }

// Tier is an area's tier (the Haven's for Haven areas) and its index.
func (m *Map) Tier(c int) (*combatdefs.DifficultyTier, int, bool) {
	if m.Haven(c) {
		return m.Def.Haven(), 0, true
	}
	l, ok := m.Level(c)
	if !ok {
		return nil, -1, false
	}
	t, i := m.Def.TierFor(l)
	return t, i, true
}

// AreaAt is the combat view (combat.Areas): level, tier, known.
func (m *Map) AreaAt(x, z float64) (int, *combatdefs.DifficultyTier, bool) {
	c := m.Cell(x, z)
	l, ok := m.Level(c)
	if !ok {
		return 0, nil, false
	}
	t, _, _ := m.Tier(c)
	return l, t, true
}

// By is the name of the area's discoverer ("" unknown or the Haven).
func (m *Map) By(c int) string {
	if c < 0 || c >= len(m.by) {
		return ""
	}
	return m.by[c]
}

// Pending reports an area with a claim in flight.
func (m *Map) Pending(c int) bool { return m.pending[c] }

// SetPending marks (or clears) a claim in flight.
func (m *Map) SetPending(c int, v bool) { m.pending[c] = v }

// Set records a stamp (from the store or a provisional fallback). A Haven
// area never changes; a stamped area changes only from provisional to
// stamped.
func (m *Map) Set(s Stamp, tick uint32) {
	c := s.Cell
	if c < 0 || c >= len(m.level) || m.haven[c] {
		return
	}
	m.pending[c] = false
	if m.level[c] > 0 && !m.prov[c] {
		return // stamps are immutable
	}
	m.level[c] = int16(max(1, min(m.Def.MaxLevel, s.Level)))
	m.prov[c] = s.Provisional
	m.by[c] = s.ByName
	if s.Provisional {
		m.retryAt[c] = tick + 30*30
	}
}

// NeedsClaim reports an area a nearby player should claim now: unknown, or
// provisional and due for a retry; never the Haven or one already pending.
func (m *Map) NeedsClaim(c int, tick uint32) bool {
	if m.haven[c] || m.pending[c] {
		return false
	}
	if m.level[c] <= 0 {
		return true
	}
	return m.prov[c] && tick >= m.retryAt[c]
}

// Near appends the areas whose square lies within r metres of (x, z),
// nearest first (the player's own area first).
func (m *Map) Near(x, z, r float64, out []int) []int {
	c0 := m.Cell(x, z)
	out = append(out, c0)
	cx0, cz0 := m.XZ(c0)
	span := int(math.Ceil(r/m.CellM)) + 1
	type cd struct {
		c int
		d float64
	}
	var tmp [64]cd
	n := 0
	for dz := -span; dz <= span; dz++ {
		for dx := -span; dx <= span; dx++ {
			cx, cz := cx0+dx, cz0+dz
			if (dx == 0 && dz == 0) || cx < 0 || cz < 0 || cx >= m.PerEdge || cz >= m.PerEdge {
				continue
			}
			// distance from the point to the area's square
			x0, z0 := float64(cx)*m.CellM, float64(cz)*m.CellM
			ddx := math.Max(0, math.Max(x0-x, x-(x0+m.CellM)))
			ddz := math.Max(0, math.Max(z0-z, z-(z0+m.CellM)))
			if d := math.Hypot(ddx, ddz); d <= r && n < len(tmp) {
				tmp[n] = cd{cz*m.PerEdge + cx, d}
				n++
			}
		}
	}
	for i := 1; i < n; i++ { // insertion sort by distance, then index
		for j := i; j > 0 && (tmp[j].d < tmp[j-1].d || (tmp[j].d == tmp[j-1].d && tmp[j].c < tmp[j-1].c)); j-- {
			tmp[j], tmp[j-1] = tmp[j-1], tmp[j]
		}
	}
	for i := 0; i < n; i++ {
		out = append(out, tmp[i].c)
	}
	return out
}

// Neighbours are the 8 areas around c.
func (m *Map) Neighbours(c int) []int {
	cx, cz := m.XZ(c)
	out := make([]int, 0, 8)
	for dz := -1; dz <= 1; dz++ {
		for dx := -1; dx <= 1; dx++ {
			x, z := cx+dx, cz+dz
			if (dx == 0 && dz == 0) || x < 0 || z < 0 || x >= m.PerEdge || z >= m.PerEdge {
				continue
			}
			out = append(out, z*m.PerEdge+x)
		}
	}
	return out
}

// HavenLevels returns the Haven's neighbours of c as known levels (the
// Haven is never in the store but counts as a level-1 neighbour).
func (m *Map) HavenLevels(c int) map[int]int {
	out := map[int]int{}
	for _, n := range m.Neighbours(c) {
		if m.haven[n] {
			out[n] = 1
		}
	}
	return out
}

// Danger is the generator's region danger at an area's centre (0..1).
func (m *Map) Danger(c int) float64 {
	if m.danger == nil {
		return 0
	}
	x, z := m.Center(c)
	return math.Max(0, math.Min(1, m.danger(x, z)))
}

// Propose is the stamp rule (decision 0021): the discoverer's level plus
// dangerBonus x the generator's region danger, pulled toward the mean of
// the stamped neighbours by neighbourWeight, then clamped to within maxStep
// of every stamped neighbour (as far as the neighbours' spread allows),
// rounded, in 1..maxLevel.
func Propose(def *combatdefs.Difficulty, playerLevel int, neighbours []int, danger float64) int {
	target := float64(max(1, playerLevel)) + def.DangerBonus*math.Max(0, math.Min(1, danger))
	if len(neighbours) > 0 {
		lo, hi, sum := math.MaxInt, 0, 0
		for _, n := range neighbours {
			lo, hi = min(lo, n), max(hi, n)
			sum += n
		}
		mean := float64(sum) / float64(len(neighbours))
		target = (1-def.NeighbourWeight)*target + def.NeighbourWeight*mean
		// Within maxStep of the highest and the lowest neighbour; when the
		// neighbours are farther apart than that allows, stay within maxStep
		// of the lowest (difficulty creeps up gently from the Haven).
		upper := float64(lo + def.MaxStep)
		lower := float64(hi - def.MaxStep)
		if lower > upper {
			lower = upper
		}
		target = math.Max(lower, math.Min(upper, target))
	}
	return max(1, min(def.MaxLevel, int(math.Round(target))))
}
