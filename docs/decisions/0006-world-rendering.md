# 0006: World rendering and streaming (WP05)

Date: 2026-11-08

## Terrain tiles are worldgen's quadtree chunks

`chunk_build(cx, cz, lod)` already returns quadtree tiles (65 x 65 samples at
2^lod m, seams shared across LODs), so the renderer's tiles are exactly those:
no resampling, no second height function. Each lattice cell is split on the
collision diagonal, so a lod-0 tile is the collision surface (unit test:
2,000 points, exact equality with `collision_height`).

## Geomorphing: time-based morphs plus exact edge stitching

Classic CDLOD morphs by distance and is crack-free only if each LOD's morph
band is wider than about 2.8 tile diagonals. With 64 m lod-0 tiles that meant
lod-0 out to ~360 m and ~3x the triangles of the budget. Instead:

- every vertex carries its height and normal on the next-coarser lattice
  (odd vertices interpolate along the coarse cell edge or the same diagonal,
  so a fully morphed tile *is* its parent);
- a tile that replaces its parent starts fully morphed and eases to its own
  shape over 0.6 s; a merge first eases the children into the parent's shape
  and swaps only then, so neither direction changes a pixel at the swap;
- edges bordering a coarser tile are pinned to the coarser lattice (the
  quadtree is balanced to one level), so steady-state seams are exact;
- skirts cover transients (a two-level jump while a tile streams in).

## Fog and grading in post

Height fog with sun in-scattering is computed once per pixel from the depth
buffer, coloured by the same analytic sky the dome draws. One formula for
every material (including other packages' materials, which need no fog code)
and distant terrain dissolves into exactly the sky behind it. Grading is a
parametric lift/gamma/gain/saturation per time of day and biome rather than
LUT files: the same knobs a LUT bakes, without assets; LUTs can replace it.

## Cascaded shadows: three's CSM, patched for everyone else

CSM adds one directional light per cascade. Plain materials (other packages)
would sum all of them, so the CSM shader chunk is patched: non-CSM materials
use only light 0 (the nearest cascade) among shadow casters. Shadow casters
are limited by distance (terrain lod-0 tiles within 64 m, rocks/bushes 70 m,
tree LOD1 100 m): each cascade redraws every caster, and unlimited casters
were a million shadow triangles.

## Scatter: world-wide instanced meshes, CPU re-binning

One InstancedMesh per (archetype, LOD) for the whole world instead of per
chunk group: the CPU re-bins instances by distance every 6 m (at most every
150 ms), the GPU cross-fades LODs per instance with dithering. Draw calls are
fixed (~20 + shadows) whatever the view distance. Trees: mesh LOD0 < 60 m,
LOD1 < 200 m, impostor billboards (rendered at load from the LOD0 meshes) to
1 km. Meshes are procedural (no model files yet); every instance keeps its
generator stable id.

## Caches

Atlas and built tile meshes live in WP04's `lodestone` IndexedDB under
`cache:`-prefixed stores (so `clearCaches()` never touches saves). Mesh keys
add the atlas hash and a mesh-format version to the spec's
(genVersion, chunk, lod): two worlds share a genVersion. The mesh cache is
read and written inside the workers; LRU cap 500 MB (spec 12).

## Textures

3dtextures.me CC0 sets, downloaded by a script that reads each post's Google
Drive folder. KTX2 arrays are built with the `ktx2-encoder` npm package
(Basis Universal in wasm) by driving its encoder in 2D-array mode; no native
tools. Only Marble White 006 and Stylized Stone Column 001 were in
refs/3d-portfolio-website (ruins stone); all terrain sets are new downloads.
