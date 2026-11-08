package game

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"lodestone/server/zone/internal/explore"
)

// Exploration progress in Postgres (WP12, spec 11): characters.level, xp,
// last_waypoint (the waypoint site's stable 64-bit id stored as int64 bits)
// and character_progress.towers / waypoints / discoveries (bitsets indexed
// by atlas site index) / pins (jsonb, migration 0004).

// LoadProgress implements ProgressStore. found=false when the character has
// no row (bots, dev tickets) or no progress yet.
func (p *PGStore) LoadProgress(ctx context.Context, id string, sites []uint64) (*explore.Progress, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, false, nil
	}
	var (
		level                         int
		xp                            int64
		lastWP                        *int64
		towers, waypoints, discovered []byte
		pins                          []byte
	)
	err := p.Pool.QueryRow(ctx, `
		SELECT c.level, c.xp, c.last_waypoint,
		       COALESCE(cp.towers, '\x'::bytea), COALESCE(cp.waypoints, '\x'::bytea), COALESCE(cp.discoveries, '\x'::bytea),
		       COALESCE(cp.pins, '[]'::jsonb)
		FROM characters c LEFT JOIN character_progress cp ON cp.character_id = c.id
		WHERE c.id = $1::uuid`, id).Scan(&level, &xp, &lastWP, &towers, &waypoints, &discovered, &pins)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	pr := explore.NewProgress()
	pr.XP = xp
	// The level column is derived data: recompute it from XP so a tuning
	// change to the curve (WP13) can never leave the two inconsistent.
	pr.Level = max(level, explore.LevelForXP(xp))
	pr.Towers, pr.Waypoints, pr.Discoveries = towers, waypoints, discovered
	pr.LoadPinsJSON(pins)
	if lastWP != nil {
		for i, sid := range sites {
			if int64(sid) == *lastWP {
				pr.LastWaypoint = i
				break
			}
		}
	}
	return pr, true, nil
}

// SaveProgress implements ProgressStore: one transaction updating the
// characters row and upserting character_progress, so level/xp and the
// bitsets that earned them never disagree after a crash.
func (p *PGStore) SaveProgress(ctx context.Context, id string, s ProgressSnapshot) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	return pgx.BeginFunc(ctx, p.Pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE characters SET level = $2, xp = $3, last_waypoint = $4, updated_at = now() WHERE id = $1::uuid`, id, s.Level, s.XP, s.LastWaypoint)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNoRow
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO character_progress (character_id, towers, waypoints, discoveries, pins)
			VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
			ON CONFLICT (character_id) DO UPDATE SET towers = EXCLUDED.towers, waypoints = EXCLUDED.waypoints,
				discoveries = EXCLUDED.discoveries, pins = EXCLUDED.pins`,
			id, s.Towers, s.Waypoints, s.Discoveries, string(s.Pins))
		return err
	})
}
