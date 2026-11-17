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

// LoadAppearance implements LookStore (CR 047): the character's stored appearance JSON.
func (p *PGStore) LoadAppearance(ctx context.Context, id string) ([]byte, error) {
	if !uuidRe.MatchString(id) {
		return nil, nil
	}
	var raw []byte
	err := p.Pool.QueryRow(ctx, `SELECT appearance FROM characters WHERE id = $1::uuid`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return raw, err
}

// World is the subset of a `worlds` row the zone announces and sends in
// Welcome.
type World struct {
	ID         string
	Seed       uint64
	GenVersion string
	// Spec and AtlasHash pin the terrain (WP07): the zone rebuilds the atlas
	// from Spec and refuses to serve if it doesn't hash to AtlasHash.
	Spec      []byte
	AtlasHash string
}

// OfficialWorld returns the world WP04's account service marks official
// (`worlds.official`, migration 0002). The director routes players to zones
// announced under that id, so a zone started without LODESTONE_WORLD_ID uses
// it. ok=false when there is none (or the column doesn't exist yet).
func (p *PGStore) OfficialWorld(ctx context.Context) (World, bool, error) {
	var w World
	var seed string
	err := p.Pool.QueryRow(ctx, `SELECT id::text, seed::text, gen_version, spec::text, atlas_hash FROM worlds WHERE official ORDER BY created_at LIMIT 1`).
		Scan(&w.ID, &seed, &w.GenVersion, &w.Spec, &w.AtlasHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return World{}, false, nil
	}
	if err != nil {
		return World{}, false, err
	}
	if _, err := fmt.Sscan(seed, &w.Seed); err != nil {
		return World{}, false, fmt.Errorf("world seed %q: %w", seed, err)
	}
	return w, true, nil
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

// ---- WP16: checkpoint fencing ----
//
// Two zones can hold writes for the same character in their write-behind
// queues around a handoff (or a release): the old owner's last checkpoint
// may still be queued, or retrying against a slow Postgres, when the new
// owner writes. Each owner writes with its epoch (Unix ms at admission,
// always above the previous owner's: handoff.go joinState) stored as
// position.e, and a write with an older epoch than the stored one is
// refused. So the newest owner's state always wins, whatever order the
// queues drain in. Single-zone zones write with epoch 0: the original,
// unfenced statements.

// ErrFenced: a newer owner already wrote this character (skip, don't retry).
var ErrFenced = fmt.Errorf("checkpoint superseded by a newer owner: %w", writebehind.ErrSkip)

// epochFence is the WHERE clause guarding a write with epoch $5 (position
// writes use $3; see SavePositionEpoch).
const epochFence = `COALESCE((position->>'e')::bigint, 0) <= $5`

// epochSaver is implemented by stores that can fence position writes.
type epochSaver interface {
	SavePositionEpoch(ctx context.Context, characterID string, pos movement.Vec3, epoch int64) error
}

func savePosition(ctx context.Context, store CharacterStore, id string, pos movement.Vec3, epoch int64) error {
	if es, ok := store.(epochSaver); ok && epoch > 0 {
		return es.SavePositionEpoch(ctx, id, pos, epoch)
	}
	return store.SavePosition(ctx, id, pos)
}

type posEpochJSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
	E int64   `json:"e"`
}

// SavePositionEpoch implements epochSaver. The JSON is built in Go (exact
// shortest floats; a float8 -> numeric cast in SQL would round to 15
// digits).
func (p *PGStore) SavePositionEpoch(ctx context.Context, id string, pos movement.Vec3, epoch int64) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	b, _ := json.Marshal(posEpochJSON{pos.X, pos.Y, pos.Z, epoch})
	tag, err := p.Pool.Exec(ctx, `UPDATE characters SET position = $2::jsonb, updated_at = now()
		WHERE id = $1::uuid AND COALESCE((position->>'e')::bigint, 0) <= $3`, id, b, epoch)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return p.missingOrFenced(ctx, id)
	}
	return nil
}

// missingOrFenced explains an UPDATE that touched no row.
func (p *PGStore) missingOrFenced(ctx context.Context, id string) error {
	var one int
	err := p.Pool.QueryRow(ctx, `SELECT 1 FROM characters WHERE id = $1::uuid`, id).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoRow
	}
	if err != nil {
		return err
	}
	return ErrFenced
}
