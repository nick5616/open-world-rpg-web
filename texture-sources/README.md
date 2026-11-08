# texture-sources

Raw CC0 SD texture sets from [3dtextures.me](https://3dtextures.me), one
folder per set (`<Set>_SD/`), exactly as downloaded minus preview renders.
Outside `client/public/` on purpose: they never ship. `tools/textures/build-textures.mjs`
turns them into the runtime WebP sets and KTX2 terrain arrays; `tools/textures/fetch-sets.mjs`
re-downloads any missing set listed in `tools/textures/sets.json`.

`Marble_White_006_SD` and `Stylized_Stone_Column_001_SD` were copied from
`refs/3d-portfolio-website/texture-sources/` (same CC0 source). Every set is
listed in `CREDITS.md` at the repo root.
