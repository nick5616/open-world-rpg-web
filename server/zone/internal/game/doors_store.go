package game

// door_state persistence (migration 0024; doors_sync.go has the rules).
// One row per door that ever changed, keyed by the door prop's stable id;
// writes come in batches through the write-behind queue (never the tick),
// reads once at startup (RestoreDoors).

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DoorRow is one persisted door.
type DoorRow struct {
	ID   uint64    // door prop stable id (Interact 34 targetId)
	Open bool      // the state its authority last decided
	At   time.Time // when (a row only ever moves forward in time)
}

// DoorStore persists building door states (nil: zone memory only).
type DoorStore interface {
	LoadDoors(ctx context.Context, worldID string) ([]DoorRow, error)
	// SaveDoors upserts rows; a row older than the stored one is ignored.
	SaveDoors(ctx context.Context, worldID, zoneID string, rows []DoorRow) error
}

// PGDoorStore implements DoorStore on the shared Postgres.
type PGDoorStore struct{ Pool *pgxpool.Pool }

// LoadDoors returns every stored door of the world (dev worlds: none).
func (p *PGDoorStore) LoadDoors(ctx context.Context, worldID string) ([]DoorRow, error) {
	if !uuidRe.MatchString(worldID) {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT door_id, open, changed_at FROM door_state WHERE world_id = $1::uuid`, worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DoorRow
	for rows.Next() {
		var r DoorRow
		var id int64
		if err := rows.Scan(&id, &r.Open, &r.At); err != nil {
			return nil, err
		}
		r.ID = uint64(id)
		out = append(out, r)
	}
	return out, rows.Err()
}

// SaveDoors writes a batch in one statement (idempotent: a retry after a
// timeout rewrites the same rows).
func (p *PGDoorStore) SaveDoors(ctx context.Context, worldID, zoneID string, rows []DoorRow) error {
	if !uuidRe.MatchString(worldID) {
		return errNotUUID
	}
	if len(rows) == 0 {
		return nil
	}
	ids := make([]int64, len(rows))
	open := make([]bool, len(rows))
	at := make([]time.Time, len(rows))
	for i, r := range rows {
		ids[i], open[i], at[i] = int64(r.ID), r.Open, r.At
	}
	_, err := p.Pool.Exec(ctx, `INSERT INTO door_state (world_id, door_id, open, changed_at, zone_id)
		SELECT $1::uuid, u.d, u.o, u.t, $5 FROM unnest($2::bigint[], $3::boolean[], $4::timestamptz[]) AS u(d, o, t)
		ON CONFLICT (world_id, door_id) DO UPDATE SET open = EXCLUDED.open, changed_at = EXCLUDED.changed_at, zone_id = EXCLUDED.zone_id
		WHERE door_state.changed_at <= EXCLUDED.changed_at`, worldID, ids, open, at, zoneID)
	return err
}

// MemDoorStore is an in-process DoorStore (tests; several zones may share one).
type MemDoorStore struct {
	mu      sync.Mutex
	rows    map[string]map[uint64]DoorRow
	writers map[uint64]map[string]bool
	saves   int
}

// NewMemDoorStore returns an empty store.
func NewMemDoorStore() *MemDoorStore {
	return &MemDoorStore{rows: map[string]map[uint64]DoorRow{}, writers: map[uint64]map[string]bool{}}
}

func (m *MemDoorStore) LoadDoors(_ context.Context, worldID string) ([]DoorRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []DoorRow
	for _, r := range m.rows[worldID] {
		out = append(out, r)
	}
	return out, nil
}

func (m *MemDoorStore) SaveDoors(_ context.Context, worldID, zoneID string, rows []DoorRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saves++
	w := m.rows[worldID]
	if w == nil {
		w = map[uint64]DoorRow{}
		m.rows[worldID] = w
	}
	for _, r := range rows {
		if old, ok := w[r.ID]; !ok || !r.At.Before(old.At) {
			w[r.ID] = r
		}
		if m.writers[r.ID] == nil {
			m.writers[r.ID] = map[string]bool{}
		}
		m.writers[r.ID][zoneID] = true
	}
	return nil
}

// Stats returns how many batches were saved and which zones wrote door id
// (tests).
func (m *MemDoorStore) Stats(id uint64) (saves int, writers []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for z := range m.writers[id] {
		writers = append(writers, z)
	}
	return m.saves, writers
}

// Row returns a stored door (tests).
func (m *MemDoorStore) Row(worldID string, id uint64) (DoorRow, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[worldID][id]
	return r, ok
}
