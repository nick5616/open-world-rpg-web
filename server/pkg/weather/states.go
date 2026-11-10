package weather

// Dynamic weather (playtest 2, CR 030). Spec 8: "Day, night and weather are
// functions of world time and the seed, so they need no sync beyond the
// clock." The world is cut into WEATHER_CELL_M cells (8 x 8); each cell has
// a climate from its biomes (a 4 x 4 vote over the atlas biome grid). Cells
// are grouped into fronts of WEATHER_FRONT_CELLS x WEATHER_FRONT_CELLS (a
// region). A front keeps a severity roll (0-99) for WEATHER_WINDOW_S, its
// windows starting at a seeded phase so fronts change at different moments;
// each cell nudges the roll by up to +-WEATHER_JITTER, and the cell's
// climate table turns the roll into a state, ordered from fair to foul. One
// storm front is a thunderstorm over the meadows, a snowstorm on the peaks
// beside them and a sandstorm in the badlands.
//
// Everything is integer arithmetic on whole chemistry steps (u32 hashes,
// floor divisions) plus one float hour, so the TS twin
// (client/src/systems/weather/weather.ts) agrees to the bit; both replay
// testdata/weather_vectors.json.

import (
	"math"

	"lodestone/server/pkg/constants"
)

// Weather states, fair to foul within each climate's table.
const (
	Clear = iota
	Cloudy
	Windy
	Fog
	Drizzle
	Rain
	Thunderstorm
	Snow
	Snowstorm
	HeatHaze
	Sandstorm
	NumStates
)

// StateKeys names the states (HUD, dev overrides, logs).
var StateKeys = [NumStates]string{"clear", "cloudy", "windy", "fog", "drizzle", "rain", "thunderstorm", "snow", "snowstorm", "heat_haze", "sandstorm"}

// StateByKey is the state named key, or -1.
func StateByKey(key string) int {
	for i, k := range StateKeys {
		if k == key {
			return i
		}
	}
	return -1
}

// Climates.
const (
	ClimateTemperate = iota // meadow, forest
	ClimateWet              // wetland
	ClimateHighland         // highlands
	ClimateCold             // snowpeak
	ClimateArid             // badlands
	NumClimates
)

// biomeClimate maps the atlas biome ids (0 meadow .. 5 wetland) to climates.
var biomeClimate = [6]uint8{ClimateTemperate, ClimateTemperate, ClimateHighland, ClimateCold, ClimateArid, ClimateWet}

type band struct{ state, pct int }

// tables: each climate's states, fair to foul; the percentages sum to 100.
var tables = [NumClimates][]band{
	ClimateTemperate: {{Clear, 34}, {Cloudy, 18}, {Windy, 8}, {Fog, 7}, {Drizzle, 11}, {Rain, 13}, {Thunderstorm, 9}},
	ClimateWet:       {{Clear, 18}, {Cloudy, 16}, {Windy, 4}, {Fog, 18}, {Drizzle, 16}, {Rain, 17}, {Thunderstorm, 11}},
	ClimateHighland:  {{Clear, 28}, {Cloudy, 18}, {Windy, 17}, {Fog, 10}, {Drizzle, 6}, {Rain, 11}, {Thunderstorm, 10}},
	ClimateCold:      {{Clear, 26}, {Cloudy, 18}, {Windy, 10}, {Fog, 8}, {Snow, 26}, {Snowstorm, 12}},
	ClimateArid:      {{Clear, 32}, {HeatHaze, 24}, {Cloudy, 8}, {Windy, 14}, {Sandstorm, 14}, {Rain, 4}, {Thunderstorm, 4}},
}

// CellsN is the number of weather cells per world edge.
const CellsN = constants.WorldSizeM / constants.WeatherCellM

// FrontsN is the number of fronts per world edge.
const FrontsN = CellsN / constants.WeatherFrontCells

// WindowSteps is a front window in chemistry steps.
const WindowSteps = int64(constants.WeatherWindowS) * constants.ChemStepHz

// SlotSteps is a lightning slot in chemistry steps.
const SlotSteps = int64(constants.LightningSlotS) * constants.ChemStepHz

// Climate is a world's climate per weather cell (row-major, cz * CellsN + cx).
type Climate struct {
	Cells [CellsN * CellsN]uint8
}

// UniformClimate is a world with one climate everywhere (tests).
func UniformClimate(c int) *Climate {
	var cl Climate
	for i := range cl.Cells {
		cl.Cells[i] = uint8(c)
	}
	return &cl
}

// NewClimate votes each cell's climate from the atlas biome grid (gridN x
// gridN nodes macroRes metres apart, the grid chem/material.go reads): 4 x
// 4 samples at the cell's sub-centres, nearest node, the most common biome
// wins (ties: the lower biome id). No grid: temperate everywhere.
func NewClimate(gridN, macroRes int, biome []byte) *Climate {
	var cl Climate
	if gridN <= 0 || macroRes <= 0 || len(biome) < gridN*gridN {
		return &cl
	}
	const cell = constants.WeatherCellM
	for cz := 0; cz < CellsN; cz++ {
		for cx := 0; cx < CellsN; cx++ {
			var counts [6]int
			for sj := 0; sj < 4; sj++ {
				for si := 0; si < 4; si++ {
					x := cx*cell + (2*si+1)*cell/8
					z := cz*cell + (2*sj+1)*cell/8
					i := min(gridN-1, (x+macroRes/2)/macroRes)
					j := min(gridN-1, (z+macroRes/2)/macroRes)
					b := int(biome[j*gridN+i])
					if b > 5 {
						b = 0
					}
					counts[b]++
				}
			}
			best := 0
			for b := 1; b < 6; b++ {
				if counts[b] > counts[best] {
					best = b
				}
			}
			cl.Cells[cz*CellsN+cx] = biomeClimate[best]
		}
	}
	return &cl
}

// At is the climate of cell (cx, cz).
func (c *Climate) At(cx, cz int) int { return int(c.Cells[cz*CellsN+cx]) }

// CellOf is the weather cell under (x, z), clamped into the world.
func CellOf(x, z float64) (cx, cz int) {
	return clampCell(math.Floor(x / constants.WeatherCellM)), clampCell(math.Floor(z / constants.WeatherCellM))
}

func clampCell(v float64) int {
	if !(v > 0) {
		return 0
	}
	if v > CellsN-1 {
		return CellsN - 1
	}
	return int(v)
}

func fmix(h uint32) uint32 {
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

// mix folds v into h (u32).
func mix(h, v uint32) uint32 { return fmix(h ^ v*0xcc9e2d51) }

func frontIndex(cx, cz int) uint32 {
	return uint32((cz/constants.WeatherFrontCells)*FrontsN + cx/constants.WeatherFrontCells)
}

// FrontPhase is the seeded offset (steps) of a front's windows.
func FrontPhase(seed uint64, cx, cz int) int64 {
	return int64(mix(Hash(seed^0x70686173, 0x7068), frontIndex(cx, cz)) % uint32(WindowSteps))
}

// WindowAt is the front window of cell (cx, cz) at step k.
func WindowAt(seed uint64, cx, cz int, k int64) int64 {
	return floorDiv(k+FrontPhase(seed, cx, cz), WindowSteps)
}

// WindowStart is the first step of window w of cell (cx, cz)'s front.
func WindowStart(seed uint64, cx, cz int, w int64) int64 {
	return w*WindowSteps - FrontPhase(seed, cx, cz)
}

// Roll is the severity roll (0-99) of cell (cx, cz) in window w: the
// front's roll nudged by the cell's jitter.
func Roll(seed uint64, cx, cz int, w int64) int {
	r := int(mix(Hash(seed^0x726f6c6c, w), frontIndex(cx, cz)) % 100)
	j := int(mix(mix(Hash(seed^0x6a697474, w), uint32(cx)), uint32(cz))%uint32(2*constants.WeatherJitter+1)) - constants.WeatherJitter
	return min(99, max(0, r+j))
}

// Daytime reports heat-haze hours (09:00-18:00) at step k.
func Daytime(k int64) bool {
	h := Hour(float64(k) / constants.ChemStepHz)
	return h >= 9 && h < 18
}

// StateFor is the climate's state for a roll at step k (heat haze only by day).
func StateFor(climate, roll int, k int64) int {
	t := tables[ClimateTemperate]
	if climate >= 0 && climate < NumClimates {
		t = tables[climate]
	}
	acc := 0
	for _, b := range t {
		acc += b.pct
		if roll < acc {
			if b.state == HeatHaze && !Daytime(k) {
				return Clear
			}
			return b.state
		}
	}
	return Clear
}

// StateAtStep is the weather of cell (cx, cz) at chemistry step k.
func StateAtStep(seed uint64, c *Climate, cx, cz int, k int64) int {
	w := WindowAt(seed, cx, cz, k)
	return StateFor(c.At(cx, cz), Roll(seed, cx, cz, w), k)
}

// StateAt is the weather at world position (x, z) and world time t.
func StateAt(seed uint64, c *Climate, x, z, t float64) int {
	cx, cz := CellOf(x, z)
	return StateAtStep(seed, c, cx, cz, Step(t))
}

// Next is the state cell (cx, cz) turns to at the end of its current
// window, and the step that happens.
func Next(seed uint64, c *Climate, cx, cz int, k int64) (state int, at int64) {
	w := WindowAt(seed, cx, cz, k) + 1
	at = WindowStart(seed, cx, cz, w)
	return StateFor(c.At(cx, cz), Roll(seed, cx, cz, w), at), at
}

// IsWet reports rain of any strength (slippery climbing, doused fires, wet fish).
func IsWet(s int) bool { return s == Drizzle || s == Rain || s == Thunderstorm }

// IsSnowing reports snow or a snowstorm.
func IsSnowing(s int) bool { return s == Snow || s == Snowstorm }

// IsMurky reports states that shorten sight (and enemies' aggro).
func IsMurky(s int) bool { return s == Fog || s == Snowstorm || s == Sandstorm }

// windLevels: 0 calm .. 3 gale, per state.
var windLevels = [NumStates]int{Clear: 0, Cloudy: 1, Windy: 2, Fog: 0, Drizzle: 1, Rain: 1, Thunderstorm: 2, Snow: 1, Snowstorm: 3, HeatHaze: 0, Sandstorm: 3}

// WindLevel is a state's wind (0 calm .. 3 gale).
func WindLevel(s int) int {
	if s < 0 || s >= NumStates {
		return 0
	}
	return windLevels[s]
}

// MoveSpeedMult is the walking speed factor of a state.
func MoveSpeedMult(s int) float64 {
	switch s {
	case Snow:
		return constants.SnowMoveMult
	case Snowstorm:
		return constants.SnowstormMoveMult
	}
	return 1
}

// diag is sqrt(1/2) as the literal both languages parse to the same double.
const diag = 0.7071067811865476

// windUnit is the chemistry wind's direction as a unit vector.
func windUnit(w Wind) (float64, float64) {
	if w.DX != 0 && w.DZ != 0 {
		return float64(w.DX) * diag, float64(w.DZ) * diag
	}
	return float64(w.DX), float64(w.DZ)
}

// GlidePush is the downwind drift (m/s) of a glider in state s under the
// chemistry wind w.
func GlidePush(s int, w Wind) (float64, float64) {
	p := constants.WindGlidePushMs * float64(max(0, WindLevel(s)-1))
	ux, uz := windUnit(w)
	return p * ux, p * uz
}

// ArrowAccel is the downwind acceleration (m/s^2) of an arrow in state s.
func ArrowAccel(s int, w Wind) (float64, float64) {
	a := constants.WindArrowAccel * float64(WindLevel(s))
	ux, uz := windUnit(w)
	return a * ux, a * uz
}

// MoveWeather is what the movement step reads about the weather where the
// player stands.
type MoveWeather struct {
	Rain         bool    // climbing is slippery (halved speed, slips)
	SpeedMult    float64 // walking/sprinting speed factor (snow)
	PushX, PushZ float64 // a glider's downwind drift, m/s
}

// MoveField answers MoveWeather at a position (the movement Env's hook).
type MoveField interface {
	MoveWeatherAt(x, z float64) MoveWeather
}

// Field is the weather of every cell at one chemistry step: built once per
// zone tick (or client step) and read by every movement step in it.
type Field struct {
	Step   int64
	States [CellsN * CellsN]uint8
	Wind   Wind
	moves  [CellsN * CellsN]MoveWeather
}

// NewField evaluates every cell at step k. override >= 0 forces that state
// everywhere (dev: LODESTONE_ZONE_DEBUG_WEATHER).
func NewField(seed uint64, c *Climate, prevailingDeg int, k int64, override int) *Field {
	f := &Field{Step: k, Wind: WindAt(seed, prevailingDeg, k)}
	for cz := 0; cz < CellsN; cz++ {
		for cx := 0; cx < CellsN; cx++ {
			s := override
			if s < 0 || s >= NumStates {
				s = StateAtStep(seed, c, cx, cz, k)
			}
			i := cz*CellsN + cx
			f.States[i] = uint8(s)
			px, pz := GlidePush(s, f.Wind)
			f.moves[i] = MoveWeather{Rain: IsWet(s), SpeedMult: MoveSpeedMult(s), PushX: px, PushZ: pz}
		}
	}
	return f
}

// StateAt is the state of the cell under (x, z).
func (f *Field) StateAt(x, z float64) int {
	cx, cz := CellOf(x, z)
	return int(f.States[cz*CellsN+cx])
}

// MoveWeatherAt implements MoveField.
func (f *Field) MoveWeatherAt(x, z float64) MoveWeather {
	cx, cz := CellOf(x, z)
	return f.moves[cz*CellsN+cx]
}

// ---- lightning ----

// Strike is a seeded lightning strike: where the storm cell's slot drops
// it before the tall-spot snap (TallSpot) and the zone's choice of target.
type Strike struct {
	ID     uint32 // slot * 64 + cell (wraps): unique within a day of slots
	Step   int64
	X, Z   float64
	CX, CZ int
}

// StrikeInSlot is cell (cx, cz)'s strike in lightning slot `slot`, if the
// cell is a thunderstorm at the slot's first step and the slot's roll hits.
// override >= 0 forces the state (dev).
func StrikeInSlot(seed uint64, c *Climate, cx, cz int, slot int64, override int) (Strike, bool) {
	k0 := slot * SlotSteps
	s := override
	if s < 0 || s >= NumStates {
		s = StateAtStep(seed, c, cx, cz, k0)
	}
	if s != Thunderstorm {
		return Strike{}, false
	}
	h := mix(mix(Hash(seed^0x626f6c74, slot), uint32(cx)), uint32(cz))
	if h%100 >= constants.LightningSlotPct {
		return Strike{}, false
	}
	const span = uint32(constants.WeatherCellM * 100)
	off := int64((h >> 8) % uint32(SlotSteps))
	x := float64(cx*constants.WeatherCellM) + float64(mix(h, 0x78)%span)/100
	z := float64(cz*constants.WeatherCellM) + float64(mix(h, 0x7a)%span)/100
	return Strike{ID: uint32(slot)*64 + uint32(cz*CellsN+cx), Step: k0 + off, X: x, Z: z, CX: cx, CZ: cz}, true
}

// StrikesBetween calls fn for every seeded strike with k0 <= Step < k1, in
// step order, then cell order.
func StrikesBetween(seed uint64, c *Climate, k0, k1 int64, override int, fn func(Strike)) {
	if k1 <= k0 {
		return
	}
	var buf []Strike
	for slot := floorDiv(k0, SlotSteps); slot*SlotSteps < k1; slot++ {
		buf = buf[:0]
		for cz := 0; cz < CellsN; cz++ {
			for cx := 0; cx < CellsN; cx++ {
				if st, ok := StrikeInSlot(seed, c, cx, cz, slot, override); ok && st.Step >= k0 && st.Step < k1 {
					buf = append(buf, st)
				}
			}
		}
		// insertion sort by step (stable: cell order within a step)
		for i := 1; i < len(buf); i++ {
			for j := i; j > 0 && buf[j].Step < buf[j-1].Step; j-- {
				buf[j], buf[j-1] = buf[j-1], buf[j]
			}
		}
		for _, st := range buf {
			fn(st)
		}
	}
}

// TallSpot moves a strike to the highest of nine points on a
// LIGHTNING_TALL_PROBE_M grid around (x, z) (row by row from -z; the first
// highest wins), clamped into the world: lightning finds peaks, towers and
// roofs.
func TallSpot(height func(x, z float64) float64, x, z float64) (float64, float64) {
	const d = constants.LightningTallProbeM
	bx, bz, bh := x, z, math.Inf(-1)
	for j := -1; j <= 1; j++ {
		for i := -1; i <= 1; i++ {
			px := math.Min(constants.WorldSizeM-1, math.Max(0, x+float64(i)*d))
			pz := math.Min(constants.WorldSizeM-1, math.Max(0, z+float64(j)*d))
			if h := height(px, pz); h > bh {
				bx, bz, bh = px, pz, h
			}
		}
	}
	return bx, bz
}
