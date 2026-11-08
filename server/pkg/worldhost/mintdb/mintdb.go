// Package mintdb writes minted worlds into Postgres (`worlds` rows): the one
// place that turns WP04's placeholder official world into a real one
// (spec 6: minting stores (seed, spec, genVersion, atlasHash); that row is
// the world). Used by the account service at startup and by
// server/pkg/cmd/mintworld. Kept out of worldhost itself so the bots and the
// zone's terrain code don't link the database driver.
package mintdb

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/worldhost"
)

// Action says what EnsureOfficial did.
type Action string

const (
	AlreadyMinted Action = "already-minted" // row existed with a real gen_version; untouched
	Created       Action = "created"        // no official row: inserted a minted one
	Upgraded      Action = "upgraded"       // placeholder row: spec/gen_version/atlas_hash filled in, seed kept
)

// ErrMinted is returned when asked to change a world that is already minted:
// a minted world is pinned forever (spec 5 rule 6).
var ErrMinted = errors.New("world is already minted with different values; refusing to change it")

// Official loads the official world row, ok=false when none exists.
func Official(ctx context.Context, db accountapi.DB) (accountapi.World, bool, error) {
	var w accountapi.World
	err := db.Pool.QueryRow(ctx, `SELECT id::text, name, seed::text, spec, gen_version, atlas_hash, official FROM worlds WHERE official ORDER BY created_at LIMIT 1`).
		Scan(&w.ID, &w.Name, &w.Seed, &w.Spec, &w.GenVersion, &w.AtlasHash, &w.Official)
	if errors.Is(err, pgx.ErrNoRows) {
		return accountapi.World{}, false, nil
	}
	return w, err == nil, err
}

// EnsureOfficial makes sure the official world exists and is minted.
// defaults supplies name and seed for a new row (an existing row keeps its
// seed: characters already live in that world). load is called only when a
// mint is needed, so services with a minted world never pay for compiling
// the wasm.
func EnsureOfficial(ctx context.Context, db accountapi.DB, load func() (*worldhost.Module, error), defaults accountapi.World) (accountapi.World, Action, error) {
	existing, ok, err := Official(ctx, db)
	if err != nil {
		return accountapi.World{}, "", err
	}
	if ok && !worldhost.IsPlaceholder(existing.GenVersion) {
		return existing, AlreadyMinted, nil
	}
	seedText := defaults.Seed
	if ok {
		seedText = existing.Seed
	}
	var seed uint64
	if _, err := fmt.Sscan(seedText, &seed); err != nil {
		return accountapi.World{}, "", fmt.Errorf("world seed %q: %w", seedText, err)
	}
	mod, err := load()
	if err != nil {
		return accountapi.World{}, "", err
	}
	mt, err := mod.Mint(seed, nil, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		return accountapi.World{}, "", err
	}
	mt.World.Close()
	if !ok {
		row := defaults
		if row.Name == "" {
			row.Name = mt.Name
		}
		row.Spec, row.GenVersion, row.AtlasHash = mt.Spec, mt.GenVersion, mt.AtlasHash
		w, created, err := db.EnsureOfficialWorld(ctx, row)
		if err != nil {
			return accountapi.World{}, "", err
		}
		if created {
			return w, Created, nil
		}
		existing = w // lost a race with another starter; fall through
		if !worldhost.IsPlaceholder(existing.GenVersion) {
			return existing, AlreadyMinted, nil
		}
	}
	w, err := SetMint(ctx, db, existing.ID, mt)
	return w, Upgraded, err
}

// SetMint fills a world row's spec, gen_version and atlas_hash. Only a
// placeholder row is changed (compare-and-set on gen_version, so concurrent
// minters can't interleave); a row already holding exactly these values is
// a no-op; anything else is ErrMinted.
func SetMint(ctx context.Context, db accountapi.DB, id string, mt worldhost.Minted) (accountapi.World, error) {
	var w accountapi.World
	err := db.Pool.QueryRow(ctx, `
		UPDATE worlds SET spec = $2::jsonb, gen_version = $3, atlas_hash = $4
		WHERE id = $1 AND gen_version IN ('', 'placeholder', 'dev') AND seed = $5::numeric
		RETURNING id::text, name, seed::text, spec, gen_version, atlas_hash, official`,
		id, string(mt.Spec), mt.GenVersion, mt.AtlasHash, fmt.Sprint(mt.Seed)).
		Scan(&w.ID, &w.Name, &w.Seed, &w.Spec, &w.GenVersion, &w.AtlasHash, &w.Official)
	if err == nil {
		return w, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return accountapi.World{}, err
	}
	cur, gerr := db.GetWorld(ctx, id)
	if gerr != nil {
		return accountapi.World{}, gerr
	}
	if cur.GenVersion == mt.GenVersion && cur.AtlasHash == mt.AtlasHash && cur.Seed == fmt.Sprint(mt.Seed) {
		return cur, nil
	}
	return accountapi.World{}, fmt.Errorf("%w: world %s has seed %s gen_version %q atlas_hash %q", ErrMinted, id, cur.Seed, cur.GenVersion, cur.AtlasHash)
}
