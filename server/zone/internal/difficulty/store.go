package difficulty

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Claim asks the store to stamp one area if nobody has.
type Claim struct {
	Cell        int
	PlayerLevel int
	CharID      string
	Name        string
	// Known are the neighbours' levels the zone knew when it asked (the
	// provisional fallback when the store fails; stores read their own).
	Known map[int]int
}

// Store persists stamps. Claim is first-writer-wins: it returns the stamp
// that stands (ours, Won, or an earlier one). Both methods run off the tick.
type Store interface {
	LoadAll(ctx context.Context, m *Geometry) ([]Stamp, error)
	Claim(ctx context.Context, m *Geometry, c Claim) (Stamp, error)
}

// Geometry is the immutable part of a Map a store needs (safe to share
// with the store goroutine): the world id, the grid, the Haven and the
// generator's danger per area.
type Geometry struct {
	WorldID string
	PerEdge int
	CellM   int
	haven   []bool
	danger  []float64
	def     *Map // for Propose's definition and neighbour lists (immutable parts only)
}

// Geometry snapshots the immutable parts of m for the store goroutine.
func (m *Map) Geometry(worldID string) *Geometry {
	g := &Geometry{WorldID: worldID, PerEdge: m.PerEdge, CellM: int(m.CellM), haven: append([]bool(nil), m.haven...), danger: make([]float64, len(m.level)), def: m}
	for c := range g.danger {
		g.danger[c] = m.Danger(c)
	}
	return g
}

// Propose computes the stamp for c given the stamped levels known for its
// neighbours (Haven neighbours count as level 1).
func (g *Geometry) Propose(c Claim, stamped map[int]int) int {
	var ns []int
	for _, n := range g.def.Neighbours(c.Cell) {
		if g.haven[n] {
			ns = append(ns, 1)
		} else if l, ok := stamped[n]; ok {
			ns = append(ns, l)
		}
	}
	return Propose(g.def.Def, c.PlayerLevel, ns, g.danger[c.Cell])
}

// ---- in memory (no database: dev, tests, two zones in one process) ----

// MemStore keeps stamps in memory, first writer wins. Safe for concurrent
// use, so two in-process zones sharing one MemStore agree like two zone
// processes sharing Postgres.
type MemStore struct {
	mu     sync.Mutex
	stamps map[string]map[int]Stamp
	// Delay simulates a database round trip (tests).
	Delay time.Duration
}

// NewMemStore is an empty store.
func NewMemStore() *MemStore { return &MemStore{stamps: map[string]map[int]Stamp{}} }

// LoadAll implements Store.
func (s *MemStore) LoadAll(_ context.Context, g *Geometry) ([]Stamp, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Stamp
	for _, st := range s.stamps[g.WorldID] {
		st.Won = false
		out = append(out, st)
	}
	return out, nil
}

// Claim implements Store.
func (s *MemStore) Claim(_ context.Context, g *Geometry, c Claim) (Stamp, error) {
	if s.Delay > 0 {
		time.Sleep(s.Delay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.stamps[g.WorldID]
	if w == nil {
		w = map[int]Stamp{}
		s.stamps[g.WorldID] = w
	}
	if st, ok := w[c.Cell]; ok {
		st.Won = false
		return st, nil
	}
	known := map[int]int{}
	for _, n := range g.def.Neighbours(c.Cell) {
		if st, ok := w[n]; ok {
			known[n] = st.Level
		}
	}
	st := Stamp{Cell: c.Cell, Level: g.Propose(c, known), By: c.CharID, ByName: c.Name, ByLevel: c.PlayerLevel, At: time.Now()}
	w[c.Cell] = st
	st.Won = true
	return st, nil
}

// ---- Postgres (area_difficulty, migration 0021) ----

// PGStore stamps areas in the shared Postgres.
type PGStore struct{ Pool *pgxpool.Pool }

// LoadAll implements Store.
func (s *PGStore) LoadAll(ctx context.Context, g *Geometry) ([]Stamp, error) {
	rows, err := s.Pool.Query(ctx, `SELECT cell_x, cell_z, level, stamped_by, stamped_by_name, stamped_by_level, stamped_at
		FROM area_difficulty WHERE world_id = $1::uuid AND cell_m = $2`, g.WorldID, g.CellM)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Stamp
	for rows.Next() {
		var cx, cz, lvl, byLvl int16
		var st Stamp
		if err := rows.Scan(&cx, &cz, &lvl, &st.By, &st.ByName, &byLvl, &st.At); err != nil {
			return nil, err
		}
		if int(cx) >= g.PerEdge || int(cz) >= g.PerEdge || cx < 0 || cz < 0 {
			continue
		}
		st.Cell, st.Level, st.ByLevel = int(cz)*g.PerEdge+int(cx), int(lvl), int(byLvl)
		out = append(out, st)
	}
	return out, rows.Err()
}

// Claim implements Store: read the stamped neighbours, propose, insert if
// absent (ON CONFLICT DO NOTHING: the first writer of a world's area wins,
// whichever zone it is), else read the stamp that won.
func (s *PGStore) Claim(ctx context.Context, g *Geometry, c Claim) (Stamp, error) {
	cx, cz := c.Cell%g.PerEdge, c.Cell/g.PerEdge
	if st, ok, err := s.get(ctx, g, c.Cell); err != nil || ok {
		return st, err
	}
	known := map[int]int{}
	rows, err := s.Pool.Query(ctx, `SELECT cell_x, cell_z, level FROM area_difficulty
		WHERE world_id = $1::uuid AND cell_m = $2 AND cell_x BETWEEN $3 AND $4 AND cell_z BETWEEN $5 AND $6`,
		g.WorldID, g.CellM, cx-1, cx+1, cz-1, cz+1)
	if err != nil {
		return Stamp{}, err
	}
	for rows.Next() {
		var x, z, l int16
		if err := rows.Scan(&x, &z, &l); err != nil {
			rows.Close()
			return Stamp{}, err
		}
		known[int(z)*g.PerEdge+int(x)] = int(l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Stamp{}, err
	}
	st := Stamp{Cell: c.Cell, Level: g.Propose(c, known), By: c.CharID, ByName: c.Name, ByLevel: c.PlayerLevel}
	err = s.Pool.QueryRow(ctx, `INSERT INTO area_difficulty (world_id, cell_m, cell_x, cell_z, level, stamped_by, stamped_by_name, stamped_by_level)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (world_id, cell_m, cell_x, cell_z) DO NOTHING
		RETURNING stamped_at`, g.WorldID, g.CellM, cx, cz, st.Level, st.By, st.ByName, st.ByLevel).Scan(&st.At)
	if err == nil {
		st.Won = true
		return st, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Stamp{}, err
	}
	// Someone (another zone) stamped it between our read and our insert.
	st, ok, err := s.get(ctx, g, c.Cell)
	if err == nil && !ok {
		err = errors.New("difficulty: area stamped concurrently but not readable")
	}
	return st, err
}

func (s *PGStore) get(ctx context.Context, g *Geometry, cell int) (Stamp, bool, error) {
	cx, cz := cell%g.PerEdge, cell/g.PerEdge
	st := Stamp{Cell: cell}
	var lvl, byLvl int16
	err := s.Pool.QueryRow(ctx, `SELECT level, stamped_by, stamped_by_name, stamped_by_level, stamped_at FROM area_difficulty
		WHERE world_id = $1::uuid AND cell_m = $2 AND cell_x = $3 AND cell_z = $4`, g.WorldID, g.CellM, cx, cz).Scan(&lvl, &st.By, &st.ByName, &byLvl, &st.At)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, false, nil
	}
	if err != nil {
		return st, false, err
	}
	st.Level, st.ByLevel = int(lvl), int(byLvl)
	return st, true, nil
}
