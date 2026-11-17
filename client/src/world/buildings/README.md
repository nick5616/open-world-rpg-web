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

## Doors (playtest follow-up)

Every building with floors and a closed front (forges have an open front)
has a door that opens and closes with E (`[E] Open door` / `[E] Close
door`), for everyone nearby, with collision that stays bit-identical between
prediction and the zone.

- **Boxes** (`worldgen/js/src/doors.ts` `TownDoors`, Go twin
  `server/pkg/towns/doors.go`): a door's box is the building's lintel box
  (the doorway, door width x wall thickness) lowered to the floor, every
  value copied from the towns buffer (no arithmetic, so TS and Go hold the
  same f32 numbers). Closed doors push the body out after the town
  collision (same per-box arithmetic, two passes, ascending door index);
  open doors are not there. The WP20 town collision and its golden vectors
  never see door boxes, and doors start **open** (a WP20 doorway), so
  nothing changed for anything that never closes a door.
- **States stamped by step** (`DoorStates`): the zone never changes a door
  "now". It sends each nearby player Event 970 with the input seq the
  change applies from (beyond everything that client will have predicted
  when it arrives: its newest frame + the round trip + 12 steps) and
  simulates that player's frames with the old state before it and the new
  one from it on. `doorGround.ts` (on `WorldRuntime.ground`, between the
  town ground and WP15's chemistry overlay) asks `DoorStates.openAt(d,
  stepClock.seq)`; `LocalSim` and the reconciliation replay set
  `sim/stepClock.ts` per step. A change that arrives after we already
  predicted its step (a very long round trip) re-predicts from it
  (`ClientPrediction.replayFrom`, counted in `localReplays`, not as a
  correction). Baselines (971) bring newcomers up to date.
- **Wire** (`doors.ts` `DoorSync`): Events 970-972 into the states,
  refusals (972) as toasts, E -> Interact 34 (open 1 / close 2); offline
  (solo) the door toggles locally from the next step.
- **Leaves** (`doorsMesh.ts`): one `InstancedMesh` (one draw call plus its
  shadow passes) for every leaf within 110 m; a leaf hangs on the inner
  face of the wall and swings into the room over ~0.45 s, starting at the
  step the collision changes; doorways wider than 1.6 m get two leaves.
  The static leaves are no longer in the settlement shell.
- **NPCs** open a closed door they need, wait for it, walk through and
  close it behind them; through an open door they just walk
  (`server/zone/internal/game/doors.go`).
- Tests: `doors.test.ts` (door boxes and push-out replay
  `server/pkg/towns/testdata/doors.json` bit for bit, states, door ground,
  DoorSync), `doorWalk.integration.test.ts` (Node client vs the zone binary:
  close, walk into it, open, walk in, close behind you, push into it, open,
  walk out: 0 corrections). Evidence: `npx vite-node
  src/world/buildings/dev/door-acceptance.ts` ->
  `docs/evidence/pt-ux-door-walkthrough.txt` (also through the netsim proxy
  at ~190 ms RTT); screenshots `npx vite-node
  src/world/buildings/dev/door-shots.ts` -> `docs/evidence/pt-ux-door-closed.png`,
  `pt-ux-door-open.png`.
- Debug: `__lodestoneTowns.doors(si)`, `toggleDoor(d)`, `doorStats()`.

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
| `npcs.ts` | Townsfolk renderer and labels; since CR 050 also their behaviour (work poses, looking at you, greetings, chats, reactions, bubbles). |
| `npcLife.ts`, `npcLines.ts`, `npcGear.ts`, `npcBubbles.ts`, `smithLink.ts` | CR 050: the pure half (looks, greeting limiter, chat pairs, bubble choice, work poses, dress; vitest), the lines townsfolk say, the one-draw gear meshes, the speech bubbles, the smith/audio hand-off. |
| `townAnimals.ts`, `animalsPlan.ts` | CR 050: chickens, dogs and cats about the towns (planned from the settlement id, four draws). |
| `interact.ts`, `townHud.ts`, `townEvents.ts` | Target selection, the HUD/panel, Event payload decoders. |
| `doors.ts`, `doorGround.ts`, `doorsMesh.ts` | Doors: Events 970-972 and Interact 34 (`DoorSync`), the door overlay on the movement ground, the instanced swinging leaves. |
| `dev/doorWalk.ts`, `dev/door-acceptance.ts`, `dev/door-shots.ts`, `doorWalk.integration.test.ts` | Door walk-through prediction check vs the zone binary, its evidence run, screenshots. |
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
- Doors: open leaves have no collision (as before); a closed door is
  pushed out of after the town collision rather than inside its passes; a
  client that stops sending input (a hidden tab) holds a change "pending"
  for up to 3 s (others get "still swinging" meanwhile); door state lives
  in the zone's memory (a restart reopens every door; WP16 zones each keep
  their own) and `tools/bots` predict without doors (a bot walking into a
  door someone closed gets corrected).

## Towns on natural terrain (playtest 1, genVersion 2)

`docs/cr/014-towns-terrain-density.md`, decision 0022. The worldgen
records changed meaning, not layout, so everything above holds:

- **Foundations** (`kit.ts`): the floor slab's foundation is drawn by the
  building flags: stone plinth with a cap course; `stepped` (64): a footing
  that steps down with the ground in ~1.5 m runs (`drawPlinthTrim`, reads
  `heightAt`); `posts` (128): beam band, recessed board skirt over the
  collision outline, posts every ~2 m from below the ground, braces where
  tall (`drawPosts`). The porch deck (a floor box in front of the door wall)
  is solid since genVersion 2 and drawn on posts with a board skirt. Door
  ramps rising more than 0.55 m are drawn as steps (`drawSteps`: treads
  whose nosings sit on the walkable slope, stringers).
- **Footpaths** (`roads.ts`): ROADS class 2, trodden-earth ribbons at
  `LIFT.path` (between roads and streets); scatter on them is hidden like on
  streets (`clearance.ts` covers every road record).
- **Landmarks and enemy camps** (`structures.ts`): towns-buffer structure
  kinds 9 / 10 (`TOWN_STRUCTURE_KINDS`); landmark pieces 15-22 draw standing
  stones, an elder tree (canopy decoration over a solid trunk), an arch,
  a rune monolith, giant ribs, glowing crystal spires, a colossus, a hot
  spring; camps reuse the bandit-camp pieces in log masonry.
- **Archived generators**: the runtime compiles the wasm of the world's
  genVersion (`core/wasmFor.ts`, Welcome `genVersion` online) and hands its
  URL to this worker (`init.wasmUrl`).
- Evidence: `docs/evidence/pt-towns-*` (before/after shots from
  `dev/townsTerrainShots.mjs`, sloped-lot walk/door agreement from
  `dev/sloped-acceptance.ts`).

## Chimney smoke (playtest 2 immersion pass)

`kit.ts drawChimney` reports each stack's top into the settlement mesh
(`SettlementMesh.smoke`, 3 floats per chimney, transferred with the mesh);
`chimneySmoke.ts` draws a plume over the 40 nearest within 260 m: one
instanced quad draw, 16 puffs per chimney animated on the GPU (rise, widen,
drift downwind with the shared wind, fade), busiest at breakfast and
supper (`hearthActivity`), thinner in rain, dim and faint at night. The CPU
only re-picks the chimneys 4x a second.

## Towns art (playtest 3, CR 046)

Render-side only (no genVersion change, no collision change). `detail.ts`
holds the **detail level** (0 low, 1 medium, 2 high / ultra), taken from the
quality tier when the layer starts and sent to the worker in `init`; `kit.ts`,
`props.ts` and `dress.ts` read it (`detail()`), and the texture array is 512 px
at level 2.

- `kit.ts`: windows with real frames, shutters (open or closed), flower boxes,
  curtains; stone footing courses; half-timbered timber-style walls and gables;
  per-building lime wash and roof tint; ridge caps; stepped chimneys; door
  surrounds, wall lanterns (night-only glow) and the inn's hanging sign.
- `dress.ts`: `Yard` (what clutter must stay clear of: collision boxes, roads,
  the square), `dressBuilding` (barrels, crates, sacks, wood piles, hay, carts,
  wash lines, ladders, pots, benches, coal), `drawInterior` (skirting,
  wainscot, ceiling beams, hanging herbs, the inn's candle wheel). Yard items
  are decoration without collision, placed against side and back walls.
- Tests: `art.test.ts`. Bench: `dev/townBench.mjs --tier low|medium|high`,
  views `street,dusk,interior` etc.; evidence `docs/evidence/pt3-towns-*`.
