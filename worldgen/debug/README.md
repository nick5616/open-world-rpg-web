# worldgen debug map

A 2D view of an atlas for eyeballing: biomes with hillshade, sea and lakes,
rivers, the region grid with names, elements and danger, every site
(towers, settlements to scale, structures, cave mouths, waypoints,
landmarks, camps), the spawn, and an optional 800 m coverage layer
(magenta = walkable land that sees no POI within 800 m). Clicking the map
builds the 5 x 5 LOD-0 chunks around that point at 1 px/m: splat colors,
hillshade, water, trees, bushes, rocks, containers and spawn anchors.

```
npm run build:wasm
npm run debug -w @lodestone/worldgen     # http://localhost:5180/debug/?seed=7
node worldgen/debug/screenshot.mjs 7 1234 7:cover   # PNGs into docs/evidence/
```

Port 5180 (`LODESTONE_WORLDGEN_DEBUG_PORT` overrides). The same Vite server
(root `worldgen/`, cross-origin isolated) serves the Chromium golden harness
at `/harness/browser/`. Nothing here ships.
