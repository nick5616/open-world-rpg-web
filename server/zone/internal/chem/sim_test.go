package chem

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/weather"
)

var update = flag.Bool("update", false, "rewrite testdata/sim_vectors.json")

// synth is a synthetic world both languages can build exactly
// (client/src/systems/chem/chem.test.ts): biome bands, a round lake.
type synth struct{ seed uint64 }

func (s synth) lake(ix, iz int) bool { dx, dz := ix-1000, iz-1000; return dx*dx+dz*dz < 30*30 }
func (s synth) Material(ix, iz int) uint8 {
	if !InWorld(ix, iz) {
		return MatNone
	}
	if s.lake(ix, iz) {
		return MatWater
	}
	return BiomeMaterial(s.seed, ix, iz, ((ix>>4)+(iz>>4))%6)
}
func (s synth) Height(ix, iz int) float64 { return 100 + float64(ix%7)*0.25 }
func (s synth) Water(ix, iz int) float64 {
	if s.lake(ix, iz) {
		return 101.5
	}
	return math.Inf(-1)
}

type vecOp struct {
	Step   int64  `json:"step"`
	Kind   uint8  `json:"kind"`
	Cell   uint32 `json:"cell"`
	Radius int32  `json:"radius"`
}

type scenario struct {
	Name    string   `json:"name"`
	Seed    string   `json:"seed"`
	WindDeg int      `json:"windDeg"`
	Start   int64    `json:"start"`
	Steps   int      `json:"steps"`
	Rain    *bool    `json:"rain"`
	Climate int      `json:"climate"` // CR 030: a uniform weather climate (-1: WP10's global rain)
	Ops     []vecOp  `json:"ops"`
	Hashes  []uint32 `json:"hashes"`  // after every 10th step
	Burning []int    `json:"burning"` // burning count after every 10th step
	Final   []uint32 `json:"final"`   // sorted id, state, until-step triples
}

func runScenario(sc *scenario) *Sim {
	var seed uint64
	_ = json.Unmarshal([]byte(sc.Seed), &seed)
	s := NewSim(seed, sc.WindDeg, synth{seed}, sc.Start)
	s.Rain = sc.Rain
	if sc.Climate >= 0 {
		s.Weather = &Weather{Climate: weather.UniformClimate(sc.Climate), Override: -1}
	}
	for _, o := range sc.Ops {
		s.Schedule(Op{Step: o.Step, Kind: o.Kind, Cell: o.Cell, Radius: o.Radius})
	}
	sc.Hashes, sc.Burning = nil, nil
	for i := 1; i <= sc.Steps; i++ {
		s.AdvanceTo(sc.Start + int64(i))
		if i%10 == 0 {
			sc.Hashes = append(sc.Hashes, s.Hash())
			sc.Burning = append(sc.Burning, s.Burning())
		}
	}
	sc.Final = nil
	for _, c := range sortedCells(s) {
		sc.Final = append(sc.Final, c.ID, uint32(c.State), uint32(c.Until-s.Step))
	}
	return s
}

func sortedCells(s *Sim) []BaselineCell {
	var out []BaselineCell
	for ch := uint32(0); ch < ChunksN*ChunksN; ch++ {
		_ = ch
	}
	for _, ch := range s.ActiveChunks() {
		s.ChunkCellsOf(ch, func(id uint32, st uint8, until int64) { out = append(out, BaselineCell{id, st, until}) })
	}
	// ActiveChunks is sorted by chunk, cells by id inside a chunk: sort globally by id.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].ID < out[j-1].ID; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func scenarios() []*scenario {
	dry, wet := false, true
	start := int64(8813000123) // a realistic world-time step (> 2^32)
	c := func(ix, iz int) uint32 { return CellID(ix, iz) }
	return []*scenario{
		{Name: "meadow-fire", Seed: "20261108", WindDeg: 270, Start: start, Steps: 300, Rain: &dry, Climate: -1,
			Ops: []vecOp{{start + 3, OpIgnite, c(900, 905), 1}}},
		{Name: "two-fires-wind-north", Seed: "1234", WindDeg: 0, Start: start, Steps: 400, Rain: &dry, Climate: -1,
			Ops: []vecOp{{start + 3, OpIgnite, c(1100, 1100), 0}, {start + 40, OpIgnite, c(1130, 1090), 2}, {start + 120, OpExtinguish, c(1100, 1110), 6}}},
		{Name: "rain-douses", Seed: "7", WindDeg: 135, Start: start, Steps: 300, Rain: &wet, Climate: -1,
			Ops: []vecOp{{start + 1, OpIgnite, c(950, 950), 3}}},
		{Name: "ice-and-fire", Seed: "20261108", WindDeg: 45, Start: start, Steps: 350, Rain: &dry, Climate: -1,
			Ops: []vecOp{{start + 2, OpFreeze, c(1000, 1000), 6}, {start + 2, OpIgnite, c(1000, 1033), 2}, {start + 5, OpFreeze, c(1025, 1000), 4}, {start + 60, OpIgnite, c(1000, 1031), 1}}},
		{Name: "seeded-rain", Seed: "99", WindDeg: 200, Start: 0, Steps: 400, Rain: nil, Climate: -1,
			Ops: []vecOp{{2, OpIgnite, c(700, 640), 2}, {2, OpIgnite, c(705, 650), 0}}},
		// CR 030: rain where each burning cell is (a wet climate; fronts differ).
		{Name: "weather-rain", Seed: "20261108", WindDeg: 90, Start: start, Steps: 500, Rain: nil, Climate: 1,
			Ops: []vecOp{{start + 2, OpIgnite, c(700, 640), 3}, {start + 2, OpIgnite, c(1400, 1500), 3}, {start + 2, OpIgnite, c(260, 1800), 3}}},
	}
}

// TestSimVectors pins the simulation the TS twin replays bit for bit.
func TestSimVectors(t *testing.T) {
	path := filepath.Join("testdata", "sim_vectors.json")
	got := scenarios()
	for _, sc := range got {
		runScenario(sc)
	}
	if *update {
		b, _ := json.MarshalIndent(got, "", " ")
		_ = os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test ./internal/chem -run SimVectors -update)", err)
	}
	var want []*scenario
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	for i, sc := range got {
		w := want[i]
		if len(sc.Hashes) != len(w.Hashes) || len(sc.Final) != len(w.Final) {
			t.Fatalf("%s: shape changed", sc.Name)
		}
		for j := range sc.Hashes {
			if sc.Hashes[j] != w.Hashes[j] {
				t.Fatalf("%s: hash %d differs", sc.Name, j)
			}
		}
	}
	// Each scenario actually does something.
	for _, sc := range got {
		peak := 0
		for _, n := range sc.Burning {
			peak = max(peak, n)
		}
		if peak == 0 && sc.Name != "ice-and-fire" {
			t.Fatalf("%s: never burned", sc.Name)
		}
		t.Logf("%s: peak burning %d, final cells %d", sc.Name, peak, len(sc.Final)/3)
	}
}

func TestFireSpreadsDownwindAndBurnsOut(t *testing.T) {
	src := patch{uniform{MatGrass}, 500, 500, 40}
	s := NewSim(42, 270, src, 0) // wind from the west: blows toward +x
	no := false
	s.Rain = &no
	// A fire spell's 3 x 3 cells; v5 spread (docs/cr/016) makes small patch
	// fires, so look at where the whole fire went after a minute.
	for dx := -1; dx <= 1; dx++ {
		for dz := -1; dz <= 1; dz++ {
			s.Schedule(Op{Step: 1, Kind: OpIgnite, Cell: CellID(500+dx, 500+dz)})
		}
	}
	// The first cell burns out in about 20 s (16-24 s).
	s.AdvanceTo(2)
	st, until := s.State(CellID(500, 500))
	if st != StBurning || until < 1+80 || until > 1+120 {
		t.Fatalf("ignition cell: state %d until %d", st, until)
	}
	s.AdvanceTo(300) // 60 s
	down, up := 0, 0
	s.Cells(func(id uint32, st uint8, _ int64) {
		ix, _ := CellXZ(id)
		if ix > 501 {
			down++
		}
		if ix < 499 {
			up++
		}
	})
	if down <= up {
		t.Fatalf("fire should run downwind (+x): %d cells downwind, %d upwind", down, up)
	}
	if n := s.burning; n > 200 {
		t.Fatalf("v5 fires stay small: %d burning after 60 s", n)
	}
	if st, _ := s.State(CellID(500, 500)); st != StBurnt {
		t.Fatal("should be burnt out")
	}
	// Regrows in an in-game day.
	s.AdvanceTo(int64(until) + constants.FireRegrowSteps + 1)
	if st, _ := s.State(CellID(500, 500)); st != StNone && st != StBurning {
		t.Fatalf("should have regrown, state %d", st)
	}
}

type uniform struct{ m uint8 }

// patch is uniform material within r cells of (cx, cz), bare outside.
type patch struct {
	uniform
	cx, cz, r int
}

func (p patch) Material(ix, iz int) uint8 {
	if dx, dz := ix-p.cx, iz-p.cz; dx*dx+dz*dz > p.r*p.r {
		return MatNone
	}
	return p.m
}

func (u uniform) Material(ix, iz int) uint8 { return u.m }
func (u uniform) Height(ix, iz int) float64 { return 10 }
func (u uniform) Water(ix, iz int) float64  { return 11 }

func TestRainDousesAndIceFreezesAndMelts(t *testing.T) {
	yes := true
	s := NewSim(3, 0, uniform{MatGrass}, 0)
	s.Rain = &yes
	s.Schedule(Op{Step: 1, Kind: OpIgnite, Cell: CellID(10, 10), Radius: 3})
	s.AdvanceTo(1)
	if s.Burning() == 0 {
		t.Fatal("ignite")
	}
	s.AdvanceTo(200)
	if s.Burning() != 0 {
		t.Fatalf("rain should put it out, %d burning", s.Burning())
	}
	w := NewSim(3, 0, uniform{MatWater}, 0)
	w.Schedule(Op{Step: 1, Kind: OpFreeze, Cell: CellID(20, 20), Radius: 2})
	w.AdvanceTo(1)
	if y, ok := w.Sheet(CellID(21, 20)); !ok || y != 11 {
		t.Fatal("frozen sheet at the water height")
	}
	w.AdvanceTo(1 + constants.FreezeSteps)
	if _, ok := w.Sheet(CellID(21, 20)); ok {
		t.Fatal("thaws after 60 s")
	}
}

func TestOverlayGround(t *testing.T) {
	s := NewSim(1, 0, uniform{MatWater}, 0)
	var o Overlay
	g := Ground{Inner: movement.Flat{Y: 5}, O: &o}
	s.Schedule(Op{Step: 1, Kind: OpFreeze, Cell: CellID(50, 50), Radius: 1})
	s.Schedule(Op{Step: 1, Kind: OpPillar, Pillar: QuantizePillar(Pillar{ID: 7, X: 200, Z: 200, BaseY: 5, Height: constants.PillarHeightM, Half: constants.PillarHalfM, Run: constants.PillarWallRunM})})
	s.AdvanceTo(1)
	o.Sync(s)
	if h := g.HeightAt(101, 101); h != 11 {
		t.Fatalf("ice sheet %v", h)
	}
	if h := g.HeightAt(200.5, 199); h != 11 {
		t.Fatalf("pillar top %v", h)
	}
	if h := g.HeightAt(200+1.5+0.53, 200); math.Abs(h-8) > 1e-9 {
		t.Fatalf("pillar wall %v", h)
	}
	// 80 degree walls: climbable by WP10 (50..89 degrees).
	if sl := movement.SlopeAt(g, 200+1.5+0.5, 200); math.Atan(math.Sqrt(sl.T2))*180/math.Pi < 75 {
		t.Fatalf("wall slope %v", sl)
	}
	// A cave far below the sheet doesn't see it.
	if h := g.AtLevel(-30).HeightAt(101, 101); h != 5 {
		t.Fatalf("cave level sees the overlay: %v", h)
	}
	s.AdvanceTo(1 + constants.PillarSteps)
	o.Sync(s)
	if h := g.HeightAt(200, 200); h != 5 {
		t.Fatalf("pillar crumbled: %v", h)
	}
}

func TestCodecRoundTrip(t *testing.T) {
	s := NewSim(9, 90, uniform{MatGrass}, 1000)
	s.Schedule(Op{Step: 1001, Kind: OpIgnite, Cell: CellID(64, 64), Radius: 2})
	s.AdvanceTo(1010)
	ch := ChunkOf(CellID(64, 64))
	step, cells, err := DecodeBaseline(ch, EncodeBaseline(s, ch))
	if err != nil || step != 1010 {
		t.Fatal(err)
	}
	c := NewSim(9, 90, uniform{MatGrass}, 1010)
	for _, a := range s.ActiveChunks() {
		_, cs, _ := DecodeBaseline(a, EncodeBaseline(s, a))
		c.LoadChunk(a, cs)
	}
	if c.Hash() != s.Hash() || len(cells) == 0 {
		t.Fatal("baseline round trip")
	}
	c.AdvanceTo(1100)
	s.AdvanceTo(1100)
	if c.Hash() != s.Hash() {
		t.Fatal("a client loaded from baselines continues identically")
	}
	op := Op{Step: 77, Kind: OpPillar, Pillar: QuantizePillar(Pillar{ID: 3, X: 10.004, Z: 20, BaseY: 30.5, Height: 6, Half: 1.5, Run: 1.06})}
	ev := OpEvent(op)
	back, err := DecodeOp(&ev)
	if err != nil || back.Pillar != op.Pillar || back.Step != 77 {
		t.Fatalf("pillar op %+v vs %+v", back, op)
	}
	ev = OpEvent(Op{Step: 5, Kind: OpFreeze, Cell: 12345, Radius: 3})
	if b, _ := DecodeOp(&ev); b.Kind != OpFreeze || b.Cell != 12345 || b.Radius != 3 || ev.Kind != EvFreeze {
		t.Fatal("freeze op")
	}
	if bm := EncodeBitmap(s, ch); len(bm) != 8+256 {
		t.Fatal("bitmap size")
	}
	_ = proto.Event{}
}

func TestRebaseKeepsTheFireAndItsTimers(t *testing.T) {
	no := false
	a := NewSim(5, 90, patch{uniform{MatGrass}, 100, 100, 30}, 1000)
	b := NewSim(5, 90, patch{uniform{MatGrass}, 100, 100, 30}, 1000)
	a.Rain, b.Rain = &no, &no
	for _, s := range []*Sim{a, b} {
		s.Schedule(Op{Step: 1003, Kind: OpIgnite, Cell: CellID(100, 100), Radius: 1})
		s.AdvanceTo(1050)
	}
	b.Rebase(1050 - 40000) // the clock jumped back
	if a.Hash() != b.Hash() {
		t.Fatal("rebase changed the relative state")
	}
	// Spread rolls hash the absolute step, so the two diverge from here (clients
	// re-sync from fresh baselines after a jump); the fire just keeps burning.
	before := b.Burning()
	b.AdvanceTo(1060 - 40000)
	if before == 0 || b.Burning() == 0 {
		t.Fatal("the rebased fire went out")
	}
}
