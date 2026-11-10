package chem

import (
	"slices"
	"sort"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/weather"
)

// Op kinds, in the order ops of one step apply (then by cell): putting out
// and freezing happen before igniting, so "ice and fire on the same cell in
// the same step" means the same thing everywhere.
const (
	OpExtinguish uint8 = 1
	OpFreeze     uint8 = 2
	OpIgnite     uint8 = 3
	OpPillar     uint8 = 4
)

// Op is one scheduled operation (Events 520-523).
type Op struct {
	Step   int64
	Kind   uint8
	Cell   uint32
	Radius int32 // cells (0 = just the cell)
	Pillar Pillar
}

// Pillar is a raised earth pillar (spec 8: a climbable pillar for 2 minutes).
type Pillar struct {
	ID         uint32
	X, Z       float64 // centre, cm-quantized on the wire
	BaseY      float64 // ground at the centre when raised
	Height     float64
	Half, Run  float64 // top half-edge and wall run (80 degree walls)
	Until      int64   // step it crumbles
	raisedStep int64
}

type cell struct {
	st    uint8
	until int64
	y     float64 // burning: updraft top; frozen: the ice sheet's height
}

// Sim is the deterministic chemistry state. Step is the last applied step;
// AdvanceTo applies steps in order. Not safe for concurrent use (the zone's
// tick goroutine owns it; Overlay publishes what other goroutines read).
type Sim struct {
	Seed    uint64
	WindDeg int // WorldSpec windDirection (degrees the wind blows from)
	Src     Source
	Step    int64
	// Rain overrides the weather (dev: LODESTONE_ZONE_DEBUG_RAIN); nil = seeded.
	Rain *bool
	// Weather (playtest 2, CR 030): rain where each cell is (the weather
	// cell's state); nil = WP10's global rain windows (the vectors, worlds
	// without an atlas).
	Weather *Weather

	cells   map[uint32]cell
	burning int
	// active is every burning or frozen cell (the only ones a step looks
	// at besides timers); timers buckets cells by the step they change, so
	// a step costs the fire's size, not the burnt ground waiting to regrow.
	active  map[uint32]bool
	timers  map[int64][]uint32
	ops     []Op
	Pillars []Pillar
	// Late counts ops that arrived for a step already applied (applied at
	// the next step instead: a desync the next baseline heals).
	Late int
	// SurfaceVersion changes whenever ice sheets or pillars change (the
	// ground overlay rebuilds then).
	SurfaceVersion uint64
	// Changed is set by each step that changed any cell (renderers, bitmaps).
	Changed bool
	// Dirty chunks since the last TakeDirty (bitmap fallback).
	dirty map[uint32]bool
}

// NewSim starts an empty simulation at step `step`.
func NewSim(seed uint64, windDeg int, src Source, step int64) *Sim {
	return &Sim{Seed: seed, WindDeg: windDeg, Src: src, Step: step, cells: map[uint32]cell{}, dirty: map[uint32]bool{}, active: map[uint32]bool{}, timers: map[int64][]uint32{}}
}

// Schedule queues an op (kept sorted; applied when its step comes).
func (s *Sim) Schedule(op Op) {
	if op.Step <= s.Step {
		s.Late++
		op.Step = s.Step + 1
	}
	i := sort.Search(len(s.ops), func(i int) bool { return opLess(op, s.ops[i]) })
	s.ops = slices.Insert(s.ops, i, op)
}

func opLess(a, b Op) bool {
	if a.Step != b.Step {
		return a.Step < b.Step
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	if a.Cell != b.Cell {
		return a.Cell < b.Cell
	}
	return a.Radius < b.Radius
}

// Burning is the number of burning cells.
func (s *Sim) Burning() int { return s.burning }

// State returns a cell's state and the step it changes.
func (s *Sim) State(id uint32) (st uint8, until int64) {
	c := s.cells[id]
	return c.st, c.until
}

// Cells calls fn for every non-default cell (unordered).
func (s *Sim) Cells(fn func(id uint32, st uint8, until int64)) {
	for id, c := range s.cells {
		fn(id, c.st, c.until)
	}
}

// AdvanceTo applies every step up to and including k.
func (s *Sim) AdvanceTo(k int64) {
	for s.Step < k {
		s.stepOnce(s.Step + 1)
	}
}

// Weather is the climate the simulation reads rain from (CR 030).
type Weather struct {
	Climate  *weather.Climate
	Override int // >= 0: this state everywhere (dev)
}

// rainFn is rain at step k per cell: the override, the weather where the
// cell is (each weather cell evaluated once), or the global windows.
func (s *Sim) rainFn(k int64) func(id uint32) bool {
	if s.Rain != nil {
		r := *s.Rain
		return func(uint32) bool { return r }
	}
	w := s.Weather
	if w == nil || w.Climate == nil {
		r := weather.RainingAtStep(s.Seed, k)
		return func(uint32) bool { return r }
	}
	var memo [weather.CellsN * weather.CellsN]int8
	return func(id uint32) bool {
		ix, iz := CellXZ(id)
		x, z := CellCenter(ix, iz)
		cx, cz := weather.CellOf(x, z)
		i := cz*weather.CellsN + cx
		if memo[i] == 0 {
			st := w.Override
			if st < 0 || st >= weather.NumStates {
				st = weather.StateAtStep(s.Seed, w.Climate, cx, cz, k)
			}
			memo[i] = 1
			if weather.IsWet(st) {
				memo[i] = 2
			}
		}
		return memo[i] == 2
	}
}

var neighbors = [8][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}}

// windPct is the spread bonus per unit of alignment with the wind, by strength.
var windPct = [4]int{0, 35, 65, 95}

func (s *Sim) set(id uint32, c cell) {
	old, had := s.cells[id]
	if had && old.st == StBurning {
		s.burning--
	}
	if c.st == StNone {
		delete(s.cells, id)
		delete(s.active, id)
	} else {
		if c.until <= s.Step {
			c.until = s.Step + 1 // a stale baseline entry: change at the next step
		}
		s.cells[id] = c
		if c.st == StBurning {
			s.burning++
		}
		if c.st == StBurning || c.st == StFrozen {
			s.active[id] = true
		} else {
			delete(s.active, id)
		}
		if !had || old.until != c.until {
			s.timers[c.until] = append(s.timers[c.until], id)
		}
	}
	if (had && old.st == StFrozen) != (c.st == StFrozen) {
		s.SurfaceVersion++
	}
	s.Changed = true
	s.dirty[ChunkOf(id)] = true
}

func (s *Sim) stepOnce(k int64) {
	s.Step = k
	s.Changed = false
	// 1. Ops due now.
	n := 0
	for n < len(s.ops) && s.ops[n].Step <= k {
		s.apply(s.ops[n], k)
		n++
	}
	s.ops = s.ops[n:]
	// 2. Timers: fires burn out, ice melts, burnt ground regrows, pillars crumble.
	if due, ok := s.timers[k]; ok {
		delete(s.timers, k)
		for _, id := range due {
			c, ok := s.cells[id]
			if !ok || c.until != k {
				continue // changed since it was bucketed
			}
			if c.st == StBurning {
				s.set(id, cell{st: StBurnt, until: k + constants.FireRegrowSteps})
			} else {
				s.set(id, cell{})
			}
		}
	}
	if len(s.Pillars) > 0 {
		keep := s.Pillars[:0]
		for _, p := range s.Pillars {
			if p.Until > k {
				keep = append(keep, p)
			} else {
				s.SurfaceVersion++
			}
		}
		s.Pillars = keep
	}
	if s.burning == 0 {
		return
	}
	// 3. Fire near ice melts it early (spec 8); rain douses (spec 8).
	rain := s.rainFn(k)
	klo, khi := uint32(k), uint32(uint64(k)>>32)
	var melt, doused []uint32
	for id := range s.active {
		switch c := s.cells[id]; c.st {
		case StFrozen:
			if s.nearBurning(id) {
				melt = append(melt, id)
			}
		case StBurning:
			if rain(id) && hash4(s.Seed, klo, khi, id, 0x7261696e)%1000 < constants.FireRainOutPermille {
				doused = append(doused, id)
			}
		}
	}
	for _, id := range melt {
		s.set(id, cell{})
	}
	for _, id := range doused {
		s.set(id, cell{st: StBurnt, until: k + constants.FireRegrowSteps})
	}
	// 4. Spread along the wind into fresh fuel. The rolls depend only on
	// (step, source, target), so the result is a set and iteration order
	// never matters.
	if s.burning == 0 || s.burning >= constants.FireMaxBurning {
		return
	}
	w := weather.WindAt(s.Seed, s.WindDeg, k)
	catch := map[uint32]bool{}
	for id := range s.active {
		if s.cells[id].st != StBurning {
			continue
		}
		ix, iz := CellXZ(id)
		for _, o := range neighbors {
			nx, nz := ix+o[0], iz+o[1]
			if !InWorld(nx, nz) {
				continue
			}
			nid := CellID(nx, nz)
			if _, busy := s.cells[nid]; busy || catch[nid] {
				continue
			}
			base := spreadBase(s.Src.Material(nx, nz))
			if base == 0 {
				continue
			}
			mult := 100 + (o[0]*w.DX+o[1]*w.DZ)*windPct[w.Strength]
			mult = min(400, max(15, mult))
			chance := base * mult / 100
			if o[0] != 0 && o[1] != 0 {
				chance = chance * 7 / 10
			}
			if rain(id) {
				chance /= 5
			}
			if int(hash4(s.Seed, klo, khi, id, nid)%1000) < chance {
				catch[nid] = true
			}
		}
	}
	for nid := range catch {
		s.ignite(nid, k)
	}
}

func spreadBase(m uint8) int {
	switch m {
	case MatGrass:
		return constants.FireGrassSpreadPermille
	case MatBrush:
		return constants.FireBrushSpreadPermille
	case MatDamp:
		return constants.FireDampSpreadPermille
	}
	return 0
}

func (s *Sim) nearBurning(id uint32) bool {
	ix, iz := CellXZ(id)
	for _, o := range neighbors {
		nx, nz := ix+o[0], iz+o[1]
		if InWorld(nx, nz) && s.cells[CellID(nx, nz)].st == StBurning {
			return true
		}
	}
	return false
}

// burnSteps is a cell's seeded burn time.
func (s *Sim) burnSteps(id uint32, m uint8) int64 {
	base := int64(constants.FireGrassBurnSteps)
	if m == MatBrush {
		base = constants.FireBrushBurnSteps
	}
	return base + int64(hash4(s.Seed, id, 0x6275726e, 0, 0)%(constants.FireBurnJitterSteps+1))
}

func (s *Sim) ignite(id uint32, k int64) {
	ix, iz := CellXZ(id)
	m := s.Src.Material(ix, iz)
	s.set(id, cell{st: StBurning, until: k + s.burnSteps(id, m), y: s.Src.Height(ix, iz) + constants.FireUpdraftTopM})
}

// within calls fn for every in-world cell within r cells of centre
// (integer distance, so both languages pick the same cells), in id order.
func within(center uint32, r int32, fn func(id uint32, ix, iz int)) {
	cx, cz := CellXZ(center)
	rr := int(r)
	for dz := -rr; dz <= rr; dz++ {
		for dx := -rr; dx <= rr; dx++ {
			if dx*dx+dz*dz > rr*rr {
				continue
			}
			x, z := cx+dx, cz+dz
			if InWorld(x, z) {
				fn(CellID(x, z), x, z)
			}
		}
	}
}

func (s *Sim) apply(op Op, k int64) {
	switch op.Kind {
	case OpExtinguish:
		within(op.Cell, op.Radius, func(id uint32, _, _ int) {
			if s.cells[id].st == StBurning {
				s.set(id, cell{st: StBurnt, until: k + constants.FireRegrowSteps})
			}
		})
	case OpFreeze:
		within(op.Cell, op.Radius, func(id uint32, ix, iz int) {
			switch c := s.cells[id]; {
			case c.st == StBurning:
				s.set(id, cell{st: StBurnt, until: k + constants.FireRegrowSteps})
			case (c.st == StNone || c.st == StFrozen) && s.Src.Material(ix, iz) == MatWater:
				s.set(id, cell{st: StFrozen, until: k + constants.FreezeSteps, y: s.Src.Water(ix, iz)})
			}
		})
	case OpIgnite:
		within(op.Cell, op.Radius, func(id uint32, ix, iz int) {
			switch c := s.cells[id]; {
			case c.st == StFrozen:
				s.set(id, cell{}) // fire melts ice
			case c.st == StNone && Flammable(s.Src.Material(ix, iz)):
				s.ignite(id, k)
			}
		})
	case OpPillar:
		p := op.Pillar
		p.raisedStep = k
		p.Until = k + constants.PillarSteps
		// A pillar with the same id replaces the old one.
		s.Pillars = slices.DeleteFunc(s.Pillars, func(q Pillar) bool { return q.ID == p.ID })
		s.Pillars = append(s.Pillars, p)
		s.SurfaceVersion++
	}
}

// Sheet returns the ice sheet height at a cell (ok = frozen).
func (s *Sim) Sheet(id uint32) (float64, bool) {
	c, ok := s.cells[id]
	if !ok || c.st != StFrozen {
		return 0, false
	}
	return c.y, true
}

// Frozen calls fn for every frozen cell with its sheet height.
func (s *Sim) Frozen(fn func(id uint32, y float64)) {
	for id := range s.active {
		if c := s.cells[id]; c.st == StFrozen {
			fn(id, c.y)
		}
	}
}

// LiftAt implements movement.UpdraftField from the burning cells: fire's
// rising heat (spec 8) lifts a glider over any burning cell of the 3 x 3
// block under it, up to FIRE_UPDRAFT_TOP_M above that cell's ground.
func (s *Sim) LiftAt(x, y, z float64) float64 {
	if s.burning == 0 {
		return 0
	}
	ix, iz := CellAt(x, z)
	for dz := -1; dz <= 1; dz++ {
		for dx := -1; dx <= 1; dx++ {
			if !InWorld(ix+dx, iz+dz) {
				continue
			}
			if c, ok := s.cells[CellID(ix+dx, iz+dz)]; ok && c.st == StBurning && y <= c.y {
				return constants.FireUpdraftLift
			}
		}
	}
	return 0
}

// TakeDirty returns and clears the chunks changed since the last call.
func (s *Sim) TakeDirty() []uint32 {
	out := make([]uint32, 0, len(s.dirty))
	for c := range s.dirty {
		out = append(out, c)
	}
	clear(s.dirty)
	slices.Sort(out)
	return out
}

// Hash is an FNV-1a digest of the whole state (sorted cells: id, state,
// until; then pillars), the number two clients and the zone compare.
func (s *Sim) Hash() uint32 {
	ids := make([]uint32, 0, len(s.cells))
	for id := range s.cells {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	h := uint32(2166136261)
	put := func(v uint32) {
		for i := 0; i < 4; i++ {
			h ^= v & 0xff
			h *= 16777619
			v >>= 8
		}
	}
	for _, id := range ids {
		c := s.cells[id]
		put(id)
		put(uint32(c.st))
		put(uint32(c.until - s.Step))
	}
	for _, p := range s.Pillars {
		put(p.ID)
		put(uint32(p.Until - s.Step))
	}
	return h
}

// ChunkCellsOf calls fn for every non-default cell of a chunk, in id order.
func (s *Sim) ChunkCellsOf(chunk uint32, fn func(id uint32, st uint8, until int64)) {
	cx, cz := int(chunk%ChunksN)*ChunkCells, int(chunk/ChunksN)*ChunkCells
	for z := cz; z < cz+ChunkCells; z++ {
		for x := cx; x < cx+ChunkCells; x++ {
			id := CellID(x, z)
			if c, ok := s.cells[id]; ok {
				fn(id, c.st, c.until)
			}
		}
	}
}

// LoadChunk replaces a chunk's cells with a baseline (clients; tests).
func (s *Sim) LoadChunk(chunk uint32, cells []BaselineCell) {
	cx, cz := int(chunk%ChunksN)*ChunkCells, int(chunk/ChunksN)*ChunkCells
	for z := cz; z < cz+ChunkCells; z++ {
		for x := cx; x < cx+ChunkCells; x++ {
			if _, ok := s.cells[CellID(x, z)]; ok {
				s.set(CellID(x, z), cell{})
			}
		}
	}
	for _, c := range cells {
		ix, iz := CellXZ(c.ID)
		var y float64
		switch c.State {
		case StBurning:
			y = s.Src.Height(ix, iz) + constants.FireUpdraftTopM
		case StFrozen:
			y = s.Src.Water(ix, iz)
		}
		s.set(c.ID, cell{st: c.State, until: c.Until, y: y})
	}
}

// ActiveChunks returns the chunks with any non-default cell (sorted).
func (s *Sim) ActiveChunks() []uint32 {
	set := map[uint32]bool{}
	for id := range s.cells {
		set[ChunkOf(id)] = true
	}
	out := make([]uint32, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	slices.Sort(out)
	return out
}

// Rebase moves the simulation to step k without simulating the gap,
// shifting every timer, op and pillar by the same amount: the world clock
// jumped (a dev "set time"), and fires keep their remaining time. Clients
// rebuild their view and get fresh baselines.
func (s *Sim) Rebase(k int64) {
	d := k - s.Step
	if d == 0 {
		return
	}
	s.Step = k
	for id, c := range s.cells {
		c.until += d
		s.cells[id] = c
	}
	timers := make(map[int64][]uint32, len(s.timers))
	for at, ids := range s.timers {
		timers[at+d] = ids
	}
	s.timers = timers
	for i := range s.ops {
		s.ops[i].Step += d
	}
	for i := range s.Pillars {
		s.Pillars[i].Until += d
	}
	s.SurfaceVersion++
}
