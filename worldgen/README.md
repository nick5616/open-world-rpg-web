# worldgen

The deterministic world generator (spec sections 5 and 6): one Rust crate,
compiled once to `worldgen.wasm`, executed unchanged by browsers (Web
Workers), Node and Go zone servers (wazero). A world is
`(seed, WorldSpec, genVersion)`; nothing world-shaped ever goes over the wire.

This file is the contract for WP05 (client renderer), WP07 (Go host), WP09
(caves: section "Caves"), WP12 (map/towers) and WP20 (towns/structures): the wasm ABI and every
buffer layout, byte for byte. `worldgen/js/src/format.ts` is the reference
reader and must stay in sync with this document.

| Path | What |
| --- | --- |
| `src/` | The crate: `spec.rs` (spec_from_seed, validation), `names.rs` (name grammars), `rng.rs` / `noise.rs` (counter hashing, gradient noise), `atlas/` (pass 1), `ground.rs` (height function + collision queries), `chunk.rs` (pass 2), `abi.rs` (wasm exports), `cave/` (WP09 caves, gems and veins), `gen/` (generated from contracts, never edit) |
| `js/` | `@lodestone/worldgen`, the typed TS loader (README there) |
| `golden/` | Golden table `golden.json` and its generator |
| `harness/` | Chromium (Web Worker) and Go/wazero hosts of the golden table |
| `debug/` | Vite debug map on port 5180 |
| `scripts/` | `build-wasm.mjs`, `test-golden.mjs` |
| `examples/atlas_stats.rs` | Native sanity report: `cargo run -p worldgen --release --example atlas_stats -- 42` |
| `examples/cave_stats.rs` | Cave report (systems, depths, veins, cell build times): `cargo run -p worldgen --release --example cave_stats -- 20261108` |
| `tests/caves.rs` | Cave invariants: every chamber of every system reachable from the sky (4 worlds), border vertices shared, edits, system query |
| `pkg/` | Build output (gitignored): `worldgen.wasm`, `worldgen-<sha256:16>.wasm`, `manifest.json` |

## Commands

| Command | What |
| --- | --- |
| `npm run build:wasm` | Release build to `worldgen/pkg/` + manifest (sha256, size, genVersion, exports). Fails if the module has any import. |
| `npm run test:golden` | Build, then check the golden table in Node, headless Chromium (Web Worker, with the 8 ms budget), Go/wazero (compiler + interpreter) and native Rust. Writes `docs/evidence/wp01-golden.txt`. |
| `npm run golden:update` | Regenerate `golden/golden.json`. Only together with a `GEN_VERSION` bump once any world is live (see "Versioning"). |
| `npm run debug -w @lodestone/worldgen` | Debug map at http://localhost:5180/debug/?seed=7 (`LODESTONE_WORLDGEN_DEBUG_PORT` overrides) |
| `node worldgen/debug/screenshot.mjs 7 1234 7:cover` | Headless screenshots into `docs/evidence/` |
| `cargo test -p worldgen` | Unit tests + native golden subset (debug build, NaN asserts on) |
| `cargo clippy -p worldgen --all-targets -- -D warnings` | Lint (also run with `--target wasm32-unknown-unknown`) |

## Coordinates and units

- 1 unit = 1 m, y up. The world spans x, z in [0, 4096). "North" is -z (the
  climate gradient and `windDirection` use it; wind direction is where the
  wind comes *from*, 0 = from the north, 90 = from +x).
- Chunk (cx, cz) covers [cx*64, cx*64+64) x [cz*64, cz*64+64); world chunks are 0..63.
- Region index = rz * 4 + rx, region = 16 x 16 chunks (1024 m).
- Macro grid: 129 x 129 nodes, node (i, j) at (i*32, j*32), index j*129 + i.
- Yaw: radians from +x toward +z (so yaw = atan2(dz, dx)).

## Wasm ABI (ABI_VERSION 1)

The module imports nothing (`WebAssembly.instantiate(bytes, {})`; wazero
`Instantiate` with no host modules). It exports `memory` and the functions
below. `ptr`/`len` are i32 offsets into linear memory.

| Export | Wasm signature | Returns / effect |
| --- | --- | --- |
| `gen_version()` | `() -> i32` | Generator major version (output-defining, currently 1) |
| `abi_version()` | `() -> i32` | 1; loaders refuse other values |
| `alloc(len)` | `(i32) -> i32` | 8-aligned block for the host; 0 on failure |
| `free(ptr, len)` | `(i32, i32) -> ()` | Release a block from `alloc` or `atlas_build` (same `len`) |
| `spec_from_seed(seed_lo, seed_hi)` | `(i32, i32) -> i32` | Pointer to WorldSpec JSON (UTF-8) in scratch; length from `result_len()` |
| `atlas_build(spec_ptr, spec_len, seed_lo, seed_hi)` | `(i32, i32, i32, i32) -> i32` | Pointer to a newly allocated atlas (layout below); length from `result_len()` and header offset 8; 0 on error. Host owns it: `free(ptr, len)`. `spec.seed` must equal the seed arguments. |
| `atlas_check(atlas_ptr)` | `(i32) -> i32` | 1 if the buffer is a valid atlas of this format, else 0 + error. Use after loading cached bytes. |
| `chunk_build(atlas_ptr, cx, cz, lod)` | `(i32, i32, i32, i32) -> i32` | Pointer to a chunk buffer in scratch (layout below); length from `result_len()`; 0 on error |
| `collision_height(atlas_ptr, x, z)` | `(i32, f64, f64) -> f64` | Ground height (see "Collision"); -1e9 on an invalid atlas or non-finite input |
| `water_height(atlas_ptr, x, z)` | `(i32, f64, f64) -> f64` | WP10: water surface height, the same triangle mesh as `collision_height` over the f32 water lattice the chunks carry (so it equals interpolating LOD 0 chunk water); sea level where no lake or river covers the point (under dry land); -1e9 on an invalid atlas or non-finite input. Added after genVersion 1 shipped: outputs and golden hashes are unchanged |
| `ground_normal(atlas_ptr, x, z, out_ptr)` | `(i32, f64, f64, i32) -> f64` | Writes the unit normal as 3 x f64 LE at `out_ptr` (24 bytes); returns slope in degrees, -1 on error |
| `raycast(atlas_ptr, ox, oy, oz, dx, dy, dz, max_dist)` | `(i32, f64 x7) -> f64` | Distance along the normalized direction to the first surface hit, or -1 (no hit within min(max_dist, 1024 m)) |
| `hash_buffer(ptr, len)` | `(i32, i32) -> i64` | FNV-1a 64 of the bytes (JS receives a signed BigInt: use `BigInt.asUintN(64, v)`) |
| `result_len()` | `() -> i32` | Length of the last `spec_from_seed` / `atlas_build` / `chunk_build` result |
| `error_ptr()`, `error_len()` | `() -> i32` | UTF-8 message of the last error |

Rules for hosts:

1. **Scratch results** (`spec_from_seed`, `chunk_build`) live in one
   module-owned buffer that is valid only until the next call to any of
   those exports. Copy the bytes out first.
2. **Memory can grow on any call.** Re-create typed-array views of
   `memory.buffer` after every call (wazero: re-`Read` after every call).
3. **Seeds** are u64 split into two i32 halves (`lo = seed & 0xffffffff`,
   `hi = seed >> 32`); pass the halves as raw bits.
4. **One instance per thread.** Instances are single-threaded; run one per
   Web Worker / goroutine. The atlas must be copied into each instance
   (`alloc` + write, then `atlas_check`).
5. A trap (out of memory, a bug) leaves the instance unusable: re-instantiate.
6. All multi-byte values in buffers are little-endian.

### Typical flows

- **Mint (server, once):** `spec_from_seed` (or a creator spec) ->
  `atlas_build` -> store `(seed, spec, genVersion, hash_buffer(atlas))`.
- **Client:** download the atlas by hash (or regenerate it locally: the bytes
  are identical), `alloc` + copy, `atlas_check`, then `chunk_build` per chunk
  in workers.
- **Server:** same atlas; `collision_height` / `ground_normal` / `raycast` for
  movement validation, `chunk_build` for scatter ids, containers and spawns.

## Atlas buffer (format 1)

Built once per world. ~310 KB raw, ~105-145 KB gzipped (budget 2 MB).

### Header (64 bytes)

| Off | Type | Field |
| --- | --- | --- |
| 0 | u8[4] | magic `LDAT` |
| 4 | u16 | atlas format version (1) |
| 6 | u16 | genVersion |
| 8 | u32 | total byte length |
| 12 | u32 | header length (64) |
| 16 | u64 | seed |
| 24 | u16 | world size, m (4096) |
| 26 | u16 | macro resolution, m (32) |
| 28 | u16 | grid nodes per edge N (129) |
| 30 | u8 | regions per edge (4) |
| 31 | u8 | chunks per region edge (16) |
| 32 | f32 | sea level y |
| 36 | f32 | spawn x |
| 40 | f32 | spawn z |
| 44 | f32 | min macro height |
| 48 | f32 | max macro height |
| 52 | u32 | site count |
| 56 | u32 | name count |
| 60 | u32 | reserved (0) |

At offset 64: a directory of 16 entries `(u32 offset, u32 length)`, one per
section id below (unused ids are 0, 0). Sections start at 8-aligned offsets.
Readers find sections only through the directory.

### Sections

| Id | Name | Content |
| --- | --- | --- |
| 0 | SPEC | Canonical WorldSpec JSON (serde field order, shortest floats). Self-describing atlas. |
| 1 | PARAMS | 32 x f64, slots below |
| 2 | HEIGHT | N*N f32: macro ground height (river nodes already sunk into valleys) |
| 3 | WATER | N*N f32: water surface; lake level on lake nodes, else sea level |
| 4 | FLOW | N*N u8: D8 downstream direction, index into `[(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1),(0,-1),(1,-1)]` as (di, dj); 255 = none (border outlet) |
| 5 | RIVER | N*N u8: river width in m at this node (0 = no river); the river runs from the node to its FLOW neighbor |
| 6 | BIOME | N*N u8: 0 meadow, 1 forest, 2 highlands, 3 snowpeak, 4 badlands, 5 wetland |
| 7 | TEMP | N*N u8: temperature 0..1 (x255) |
| 8 | MOIST | N*N u8: moisture 0..1 (x255) |
| 9 | NODEP | N*N x 4 u8: [detail amplitude (0.1 m units), terrace weight /255, ridge weight /255, flags]. Flags: 1 sea, 2 lake, 4 river, 8 settlement footprint |
| 10 | REGIONS | 16 x 32-byte records |
| 11 | SITES | u32 count, u32 record size (48), then records |
| 12 | NAMES | u32 count, then per name: u16 byte length + UTF-8. Name 0 = world name, 1..16 = region names, then site names |
| 13 | COVERAGE | N*N u8: number of sites visible within 800 m from this node (capped 255) |

PARAMS slots (f64): 0 seaY, 1 peakH (peak height above sea), 2 roughness,
3 plateaus, 4 enemyDensity, 5 dangerCurve, 6 flammability, 7 caveDensity,
8 oreAbundance, 9 structureDensity, 10 settlementDensity, 11 temperatureBias,
12 moistureBias, 13 windDirection (deg), 14 stormFrequency, 15 demonIntensity,
16 loot theme bitmask (bit i = `LOOT_THEMES_VALUES[i]`), 17 palette index,
18 nameGrammar index, 19 fraction of walkable nodes that see a POI within
800 m, 20 spawn x, 21 spawn z, 22 spawn y, 23 actual land fraction, 24..31 reserved.

### Region record (32 bytes)

| Off | Type | Field |
| --- | --- | --- |
| 0 | u8 | region index |
| 1 | u8 | dominant biome |
| 2 | u8 | dominant element: 0 fire, 1 ice, 2 lightning, 3 earth, 4 wind, 5 light, 6 dark, 7 void |
| 3 | u8 | secondary element |
| 4 | u16 | name index |
| 6 | u16 | site index of the region's tower (0xFFFF none; never in practice) |
| 8 | f32 | danger 0..1 (distance from spawn shaped by `dangerCurve`) |
| 12 | f32 | land fraction of the region |
| 16 | u8[6] | biome mix over the region's land (x255) |
| 22 | u8 | settlements in region |
| 23 | u8 | sites in region |
| 24 | u8[8] | reserved |

### Site record (48 bytes)

Points of interest, settlement sites and structure sites share one table.
A site's **index** in the table is stable for the world (per-character
bitsets for towers and waypoints use it); its **id** is the stable 64-bit id.

| Off | Type | Field |
| --- | --- | --- |
| 0 | u64 | stable id |
| 8 | u8 | category: 0 POI, 1 settlement, 2 structure |
| 9 | u8 | kind. POI: 0 tower, 1 cave_mouth, 2 waypoint, 3 landmark, 4 enemy_camp. Settlement: 0. Structure: 0 ruin, 1 watchtower, 2 mineshaft, 3 shrine, 4 bandit_camp, 5 wizard_tower, 6 meteor_crater, 7 sunken_temple, 8 demon_lair |
| 10 | u8 | region |
| 11 | u8 | size. Settlement: 0 hamlet (4-8 buildings), 1 village (10-25), 2 town (30-60, walled). Structure: tier 0..2. Enemy camp: 0..2. Landmark: variant 0 standing stones, 1 great tree, 2 stone arch, 3 monolith, 4 giant bones, 5 crystal outcrop, 6 statue, 7 hot spring. Waypoint: 1 = in a settlement, 0 = wilderness |
| 12 | f32 | x |
| 16 | f32 | y (macro ground height; use `collision_height` for the exact surface) |
| 20 | f32 | z |
| 24 | f32 | footprint radius, m (hamlet 45, village 80, town 130, structures 10-40) |
| 28 | f32 | placement score (viewshed size for towers) |
| 32 | u16 | name index (0xFFFF = unnamed; settlement waypoints take their settlement's name) |
| 34 | u8 | biome at the site |
| 35 | u8 | element accent (structures; 255 none) |
| 36 | u8 | visible height used for viewsheds, m (tower 30) |
| 37 | u8 | reserved |
| 38 | u16 | walkable macro nodes that see this site within 800 m |
| 40 | u32 | per-site seed for layout generation (WP20) |
| 44 | u16 | yaw as a fraction of a turn (x65536); cave mouths face downhill |
| 46 | u16 | linked site index (a settlement's waypoint links its settlement), 0xFFFF none |

## Chunk buffer (format 1)

`chunk_build(atlas, cx, cz, lod)`: a 65 x 65 lattice with spacing
`step = 2^lod` m starting at (cx*64, cz*64), covering 64*2^lod m. For lod > 0,
cx and cz must be multiples of 2^lod (quadtree tiles); lod 0..6 (lod 6 = the
whole world in one tile). Valid cx, cz: -64..127 (outside 0..63 is sea floor
past the coast, with no scatter). Every LOD samples the same height function,
so a coarse tile's vertices equal the fine tiles' vertices at the same
points: seams match without skirts. Scatter, containers and spawns exist
only at lod 0 and only for chunks inside the world.

### Header (64 bytes)

| Off | Type | Field |
| --- | --- | --- |
| 0 | u8[4] | magic `LDCK` |
| 4 | u16 | chunk format version (1) |
| 6 | u16 | genVersion |
| 8 | u32 | total byte length |
| 12 | i32 | cx |
| 16 | i32 | cz |
| 20 | u8 | lod |
| 21 | u8 | flags: bit 0 = some water surface lies above the ground, bit 1 = has records |
| 22 | u16 | samples per edge S (65) |
| 24 | f32 | step, m |
| 28 | f32 | min height |
| 32 | f32 | max height |
| 36 | u32 | heights offset |
| 40 | u32 | water offset |
| 44 | u32 | splat plane A offset |
| 48 | u32 | splat plane B offset |
| 52 | u32 | records offset (8-aligned) |
| 56 | u16 | scatter count |
| 58 | u16 | container count |
| 60 | u16 | spawn anchor count |
| 62 | u16 | record size (24) |

Sections (current offsets, but always read them from the header):

| Section | Offset | Content |
| --- | --- | --- |
| heights | 64 | S*S f32, index j*S + i, sample at (cx*64 + i*step, cz*64 + j*step) |
| water | 16964 | S*S f32 water surface height at each sample. Never NaN: where there is no lake or river it is sea level (under dry land). Draw water where water > ground. |
| splat A | 33864 | S*S RGBA8: grass, dirt, rock, snow |
| splat B | 50764 | S*S RGBA8: sand, mud, dominant biome id, moisture x255. The six weights sum to exactly 255. |
| records | 67664 | scatter records, then container records, then spawn records, 24 bytes each |

### Record (24 bytes)

| Off | Type | Field |
| --- | --- | --- |
| 0 | u64 | stable id |
| 8 | f32 | x |
| 12 | f32 | y: exactly `(f32) collision_height(x, z)` |
| 16 | f32 | z |
| 20 | u8 | kind (tables below) |
| 21 | u8 | variant: scatter = random model variant; container = loot theme index into `LOOT_THEMES_VALUES` (255 none); spawn = group size |
| 22 | u8 | scatter: random scale byte (renderer maps it); anchors: region danger x255 |
| 23 | u8 | yaw as a fraction of a turn (x256) |

Scatter is ordered by layer (trees, rocks, bushes, grass tufts). Kinds:

| Layer (id) | Kinds |
| --- | --- |
| tree (1) | 0 oak, 1 birch, 2 broadleaf, 3 pine, 4 snow fir, 5 dead tree, 6 acacia, 7 willow, 8 cypress |
| rock (2) | 0 boulder, 1 slab, 2 spire, 3 mossy, 4 snowy |
| bush (3) | 0 shrub, 1 berry bush, 2 fern, 3 dry scrub, 4 reeds, 5 heather |
| grass tuft (4) | 0 tuft, 1 tall grass, 2 flowers, 3 dry grass, 4 snow grass, 5 marsh grass |
| container (5) | 0 chest, 1 buried cache, 2 urn, 3 crate |
| spawn anchor (6) | enemy table: 0..5 the biome's wild table (biome ids), 6 bandit, 7 demon (night lairs), 8 guardian (towers, wizard towers, sunken temples) |

### Stable ids

`id = mix64(layer << 56 | (u16)a << 40 | (u16)b << 24 | index)` where
`mix64` is the SplitMix64 finalizer, a bijection, so distinct tuples always
give distinct ids (spec 5's `hash(cx, cz, layer, index)`):

- Scatter/containers/spawns: layer 1..6 above, a = cx, b = cz, index = the
  candidate cell index inside the chunk (row-major), or `0x1000 + site_index*8 + k`
  for anchors tied to a site. The index depends only on the cell, so an id
  never changes when neighboring objects change.
- Sites: layer `0x40 | category << 4 | kind`, a = 0, b = macro node index, index = site index.

The inverse (`unmix64` in `rng.rs`, `unmix` in `debug/main.ts`) recovers
the tuple, e.g. the layer of a scatter id.

## Collision

The playable surface is the triangle mesh over the 1 m lattice of the height
function, with every lattice value rounded to f32 (exactly the LOD 0 chunk
heights). Each 1 m cell is split along the diagonal from (x0+1, z0) to
(x0, z0+1). `collision_height(x, z)` computes, in f64 and in this order:

```
x0 = floor(x); z0 = floor(z); fx = x - x0; fz = z - z0
h00 = H(x0, z0); h10 = H(x0+1, z0); h01 = H(x0, z0+1); h11 = H(x0+1, z0+1)   // f32 lattice values
if fx + fz <= 1:  h = h00 + (h10 - h00) * fx + (h01 - h00) * fz
else:             h = h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
```

So a renderer that triangulates chunk quads along the same diagonal draws
exactly the collision surface, and a host can evaluate it from chunk heights
without a wasm call (`chunkSurfaceHeight` in the TS loader does, and the test
suite proves it matches the wasm to the bit at 2,000 random points). The
server and client agree to the bit because both run this same wasm.
`ground_normal` returns the normal of the same triangle; `raycast` intersects
the same triangles.

Cost: `collision_height` ~1.7 us per call from Node (10,000 random queries in
17 ms); `raycast` ~4 height samples per 1 m cell crossed.

## Caves (WP09)

The overworld is a heightfield; the underground is a density volume grown
from a graph per cave mouth (spec 7). Code: `src/cave/` (module table in
`src/cave/mod.rs`). All of it is new output next to WP01's: no existing
buffer changed, every chunk/atlas hash of genVersion 1 still holds, and the
cave hashes joined the golden table (`docs/cr/005-cave-exports.md`).

### Exports (same rules as the ABI above: scratch results, 0 = error)

| Export | Wasm signature | Returns |
| --- | --- | --- |
| `cave_graph(atlas_ptr)` | `(i32) -> i32` | Cave graph buffer (below). The first cave call on an instance builds every system of the world (~10 ms native, ~40 ms in a browser worker, 15 ms wazero), cached per instance by (seed, spec, genVersion). |
| `cave_build(atlas_ptr, cx, cy, cz)` | `(i32, i32, i32, i32) -> i32` | Cave cell buffer (spec 5 `cave_build`): density, surface-nets mesh, collision columns, veins, decorations. Valid cells: cx, cz 0..63, cy -8..23 (32 m tall cells, -256..768 m). |
| `cave_build_edited(atlas_ptr, cx, cy, cz, edits_ptr, edits_len)` | `(i32 x 6) -> i32` | Same with world edits applied (carve spheres open the density; listed veins come back flagged mined). Edits: 32-byte records `u64 vein id, f32 x, y, z, radius, 8 reserved`; hosts pass the edits touching the cell sorted by vein id. |
| `cave_mask(atlas_ptr, cx, cz)` | `(i32, i32, i32) -> i32` | Mouth mask of overworld chunk (cx, cz): 24-byte header (`LDCM`, u16 format 1, u16 genVersion, i32 cx, i32 cz, u32 masked count, u32 0) + 64 x 64 x 2 bits, bit `((z*64 + x) << 1) | tri`. |
| `cave_system_at(atlas_ptr, x, y, z)` | `(i32, f64, f64, f64) -> i32` | Cave-system index whose planned air (chambers and tunnels, padded 2 m, no noise) contains the point; -1 none; -2 error. |

### Generation

1. **Graph** (`graph.rs`): from each mouth site, an entry ramp starts on the
   open hillside (where the ground has fallen 1.4 m below the mouth) and
   descends ~20 degrees into an entrance chamber 8-20 m under the mouth; a
   "spine" of chambers descends toward `caveMaxDepth * (0.5 + 0.42 *
   caveDensity)` with tunnels no steeper than 30 degrees (long steep drops
   become ravines: stretched, narrow slots); side branches and up to two
   loops; with probability `0.25 + 0.35 * caveDensity` a sinkhole shaft from
   a mid-depth chamber to the sky. 4 + 7 x caveDensity (+0..2) chambers,
   within 150 m of the mouth (mouths are >= 350 m apart, so systems never
   merge). Every chamber is placed at the end of a new tunnel from one
   already in the graph: connected by construction. Every placement keeps
   3 m of rock plus the noise amplitude above it (checked against the real
   surface; the macro heightmap minus 72 m is a quick accept). Deeper means
   tighter (chamber 9.5 -> 5 m, tunnels 3.3 -> 2.3 m radius).
2. **Density** (`field.rs`): negative = air. Chambers are flat-floored
   ellipsoids, tunnels flat-floored capsule chains (3 segments along a
   quadratic Bezier), joined with a smooth minimum (k = 2.5 m), displaced
   by two-octave 3D gradient noise (1.3 m, at most 35% of a tunnel's radius
   so nothing pinches shut; zero within r_mask + 2 m of an opening). Near
   openings everything above the terrain surface is air ("zone"); elsewhere
   a roof clamp keeps 2.5 m of rock under the surface.
3. **Mesh** (`cell.rs`): 33 x 17 x 33 samples at 2 m plus one padding layer
   on the low sides; surface nets (vertex = mean of edge crossings, normal =
   minus the field gradient); a cell owns the sample edges based in [0,32) x
   [0,16) x [0,32), so neighbors' shared vertices are bit-identical and
   meshes close without stitching. Reproduced-surface triangles beyond
   r_mask + 2 m are dropped (a 2 m overlap ring under the rock-arch prop).
4. **Veins and decorations** (`veins.rs`): per chamber 1-6 veins, marched
   from the chamber center to the wall along a seeded direction; gem chance
   `(0.06 + 0.6 * (depth / caveMaxDepth) ^ gemRarityCurve) x biome affinity`;
   gem element from the region's dominant (4) / secondary (2) / others (0.4)
   x affinity, Dark grows with depth, Void (amethyst) only in the deepest
   quarter, Light (sunstone) where daylight reaches; ores by depth band
   (copper, iron, silver, sunsteel only in sunlit veins at mid/deep or near
   peaks, voidglass deepest). Starmetal: `veins::crater_veins` hook for WP20
   meteor craters (returns nothing yet). Glowing fungi, crystal shards and
   stalagmites on chamber floors.
5. **Depth bands**: depth = mouth surface height - y. Shallow < 64 m, mid
   < 160 m, deep >= 160 m.

### Stable ids

Veins: `stable_id(7, mouth site index, chamber index (within its system), vein index)`.
The zone files a vein's world edit under the chunk `(floor(x/64), floor(z/64))` of its position.

### Cave cell buffer (`LDCV`, format 1)

Header (96 bytes): 0 magic, 4 u16 format, 6 u16 genVersion, 8 u32 length,
12 i32 cx, 16 i32 cy, 20 i32 cz, 24 u32 flags (1 has mesh, 2 mouth zone,
4 edited), 28 u32 vertex count, 32 u32 triangle count, 36 u32 density
offset, 40 positions offset, 44 normals offset, 48 indices offset, 52
columns offset, 56 columns length (bytes), 60 veins offset, 64 u16 vein
count, 66 u16 deco count, 68 u32 deco offset, 72 u16 system (0xFFFF none),
74 u8 depth band, 76 f32 min y, 80 f32 max y of the mesh.

| Section | Content |
| --- | --- |
| density | 33 x 17 x 33 i8: field x 15.875 clamped to +-127, index (j*33 + k)*33 + i, sample (cx*64 + 2i, cy*32 + 2j, cz*64 + 2k); negative = air. Informational: the mesh is authoritative. |
| positions | f32 x 3 per vertex, world meters |
| normals | i8 x 4 per vertex: normal (x127, into the air) and the vertex's depth band |
| indices | u16 x 3 per triangle, counter-clockwise seen from the air |
| columns | CSR collision index: u32 offsets[34*34 + 1], then u32 triangle ids; bin (bx, bz) = floor((v - origin + 2) / 2) clamped to 0..33 covers local x/z in [-2, 66) |
| veins | 32-byte records: u64 id, f32 x, y, z, i8 nx, ny, nz (out of the wall), u8 kind (0 ore, 1 gem), u8 material (ore id: copper, iron, silver, sunsteel, starmetal, voidglass; gem id: ruby, sapphire, topaz, emerald, aquamarine, sunstone, onyx, amethyst, opal, moonstone), u8 element, u16 hit points, u8 crystals (3..7), u8 flags (1 sunlit, 2 mined), u8 band, u8 chamber. A vein lives in exactly the cell containing its position. |
| decos | 16-byte records: f32 x, y, z, u8 kind (0 fungus, 1 crystal, 2 stalagmite), u8 element tint, u8 scale, u8 yaw |

### Cave graph buffer (`LDCG`, format 1)

Header (64 bytes): 0 magic, 4 u16 format, 6 u16 genVersion, 8 u32 length,
12 u32 systems, 16 chambers, 20 tunnels, 24 openings, 28 veins, 32/36/40/44/48
u32 offsets of those sections, 52 f32 caveMaxDepth, 56 f32 gemRarityCurve.

- System (72 B): u64 id (= the mouth site's id), u16 site index, u8 region,
  biome, element, element2, flags, deepest band, f32 mouth y, u32 first
  chamber, u16 chambers, u16 tunnels, u32 first tunnel, u16 first opening,
  u16 openings, u32 first vein, u16 veins, u16 deepest chamber (local),
  f32 x 6 bbox (incl. margins), f32 max depth.
- Chamber (32 B): f32 x, y, z, rx, ry, floor, depth; u8 flags (1 entrance,
  2 sunlit, 4 shaft, 8 deepest), u8 band, u16 parent (local, 0xFFFF root).
- Tunnel (72 B): u16 a, u16 b (local chambers; entry: 0, 0), u8 kind (0
  entry, 1 tunnel, 2 ravine, 3 shaft), 3 pad, f32 radius, f32 vertical
  stretch, f32 floor depth (x radius below the axis), f32 x 12 axis points
  (4 points, 3 segments), 4 pad. The enemy nav graph is chambers + these
  polylines.
- Opening (32 B): f32 x, y (surface), z, r_mask, r_zone; u16 system, u16
  tunnel, u8 kind (0 mouth, 1 sinkhole), pad, u16 yaw (facing out of the
  hill, fraction of a turn x 65536), 4 pad.
- Veins: the 32-byte vein records of every system (the zone's vein registry).

### Mouth masks

A heightfield triangle of the 1 m surface mesh (cell (x0, z0), triangle 0
below the diagonal, 1 above) is dropped when its centroid `(x0 + 1/3, z0 +
1/3)` / `(x0 + 2/3, z0 + 2/3)` lies strictly within `r_mask` of an opening
(f64 arithmetic on the f32 graph values). Hosts apply the rule from the
graph's openings (`caveTriMasked` / `caves.TriMasked`); `cave_mask` is the
reference. The client's lod 0-1 terrain tiles drop the same triangles (and
skirts crossing the hole); a rock arch and rim boulders sit over the seam.

### Cave collision and ground dispatch (TS `cave.ts`, Go `server/pkg/caves`)

Pure host code over the cell buffers' f32 triangles, identical in TS and Go
(f64, same operation order, no FMA), pinned by the golden table's floor and
collide vectors. Constants: MAX_STEP_UP_M 0.6, PLAYER_CAPSULE_RADIUS 0.4,
wall = triangle normal y < cos 50 deg (0.6428), ceiling = normal y <= -0.5.

- `floorAt(x, y, z)`: the highest up-facing triangle (normal y > 0) whose
  plane height at (x, z) is in [y - 34, y + 0.6], (x, z) inside its xz
  projection (barycentric, 1e-9 tolerance), searched in the cells whose
  2 m-padded box contains (x, z) and whose y range overlaps.
- `collide(x, y, z)`: 2 passes x 2 body spheres (feet + 1.0 and + 1.5 m,
  radius 0.4), each over the wall triangles near the sphere (cells cy, cz,
  cx ascending; per cell its candidate ids sorted and deduplicated, fixed
  at the start of that sphere's pass): closest point on the triangle
  (Ericson 5.1.5); if closer than the radius, push horizontally along the
  xz part of (center - closest) by (radius - distance) (along the
  triangle's normal xz if that is degenerate). Then one ceiling pass with
  the high sphere: overlap pushes y down and reports `ceiling`.
- `raycast(o, d, max)`: probes every 1.5 m along the ray gather the
  triangles within 1.2 m (same candidate order as `collide`) and test
  them two-sided (Moller-Trumbore); the nearest hit, stopping once it lies
  behind the probes; -1 for none. Line of sight, aim and spell impacts.
- Ground dispatch (`CaveGroundCore` / `caves.Ground`): the surface ground
  (terrain, or terrain + structures) on the open surface; in a mouth hole
  (point masked) or more than 1 m under the surface ("in a cave") the floor
  under feet height y: the highest cave floor in [y - 34, y + 0.6], else the
  lowest ledge in (y + 0.6, y + 3], else y inside rock (trilinear density of
  the cell >= 0), else y - 35 (open pit); a masked point with no cells keeps
  the surface. `collide` is a no-op outside caves.
- The movement step (WP10's state machine) views the ground at the
  player's level once per step and runs one `collide` pass after the mode
  step: `server/pkg/movement/caves.go`, `client/src/sim/caves.ts`.

Cost (Chromium worker, golden table run): cave_build mean 0.8 ms, max 3.7 ms
over 220 cells around system chambers (budget 12 ms); the cave graph once
per worker ~38 ms.

## How the world is made

**spec_from_seed** picks every field inside tasteful sub-ranges of the schema
(every biome weight >= 0.35 so all six can appear, mountains 0.4-0.9, land
0.5-0.78, ...), rounded to 3 decimals; the name comes from one of five
original syllable grammars with a blocklist against names from the games we
are inspired by.

**Atlas pass** (once; ~300-450 ms in wasm):
1. Continent mask: domain-warped fBm + radial falloff + a guaranteed sea
   border; a land anchor per region guarantees every region has room for its
   tower and settlement. Land threshold is the exact `landFraction` quantile.
2. Macro heightmap: coastal rise, hills (`roughness`), ridged mountains
   masked by a mountain field (peak 140-700 m above sea by `mountainHeight`),
   terraced mesas (`plateaus`). Sea level y = 4 + 40 * `seaLevel`.
3. Hydrology: priority-flood filling gives a drainage direction for every
   node, lakes where the fill is deeper than 0.75 m, flow accumulation; rivers
   where upstream area passes a threshold set by `riverDensity`; river nodes
   are sunk into the macro surface.
4. Climate: temperature from altitude lapse, a north-south gradient,
   `temperatureBias` and broad warm/cold provinces; moisture from distance to
   water, an upwind march (first water upwind is the source, the highest
   terrain crossed casts a rain shadow), rank-normalized over land so every
   world has wet and dry provinces, then `moistureBias`.
5. Biomes: Gaussian affinities on (temperature, moisture, altitude, slope)
   times the normalized `biomeWeights` (weight 0 removes a biome), one
   majority-filter pass.
6. Sites, in order: settlement sites (flat, fresh water, shelter, spacing,
   >= 1 per region, 16-40 total by `settlementDensity`, ranked into towns,
   villages, hamlets); one tower per region at the candidate with the largest
   1.5 km viewshed (30 m observer); cave mouths and structures preferring ground
   hidden from every tower but within ~200 m of ground a tower sees ("just
   behind a ridge"); waypoints (one per settlement + one wilderness per region),
   landmarks (each region's most prominent peak), enemy camps; then lazy-greedy
   gap filling (landmarks, camps, ruins) until <= 2% of walkable land lacks a
   POI visible within 800 m, or the per-region budget (44 sites) is spent.
   Candidates are peaks, ridge crests, river bends, valley mouths and a 96 m
   grid. Viewsheds are radial line-of-sight sweeps on the macro grid.
7. Regions: biome mix, dominant + secondary element (`elementWeights` x the
   spec 7 biome affinity table, seeded weighted draw), danger by distance
   from spawn shaped by `dangerCurve`. Spawn = the best meadow/forest
   settlement near the middle.

**Chunk pass** (on demand; ~2.4 ms mean in a Chromium worker): Catmull-Rom
macro surface + derivative-damped ("erosion-shaped") fBm with per-node
amplitude, ridges, mesas; river channels cut along the warped D8 network
with banks; lakes shaped from a warped lake mask; slope-aware splat weights;
seamless Poisson-disk scatter (one jittered candidate per world-aligned cell,
a candidate survives unless a neighbor within the minimum distance has a
higher priority hash; density uses atlas data only, so neighbors agree on
their border); container and spawn anchors per 32 m cell and around sites.

## Determinism

- Pure f64 arithmetic plus `libm` (floor, sqrt, exp, pow, sin/cos/atan,
  compiled into the module). No threads, clocks, host randomness, SIMD or
  host imports.
- Randomness = SplitMix64 hashes of (seed, stream, coordinates); lattice
  noise uses a 32-bit integer hash. Sequential atlas stages use a local
  counter sequence whose draw order is itself fixed.
- Sorting and priority queues break ties on node index; HashMaps are never used.
- Stored grids are quantized to their on-disk type (f32 heights, u8 climate)
  before any later stage reads them, so every consumer sees the same values.
- No NaN: debug builds assert finite on every float written to a buffer;
  `cargo test` runs the native golden subset in debug.
- Proof: the golden table (288 chunks over 5 worlds spanning every biome,
  water, sites and LOD 0-6, plus atlas hashes and 320 collision heights) is
  identical in Node, Chromium (Web Worker), Go/wazero (compiler and
  interpreter) and native x86_64 Rust. Evidence: `docs/evidence/wp01-golden.txt`.

## Versioning

`GEN_VERSION` (lib.rs) is the generator major version, stored in atlas and
chunk headers. Rules (spec 5 "keeping old worlds working"): a change that
alters any golden hash needs a new `GEN_VERSION` and a new golden table;
refactors and speedups must leave the table untouched. `ABI_VERSION` covers
export signatures and buffer layouts; the TS loader refuses a mismatch. The
deployable artifact is `pkg/worldgen-<sha256:16>.wasm`; `manifest.json`
records its hash, size, genVersion and rustc version (pinned by
rust-toolchain.toml so builds are reproducible). Until the first world is
minted, genVersion 1 is still being tuned and `npm run golden:update` is
allowed without a bump.

## Performance (this machine: i7-11700K, Windows 11)

| Measure | Result | Budget |
| --- | --- | --- |
| Detail chunk, LOD 0, Chromium 131 Web Worker, 200 chunks | mean 2.35 ms, p95 3.70 ms, max 4.35 ms | 8 ms |
| Detail chunk, Go/wazero compiler | mean 3.9 ms, p95 6.0 ms | (server) |
| Atlas build, wasm | 270-460 ms | 60 s at mint |
| Atlas size | ~310 KB raw, 103-141 KB gzipped | 2 MB gzipped |
| `collision_height` | ~1.7 us | |
| worldgen.wasm | ~350 KB | |

## Decisions and assumptions

- **LOD tiles grow, sample count stays 65 x 65.** A LOD l tile covers
  64*2^l m with 2^l m spacing (quadtree / CDLOD friendly); scatter only at LOD 0.
- **Collision = the f32 lattice mesh**, not the continuous noise function, so
  the rendered mesh, the server and the client all agree exactly.
- **Water is a per-sample surface height** (never a sentinel), so water
  meshes need no special cases; sea level is under dry land.
- **One site table** for POIs, settlements and structures, with category +
  kind tags; WP20 builds towns, roads and buildings from settlement and
  structure sites (it can use the per-site seed and yaw). Roads are not
  generated here.
- **Settlement footprints are pre-flattened** (detail amplitude x0.25, no
  terraces) so buildings fit; trees, rocks and bushes are kept out of every
  site footprint.
- **Every region is guaranteed land**, which can make outlying regions small
  islands at low `landFraction`.
- **The atlas embeds the canonical spec JSON**, so an atlas file alone
  describes its world; the spec JSON passed in is canonicalized, so its
  formatting never changes the atlas hash.
- **spec validation rejects** out-of-range values instead of clamping;
  clamping is the creator tool's job (spec 6).
- **FNV-1a 64** stays the content hash (WP00's choice): trivial to
  reimplement in any host, ~0.1 ms per chunk.
- **Caves** (WP09) grow from the cave-mouth sites (downhill-facing yaw);
  see "Caves" above. They are new exports, not a change to chunks: the
  overworld chunk does not carry the mouth mask (spec 7 wording); hosts
  apply the analytic mask rule from the cave graph, which kept every chunk
  hash and genVersion 1.
