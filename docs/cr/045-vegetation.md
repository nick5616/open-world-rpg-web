# CR 045: Vegetation art (playtest 3)

Branch `pt3/vegetation`. Playtest feedback: "Make the assets in the world better and higher fidelity, like it would make you want to live in this world, super immersive. For example, trees suck."

Client-only. No worldgen, wire, event or migration change: scatter records, ids and positions are untouched (`LODESTONE_WIRE_DIGEST` unaffected).

## What changed

- **Quality tiers**: `WorldTier.vegetation` (config.ts): Low 0 = the original low-poly set, unchanged cost; Medium 1, High 2, Ultra 3 = the rich set with 0.6 / 1 / 1.3 x leaf-card counts. It follows the *shader* tier (`ScatterManager.setVegetation`), because the rich set adds shader programs; auto-quality steps never swap it. Dev: `?veg=0..3` forces a level (benchmarks on one build).
- **Trees** (`scatter/treeGen.ts`): 9 species in worldgen's TREE_KINDS order (oak, birch, broadleaf, pine, snow fir, dead snag, acacia, willow, cypress) x 2 variants (other seeds) x 2 mesh LODs. Tapering trunk with root flare and buttress lobes, limbs that curve and fork (tessellation by branch order), leaf clusters of alpha-tested card quads (~250 per tree on High) hung on branch tips plus crown fill, conifers with whorls and crossed needle sprays, willows with hanging strands, acacia umbrella crowns. Per-card shade (interior dark, sun side bright) and hue drift baked in vertex colours; per-instance hue drift added. LOD0 to 45 m (~1.1-1.9k tris), LOD1 to the tree mesh distance (~140 tris, larger cards), impostor billboards beyond, dithered cross-fades as before. The impostor atlas is baked from the rich LOD0 meshes with their own textures.
- **Shading** (`scatterMaterials.ts createRichMaterial`): leaf atlas with alpha test (alpha-tested shadows via `material.map`), a tiling bark texture per species with derivative bump, soft "crown normals" lit from both sides, **leaf translucency** (an emissive term from the one sun direction when the camera looks toward the sun through foliage), wind: trunk sway, **branch sway** (`aCard.y`) and leaf flutter in the vertex shader. No lights added.
- **Ground cover** (`scatter/groundcoverGen.ts`): dense grass clumps of bent, tapered blades with root-dark to tip-light gradients and hue variation, flower heads on a hashed 7 % of clumps (palette by hash, zero extra draws); flower tufts, grass tufts, leaf-card shrubs (shrub / berry), dry scrub, heather, ferns (arching frond strips), reeds with seed heads. Near and far LODs for bushes.
- **Rocks**: a sphere cut by random planes (hard facets), noise-lumped, with strata ledges and banded vertex colours; triplanar stone texture with bump; moss on upward faces (mossy kind), snow caps (snowy kind); boulder / slab / spire shapes; 320-tri near and 80-tri far LODs, cross-faded.
- **Textures** (`natureTextures.ts`): leaf / flower atlas (8 cells), 4 bark textures, stone, all painted procedurally at first use (original art, no files).
- **Towns**: dense grass is masked out of roads, plazas, building plots and fields with the towns' `Clearance` (`ScatterManager.setClearance`), the same shapes that hide the sparse scatter.
- **Removal mask friendliness**: still one instanced draw per species / variant / LOD keyed by the stable scatter ids; `hide(id)` and `idAt` work on every bin.

## Measured

`client/src/world/bench/vegetation.mjs` (RTX 3070, headless, uncapped, 1280x720, clear weather, High, one production build, `VEG_LEVEL=0` vs default; `docs/evidence/pt3-veg-{before,after}-*.jpg|json`). The GPU was shared with other agents' browsers, so single runs swing 2x; across the nine views the median p50 frame time is 12.0 ms before and 12.1 ms after (first runs on a quiet GPU: forest 5.8 ms before, 12-13 ms after). Triangles: forest 2.47 M -> 3.51 M total, scatter 0.35 M -> 0.85 M, shadow 1.39 M -> 1.92 M; draw calls forest 357 -> 413 (over the 400 soft budget in the densest mixed forest), meadow 353 -> 377. Low: unchanged code path (118-139 calls, same frame time).

## Gaps

Terrain surface near the player was not changed (the existing splat already has detail normals and tile breaking). Sky-island and cave variants have no scatter records, so no new species for them. No palms (no worldgen kind). Draw calls in a mixed forest slightly exceed 400. Leaves are larger than real ones (stylised). Impostors are a single side view.
