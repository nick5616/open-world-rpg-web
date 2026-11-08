# client/src/world/buildings

WP20's towns layer in the browser (spec 5 "Towns, roads and structures",
spec 12 budgets): building meshes assembled from the kit in a worker,
roads draped on the terrain, bridges, signposts, jigsaw structures,
townsfolk, and the "[E] Talk to ..." interaction HUD. Collision is not
here: the boxes come from worldgen's towns buffer (`worldgen/README.md`
"Towns") and the movement ground is `townGround.ts` (lead's file).

## How it works

- **One worker** (`buildings.worker.ts`) compiles worldgen.wasm, loads the
  atlas, rebuilds the towns buffer (`towns_build`, ~0.2 s, a pure function
  of the atlas), paints the texture array and builds the whole road
  network once, then assembles settlement and structure meshes on demand.
  Results are transferred typed arrays; the main thread only wraps them in
  `BufferGeometry` (one new mesh per frame).
- **Geometry = collision.** Every collision box is drawn where it is: floor
  slabs (planks on top, foundation or stilt skirt down to `baseY`), walls
  (style face outside, inner finish inside, wall ends that sit on the
  building outline left out so corners don't z-fight), the door lintel, the
  ceiling / flat roof block, both sloped roof halves (surface exactly on
  the walkable top, plus overhangs, trim, gable triangles and a ridge cap),
  door ramps, porches, fences, town walls and gate towers, bridge decks,
  ramps and railings, structure pieces. What has no collision is decoration
  only: windows (count from wall length, lit at night), shutters, sills,
  corner posts, jetty bands, chimneys, porch awnings on posts, vigas,
  merlons, gate lintels (above head height), stilts, bridge piles/piers.
  `kit.test.ts` checks wall faces, floors and roof halves of every style
  against their boxes.
- **Props** (`props.ts`): all 31 kinds as small low-poly shapes, sized from
  their furniture / town-prop box when they have one, so the table you bump
  is the table you see.
- **One material** (`townMaterial.ts`): `MeshStandardMaterial` patched to
  sample a 33-layer texture array (`textures.ts`, painted procedurally:
  plaster, timber framing, dressed stone, adobe, logs, planks, thatch, clay
  tiles, shingles, slate, cobble, dirt road, flagstones, windows, door,
  fire, books, rug, notices...) with the layer and a glow byte per vertex.
  Glow 1-127 = window light scaled by night; 128-255 = always-on fire /
  lantern glass / crystals; the texture alpha masks which texels emit.
- **Draw calls**: a settlement is one shell mesh (all buildings, town wall,
  gates, stalls, fields, outdoor props) + one interior mesh (furniture,
  shown within 80 m); a structure is one mesh; roads are one decal mesh
  (polygon offset, no shadows) + one furniture mesh (bridges, signposts,
  road lanterns) per 1 km cell. Townsfolk are 9 InstancedMeshes in total.
- **Streaming** (`townsManager.ts`): settlements within 1.5 km (dropped at
  1.8 km), structures within 1 km (dropped at 1.2 km), nearest first, two
  builds in flight.
- **Lights**: a fixed pool of PointLights (6 on high, 4 on medium, none on
  low; never added or removed, so no material recompiles) takes the nearest
  emitters at night with a flicker.
- **Scatter**: the worker finds scatter (trees, rocks, tufts) inside
  building plots, plazas, fields, structures and on roads (`clearance.ts`)
  and the scene hides it by stable id (WP05 `ScatterManager.hide`).
- **NPCs** (`npcs.ts`): online, remote entities of kind npc from
  `drawnRemotes.views` (role/variant from the snapshot `typeId`, merchant
  kind from `level`, walk cycle from speed); offline, every NPC at its work
  spot from the towns buffer. Name and role labels within 15 m.
- **Interaction** (`interact.ts`, `townHud.ts`, `townEvents.ts`): target =
  within 4 m of the eye and within ~35 degrees of the view ray (signposts:
  6 m, read-only). E sends Interact 30 (npc talk), 31 (board read), 32
  (forge/anvil use), 33 (mineshaft descend); Events 800-807 fill a DOM
  panel (NPC line, shop with Buy, bounties with Accept, Rest at the inn,
  station placeholder) and toasts (accepted, rested, purchase, refusals
  806). The panel frees the pointer lock; Esc or E closes it. Offline the
  same prompts open a local "(offline)" panel.

## Files

| File | What |
| --- | --- |
| `TownsLayer.tsx` | R3F mount (next to WP12's `StructuresLayer` in `WorldCanvas.tsx`); owns the manager's lifetime, calls `update` per frame. |
| `townsManager.ts` | Worker, streaming, uploads, light pool, scatter hiding, interaction target, debug box wireframes. |
| `buildings.worker.ts`, `protocol.ts` | The buildings worker and its messages. |
| `meshBuilder.ts` | Pure TS mesh builder (flat-shaded polygons, sloped boxes, prisms; outward-hinted winding). |
| `kit.ts` | Building shells, town walls, gates; `buildSettlementMesh`. |
| `props.ts` | The 31 prop shapes, flames, farm fields. |
| `structures.ts` | Structure meshes from pieces + boxes (tents, columns, spikes, meteorite, palisades, towers, shaft head frame). |
| `roads.ts` | Draped road/street ribbons, plazas, paving, bridges, signposts, road lanterns, per 1 km cell. |
| `clearance.ts` | Where scatter must not stand. |
| `textures.ts` | The procedural texture array. |
| `townMaterial.ts` | The patched material and `geometryOf`. |
| `npcs.ts` | Townsfolk renderer and labels. |
| `interact.ts`, `townHud.ts`, `townEvents.ts` | Target selection, the HUD/panel, Event payload decoders. |
| `townsDebug.ts` | `window.__lodestoneTowns`. |
| `dev/townBench.mjs` | Headless measurement + screenshots. |
| `townGround.ts`, `towns.worker.ts`, `dev/walkIntoBuilding.ts`, `dev/walk-acceptance.ts`, `walkIntoBuilding.integration.test.ts` | Lead's (movement ground, towns buffer worker, walk-in acceptance). |

## Run, measure, test

```
npm run dev:solo        # walk to any settlement; F-keys as usual
```

`window.__lodestoneTowns` (debug builds): `settlements()`, `largestTown()`,
`structures()`, `buildings(i)`, `npcs(i)`, `props(i, kind)`, `streets(i)`,
`bridges()`, `signs()`, `teleportTo(i, { kind, dx, dz, y })`, `stats()`
(manager stats + whole-frame renderer.info + towns triangles), `idle()`,
`target()`, `interact()`, `panel()`, `showBoxes(true)` (collision box
wireframes within 150 m), `setVisible(false)`, `meshes()`.

```
node client/src/world/buildings/dev/townBench.mjs          # production build + vite preview, random 127.0.0.1 port
node client/src/world/buildings/dev/townBench.mjs --dev    # vite dev server
node client/src/world/buildings/dev/townBench.mjs --dev --only overview,street   # some views, nothing written
npx vitest run --root client src/world/buildings
```

The bench (headless Chromium, real GPU through ANGLE/D3D11, high tier,
1600x900, uncapped) writes `docs/evidence/wp20-drawcalls.json` / `.txt`
and `wp20-*.png`.

## Numbers (official seed 20261108, largest town Draedmore: walled town, 40 buildings, 22 NPCs, RTX 3070)

See `docs/evidence/wp20-drawcalls.txt` for the latest run. Typical: the
whole town in view from above at an angle costs about 90 draw calls more
than the same view with the layer hidden (about 250 total, budget 400),
street level about 100 more (about 315 total); a settlement shell is ~22k
triangles, its interior ~13k; the largest town builds in ~25 ms in the
worker; the main thread's largest step is wrapping one mesh (a few ms).

## Known gaps

- Hip roofs (stone style) render as gables, to stay on the two roof boxes.
- WP05 grass blades (not scatter records, no stable ids) still grow
  through streets, plazas and floors near the ground; hiding them needs a
  road/plot mask in the grass generator.
- Porch posts, chimneys, gate lintels, merlons and stall posts have no
  collision (decoration; the server agrees, nothing to predict).
- No far LOD: settlements beyond 1.5 km are not drawn (fog covers most of
  it); a cheap impostor per town would be the next step.
- Signpost arms carry no lettering; the HUD reads the destinations when
  you look at the post.
- NPC yaw is taken as worldgen's convention (radians from +x toward +z),
  which is what the zone sets for NPCs.
- Offline NPCs stand still at their work spots (schedules run in the zone).
- The station panel is a placeholder until WP14 (smelting, forging).
