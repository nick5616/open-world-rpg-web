package game

// camp_pieces persistence (migration 0026; camps.go has the rules). One row
// per placed piece, written through the write-behind queue keyed per piece
// (a newer state of the same piece replaces a queued older one; a delete
// replaces a queued upsert), read once before the zone ticks (RestoreCamps).
// Chest items are `items` rows (camp_piece_id set) moved by the item
// journal (camps_chest.go).

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/zone/internal/items"
)

// CampRow is one persisted camp piece.
type CampRow struct {
	ID         uint64
	Owner      string
	OwnerName  string
	Kind       int
	XCm        int32
	YCm        int32
	ZCm        int32
	Rot        int
	Label      string
	Lock       int
	Party      uint32
	BurnUntil  float64
	State      int     // building pieces: bit 0 open (migration 0032)
	Cond       float64 // condition percent as of CondDay
	CondDay    float64
	PlacedAt   time.Time
	SeenAt     time.Time
	ChestItems []*items.Item // LoadCamps only: the chest's stored items
}

// CampStore persists camp pieces (nil: zone memory only).
type CampStore interface {
	LoadCamps(ctx context.Context, worldID string) ([]CampRow, error)
	SaveCamp(ctx context.Context, worldID, zoneID string, r CampRow) error
	DeleteCamp(ctx context.Context, worldID string, id uint64) error
}

// PGCampStore implements CampStore on the shared Postgres.
type PGCampStore struct{ Pool *pgxpool.Pool }

// LoadCamps returns every piece of the world with its chest items (dev
// worlds with a non-uuid id: none).
func (p *PGCampStore) LoadCamps(ctx context.Context, worldID string) ([]CampRow, error) {
	if !uuidRe.MatchString(worldID) {
		return nil, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT piece_id, owner_character_id, owner_name, kind, x_cm, y_cm, z_cm, rot, label, lock, party_hash, burn_until, placed_at, owner_seen_at, state, cond, cond_day
		FROM camp_pieces WHERE world_id = $1::uuid ORDER BY piece_id`, worldID)
	if err != nil {
		return nil, err
	}
	var out []CampRow
	byID := map[uint64]int{}
	for rows.Next() {
		var r CampRow
		var id, party int64
		var kind, rot, lock, state int16
		if err := rows.Scan(&id, &r.Owner, &r.OwnerName, &kind, &r.XCm, &r.YCm, &r.ZCm, &rot, &r.Label, &lock, &party, &r.BurnUntil, &r.PlacedAt, &r.SeenAt, &state, &r.Cond, &r.CondDay); err != nil {
			rows.Close()
			return nil, err
		}
		r.ID, r.Kind, r.Rot, r.Lock, r.Party, r.State = uint64(id), int(kind), int(rot), int(lock), uint32(party), int(state)
		byID[r.ID] = len(out)
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	irows, err := p.Pool.Query(ctx, `SELECT `+itemCols+`, camp_piece_id FROM items WHERE owner_character_id IS NULL AND world_id = $1::uuid AND camp_piece_id IS NOT NULL ORDER BY created_at, id`, worldID)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var piece int64
		it, err := scanItem(irows, &piece)
		if err != nil {
			return nil, err
		}
		if i, ok := byID[uint64(piece)]; ok {
			out[i].ChestItems = append(out[i].ChestItems, it)
		}
	}
	return out, irows.Err()
}

// SaveCamp upserts a piece.
func (p *PGCampStore) SaveCamp(ctx context.Context, worldID, zoneID string, r CampRow) error {
	if !uuidRe.MatchString(worldID) {
		return nil
	}
	_, err := p.Pool.Exec(ctx, `INSERT INTO camp_pieces (world_id, piece_id, owner_character_id, owner_name, kind, x_cm, y_cm, z_cm, rot, label, lock, party_hash, burn_until, placed_at, owner_seen_at, zone_id, state, cond, cond_day, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
		ON CONFLICT (world_id, piece_id) DO UPDATE SET owner_name = EXCLUDED.owner_name, label = EXCLUDED.label, lock = EXCLUDED.lock, party_hash = EXCLUDED.party_hash,
			burn_until = EXCLUDED.burn_until, owner_seen_at = GREATEST(camp_pieces.owner_seen_at, EXCLUDED.owner_seen_at), zone_id = EXCLUDED.zone_id, state = EXCLUDED.state, cond = EXCLUDED.cond, cond_day = EXCLUDED.cond_day, updated_at = now()`,
		worldID, int64(r.ID), r.Owner, r.OwnerName, int16(r.Kind), r.XCm, r.YCm, r.ZCm, int16(r.Rot), r.Label, int16(r.Lock), int64(r.Party), r.BurnUntil, r.PlacedAt, r.SeenAt, zoneID, int16(r.State), r.Cond, r.CondDay)
	return err
}

// DeleteCamp removes a piece's row (idempotent).
func (p *PGCampStore) DeleteCamp(ctx context.Context, worldID string, id uint64) error {
	if !uuidRe.MatchString(worldID) {
		return nil
	}
	_, err := p.Pool.Exec(ctx, `DELETE FROM camp_pieces WHERE world_id = $1::uuid AND piece_id = $2`, worldID, int64(id))
	return err
}

// campJSON is a piece in zone-to-zone control messages (ctlCampSet).
type campJSON struct {
	ID        uint64  `json:"id"`
	Owner     string  `json:"o"`
	OwnerName string  `json:"on"`
	Kind      int     `json:"k"`
	XCm       int32   `json:"x"`
	YCm       int32   `json:"y"`
	ZCm       int32   `json:"z"`
	Rot       int     `json:"r"`
	Label     string  `json:"l,omitempty"`
	Lock      int     `json:"lk,omitempty"`
	Party     uint32  `json:"p,omitempty"`
	BurnUntil float64 `json:"b,omitempty"`
	State     int     `json:"st,omitempty"`
	Cond      float64 `json:"cd,omitempty"`
	CondDay   float64 `json:"cdd,omitempty"`
	Gone      bool    `json:"g,omitempty"` // removed (picked up, decayed)
	Reason    int     `json:"why,omitempty"`
}

func (c campJSON) encode() json.RawMessage { b, _ := json.Marshal(c); return b }
