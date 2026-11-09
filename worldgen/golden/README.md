# worldgen golden table

`golden.json` pins `(seed, spec, genVersion, chunk) -> hash` (spec 5 rule 5).
Every host must reproduce every hash bit for bit: Node
(`worldgen/js/test/golden.test.ts`), headless Chromium in a Web Worker
(`worldgen/harness/browser`), Go via wazero (`worldgen/harness/go`) and
native Rust (`worldgen/tests/golden_native.rs`). Run all with
`npm run test:golden`.

**Tables:** `golden.json` is the current generator (**genVersion 2**,
playtest 1 towns/terrain/density, `docs/cr/014-towns-terrain-density.md`).
`golden-v1.json` is genVersion 1, frozen with the official world minted on
it; `npm run test:golden` checks it against the archived build
`worldgen/archive/worldgen-42a66cc191bee49d.wasm` in Node and Go/wazero
(`worldgen/archive/manifest.json` lists every archived version and its
table). The genVersion 2 table was regenerated after reviewing the diff
with `npx vite-node worldgen/golden/review.ts`
(`docs/evidence/pt-towns-golden-review.txt`: every genVersion 1 site kept
at its index and id, chunk heights changed only around hamlets and
villages). For a future genVersion: rename `golden.json` to
`golden-v<N>.json`, copy the outgoing `worldgen-<hash>.wasm` into
`worldgen/archive/` and list it in the manifest, bump `GEN_VERSION`,
review, then `npm run golden:update`.

Contents (both versions, same picking rules): 5 worlds (seeds 7, 1234, 99 from `spec_from_seed`,
plus two hand-made extremes of the schema ranges), 288 chunks: 6 per biome
per world where the biome exists (every biome appears >= 18 times), lakes,
rivers, sea, coast, settlement / structure / tower / cave-mouth / camp
chunks, LOD 1, 2, 3 and 6 tiles, and two chunks outside the world. Per world
also the atlas hash, byte size, gzipped size, and 64 collision heights (as
f64 bit patterns) at random points.

```jsonc
{
  "hashAlgo": "fnv1a64", "genVersion": 1, "abiVersion": 1,
  "worlds": [{
    "label": "seed-7", "seed": "7", "spec": { /* WorldSpec */ },
    "atlas": { "hash": "16 hex", "bytes": 312224, "gzipBytes": 123699 },
    "chunks": [{ "cx": 12, "cz": 40, "lod": 0, "tag": "biome:forest", "hash": "16 hex" }],
    "collision": [{ "x": 1234.5, "z": 987.25, "h": "f64 bits, 16 hex" }]
  }]
}
```

Caves (WP09, `caves` per world): the cave graph hash, ~30-50 cave cells per world (237 in all) tagged by what they hold (`mouth`, `mouth-below`, `sinkhole`, `band:shallow|mid|deep`, `deepest`, `empty`), two edited cells (a mined vein: carve + flag), six mouth masks, and collision vectors produced by the TS cave queries: 585 `floorAt` heights (f64 bits), 540 `collide` results, 405 `caveRaycast` distances and 150 cave-system ids. Node and Chromium check everything through `runGolden` (`js/src/caveGolden.ts`); Go/wazero (`harness/go/caves.go`) and native Rust check the hashes; the Go port of the queries replays the vectors in `server/pkg/caves` (`TestGoldenCaveQueries`). The caves were added to genVersion 1 without changing any existing entry (docs/cr/006-cave-exports.md).

Towns (WP20, `towns` per world): the towns buffer hash and byte size, its section counts (settlements, buildings, boxes, props, NPCs, roads, bridges, signs, structures, pieces, veins), and 350 building floor (`floorAt`) + 350 collide vectors per world produced by the TS town queries around real boxes. Node and Chromium check everything (plus "every region has a settlement") through `runGolden` (`js/src/townGolden.ts`); Go/wazero (`harness/go/towns.go`) and native Rust check the buffer hash; the Go port replays the vectors in `server/pkg/towns` (`TestGoldenTownQueries`). Towns were added to genVersion 1 without changing any existing entry (docs/cr/007-towns.md).

Regenerate with `npm run golden:update` (`generate.ts`, run by vite-node).
Once a world is minted on genVersion N, its table must never change: an
output change means a new genVersion and a new table kept next to the old
one (spec 5, "keeping old worlds working").
