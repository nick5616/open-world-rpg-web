// Command mintworld mints a world with worldgen.wasm (spec 6): it computes
// the WorldSpec (spec_from_seed, or a spec file), builds the atlas, and
// prints the row values (seed, spec, gen_version, atlas_hash). With
// -official it also writes them to the official `worlds` row: a missing row
// is created, a placeholder row (WP04 seeded it before worldgen existed) is
// upgraded in place keeping its seed, and a minted row is left alone (a
// world is pinned forever, spec 5 rule 6).
//
// The account service does the same on startup when the wasm is built
// (server/account seedWorld), so this is for operators: mint ahead of a
// deploy, inspect a seed, or upgrade a database without restarting account.
//
//	go run ./server/pkg/cmd/mintworld -seed 20261108             # print only
//	go run ./server/pkg/cmd/mintworld -official                   # upgrade/insert the official row
//	go run ./server/pkg/cmd/mintworld -seed 42 -spec my-spec.json # creator spec
//	go run ./server/pkg/cmd/mintworld -official -renew            # world renewal onto this wasm's genVersion
//
// -renew (playtest 1, docs/decisions/0022): moves a minted official world on
// an older genVersion onto the loaded worldgen.wasm in place (same id, seed
// and spec; new gen_version and atlas_hash), refusing unless every old site
// keeps its index and id (per-character progress is indexed by site);
// characters saved near a settlement whose ground changed start again at the
// spawn. It needs the archived build of the old genVersion
// (worldgen/archive/, LODESTONE_WORLDGEN_ARCHIVE) to rebuild and check the
// old world. Zones and clients must run the new build afterwards.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/accountapi"
	"lodestone/server/pkg/env"
	"lodestone/server/pkg/worldhost"
	"lodestone/server/pkg/worldhost/mintdb"
)

func main() {
	seed := flag.Uint64("seed", 0, "world seed (default: LODESTONE_WORLD_SEED, else 20261108; -official keeps an existing row's seed)")
	specFile := flag.String("spec", "", "WorldSpec JSON file (default: spec_from_seed)")
	official := flag.Bool("official", false, "write the official world row in LODESTONE_PG_URL")
	name := flag.String("name", "", "row name for a newly created official world (default LODESTONE_WORLD_NAME, else the spec's name)")
	renew := flag.Bool("renew", false, "with -official: renew a world minted on an older genVersion onto this wasm (world renewal, spec 5 rule 5)")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	start := time.Now()
	mod, err := worldhost.LoadFromEnv(ctx)
	if err != nil {
		fail(err)
	}
	defer mod.Close(ctx)
	if *seed == 0 {
		if _, err := fmt.Sscan(env.Str("LODESTONE_WORLD_SEED", "20261108"), seed); err != nil {
			fail(fmt.Errorf("LODESTONE_WORLD_SEED: %w", err))
		}
	}

	if *official {
		if *specFile != "" {
			fail(fmt.Errorf("-official mints from the seed (spec_from_seed); creator specs go through the creator tool (WP17)"))
		}
		pool, err := pgxpool.New(ctx, env.PostgresURL())
		if err != nil {
			fail(err)
		}
		defer pool.Close()
		if *renew {
			cur, _, err := mintdb.Official(ctx, accountapi.DB{Pool: pool})
			if err != nil {
				fail(err)
			}
			old, err := worldhost.LoadForGenVersion(ctx, cur.GenVersion)
			if err != nil {
				fail(err)
			}
			defer old.Close(ctx)
			res, err := mintdb.RenewOfficial(ctx, accountapi.DB{Pool: pool}, mod, old)
			if err != nil {
				fail(err)
			}
			out(map[string]any{"action": res.Action, "id": res.After.ID, "seed": res.After.Seed,
				"genVersion":      map[string]string{"before": res.Before.GenVersion, "after": res.After.GenVersion},
				"atlasHash":       map[string]string{"before": res.Before.AtlasHash, "after": res.After.AtlasHash},
				"movedCharacters": res.Moved, "keptSites": res.KeptAll, "wasmSha256": mod.SHA256(), "oldWasmSha256": old.SHA256(), "ms": time.Since(start).Milliseconds()})
			return
		}
		w, action, err := mintdb.EnsureOfficial(ctx, accountapi.DB{Pool: pool},
			func() (*worldhost.Module, error) { return mod, nil },
			accountapi.World{Name: env.Str("LODESTONE_WORLD_NAME", *name), Seed: fmt.Sprint(*seed)})
		if err != nil {
			fail(err)
		}
		out(map[string]any{"action": action, "id": w.ID, "name": w.Name, "seed": w.Seed, "genVersion": w.GenVersion,
			"atlasHash": w.AtlasHash, "spec": json.RawMessage(w.Spec), "wasmSha256": mod.SHA256(), "ms": time.Since(start).Milliseconds()})
		return
	}

	var spec []byte
	if *specFile != "" {
		if spec, err = os.ReadFile(*specFile); err != nil {
			fail(err)
		}
	}
	mt, err := mod.Mint(*seed, spec, worldhost.WorldOptions{MaxInstances: 1})
	if err != nil {
		fail(err)
	}
	h := mt.World.Header
	out(map[string]any{"seed": fmt.Sprint(mt.Seed), "name": mt.Name, "genVersion": mt.GenVersion, "atlasHash": mt.AtlasHash,
		"atlasBytes": len(mt.World.Atlas), "spawn": [2]float32{h.SpawnX, h.SpawnZ}, "seaLevel": h.SeaLevel,
		"spec": json.RawMessage(mt.Spec), "wasmSha256": mod.SHA256(), "ms": time.Since(start).Milliseconds()})
}

func out(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "mintworld:", err)
	os.Exit(1)
}
