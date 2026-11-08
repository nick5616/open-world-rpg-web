# worldgen

The deterministic world generator (spec sections 5 and 6): one Rust crate,
compiled once to `worldgen.wasm`, executed unchanged by browsers (Web
Workers), Node and Go zone servers (wazero). A world is
`(seed, WorldSpec, genVersion)`; nothing world-shaped ever goes over the wire.

This file is the contract for WP05 (client renderer), WP07 (Go host), WP09
(caves), WP12 (map/towers) and WP20 (towns/structures): the wasm ABI and every
buffer layout, byte for byte. `worldgen/js/src/format.ts` is the reference
reader and must stay in sync with this document.

| Path | What |
| --- | --- |
| `src/` | The crate: `spec.rs` (spec_from_seed, validation), `names.rs` (name grammars), `rng.rs` / `noise.rs` (counter hashing, gradient noise), `atlas/` (pass 1), `ground.rs` (height function + collision queries), `chunk.rs` (pass 2), `abi.rs` (wasm exports), `gen/` (generated from contracts, never edit) |
| `js/` | `@lodestone/worldgen`, the typed TS loader (README there) |
| `golden/` | Golden table `golden.json` and its generator |
| `harness/` | Chromium (Web Worker) and Go/wazero hosts of the golden table |
| `debug/` | Vite debug map on port 5180 |
| `scripts/` | `build-wasm.mjs`, `test-golden.mjs` |
| `examples/atlas_stats.rs` | Native sanity report: `cargo run -p worldgen --release --example atlas_stats -- 42` |
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
- **Caves are not generated yet** (WP09 owns `cave_build`); cave mouths are
  placed as sites with a downhill-facing yaw so WP09 can grow systems from them.
