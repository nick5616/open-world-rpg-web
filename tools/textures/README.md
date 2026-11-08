# tools/textures

Texture pipeline (spec 12, WP05): CC0 PBR sets from [3dtextures.me](https://3dtextures.me)
→ runtime textures in `client/public/`.

| File | What |
| --- | --- |
| `sets.json` | Every set: runtime id, source folder in `texture-sources/`, 3dtextures.me page, brightness gain, use. `terrain.layers` is the texture-array layer order (must equal `TERRAIN_LAYERS` in `client/src/world/terrain/terrainMaterial.ts`; a client test checks it). |
| `fetch-sets.mjs` | Downloads missing sets: reads each post's Google Drive folder link, lists the folder, fetches each map (skips preview renders). Requests are spaced out: the site rate-limits bursts. `--search <words>` lists matching posts. |
| `build-textures.mjs` | Port of 3d-portfolio-website `scripts/build-textures.mjs`. Per set: `client/public/textures/<id>/{color,normal,orm}.webp` (sRGB albedo, OpenGL normals, R AO / G roughness / B metalness). Terrain: `client/public/textures/terrain/{color,normal,orm}-<hash>.ktx2` 2D arrays (512 px, full mips; color RGBA = albedo + height for height blending) + `manifest.json` (layers, files, bytes, mean colours). Copies three's Basis transcoder to `client/public/basis/`. |

```
npm run fetch -w @lodestone/textures      # only needed for new sets (sources are committed)
npm run build -w @lodestone/textures      # ~80 s (the UASTC normal array is the slow part)
npm run build -w @lodestone/textures -- --webp   # per-set WebP only
```

KTX2: encoded in Node with the `ktx2-encoder` npm package (Basis Universal
compiled to wasm; no native `basisu`/`toktx` needed). It has no 2D-array API,
so the script drives its `BasisEncoder` directly (`setTexType(2DArray)`, one
slice per layer). Color and ORM are ETC1S, normals UASTC + RDO + Zstandard.
Sizes (9 layers): color 900 KB, normal 2.36 MB, ORM 378 KB.

Outputs are committed (they are what ships), sources are committed under
`texture-sources/` (never shipped). Credits: `CREDITS.md` at the repo root.
