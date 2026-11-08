package game

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/writebehind"
)

// CharacterStore is the zone's view of Postgres. Reads happen on login (on
// the connection goroutine, never the tick); writes go through the
// write-behind queue.
type CharacterStore interface {
	// LoadPosition returns the saved position, or ok=false if the character
	// has no row (WP04 creates characters; until then the zone spawns them).
	LoadPosition(ctx context.Context, characterID string) (pos movement.Vec3, ok bool, err error)
	// SavePosition checkpoints a position. A missing row returns an error
	// wrapping writebehind.ErrSkip (retrying cannot help).
	SavePosition(ctx context.Context, characterID string, pos movement.Vec3) error
}

// characters.id is a uuid column; anything else (dev names, local profiles'
// ids) cannot have a row, so we skip it without a round trip.
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ErrNoRow is wrapped by SavePosition when the character row is missing.
var ErrNoRow = fmt.Errorf("character row does not exist yet: %w", writebehind.ErrSkip)

// PGStore implements CharacterStore on the shared Postgres (spec 11
// `characters.position` jsonb {"x","y","z"} in meters).
type PGStore struct{ Pool *pgxpool.Pool }

type posJSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

// LoadPosition implements CharacterStore.
func (p *PGStore) LoadPosition(ctx context.Context, id string) (movement.Vec3, bool, error) {
	if !uuidRe.MatchString(id) {
		return movement.Vec3{}, false, nil
	}
	var raw []byte
	err := p.Pool.QueryRow(ctx, `SELECT position FROM characters WHERE id = $1::uuid`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return movement.Vec3{}, false, nil
	}
	if err != nil {
		return movement.Vec3{}, false, err
	}
	var pj posJSON
	if err := json.Unmarshal(raw, &pj); err != nil {
		return movement.Vec3{}, false, err
	}
	return movement.Vec3{X: pj.X, Y: pj.Y, Z: pj.Z}, true, nil
}

// SavePosition implements CharacterStore.
func (p *PGStore) SavePosition(ctx context.Context, id string, pos movement.Vec3) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	b, _ := json.Marshal(posJSON{pos.X, pos.Y, pos.Z})
	tag, err := p.Pool.Exec(ctx, `UPDATE characters SET position = $2::jsonb, updated_at = now() WHERE id = $1::uuid`, id, b)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoRow
	}
	return nil
}
