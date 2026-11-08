package social

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the Postgres side: relations keyed by character id (migration
// 0003, docs/cr/001), settings, sanctions and reports. Everything here is
// "a player would be upset to lose it" (spec 11); the rest lives in Redis.
type Store struct{ Pool *pgxpool.Pool }

// LookupName resolves a character by world and case-insensitive name across
// account and local characters (names are unique across both, decision 0004).
func (st *Store) LookupName(ctx context.Context, worldID, name string) (id, display string, ok bool, err error) {
	err = st.Pool.QueryRow(ctx, `
		SELECT id::text, name FROM characters WHERE world_id = $1::uuid AND name_lower = lower($2)
		UNION ALL
		SELECT id::text, name FROM local_characters WHERE world_id = $1::uuid AND name_lower = lower($2)
		LIMIT 1`, worldID, name).Scan(&id, &display)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	return id, display, err == nil, err
}

// NamesByIDs returns display names for the ids that have a character row.
func (st *Store) NamesByIDs(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := st.Pool.Query(ctx, `
		SELECT id::text, name FROM characters WHERE id = ANY($1::uuid[])
		UNION ALL
		SELECT id::text, name FROM local_characters WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// Relations loads who a character muted and blocked, and their filter setting.
func (st *Store) Relations(ctx context.Context, charID string) (muted, blocked []string, filter bool, err error) {
	filter = true
	rows, err := st.Pool.Query(ctx, `
		SELECT 'm', muted::text FROM social_mutes WHERE muter = $1::uuid
		UNION ALL
		SELECT 'b', blocked::text FROM social_blocks WHERE blocker = $1::uuid`, charID)
	if err != nil {
		return nil, nil, true, err
	}
	for rows.Next() {
		var kind, id string
		if err := rows.Scan(&kind, &id); err != nil {
			rows.Close()
			return nil, nil, true, err
		}
		if kind == "m" {
			muted = append(muted, id)
		} else {
			blocked = append(blocked, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, true, err
	}
	err = st.Pool.QueryRow(ctx, `SELECT profanity_filter FROM social_settings WHERE character_id = $1::uuid`, charID).Scan(&filter)
	if errors.Is(err, pgx.ErrNoRows) {
		return muted, blocked, true, nil
	}
	return muted, blocked, filter, err
}

// IsBlocked reports whether blocker has blocked blocked.
func (st *Store) IsBlocked(ctx context.Context, blocker, blocked string) (bool, error) {
	var one int
	err := st.Pool.QueryRow(ctx, `SELECT 1 FROM social_blocks WHERE blocker = $1::uuid AND blocked = $2::uuid`, blocker, blocked).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Block records a block and ends any friendship or pending request between
// the two, in one transaction: a blocked player should not keep seeing you
// online in their friends list.
func (st *Store) Block(ctx context.Context, blocker, blocked string) error {
	return pgx.BeginFunc(ctx, st.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO social_blocks (blocker, blocked) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, blocker, blocked); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM social_friends WHERE (requester = $1::uuid AND target = $2::uuid) OR (requester = $2::uuid AND target = $1::uuid)`, blocker, blocked)
		return err
	})
}

// Unblock removes a block.
func (st *Store) Unblock(ctx context.Context, blocker, blocked string) error {
	_, err := st.Pool.Exec(ctx, `DELETE FROM social_blocks WHERE blocker = $1::uuid AND blocked = $2::uuid`, blocker, blocked)
	return err
}

// Mute records a mute.
func (st *Store) Mute(ctx context.Context, muter, muted string) error {
	_, err := st.Pool.Exec(ctx, `INSERT INTO social_mutes (muter, muted) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, muter, muted)
	return err
}

// Unmute removes a mute.
func (st *Store) Unmute(ctx context.Context, muter, muted string) error {
	_, err := st.Pool.Exec(ctx, `DELETE FROM social_mutes WHERE muter = $1::uuid AND muted = $2::uuid`, muter, muted)
	return err
}

// SetFilter stores the profanity filter preference.
func (st *Store) SetFilter(ctx context.Context, charID string, on bool) error {
	_, err := st.Pool.Exec(ctx, `
		INSERT INTO social_settings (character_id, profanity_filter) VALUES ($1::uuid, $2)
		ON CONFLICT (character_id) DO UPDATE SET profanity_filter = EXCLUDED.profanity_filter, updated_at = now()`, charID, on)
	return err
}

// friendRow is one relation from the asking character's point of view.
type friendRow struct {
	ID    string
	State string // pending_out | pending_in | accepted
}

// Friends lists every friend and pending request involving charID.
func (st *Store) Friends(ctx context.Context, charID string) ([]friendRow, error) {
	rows, err := st.Pool.Query(ctx, `
		SELECT target::text, CASE WHEN state = 'accepted' THEN 'accepted' ELSE 'pending_out' END
		  FROM social_friends WHERE requester = $1::uuid
		UNION ALL
		SELECT requester::text, CASE WHEN state = 'accepted' THEN 'accepted' ELSE 'pending_in' END
		  FROM social_friends WHERE target = $1::uuid`, charID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []friendRow
	for rows.Next() {
		var r friendRow
		if err := rows.Scan(&r.ID, &r.State); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FriendLink returns the row between a and b, if any.
func (st *Store) FriendLink(ctx context.Context, a, b string) (requester, state string, ok bool, err error) {
	err = st.Pool.QueryRow(ctx, `
		SELECT requester::text, state FROM social_friends
		 WHERE (requester = $1::uuid AND target = $2::uuid) OR (requester = $2::uuid AND target = $1::uuid)`, a, b).Scan(&requester, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	return requester, state, err == nil, err
}

// CountFriends counts accepted friends plus pending requests in both
// directions: requests count toward the cap so nobody can be flooded with
// requests past FRIENDS_MAX.
func (st *Store) CountFriends(ctx context.Context, charID string) (int, error) {
	var n int
	err := st.Pool.QueryRow(ctx, `SELECT count(*) FROM social_friends WHERE requester = $1::uuid OR target = $1::uuid`, charID).Scan(&n)
	return n, err
}

// AddFriendRequest inserts a pending request.
func (st *Store) AddFriendRequest(ctx context.Context, worldID, from, to string) error {
	_, err := st.Pool.Exec(ctx, `INSERT INTO social_friends (requester, target, world_id, state) VALUES ($1::uuid, $2::uuid, $3::uuid, 'pending') ON CONFLICT DO NOTHING`, from, to, worldID)
	return err
}

// AcceptFriend turns requester's pending request to target into a friendship.
func (st *Store) AcceptFriend(ctx context.Context, requester, target string) (bool, error) {
	tag, err := st.Pool.Exec(ctx, `UPDATE social_friends SET state = 'accepted', updated_at = now() WHERE requester = $1::uuid AND target = $2::uuid AND state = 'pending'`, requester, target)
	return tag.RowsAffected() == 1, err
}

// RemoveFriend deletes the relation between a and b in either direction
// (declining, cancelling and unfriending are all this).
func (st *Store) RemoveFriend(ctx context.Context, a, b string) (bool, error) {
	tag, err := st.Pool.Exec(ctx, `DELETE FROM social_friends WHERE (requester = $1::uuid AND target = $2::uuid) OR (requester = $2::uuid AND target = $1::uuid)`, a, b)
	return tag.RowsAffected() > 0, err
}

// Report is one row for the reports table.
type Report struct {
	WorldID, Reporter, ReporterName, Reported, ReportedName, Channel, Reason string
	Context                                                                  any
}

// InsertReport stores a report and returns its id.
func (st *Store) InsertReport(ctx context.Context, r Report) (string, error) {
	b, err := json.Marshal(r.Context)
	if err != nil {
		return "", err
	}
	var id string
	err = st.Pool.QueryRow(ctx, `
		INSERT INTO reports (reporter, reported, channel, context, world_id, reporter_name, reported_name, reason)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, NULLIF($8, ''))
		RETURNING id::text`, r.Reporter, r.Reported, r.Channel, b, r.WorldID, r.ReporterName, r.ReportedName, r.Reason).Scan(&id)
	return id, err
}

// Status returns the moderation status for a ticket's owner: accounts.status
// for accounts, social_sanctions for local profiles. Unknown owners (dev
// tickets without rows) are active.
func (st *Store) Status(ctx context.Context, accountID, profileID string) (string, error) {
	var s string
	var err error
	switch {
	case accountID != "":
		err = st.Pool.QueryRow(ctx, `SELECT status FROM accounts WHERE id = $1::uuid`, accountID).Scan(&s)
	case profileID != "":
		err = st.Pool.QueryRow(ctx, `SELECT status FROM social_sanctions WHERE profile_id = $1::uuid`, profileID).Scan(&s)
	default:
		return "active", nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "active", nil
	}
	return s, err
}
