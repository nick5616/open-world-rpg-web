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
| `scatter/` | `archetypes.ts` procedural trees/rocks/bushes/grass, `impostors.ts` impostor atlas, `scatterMaterials.ts` (wind, LOD dither fades, foliage tint), `scatterManager.ts` (global InstancedMeshes re-binned by distance, stable ids, hide by id), `grassGen.ts` (worker grass clumps). |
| `sky/` | `atmosphere.ts` analytic scattering (CPU + GLSL twins), `skyDome.ts` (stars, sun, moon, clouds), `sunShadows.ts` (CSM, patched so non-CSM materials use cascade 0 only). |
| `post/postfx.ts` | Composer: fog from depth, god rays (half res), bloom, ACES, grade. |
| `structures/` | (WP12) Structure overlay on the ground (`WorldRuntime.ground` = terrain + towers), towers from the atlas, tower and waypoint-stone visuals. README there (how WP20 adds structures). |
| `debug/` | `worldDebug.ts` (stats + window handle), `lodOverlay.ts`, `WorldDebugSection.tsx` (debug panel). |
| `bench/traversal.mjs` | The traversal benchmark. |
| `buildings/` | WP20: towns layer (built in a worker at load), `TownGround` (building floors, walls, ceilings on the movement ground; `WorldRuntime.ground` wraps the caves), kit meshes per settlement, roads, bridges, signposts, structures, props, NPCs, interaction HUD (Interact 30-33, Events 800-807), town bench. README there. |
| `caves/` | WP09: cave cells (workers), cave-aware ground, mouth holes in tiles, cave meshes, gems, fungi, light pool, arches, mining, reverb. README there. |
| `testing/wasm.ts` | Test helper: the real worldgen.wasm in Node. |

## Decisions (details in `docs/decisions/0009-world-rendering.md`)

- Tiles are worldgen's own quadtree chunks (65 x 65 at 2^lod m); the lod-0 mesh is the collision surface.
- Geomorphing is time-based (a split eases children out of the parent's shape over 0.6 s, a merge eases them back before the swap) plus exact edge stitching to coarser neighbours; distance-based CDLOD morphing needs ranges ~2.8 tile diagonals wide, which at 64 m tiles meant 3x the triangles.
- Fog lives in post (from depth), so every material, including other packages', gets the same height fog for one pass.
- Scatter uses a fixed set of world-wide InstancedMeshes re-binned by distance on the CPU, so draw calls don't grow with view distance.
- Textures: 3dtextures.me CC0 sets, KTX2 arrays built with the `ktx2-encoder` npm package (Basis Universal); see `tools/textures/README.md`.
