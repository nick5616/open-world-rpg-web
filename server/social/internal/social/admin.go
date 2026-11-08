package social

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

// Moderation actions for the admin CLI (spec 10: mute, suspend and ban
// accounts, read reports; no admin UI in v1). They live here, not in the
// CLI, so the integration tests drive exactly what moderators run.

// Admin bundles what moderation needs.
type Admin struct {
	Store *Store
	RDB   *redis.Client
	Actor string // recorded in moderation_log
}

// Subject is who an action lands on, resolved from a character name.
type Subject struct {
	Kind          string // account | profile
	ID            string // account id or profile id
	CharacterID   string
	CharacterName string
	WorldID       string
	Status        string
}

// statuses maps CLI verbs to the stored status.
var statuses = map[string]string{"mute": "muted", "unmute": "active", "suspend": "suspended", "ban": "banned", "unban": "active"}

// ResolveSubject finds the owner of a character by name (worldID "" = any world).
func (a *Admin) ResolveSubject(ctx context.Context, worldID, name string) (Subject, error) {
	var s Subject
	err := a.Store.Pool.QueryRow(ctx, `
		SELECT 'account', c.account_id::text, c.id::text, c.name, c.world_id::text, a.status
		  FROM characters c JOIN accounts a ON a.id = c.account_id
		 WHERE c.name_lower = lower($1) AND ($2 = '' OR c.world_id = NULLIF($2, '')::uuid)
		UNION ALL
		SELECT 'profile', l.profile_id::text, l.id::text, l.name, l.world_id::text, coalesce(s.status, 'active')
		  FROM local_characters l LEFT JOIN social_sanctions s ON s.profile_id = l.profile_id
		 WHERE l.name_lower = lower($1) AND ($2 = '' OR l.world_id = NULLIF($2, '')::uuid)
		LIMIT 2`, name, worldID).Scan(&s.Kind, &s.ID, &s.CharacterID, &s.CharacterName, &s.WorldID, &s.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, fmt.Errorf("no character named %q", name)
	}
	return s, err
}

// Apply runs mute|unmute|suspend|ban|unban on a character's owner: the
// whole account (or local profile), every character it has, every world.
// Live sessions are updated through the bus immediately.
func (a *Admin) Apply(ctx context.Context, verb, worldID, name, reason string) (Subject, error) {
	status, ok := statuses[verb]
	if !ok {
		return Subject{}, fmt.Errorf("unknown action %q", verb)
	}
	subj, err := a.ResolveSubject(ctx, worldID, name)
	if err != nil {
		return subj, err
	}
	var chars []struct{ id, world string }
	err = pgx.BeginFunc(ctx, a.Store.Pool, func(tx pgx.Tx) error {
		var q string
		if subj.Kind == "account" {
			if _, err := tx.Exec(ctx, `UPDATE accounts SET status = $2 WHERE id = $1::uuid`, subj.ID, status); err != nil {
				return err
			}
			q = `SELECT id::text, world_id::text FROM characters WHERE account_id = $1::uuid`
		} else {
			if _, err := tx.Exec(ctx, `
				INSERT INTO social_sanctions (profile_id, status, reason) VALUES ($1::uuid, $2, NULLIF($3, ''))
				ON CONFLICT (profile_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = now()`,
				subj.ID, status, reason); err != nil {
				return err
			}
			q = `SELECT id::text, world_id::text FROM local_characters WHERE profile_id = $1::uuid`
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO moderation_log (actor, action, subject_kind, subject_id, character_name, reason)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))`, a.Actor, verb, subj.Kind, subj.ID, subj.CharacterName, reason); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, q, subj.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c struct{ id, world string }
			if err := rows.Scan(&c.id, &c.world); err != nil {
				return err
			}
			chars = append(chars, c)
		}
		return rows.Err()
	})
	if err != nil {
		return subj, err
	}
	subj.Status = status
	byWorld := map[string][]string{}
	for _, c := range chars {
		byWorld[c.world] = append(byWorld[c.world], c.id)
	}
	for w, ids := range byWorld {
		b, _ := json.Marshal(&envelope{Kind: kindAdmin, World: w, Targets: ids, Status: status})
		if err := a.RDB.Publish(ctx, Channel(w), b).Err(); err != nil {
			return subj, fmt.Errorf("saved, but live sessions not notified: %w", err)
		}
	}
	return subj, nil
}

// ReportRow is a report as moderators read it.
type ReportRow struct {
	ID           string          `json:"id"`
	CreatedAt    time.Time       `json:"createdAt"`
	WorldID      string          `json:"worldId"`
	Channel      string          `json:"channel"`
	ReporterName string          `json:"reporter"`
	ReportedName string          `json:"reported"`
	ReportedID   string          `json:"reportedId"`
	Reason       string          `json:"reason,omitempty"`
	Resolution   string          `json:"resolution,omitempty"`
	Context      json.RawMessage `json:"context,omitempty"`
}

// Reports lists reports, newest first.
func (a *Admin) Reports(ctx context.Context, openOnly bool, limit int) ([]ReportRow, error) {
	rows, err := a.Store.Pool.Query(ctx, `
		SELECT id::text, created_at, coalesce(world_id::text, ''), channel, coalesce(reporter_name, reporter::text),
		       coalesce(reported_name, reported::text), reported::text, coalesce(reason, ''), coalesce(resolution, '')
		  FROM reports WHERE NOT $1 OR resolution IS NULL
		 ORDER BY created_at DESC LIMIT $2`, openOnly, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReportRow
	for rows.Next() {
		var r ReportRow
		if err := rows.Scan(&r.ID, &r.CreatedAt, &r.WorldID, &r.Channel, &r.ReporterName, &r.ReportedName, &r.ReportedID, &r.Reason, &r.Resolution); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Report returns one report with its captured context.
func (a *Admin) Report(ctx context.Context, id string) (ReportRow, error) {
	var r ReportRow
	err := a.Store.Pool.QueryRow(ctx, `
		SELECT id::text, created_at, coalesce(world_id::text, ''), channel, coalesce(reporter_name, reporter::text),
		       coalesce(reported_name, reported::text), reported::text, coalesce(reason, ''), coalesce(resolution, ''), context
		  FROM reports WHERE id = $1::uuid`, id).Scan(&r.ID, &r.CreatedAt, &r.WorldID, &r.Channel, &r.ReporterName, &r.ReportedName, &r.ReportedID, &r.Reason, &r.Resolution, &r.Context)
	return r, err
}

// Resolve closes a report with a resolution note.
func (a *Admin) Resolve(ctx context.Context, id, resolution string) error {
	return pgx.BeginFunc(ctx, a.Store.Pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE reports SET resolution = $2 WHERE id = $1::uuid`, id, resolution)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("no report %s", id)
		}
		_, err = tx.Exec(ctx, `INSERT INTO moderation_log (actor, action, subject_kind, subject_id, reason) VALUES ($1, 'resolve', 'report', $2, $3)`, a.Actor, id, resolution)
		return err
	})
}
