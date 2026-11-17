# client/src/ui/build

Playtest 3 base building in the browser (CR 041, `docs/cr/041-base-building.md`). A building piece is a camp piece
(`ui/camps`): same store, same events (1100-1103), same collision set; this folder adds the rules mirror, the
hammer, the menu and the instanced drawing. Names, costs and geometry come from `contracts/build.yaml` (generated `CAMPS`).

| File | What |
| --- | --- |
| `geometry.ts` | sparse piece lookup (`pieceDef`, ids 1-5, 100+, 200+), quarter turns, integer-cm sockets, `boxesOf` / `surfaceOf` (the TS half of `server/pkg/camps/build.go`) |
| `rules.ts` | `checkBuild`, `stability`, `orphans`: the zone's placement and support rules, bit for bit (`rules.test.ts` replays `server/pkg/camps/testdata/build.json`) |
| `snap.ts` | aim ray to grid cell or edge, rotation, candidate heights from sockets and ground, `aimPiece` for deconstruct / repair |
| `ghost.ts` | the live ghost (`updateBuildGhost`): snapped spot, refusal, cost lines, what you are missing |
| `defs.ts` | the catalogue by base and material, categories, cost / refund / repair formulas |
| `models.ts` | procedural pieces: beveled planks, stone blocks with mortar, sunsteel strapping, shingles, steps, furnishings; one merged vertex-coloured geometry per kind |
| `renderer.ts` | `BuildRenderer`: one `InstancedMesh` per (kind, door state), unlit glow mesh, flame cards, a fixed pool of 2 point lights; `ghostMesh` |
| `BuildLayer.tsx` | in-world: the renderer fed from the camp store, the ghost |
| `BuildHud.tsx` | the hammer: keys, bar, build menu, comfort / budget / home / share readout, `window.__lodestoneBuild` (debug builds) |
| `dev/buildLab.ts`, `dev/build-shots.ts` | `build-dev.html`: a house built through the real rules and drawn by the real renderer; `cd client && npx vite-node src/ui/build/dev/build-shots.ts` writes `docs/evidence/pt3-base-building-*.png` |

Controls: **8** the build menu (in build mode: leave it); in build mode **R** or the wheel turns, **Tab** changes the material
(**Shift+Tab** the category), **Q / E** or **1-9** pick a piece, **left mouse** places (green only), **hold X** deconstructs
the piece you aim at, **F** repairs it, **right mouse** or **Esc** leaves. **E** still uses doors, beds, chests and stations.
(G is the glider, B the character build screen: every letter is taken, so the hammer is slot 8.)

Performance: `BuildLayer` rebuilds instances only when the pieces change or you walk 24 m; per frame it moves the ghost and
two point lights (a fixed pool, never added or removed at runtime) and sways the glow by 2.5 % (6 % without Reduce flashing).
