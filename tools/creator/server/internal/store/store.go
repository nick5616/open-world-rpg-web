// Package store writes minted worlds into the shared `worlds` table
// (contracts/migrations/0001_init.sql + 0002's `official` flag). "Minting
// stores (seed, spec, genVersion, atlasHash) in Postgres; that row is the
// world" (spec 6). Creator worlds are never official: the official world is
// the account service's to seed.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// World is one `worlds` row as the creator API returns it.
type World struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Seed       string          `json:"seed"` // decimal: uint64 does not fit a JS number
	Spec       json.RawMessage `json:"spec"`
	GenVersion string          `json:"genVersion"`
	AtlasHash  string          `json:"atlasHash"`
	Official   bool            `json:"official"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// Store wraps a pgx pool.
type Store struct{ Pool *pgxpool.Pool }

const cols = `id::text, name, seed::text, spec, gen_version, atlas_hash, official, created_at`

func scan(row pgx.Row) (World, error) {
	var w World
	var spec []byte
	err := row.Scan(&w.ID, &w.Name, &w.Seed, &spec, &w.GenVersion, &w.AtlasHash, &w.Official, &w.CreatedAt)
	w.Spec = spec
	return w, err
}

// Insert stores a minted world. Minting the same (seed, genVersion,
// atlasHash) twice returns the existing row with existed=true instead of a
// duplicate: the atlas hash covers the embedded canonical spec, so equal
// hashes mean the same world (a re-click on Mint must not create a twin that
// players would see in the world list). The advisory lock serializes
// concurrent mints of the same world; there is no unique index to lean on
// and adding one is a contract change for a cosmetic race.
func (s *Store) Insert(ctx context.Context, w World) (World, bool, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return World{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('creator-mint:' || $1 || ':' || $2 || ':' || $3, 0))`, w.Seed, w.GenVersion, w.AtlasHash); err != nil {
		return World{}, false, err
	}
	existing, err := scan(tx.QueryRow(ctx, `SELECT `+cols+` FROM worlds WHERE seed = $1::numeric AND gen_version = $2 AND atlas_hash = $3 ORDER BY created_at LIMIT 1`, w.Seed, w.GenVersion, w.AtlasHash))
	if err == nil {
		return existing, true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return World{}, false, err
	}
	out, err := scan(tx.QueryRow(ctx, `INSERT INTO worlds (name, seed, spec, gen_version, atlas_hash, official) VALUES ($1, $2::numeric, $3::jsonb, $4, $5, false) RETURNING `+cols,
		w.Name, w.Seed, string(w.Spec), w.GenVersion, w.AtlasHash))
	if err != nil {
		return World{}, false, err
	}
	return out, false, tx.Commit(ctx)
}

// List returns the newest worlds first (official ones included, flagged).
func (s *Store) List(ctx context.Context, limit int) ([]World, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+cols+` FROM worlds ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []World{}
	for rows.Next() {
		w, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
