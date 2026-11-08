# 0007: Server terrain and collision (WP07)

Date: 2026-11-08

## Ground queries: cached chunk heights, wasm only on a miss

`collision_height` through wazero costs 2.7-5 us per call (pool hand-off,
call, four lattice evaluations of the height noise). The zone asks for the
ground ~6 times per player per tick (two steps x two queries, plus the
grounded test for quantize and SelfState), so 150 players would spend ~3-4 ms
of every tick in wasm. Instead `worldhost.Terrain` caches LOD 0 chunks and
evaluates the collision formula on their f32 lattice in pure Go (23 ns),
falling back to a direct `collision_height` call only for a cold chunk. The
formula keeps the wasm's operation order and forbids FMA fusion with
explicit `float64()` conversions, so both paths give identical bits
(`TestFastPathBitwise`, 20,011 points; `heightcmp`, 10,000 points across
seven hosts).

Measured: terrain share of a 150-player tick 46 us (`BenchmarkTick150`);
live 150-bot soak, 2.85M cache answers vs 182 wasm calls, tick p99 1.27 ms.

## Never block a tick on generation

`chunk_build` takes 3-6 ms. `HeightAt` never generates: a miss is answered
by wasm (same bits) and the chunk is queued. Workers own their instances, so
a query never waits behind a generation; the query pool is separate. The
zone re-announces each player's interest twice a second with a margin of
48 m plus 3 s of travel, so chunks are ready before anyone stands on them.

## gen_version is the generator major version, atlas_hash is the real pin

`worlds.gen_version` stores the wasm's `gen_version()` as text ("1"), not the
wasm content hash the 0001 migration comment suggests: spec 5 allows a
rebuilt wasm (speedups, new exports) to replace the old one for a version as
long as every golden hash holds, and pinning the file hash would refuse such
rebuilds. The strong pin is `atlas_hash`: the zone rebuilds the atlas from
the stored spec and refuses to serve if the hash differs, which catches an
output change even when someone forgot to bump `GEN_VERSION`. Deployments
can additionally pin the file with `LODESTONE_WORLDGEN_WASM_SHA256`. The
migration comment is left as is (contracts are not changed by WP07); the
meaning is documented here and in `server/pkg/worldhost/mint.go`.

## Minting: the account service, plus a command

The account service seeds the official world on startup (WP04). It now mints
it with `worldhost` (`spec_from_seed`, gen_version, atlas_hash) through
`server/pkg/worldhost/mintdb`, and upgrades a placeholder row in place
(keeping id and seed: characters already belong to it). A minted row is never
touched again and the wasm is not even loaded. `server/pkg/cmd/mintworld`
does the same on demand (`-official`) and prints row values for any seed.
Without a built wasm the account service still seeds a placeholder, and
zones open placeholder rows from `spec_from_seed(seed)`, so `npm run dev`
works in either order. Chosen over a command-only approach so a fresh
database never needs a manual step.

## Spawns

Saved positions are respected (lifted onto the ground if below it). New
characters start on a dry cell within 8 m of the atlas spawn (a pre-flattened
meadow/forest settlement), stable per character id. WP04 creates account
characters at exactly `(2048, 0, 2048)` ("snap to ground"); the zone treats
that exact position as never-checkpointed and uses the atlas spawn. This
avoids a contract change (no spawn column) and the account service needing
the atlas.

## Slope rules deferred to WP10

`WALKABLE_SLOPE_DEG` and `MAX_STEP_UP_M` exist in constants but neither the
TS client (WP02) nor the Go step applies them; the ground snap walks up any
slope. Adding them only on the server would desync prediction, and adding
them to `client/src/sim/movement.ts` now would collide with WP05/WP06 and
WP10's climb/slide design. Both sides stay identical; WP10 adds slope limits
to both together. The zone's new vertical validation (rise at most one jump
step or onto the snapped ground, never below the ground) is an invariant of
the current step and must be extended by WP10 for climb and glide.

## Terrain raises clustered downlink ~20%

On flat ground a walking player's y and vy never change; on terrain they
change every tick, so their mask bits are set in most records. Clustered soak
(150 bots in a 300 m disc, ~146 in view): flat avg 102 / max 137 kbps,
terrain avg 121-127 / max 152-163 kbps against the 160 kbps budget. This
belongs to WP06's per-client byte budget (decision 0005); recorded here so
the budget work measures with terrain on.
