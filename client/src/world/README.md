# client/src/world

The generated world in the browser (WP05, spec 12): chunk streaming in Web
Workers, quadtree terrain with geomorphing, the splat shader over KTX2
texture arrays, water, instanced scatter, the shared wind field, the analytic
sky, cascaded sun shadows and the post chain (height fog, god rays, bloom,
filmic tone mapping, grading). Plain three.js managers driven from one
`useFrame`; React only owns their lifetime.

## Run

```
npm run dev:solo                     # from the repo root; builds worldgen.wasm first if missing (vite plugin)
# http://localhost:5173/?autoplay=1  (?seed=N another world, ?nocache=1 skip the IndexedDB mesh cache)
```

The solo player spawns on land at the atlas spawn (worldgen picks the best
meadow/forest settlement near the middle) and walks the wasm collision surface.

Debug (dev/solo builds or `?debug=1`): F4 shows WP02's cell/chunk/region
borders plus the terrain tile outlines coloured by LOD; the backquote panel
has a World section: "Regenerate chunk + compare hash" (fresh build in a
worker and on the main thread vs. the hash the loaded mesh was built from)
and one-click teleports to every biome. The HUD's chunk queue / loaded slots
are filled. `window.__lodestoneWorld` exposes `stats()`, `regenerateCurrentChunk()`,
`groundAt(x, z)`, `sites()`, `biomeSpot(biomeId)`.

## Test

```
npm run test -w client                # includes src/world/**: quadtree, tile mesh vs wasm collision, pool, ground, wind, sky
npm run typecheck -w client && npx eslint client/src/world
# traversal benchmark (spec 12 budgets) against the production build:
cd client && VITE_SOLO=1 npx vite build && npx vite preview --port 5177   # leave running
npm run bench -w client               # high + low -> docs/evidence/wp05-traversal*.{json,md}, wp05-*.png
```

The benchmark uses the real GPU through ANGLE/D3D11 in headless Chromium
(`LODESTONE_BENCH_GL=swiftshader` forces software GL, `LODESTONE_BENCH_UNCAPPED=1`
disables vsync to expose true frame cost, `LODESTONE_BENCH_SHORT=1` only
takes the beauty shots).

## Layout

| Path | What |
| --- | --- |
| `WorldCanvas.tsx` | Play-screen mount: loads the runtime, then WP02's `GameCanvas` with the wasm ground, the world scene and no placeholder sky. Loading veil until the first playable frame. Same props as `GameCanvas` (WP06 passes `onStep` here). |
| `WorldScene.tsx` | The managers, the per-frame update (time of day, lights, fog, grade, streaming) and the render through the post chain; renderer.info for the whole frame. |
| `config.ts` | World seed (`?seed=`, `VITE_WORLD_SEED`, default 20261108 like WP04) and the per-tier table (LOD split, upload budget, scatter/grass distances, shadow reach, bloom, god rays, water detail). |
| `wind.ts` | The one wind field: `windAt(x, z)`, `windGust`, `windUniforms`, `WIND_GLSL` (same formula on CPU and GPU). Other packages read it from here. |
| `core/runtime.ts` | wasm compile (one `Module` shared with workers), atlas from IndexedDB or built in a worker, main-thread worldgen for the ground, worker pool start. |
| `core/workerPool.ts`, `core/chunk.worker.ts`, `core/protocol.ts` | `min(hardwareConcurrency - 2, 4)` workers, priority queue with dedupe/cancel; jobs: atlas, tile, scatter, grass, hash, evict. Results are transferred buffers. |
| `core/cacheDb.ts` | Stores in WP04's shared `lodestone` IndexedDB, all prefixed `cache:` (`cache:atlas`, `cache:terrain-mesh`, `cache:terrain-meta`); mesh cache keyed (atlasHash, genVersion, format, lod, cx, cz), LRU capped at 500 MB, read and written inside the workers. |
| `core/ground.ts` | `WorldGround`: the client `GroundQuery` straight over the wasm `collision_height` export (no allocation, works before any mesh exists). |
| `terrain/quadtree.ts` | Tile selection (split while within `split x size`), hysteresis, restricted-quadtree balancing, ancestor fallback, coarser-edge flags. |
| `terrain/tileMesh.ts` | Worker-side mesh: collision diagonal, coarse-lattice morph targets (height + normal), skirts, coarse water mesh with exact depth. |
| `terrain/terrainManager.ts` | Streaming (current + velocity prefetch + view prefetch + idle ring), time-sliced uploads, time-based geomorphs and edge stitching, merge/split animation, coverage texture, eviction, distance-limited terrain shadow casting. |
| `terrain/terrainMaterial.ts`, `terrain/terrainTextures.ts` | Splat shader on `MeshStandardMaterial` (9 array layers, height blend, triplanar cliffs > ~50 deg, anti-tiling, biome grass tint, flat fallback until textures arrive); KTX2 array loading. |
| `terrain/horizon.ts` | Distant terrain straight from the atlas heightmap (one mesh, discards where tiles are drawn). |
| `water/water.ts` | Water shader (sky reflection, depth fade, gentle normals, glints, foam) for tile water and the camera-following sea plane. |
| `scatter/` | `archetypes.ts` the original low-poly trees/rocks/bushes/grass (Low tier), `impostors.ts` impostor atlas (and the bake material for the rich trees), `scatterMaterials.ts` (wind, LOD dither fades, foliage tint; `createRichMaterial`: leaf atlas with alpha cut, bark, leaf translucency, branch sway, triplanar stone with moss/snow), `scatterManager.ts` (global InstancedMeshes re-binned by distance, stable ids, hide by id; `setVegetation(level)` swaps the original set for the rich kit), `grassGen.ts` (worker grass clumps). Rich vegetation (playtest 3, CR 045): `natureTextures.ts` (procedural leaf/flower atlas, bark, stone), `meshBuilder.ts`, `treeGen.ts` (9 species x 2 variants x 2 LODs), `groundcoverGen.ts` (shrubs, scrub, heather, ferns, reeds, grass, flowers, fractured rocks). `bench/vegetation.mjs` takes the before/after shots and frame times. |
| `sky/` | `atmosphere.ts` analytic scattering (CPU + GLSL twins), `skyDome.ts` (stars, sun, moon, clouds), `sunShadows.ts` (CSM, patched so non-CSM materials use cascade 0 only). |
| `life/ambientLife.ts` | Playtest 2 immersion pass: ambient life around the camera by biome, hour and weather: flocks of birds (hawks over the highlands and badlands), butterflies, fireflies on warm dry nights (slow glows, no blinking), falling leaves in woods, pollen motes. Anchored at world positions in a box that wraps around the camera (ground sampled once per wrap), 5 draws, half the counts on Low, nothing underground, over water (insects) or in rain; `__lodestoneLife` (debug). Purely visual. |
| `post/postfx.ts` | Composer: fog from depth, god rays (half res), bloom, ACES, grade. |
| `structures/` | (WP12) Structure overlay on the ground (`WorldRuntime.ground` = terrain + towers), towers from the atlas, tower and waypoint-stone visuals. README there (how WP20 adds structures). |
| `debug/` | `worldDebug.ts` (stats + window handle), `lodOverlay.ts`, `WorldDebugSection.tsx` (debug panel). |
| `bench/traversal.mjs` | The traversal benchmark. WP19b: lists every shader program linked during the walk and the flight (name, cache key, time: match them to long tasks), the programs linked before playable, `LODESTONE_BENCH_PREFIX` (result file names) and `LODESTONE_BENCH_QUERY` (extra URL parameters, e.g. `nowarmup`). |
| `warmup.ts`, `warmExtras.ts` | WP19b shader warm-up (spec 12 "shader precompile during the loading screen"): once the first terrain is in the scene, and again after an explicit shader-tier change, `renderer.compileAsync` compiles every material in the scene plus `warmExtras` (objects whose programs only appear later: town solid/decal, cave rock, avatar meshes and nameplate, the weapon material, enemy bars and the additive glow decal) against a render target (the world draws through the post chain, which gives programs linear output and no tone mapping). With `KHR_parallel_shader_compile` the driver compiles in the background; `WorldScene` draws nothing until it is done and the loading veil waits for it (`worldDebug.shadersWarm`). Before: one 347-357 ms long task on high, 62 + 157-175 ms on low, every one a first-use compile (`docs/evidence/wp19b-nowarmup-traversal-run.txt`); after: no long task, no program linked during traversal, first playable on high ~4.7-5.0 s instead of 6.7-7.2 s. `?nowarmup` (debug builds) skips it. A new material that appears mid-play shows up in the benchmark's program list: add it to `warmExtras.ts`. |
| `edits/` | Playtest 3 (CR 040): the breakable world. `overlay.ts` (per-vertex height deltas on the 1 m lattice, the TS twin of `server/pkg/worldedit`, bit-identical to the zone: `contracts/golden/world_edits.json`; `WorldGround.edits`), `tileEdits.ts` (edits in a tile build in the workers: lifted lattice, bare-soil splat), `planner.ts` + `harvestDefs.ts` (the dig planner and break rules, solo authority and targeting), `worldEdits.ts` (key = work tool, targeting ring, hit bar, debris pool, felling, session hooks for WorldEdits kind `object_destroyed`, TerrainEdits and Events 1800-1807), `toolState.ts`. `TerrainManager.setEdits` builds tiles with edits and rebuilds the touched loaded ones in place; `ScatterManager.hide/unhide` is the removal mask. `dev/edits-shots.ts` is the real-client + zone evidence run. |
| `buildings/` | WP20: towns layer (built in a worker at load), `TownGround` (building floors, walls, ceilings on the movement ground; `WorldRuntime.ground` wraps the caves), kit meshes per settlement, roads, bridges, signposts, structures, props, NPCs, interaction HUD (Interact 30-33, Events 800-807), town bench. README there. |
| `caves/` | WP09: cave cells (workers), cave-aware ground, mouth holes in tiles, cave meshes, gems, fungi, light pool, arches, mining, reverb. README there. |
| `testing/wasm.ts` | Test helper: the real worldgen.wasm in Node. |

## Decisions (details in `docs/decisions/0009-world-rendering.md`)

- Tiles are worldgen's own quadtree chunks (65 x 65 at 2^lod m); the lod-0 mesh is the collision surface.
- Geomorphing is time-based (a split eases children out of the parent's shape over 0.6 s, a merge eases them back before the swap) plus exact edge stitching to coarser neighbours; distance-based CDLOD morphing needs ranges ~2.8 tile diagonals wide, which at 64 m tiles meant 3x the triangles.
- Fog lives in post (from depth), so every material, including other packages', gets the same height fog for one pass.
- Scatter uses a fixed set of world-wide InstancedMeshes re-binned by distance on the CPU, so draw calls don't grow with view distance.
- Textures: 3dtextures.me CC0 sets, KTX2 arrays built with the `ktx2-encoder` npm package (Basis Universal); see `tools/textures/README.md`.

## Dwarves (CR 043)

`vertical/dwarfDecos.ts` draws the genVersion 4 decorations (kinds 28-45: cave dressing, chests and tablets, the dwarves' doors, pillars, statues, banners, rune circles, throne, forge glow) and the carved colonnades; `vertical/dwarfKinds.ts` holds their kind numbers, the Interact / Event numbers (160-161, 1860-1863) and the live chest / discovery state; `buildings/kit.ts` style 6 `dwarf`, `buildings/npcs.ts` dwarven townsfolk, `townMaterial.ts` `uCaveFill` (warm stone fill, no sun underground). Shots: `node client/src/world/vertical/dev/dwarf-shots.mjs`.

## Diegetic layer (CR 052)

Guidance and feedback in the picture instead of the HUD; one mount (`DiegeticLayer.tsx`, in `WorldCanvas` next to the towns layer), all client side, no worldgen change:

| Path | What |
| --- | --- |
| `guide/` | The guiding wisp: `route.ts` (road graph from `Towns.roads`, A*, route planning, the wisp's lead/wait/fade step; pure, tested), `target.ts` (quest marker, else pin), `WispLayer.tsx` (one Points draw), `guideStore.ts` (the **.** key; G is the glider). |
| `signposts/` | `placement.ts` (fork posts keep the towns buffer's arms and get names; new exit posts at each town road; the names a board chooses; pure, deterministic), `boards.ts` (lettered faces and arrows), `SignpostLayer.tsx` (exit post meshes per town, a pool of canvas label slots by quality tier), `boardPapers.ts` + `BoardPapersLayer.tsx` (papers on bounty boards). |
| `landmarks/` | `landmarks.ts` (which sites signal what, plume/bird/glint motion; pure) and `LandmarkLayer.tsx` (three Points draws plus up to four pillar beams): smoke over camps, light pillars over unattuned towers at dusk, lanterns at dwarven doors, cave-mouth glows, birds over vaults and live events, glints on sky palaces. |
| `feedback/LevelGlow.tsx` | The golden spiral around you on a level up. |
| `diegeticDebug.ts` | `window.__lodestoneDiegetic` (debug builds). Shots: `npx vite-node src/world/guide/dev/diegetic-shots.ts` (from `client/`). |

No lights are added or removed at run time; everything is emissive sprites or small meshes. Low drops the birds and glints and halves the plumes and label slots.
