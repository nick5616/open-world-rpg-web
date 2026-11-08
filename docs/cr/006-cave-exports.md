# CR 006: cave exports in worldgen genVersion 1, mining event kinds

Date: 2026-11-08 · WP09 (caves, gems and mining)

## What

1. **worldgen.wasm gains five exports**: `cave_graph`, `cave_build`
   (spec 5), `cave_build_edited`, `cave_mask`, `cave_system_at`, with three
   new buffer layouts (cave cell `LDCV`, cave graph `LDCG`, mouth mask
   `LDCM`) documented in `worldgen/README.md` "Caves". `ABI_VERSION` stays 1
   (no existing export or layout changed; loaders that don't know the cave
   exports keep working).
2. **genVersion stays 1.** No existing output changed: every atlas, chunk
   and collision hash in `worldgen/golden/golden.json` is unchanged, which
   is exactly spec 5's rule for "new exports". The golden table grew a
   `caves` block per world (graph hash, 237 cave cells across depth bands,
   edited cells, mouth masks, 1,275 collision/system vectors), checked in
   Node, Chromium, Go/wazero and native Rust.
3. **Mouth masks are not in the chunk buffer.** Spec 7 says "the overworld
   chunk carries a mouth mask". Putting it there would have changed every
   chunk near a mouth (a genVersion bump, a re-mint of the official world,
   and conflicts with WP10/WP12 working on worldgen in parallel). Instead
   the mask is an analytic rule over the cave graph's openings (a
   heightfield triangle is dropped when its centroid is within `r_mask` of
   an opening), applied identically by the client tile builder, the TS and
   Go movement grounds, and `cave_mask` (the reference, in the golden
   table). Same result for every consumer, no chunk change.
4. **Event kinds 701-706** registered in `contracts/events.md` (WP09's
   700-799 range) and the Interact kinds for mining (targetKind 40 =
   vein, 41 = pickup; action 1 = use; registry rows next to WP12's 10/11). WorldEdits `vein_mined` params are 16
   bytes (f32 x, y, z, carve radius); `expiresAt` = respawn time, and a
   delta with `expiresAt <= now` means the edit expired (vein respawned).
   `protocol.yaml` itself is unchanged (no version bump): these are uses of
   existing messages and fields.

## Why

Caves are new content on top of a world nobody has minted against cave
data yet; adding them as exports keeps the official world's atlas hash
(`50ae4562cfd25265`, genVersion 1) valid, so no re-mint is needed and old
and new builds agree on the overworld bit for bit.

## Consumers affected

- `worldgen/js` (`src/cave.ts`, `src/caveGolden.ts`, golden runner), the
  Chromium and Go harnesses, `tests/golden_native.rs`.
- `server/pkg/caves` (new, Go readers + collision), `server/pkg/worldhost`
  (`caves.go`: wasm wrappers, cave cell cache, `CaveTerrain`),
  `server/pkg/movement` (`LevelGround` / `Collider` hooks in `caves.go`), `server/zone` (mining,
  WorldEdits, cave ground, interest clipping), `tools/bots` (predict on the
  cave ground).
- `client/src/sim` (`GroundQuery.atLevel/collide`, `caves.ts`), `client/src/world`
  (caves module, worker `cave` job, terrain holes, runtime), `client/src/net`
  (`onWorldEdits`, `onEvent`, `sendInteract`, forwarding ground).

## Compatibility

A wasm built before WP09 lacks the cave exports: the zone logs "NO CAVES"
and keeps the heightfield; the client logs a warning and keeps WP05's
ground. Old cached terrain meshes are invalidated (`MESH_FORMAT` 2 -> 3)
because tiles near mouths now carry holes.
