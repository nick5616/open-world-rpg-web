# @lodestone/worldgen

Typed loader for `worldgen.wasm` (ABI and buffer layouts: `worldgen/README.md`).
Consumed as TypeScript source, like `@lodestone/contracts`. Works in browsers,
Web Workers and Node; the module needs no imports.

```ts
import { loadWorldgen, chunkSurfaceHeight } from '@lodestone/worldgen';

const wg = await loadWorldgen(await (await fetch('/worldgen.wasm')).arrayBuffer());
const atlas = wg.buildAtlas(wg.specFromSeed(42n)); // or wg.loadAtlas(cachedBytes)
atlas.hash;                                        // bigint atlasHash, cache key
atlas.data;                                        // parsed grids, regions, sites, names
const c = wg.buildChunk(atlas, 32, 32, 0);         // owned copy: transfer c.bytes.buffer
c.heights; c.water; c.splatA; c.splatB;            // Float32Array / Uint8Array views
c.scatter.count; c.scatter.x(0); c.scatter.id(0);  // 24-byte records, zero-copy getters
wg.collisionHeight(atlas, 2050.5, 2047.25);        // same surface the server uses
chunkSurfaceHeight(c, 2050.5, 2047.25);            // same bits, from the chunk, no wasm call
wg.waterHeight(atlas, x, z);                       // water surface (WP10): swim where it is >= 1.5 m above the ground
chunkWaterHeight(c, x, z);                         // same bits from the chunk's water samples
wg.groundNormal(atlas, x, z);                      // { normal, slopeDeg }
wg.raycast(atlas, [x, y, z], [dx, dy, dz], 300);   // distance or null
atlas.free();
```

| Export | What |
| --- | --- |
| `loadWorldgen(bytes \| module)` | Instantiate; throws if the wasm ABI differs from `ABI_VERSION` |
| `Worldgen` | `specFromSeed`, `buildAtlas`, `loadAtlas`, `buildChunk`, `buildChunkBytes`, `collisionHeight`, `waterHeight`, `groundNormal`, `raycast`, `hash` |
| `AtlasHandle` | An atlas in wasm memory: `ptr`, `byteLength`, `bytes()`, `hash`, `data`, `free()` |
| `parseAtlas`, `parseChunk` | Pure-TS readers (no wasm), e.g. for a chunk posted from a worker |
| `chunkSurfaceHeight` | The collision formula evaluated on LOD 0 chunk heights |
| `chunkWaterHeight` | The `water_height` formula on LOD 0 chunk water samples (WP10; WP05's streamed ground should implement `GroundQuery.waterAt` with it) |
| `fnv1a64`, `hex64` | Content hash in TS (equal to `hash_buffer`) |
| `BIOMES`, `ELEMENTS`, `MATERIALS`, `POI_KINDS`, `STRUCTURE_KINDS`, `SETTLEMENT_SIZES`, `LANDMARK_VARIANTS`, `TREE_KINDS`, `ROCK_KINDS`, `BUSH_KINDS`, `GRASS_KINDS`, `CONTAINER_KINDS`, `ENEMY_TABLES`, `LAYER`, `PARAM` | Enum tables matching the README |
| `@lodestone/worldgen/golden` | `runGolden`, `benchmarkChunks`, `stats` for determinism hosts |

Notes: one `Worldgen` per worker (instances are single-threaded); every call
may grow wasm memory, so the wrapper copies results out and never keeps views
of `memory.buffer`. Typed arrays from `parseAtlas`/`parseChunk` assume a
little-endian host (every browser and Node platform we target).

Tests: `npm test -w @lodestone/worldgen` (needs `npm run build:wasm` first;
wasm tests skip with a warning otherwise, and fail under
`LODESTONE_REQUIRE_WASM=1`). Typecheck: `npm run typecheck -w @lodestone/worldgen`.
