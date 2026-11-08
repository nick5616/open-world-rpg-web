# Status

One section per work package (spec 15). Each package edits only its own section.
Gates: G0 ✅ · G1 ⏳ · G2 ⏳ · G3 ⏳ · G4 ⏳ · G5 ⏳

## WP00: Monorepo scaffold and contracts ✅

Works:
- npm workspaces (`contracts/ts`, `client`, `tools/*`), Go workspace (`go.work`, six modules), Cargo workspace (`worldgen`), pinned Rust toolchain.
- `contracts/`: `protocol.yaml` (13 messages, masked entity/self records), `constants.yaml` (world, sim, movement, AOI, voice, social, gameplay, security), `social.yaml`, `worldspec.schema.json`, migration `0001_init.sql`.
- Codegen (`npm run gen`, `gen:check`) emits TS, Go and Rust plus 39 golden byte vectors. TS (vitest) and Go tests decode and re-encode every vector identically.
- Go shared packages: `proto` (codec runtime + quantization), `constants`, `socialproto`, `worldspec`, `env`, `svc` (healthz, metrics, graceful shutdown), `migrate` + `cmd/migrate`.
- `infra/docker-compose.yml` (Postgres 16, Redis 7, LiveKit 1.8). `npm run dev` brings up infra, applies migrations, starts director/account/zone/social stubs (healthy on /healthz) and the Vite client; `npm run dev:solo` runs the client alone. Evidence: `docs/evidence/wp00-dev-smoke.log`.
- CI skeleton `.github/workflows/ci.yml` (ubuntu + windows): gen check, lint, tests, wasm build, client build.

Known gaps:
- CI has never run on GitHub (no push in this run).
- Service binaries are stubs; their packages replace them.
- `friends`/`blocks` reference `accounts`, so local profiles cannot have friends until WP08 decides how to key them (CR expected).

## WP01: Worldgen core, overworld ✅

Branch `wp/01-worldgen`. ABI and every buffer layout: `worldgen/README.md`.

Works:
- `spec_from_seed`: every WorldSpec field from the seed, in playable sub-ranges, with original seeded name grammars (5 grammars, blocklist against inspiration-game names). Specs are validated (rejected, not clamped) before use.
- Atlas pass (~300-450 ms in wasm, ~310 KB, 103-141 KB gzipped vs 2 MB budget): continent mask with sea border and a land anchor per region; macro heightmap at 32 m (hills, ridged mountains, mesas); priority-flood hydrology (rivers by `riverDensity`, lakes, sea level); climate (altitude lapse, gradient, bias, upwind moisture with rain shadows); six biomes; region biome mix, dominant + secondary element, danger from spawn; visibility-driven sites with stable ids and dense indices: >= 1 tower per region (largest viewshed), cave mouths and structures preferring "just behind a ridge" from towers, 9 structure types, settlement sites (hamlet/village/town, >= 1 per region), waypoints, landmarks, enemy camps, and gap filling until >= 98% of walkable land sees a POI within 800 m (99.9-100% on the golden worlds).
- Chunk pass: 65 x 65 heights at 2^lod m (seams match across LODs and neighbors), water surface per sample, slope-aware 6-material splat (two RGBA8 planes), seamless Poisson scatter (trees, rocks, bushes, grass tufts) with stable bijective ids, loot container and spawn anchors (wild + around sites). Detail chunk in a Chromium Web Worker: mean 2.34 ms, p95 3.73 ms (budget 8 ms).
- Collision: `collision_height` (exactly the f32 lattice mesh the chunks carry; ~1.7 us/query), `ground_normal`, `raycast`. A pure-TS `chunkSurfaceHeight` reproduces the wasm bits from chunk heights.
- Wasm ABI with no imports; `npm run build:wasm` -> `worldgen/pkg/worldgen.wasm` + `worldgen-<sha256>.wasm` + manifest.
- `@lodestone/worldgen` (worldgen/js): typed loader + pure-TS atlas/chunk readers.
- Determinism: golden table of 288 chunks over 5 worlds (every biome, water, sites, LOD 0-6) + atlas hashes + 320 collision heights; `npm run test:golden` passes in Node, headless Chromium (Web Worker), Go/wazero compiler and interpreter, and native Rust.
- Debug map on port 5180 (`npm run debug -w @lodestone/worldgen`).
- Evidence: `docs/evidence/wp01-golden.txt` (all hosts, timings, sizes), `docs/evidence/wp01-chromium-golden.json`, `docs/evidence/wp01-atlas-stats.txt`, screenshots `docs/evidence/wp01-atlas-seed7.png`, `wp01-atlas-seed1234.png`, `wp01-atlas-seed7-coverage.png`.

Known gaps:
- CI does not run `npm run test:golden` yet (needs `npx playwright install chromium` on runners); `npm test` runs the Node and Go golden checks only when the wasm is built, and CI builds it after tests. Suggest a CI step `npm run test:golden` (root file owned by WP00).
- Timings are from one desktop (i7-11700K), not a mid-range laptop; there is ~2x headroom on the 8 ms budget.
- Roads, town layouts and structure geometry are WP20; caves (`cave_build`) are WP09. Sites carry the data they need (kind, size, radius, yaw, per-site seed, element).
- Rivers follow the 32 m D8 network with a noise warp; wide rivers can look straight-segmented up close. Lakes are shaped per chunk from a warped mask.
- Low `landFraction` worlds can put outlying regions on small islands (each region is guaranteed land, not connection to the mainland).
- genVersion 1 is still tunable until the first world is minted; after that the golden table is frozen (`worldgen/golden/README.md`).
