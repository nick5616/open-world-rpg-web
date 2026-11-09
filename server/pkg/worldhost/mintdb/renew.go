package mintdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/worldhost"
)

// RenewResult says what Renew did.
type RenewResult struct {
	Action  Action           `json:"action"` // "renewed" or "already-current"
	Before  accountapi.World `json:"before"`
	After   accountapi.World `json:"after"`
	Moved   int64            `json:"movedCharacters"` // saved positions reset to the spawn
	KeptAll bool             `json:"keptSites"`       // every old site kept its index and id
}

// Renewed is the action of a world renewal.
const (
	Renewed        Action = "renewed"
	AlreadyCurrent Action = "already-current"
)

// ErrRenewSites is returned when the new generator does not keep every site
// of the old one at its index and id: per-character progress (towers,
// waypoints, discoveries, attunements, last waypoint) is indexed by site, so
// such a renewal would need a progress migration this command does not do.
var ErrRenewSites = errors.New("the new generator does not keep the old sites at their indices; per-character progress cannot be carried over")

// RenewOfficial moves the official world to the loaded generator (spec 5
// "keeping old worlds working", rule 5: a deliberate, rare world renewal).
// The row keeps its id, name and seed (characters, items, parties, area
// stamps stay attached) and its spec; gen_version and atlas_hash become the
// new generator's. Player progress is carried by stable ids: the renewal is
// refused unless every site of the old atlas exists at the same index with
// the same id in the new one (old, the archived module of the row's
// gen_version, rebuilds the old site table to compare). Saved positions
// within reach of a settlement whose ground changed (hamlets and villages:
// their footprint is no longer levelled, buildings moved) are reset to the
// never-checkpointed marker, so those characters start at the atlas spawn.
// One transaction; a row already on this genVersion is left alone.
func RenewOfficial(ctx context.Context, db accountapi.DB, cur, old *worldhost.Module) (RenewResult, error) {
	w, ok, err := Official(ctx, db)
	if err != nil {
		return RenewResult{}, err
	}
	if !ok || worldhost.IsPlaceholder(w.GenVersion) {
		return RenewResult{}, errors.New("no minted official world to renew (mint it first: mintworld -official)")
	}
	if w.GenVersion == cur.GenVersionString() {
		return RenewResult{Action: AlreadyCurrent, Before: w, After: w}, nil
	}
	if v, ok := worldhost.ParseGenVersion(w.GenVersion); !ok || v > cur.GenVersion() {
		return RenewResult{}, fmt.Errorf("official world is on genVersion %q, the loaded generator is %s: refusing to move a world backwards", w.GenVersion, cur.GenVersionString())
	}
	var seed uint64
	if _, err := fmt.Sscan(w.Seed, &seed); err != nil {
		return RenewResult{}, err
	}
	// Old world, rebuilt and checked against its pin.
	before, _, err := old.OpenRow(worldhost.WorldRow{Seed: seed, Spec: w.Spec, GenVersion: w.GenVersion, AtlasHash: w.AtlasHash}, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		return RenewResult{}, fmt.Errorf("rebuilding the current official world: %w", err)
	}
	defer before.World.Close()
	after, err := cur.Mint(seed, w.Spec, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		return RenewResult{}, err
	}
	defer after.World.Close()
	if err := sameSites(before.World, after.World); err != nil {
		return RenewResult{}, err
	}
	tb, err := after.World.TownsBytes()
	if err != nil {
		return RenewResult{}, err
	}
	tw, err := towns.Parse(tb)
	if err != nil {
		return RenewResult{}, err
	}

	res := RenewResult{Action: Renewed, Before: w, KeptAll: true}
	err = pgx.BeginFunc(ctx, db.Pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			UPDATE worlds SET gen_version = $2, atlas_hash = $3
			WHERE id = $1 AND gen_version = $4 AND atlas_hash = $5
			RETURNING id::text, name, seed::text, spec, gen_version, atlas_hash, official`,
			w.ID, after.GenVersion, after.AtlasHash, w.GenVersion, w.AtlasHash).
			Scan(&res.After.ID, &res.After.Name, &res.After.Seed, &res.After.Spec, &res.After.GenVersion, &res.After.AtlasHash, &res.After.Official)
		if err != nil {
			return fmt.Errorf("renewing world %s (changed concurrently?): %w", w.ID, err)
		}
		rows, err := tx.Query(ctx, `SELECT id::text, position FROM characters WHERE world_id = $1`, w.ID)
		if err != nil {
			return err
		}
		var reset []string
		for rows.Next() {
			var id string
			var raw []byte
			if err := rows.Scan(&id, &raw); err != nil {
				rows.Close()
				return err
			}
			var p struct{ X, Z float64 }
			if json.Unmarshal(raw, &p) == nil && nearChangedGround(tw, p.X, p.Z) {
				reset = append(reset, id)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range reset {
			// WP04's creation marker: the zone places these at the atlas spawn.
			if _, err := tx.Exec(ctx, `UPDATE characters SET position = '{"x":2048,"y":0,"z":2048}'::jsonb, updated_at = now() WHERE id = $1::uuid`, id); err != nil {
				return err
			}
		}
		res.Moved = int64(len(reset))
		return nil
	})
	return res, err
}

// nearChangedGround: within 40 m of a hamlet's or village's layout (their
// ground and buildings changed in genVersion 2; walled towns kept theirs).
func nearChangedGround(t *towns.Towns, x, z float64) bool {
	for i := range t.Settlements {
		s := &t.Settlements[i]
		if !s.Walled && math.Hypot(s.X-x, s.Z-z) < s.Radius+40 {
			return true
		}
	}
	return false
}

// sameSites checks that every site of a keeps its index and id in b.
func sameSites(a, b *worldhost.World) error {
	sa, err := structures.ParseAtlas(a.Atlas)
	if err != nil {
		return err
	}
	sb, err := structures.ParseAtlas(b.Atlas)
	if err != nil {
		return err
	}
	if len(sb.Sites) < len(sa.Sites) {
		return fmt.Errorf("%w: %d sites -> %d", ErrRenewSites, len(sa.Sites), len(sb.Sites))
	}
	for i := range sa.Sites {
		if sa.Sites[i].ID != sb.Sites[i].ID {
			return fmt.Errorf("%w: site %d id %016x -> %016x", ErrRenewSites, i, sa.Sites[i].ID, sb.Sites[i].ID)
		}
	}
	return nil
}
