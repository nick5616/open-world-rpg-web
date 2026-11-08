package game

// Items in Postgres (WP14, spec 11 `items`, migration 0014): one row per
// item or stack, owned by a character (slot set) or lying in the world
// (owner NULL, world_* set), plus loot_grants markers for exactly-once
// rolls. ApplyItemOp is the single transaction of the item journal.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"lodestone/server/zone/internal/items"
)

type worldPosJSON struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

const itemCols = `id::text, kind, base_id, item_level, rarity, affixes, sockets, COALESCE(slot, ''), roll_seed, tradeable, provenance, qty, verified, COALESCE(display_name, '')`

func scanItem(row pgx.Row, extra ...any) (*items.Item, error) {
	var it items.Item
	var kind string
	var aff, sock, prov []byte
	dest := append([]any{&it.ID, &kind, &it.Base, &it.Level, &it.Rarity, &aff, &sock, &it.Slot, &it.Seed, &it.Tradeable, &prov, &it.Qty, &it.Verified, &it.Name}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	it.SetAffixesJSON(aff)
	it.SetSocketsJSON(sock)
	it.SetProvJSON(prov)
	return &it, nil
}

// LoadItems implements ItemStore.
func (p *PGStore) LoadItems(ctx context.Context, id string) ([]*items.Item, []string, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, nil, false, nil
	}
	var exists bool
	if err := p.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM characters WHERE id = $1::uuid)`, id).Scan(&exists); err != nil {
		return nil, nil, false, err
	}
	if !exists {
		return nil, nil, false, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT `+itemCols+` FROM items WHERE owner_character_id = $1::uuid ORDER BY created_at, id`, id)
	if err != nil {
		return nil, nil, false, err
	}
	var inv []*items.Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			rows.Close()
			return nil, nil, false, err
		}
		inv = append(inv, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	// Markers the zone checks in memory: containers opened, boss lockouts,
	// the starter kit. Kill/vein/take keys are unique by construction and
	// never need loading.
	mrows, err := p.Pool.Query(ctx, `SELECT grant_key FROM loot_grants WHERE character_id = $1::uuid
		AND (grant_key LIKE 'container:%' OR grant_key LIKE 'boss:%' OR grant_key = 'starter')`, id)
	if err != nil {
		return nil, nil, false, err
	}
	var markers []string
	for mrows.Next() {
		var k string
		if err := mrows.Scan(&k); err != nil {
			mrows.Close()
			return nil, nil, false, err
		}
		markers = append(markers, k)
	}
	mrows.Close()
	return inv, markers, true, mrows.Err()
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func rowArgs(r ItemRow) []any {
	it := r.Item
	kind := ""
	if d := it.Def(); d != nil {
		kind = d.Kind
	}
	var owner, slot *string
	var world *string
	var pos []byte
	var despawn *time.Time
	if r.Owner != "" {
		owner, slot = &r.Owner, nullStr(it.Slot)
	}
	if r.World != nil {
		w := r.World.WorldID
		world = &w
		pos, _ = json.Marshal(worldPosJSON{r.World.X, r.World.Y, r.World.Z})
		t := r.World.DespawnAt
		despawn = &t
	}
	return []any{it.ID, owner, kind, it.Base, max(1, it.Level), it.Rarity, string(it.AffixesJSON()), string(it.SocketsJSON()), slot, it.Seed,
		it.Tradeable, string(it.ProvJSON()), max(1, it.Qty), it.Verified, nullStr(it.Name), world, nullBytes(pos), despawn}
}

func nullBytes(b []byte) *string {
	if len(b) == 0 {
		return nil
	}
	s := string(b)
	return &s
}

const upsertSQL = `INSERT INTO items (id, owner_character_id, kind, base_id, item_level, rarity, affixes, sockets, slot, roll_seed, tradeable, provenance, qty, verified, display_name, world_id, world_pos, despawn_at, updated_at)
	VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::uuid, $17::jsonb, $18, now())
	ON CONFLICT (id) DO UPDATE SET owner_character_id = EXCLUDED.owner_character_id, kind = EXCLUDED.kind, base_id = EXCLUDED.base_id,
		item_level = EXCLUDED.item_level, rarity = EXCLUDED.rarity, affixes = EXCLUDED.affixes, sockets = EXCLUDED.sockets, slot = EXCLUDED.slot,
		roll_seed = EXCLUDED.roll_seed, tradeable = EXCLUDED.tradeable, provenance = EXCLUDED.provenance, qty = EXCLUDED.qty, verified = EXCLUDED.verified,
		display_name = EXCLUDED.display_name, world_id = EXCLUDED.world_id, world_pos = EXCLUDED.world_pos, despawn_at = EXCLUDED.despawn_at, updated_at = now()`

const updateSQL = `UPDATE items SET owner_character_id = $2::uuid, kind = $3, base_id = $4, item_level = $5, rarity = $6, affixes = $7::jsonb, sockets = $8::jsonb,
		slot = $9, roll_seed = $10, tradeable = $11, provenance = $12::jsonb, qty = $13, verified = $14, display_name = $15, world_id = $16::uuid,
		world_pos = $17::jsonb, despawn_at = $18, updated_at = now()
	WHERE id = $1::uuid`

// itemTxDelay / itemCommitDelay: test hooks for the kill-mid-grant test
// (LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS holds every item transaction open
// after its statements, before COMMIT; _COMMIT_DELAY_MS sleeps after the
// COMMIT before the journal hears of it). Each logs a line the test waits
// for. Never set in production.
var (
	itemTxDelay     = envMs("LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS")
	itemCommitDelay = envMs("LODESTONE_ZONE_TEST_ITEM_COMMIT_DELAY_MS")
)

func envMs(k string) time.Duration {
	n, _ := strconv.Atoi(os.Getenv(k))
	return time.Duration(n) * time.Millisecond
}

// ApplyItemOp implements ItemStore: the op in one transaction.
func (p *PGStore) ApplyItemOp(ctx context.Context, op *ItemOp) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if op.Grant != nil && op.Char != "" {
		n := len(op.Upsert)
		tag, err := tx.Exec(ctx, `INSERT INTO loot_grants (character_id, grant_key, op_id, roll_seed, items) VALUES ($1::uuid, $2, $3::uuid, $4, $5) ON CONFLICT DO NOTHING`,
			op.Char, op.Grant.Key, op.ID, op.Grant.Seed, n)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var prev string
			if err := tx.QueryRow(ctx, `SELECT op_id::text FROM loot_grants WHERE character_id = $1::uuid AND grant_key = $2`, op.Char, op.Grant.Key).Scan(&prev); err != nil {
				return err
			}
			if prev == op.ID {
				return nil // our own committed op, retried after a lost COMMIT reply
			}
			return fmt.Errorf("%w: %s for %s", ErrDuplicateGrant, op.Grant.Key, op.Char)
		}
	}
	for _, id := range op.Take {
		var owner *string
		err := tx.QueryRow(ctx, `SELECT owner_character_id::text FROM items WHERE id = $1::uuid FOR UPDATE`, id).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && owner != nil && *owner != op.Char) {
			return fmt.Errorf("%w: world item %s is gone", ErrRowMissing, id)
		}
		if err != nil {
			return err
		}
	}
	for _, r := range op.Upsert {
		if _, err := tx.Exec(ctx, upsertSQL, rowArgs(r)...); err != nil {
			return err
		}
	}
	for _, r := range op.Update {
		tag, err := tx.Exec(ctx, updateSQL, rowArgs(r)...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("%w: update %s (%s)", ErrRowMissing, r.Item.ID, r.Item.Base)
		}
	}
	if len(op.Delete) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM items WHERE id = ANY($1::uuid[])`, op.Delete); err != nil {
			return err
		}
	}
	if itemTxDelay > 0 {
		slog.Info("TEST item tx open", "op", op.ID, "note", op.Note, "holdMs", itemTxDelay.Milliseconds())
		time.Sleep(itemTxDelay)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if itemCommitDelay > 0 {
		slog.Info("TEST item tx committed", "op", op.ID, "note", op.Note, "holdMs", itemCommitDelay.Milliseconds())
		time.Sleep(itemCommitDelay)
	}
	return nil
}

// LoadWorldItems implements ItemStore.
func (p *PGStore) LoadWorldItems(ctx context.Context, worldID string, now time.Time) ([]ItemRow, error) {
	if !uuidRe.MatchString(worldID) {
		return nil, nil
	}
	if _, err := p.Pool.Exec(ctx, `DELETE FROM items WHERE owner_character_id IS NULL AND world_id = $1::uuid AND despawn_at <= $2`, worldID, now); err != nil {
		return nil, err
	}
	rows, err := p.Pool.Query(ctx, `SELECT `+itemCols+`, world_pos, despawn_at FROM items WHERE owner_character_id IS NULL AND world_id = $1::uuid AND despawn_at > $2`, worldID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ItemRow
	for rows.Next() {
		var pos []byte
		var despawn time.Time
		it, err := scanItem(rows, &pos, &despawn)
		if err != nil {
			return nil, err
		}
		var wp worldPosJSON
		_ = json.Unmarshal(pos, &wp)
		out = append(out, ItemRow{Item: it, World: &WorldSpot{WorldID: worldID, X: wp.X, Y: wp.Y, Z: wp.Z, DespawnAt: despawn}})
	}
	return out, rows.Err()
}

// itemKindOK guards against a base the zone doesn't know (an item from a
// newer build): it is kept in the database untouched and hidden.
func itemKindOK(it *items.Item) bool { return it.Def() != nil && !strings.HasPrefix(it.Base, "tome:") || items.D.Item(it.Base) != nil }
