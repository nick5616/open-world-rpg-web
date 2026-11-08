package game

// world_edits persistence (spec 11; WP09 writes vein_mined rows). Writes go
// through the write-behind queue (never the tick); reads happen once at
// startup (RestoreEdits). The table's sweeper (hourly, spec 11) deletes
// expired rows; the zone also deletes a vein's row when it respawns, so the
// active set stays small.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/writebehind"
)

// PGEditStore implements EditStore on the shared Postgres.
type PGEditStore struct{ Pool *pgxpool.Pool }

// veinParams is the params jsonb of a vein_mined row: the carve sphere (the
// same four f32 values the wire EditRecord.params carries) and, for humans
// reading the table, the respawn time (expires_at is the authority).
type veinParams struct {
	X         float32 `json:"x"`
	Y         float32 `json:"y"`
	Z         float32 `json:"z"`
	R         float32 `json:"r"`
	RespawnAt string  `json:"respawnAt"`
}

// errNotUUID: dev worlds have non-uuid ids and no worlds row; edits for them
// live in memory only.
var errNotUUID = fmt.Errorf("world id is not a uuid (dev world): %w", writebehind.ErrSkip)

// LoadEdits returns the world's edits that have not expired at now.
func (p *PGEditStore) LoadEdits(ctx context.Context, worldID string, now time.Time) ([]StoredEdit, error) {
	if !uuidRe.MatchString(worldID) {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT edit_id, chunk_x, chunk_z, kind, target_id::text, params, tick, expires_at
		FROM world_edits WHERE world_id = $1::uuid AND (expires_at IS NULL OR expires_at > $2) ORDER BY edit_id`, worldID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredEdit
	for rows.Next() {
		var e StoredEdit
		var target string
		var params []byte
		var tick int64
		var exp *time.Time
		if err := rows.Scan(&e.EditID, &e.ChunkX, &e.ChunkZ, &e.Kind, &target, &params, &tick, &exp); err != nil {
			return nil, err
		}
		if e.TargetID, err = strconv.ParseUint(target, 10, 64); err != nil {
			return nil, fmt.Errorf("world_edits target_id %q: %w", target, err)
		}
		var vp veinParams
		if err := json.Unmarshal(params, &vp); err == nil {
			e.X, e.Y, e.Z, e.R = vp.X, vp.Y, vp.Z, vp.R
		}
		e.Tick = uint32(tick)
		if exp != nil {
			e.ExpiresAt = *exp
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SaveEdit inserts one edit (idempotent: retries after a timeout are safe).
func (p *PGEditStore) SaveEdit(ctx context.Context, worldID string, e StoredEdit) error {
	if !uuidRe.MatchString(worldID) {
		return errNotUUID
	}
	params, _ := json.Marshal(veinParams{X: e.X, Y: e.Y, Z: e.Z, R: e.R, RespawnAt: e.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	_, err := p.Pool.Exec(ctx, `INSERT INTO world_edits (world_id, chunk_x, chunk_z, edit_id, kind, target_id, params, tick, expires_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6::numeric, $7::jsonb, $8, $9) ON CONFLICT (world_id, edit_id) DO NOTHING`,
		worldID, e.ChunkX, e.ChunkZ, e.EditID, e.Kind, strconv.FormatUint(e.TargetID, 10), string(params), int64(e.Tick), e.ExpiresAt)
	return err
}

// DeleteEdit removes an edit (a respawned vein).
func (p *PGEditStore) DeleteEdit(ctx context.Context, worldID string, editID int64) error {
	if !uuidRe.MatchString(worldID) {
		return errNotUUID
	}
	_, err := p.Pool.Exec(ctx, `DELETE FROM world_edits WHERE world_id = $1::uuid AND edit_id = $2`, worldID, editID)
	return err
}
