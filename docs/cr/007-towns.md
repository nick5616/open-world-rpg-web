# CR 007: towns layer in worldgen genVersion 1, town Interact kinds and events

Date: 2026-11-08 · WP20 (towns, roads and structures)

## What

1. **worldgen.wasm gains one export, `towns_build(atlas_ptr)`**, returning
   the towns buffer (`LDTW`, format 1: settlements, buildings with their
   kit parameters, collision boxes, props, NPCs, roads and streets,
   bridges, signposts, jigsaw structures and pieces, starmetal veins, NPC
   names), byte for byte in `worldgen/README.md` "Towns, roads and
   structures". `ABI_VERSION` stays 1: no existing export or layout changed;
   loaders that don't know the export keep working. `veins::crater_veins`
   (WP09's starmetal hook) now returns clusters for meteor craters; the cave
   pass never calls it, so cave output is unchanged.
2. **genVersion stays 1.** No existing output changed: every atlas, chunk,
   collision and cave hash in `worldgen/golden/golden.json` is identical
   (the golden diff only adds a `towns` block per world: buffer hash, byte
   size, section counts and 1,750 building floor/collide vectors). This is
   spec 5 rule 3 ("new exports"), as CR 006 did for caves. The official
   world (seed 20261108, atlas `50ae4562cfd25265`) needs no re-mint: its
   atlas is unchanged and its towns are a pure function of it.
3. **Roads are drawn on the terrain, not flattened into it.** Spec 5 says
   roads are "flattened into the terrain". Cutting them into the
   heightfield would change every chunk a road crosses: a genVersion bump,
   a new golden table, a re-mint of the official world, and conflicts with
   the packages building on genVersion 1 in parallel (WP13, WP16). Instead
   roads follow least-cost paths that keep to gentle ground, are smoothed,
   and are rendered as ribbons draped on the 1 m collision surface;
   settlement footprints were already pre-flattened by WP01. Bridges are
   real collision (decks, railings, ramps). A future generator version can
   flatten roads into chunks.
4. **Siting refinement happens inside the towns pass.** The atlas fixes
   each settlement's centre, size and radius (WP01, unchanged); the towns
   pass places every plot on the real 1 m terrain (dry, under a slope
   tolerance, relaxed in passes, a second row of plots when needed), so
   buildings land only on usable ground without moving any atlas site.
5. **Interact target kinds 30-33** (`npc`, `board`, `station`, `shaft`) and
   **Event kinds 800-807** (`npc_say`, `shop`, `bounties`,
   `bounty_accepted`, `rested`, `station_opened`, `town_refused`,
   `purchase`) are registered in `contracts/events.md`. NPCs ride the
   existing `EntityRecord` (kind `npc` = 5, `typeId` = role | variant << 8,
   `level` = merchant kind, `name`). `protocol.yaml` is unchanged (no
   version bump): these are uses of existing messages and fields.

## Why

Towns and structures are new content on a world nobody has played
against yet. Adding them as a new pure export keeps the official world's
atlas hash valid and every client, zone and bot agreeing on the overworld
bit for bit, while the towns themselves are golden-tested on every host.

## Consumers affected

- `worldgen` (`src/town/`, `src/cave/veins.rs` hook, `examples/town_stats.rs`,
  `tests/towns.rs`, golden generator and the Node/Chromium/Go/native golden hosts).
- `worldgen/js` (`src/town.ts` reader + collision, `src/townGolden.ts`,
  `towns_build?` in `WorldgenExports`).
- `server/pkg/towns` (new: Go reader + bit-exact collision + `Ground`),
  `server/pkg/worldhost` (`TownsBytes`).
- `server/zone` (`towns.go` wiring, `internal/npc` (new), `internal/game/towns.go`,
  `Config.Towns/Stations/TimeOffsetS`, `Entity.TypeID`), `tools/bots` (predict on the towns ground).
- `client/src/world/core/runtime.ts` (towns built in a worker at load,
  `TownGround` on the movement ground, `caveGround` exposed),
  `client/src/world/caves/caveManager.ts` (uses `runtime.caveGround`),
  `client/src/world/buildings/` (new: rendering, NPCs, interaction UI).

## Compatibility

A wasm built before WP20 lacks `towns_build`: the zone logs "NO TOWNS" and
keeps its ground (no building collision, no NPCs); the client warns and
keeps its ground (no buildings drawn). Both sides then agree (neither has
buildings). Mixed versions (a client with towns against a zone without, or
the reverse) would disagree inside buildings: deploy the zone, client and
bots from the same wasm (they share one content-hashed build already).
