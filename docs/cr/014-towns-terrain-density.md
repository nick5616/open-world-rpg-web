# CR 014: worldgen genVersion 2: towns on natural terrain, footpaths, density (playtest 1)

Author: playtest-1 towns/density agent · Date: 2026-11-09 · Status: applied on `pt/towns-density`

Nicole's playtest: "terrain in non-castle-towns shouldnt be flat. it should
be more disheveled and houses built on foundations and paths to get
everywhere. also the game feels a little too spread out and spacious, even
in the towns". Decisions: `docs/decisions/0022-towns-terrain-density.md`.

This **changes generator output**, so it is a new generator major version
(spec 5 rule 4): `GEN_VERSION` 1 -> **2**. `ABI_VERSION` stays 1 and no
buffer layout changes (the towns buffer `LDTW` stays format 1; it gains
enum values only). `protocol.yaml`, `constants.yaml`, events and
migrations are unchanged.

## What

### Generator (worldgen, genVersion 2)

1. **Natural ground in hamlets and villages.** The atlas node parameters no
   longer damp the detail noise inside non-walled settlement footprints
   (genVersion 1: amplitude x0.25, no mesas, no ridges); mesa steps are
   softened to x0.3 and ridges to x0.5 so lots stay buildable. Walled towns
   keep their levelled courts. Chunk heights change only within reach of
   hamlets and villages (golden review: `docs/evidence/pt-towns-golden-review.txt`,
   0 changed chunks elsewhere).
2. **Foundations.** Each building measures the 1 m lattice under its lot:
   a stone plinth, a **stepped plinth** (building flag 64) from 0.9 m of
   relief, **timber posts and cribbing** (flag 128) from 2.2 m; stilt
   houses (wetland) may stand in up to 1.8 m of water. The floor sits on
   the highest lattice point (+0.25 m, posts +0.35 m, stilts +1.4 m), the
   foundation box reaches below the lowest. A door more than 1.3 m above
   the ground in front gets a porch deck; the door ramp becomes **steps**
   (~33 degrees) above a 0.55 m rise. Collision boxes keep their WP20
   meaning; the porch deck is now `walk | solid` (a wall from beside it, a
   floor from the door and the steps), the steps stay a walkable ramp.
3. **Footpaths** (`worldgen/src/town/paths.rs`): every door (the foot of
   its steps), ward-garden gate and stall that does not open onto a street
   or the square gets a path to them: multi-source Dijkstra on a 1 m grid
   (obstacles: the settlement's solid boxes grown by a body radius, deep
   water; costs: slope, walls, fields, shallow water), traced back and
   joined into earlier paths. Stored as ROADS records **class 2**,
   `from` = the building served, `to` = the path joined (none = it ends on
   the street/square), drawn on the terrain like streets (no levelling, no
   chunk change, no collision).
4. **Tighter layouts:** layout radius 0.8 / 0.7 / 0.85 of the atlas
   footprint (hamlet / village / town), squares 7 / 9 / 12 m (was 9 / 13 /
   18), streets 3.0 / 3.4 / 4.6 m (was 4 / 4 / 5), lots 0.5 m off the
   street (was 0.8), 1.2 m alleys (was 1.6), back lanes 7.5 m behind (was
   10), ring street at most 18 m out (was 28); lots keep room in front for
   their porch and steps. Trees and rocks now grow up to the layout radius.
5. **Denser world** (atlas step 6, appended after the coverage pass, so
   every genVersion 1 site keeps its index, id and place): 6 + 10 x
   `settlementDensity` extra hamlets (>= 270 m from other settlements, <= 6
   per region, each with its waypoint), then minor points of interest
   farthest-first until every candidate is within 120 m of a site edge:
   landmarks, small ruins, shrines, ruined watchtowers, enemy camps (never
   within 750 m of the spawn: the Haven stays calm), at most 80 sites per
   region.
6. **Landmarks and enemy camps are built** (towns buffer STRUCTURES kinds
   **9 landmark** and **10 enemy camp**; PIECES kinds **15-22**: stones,
   tree, arch, monolith, bones, crystals, statue, spring). genVersion 1
   only listed them on the map.

### Hosts

- `worldgen/archive/`: the genVersion 1 build (`worldgen-42a66cc191bee49d.wasm`)
  + `manifest.json`; `worldgen/golden/golden-v1.json` its table. `npm run
  test:golden` checks it in Node and Go/wazero.
- `server/pkg/worldhost`: `LoadForGenVersion` (archive loader); the zone
  and bots load the generator of the world row's `gen_version`.
- `server/pkg/worldhost/mintdb.RenewOfficial`, `mintworld -official -renew`,
  and the account service renewing a dev official world automatically
  (never in production): world renewal in place.
- Client: `client/src/world/core/wasmFor.ts` (the world's generator by
  Welcome `genVersion`; archived builds are hashed assets), the buildings
  worker takes the wasm URL in its init message.

## Interface notes for `pt/ux` (doors, CR 013)

Door ids and boxes are derived exactly as before: the door prop (kind 0,
stable id `(0x21, site, 0, n)`) and the lintel box (the one wall box whose
bottom is > 1 m above the floor) of every building with floors that is not
open-fronted. genVersion 2 moves doors with their buildings (floors are
higher on slopes) and adds doors (more hamlets); `server/pkg/towns/testdata/doors.json`
was regenerated (`go test ./towns -run DoorVectors -update`), and the door
walk-through passes on sloped lots (`docs/evidence/pt-towns-sloped-walk.txt`).
A door on a slope is reached up a porch and steps: scripts that start a
fixed distance in front of a door must start beyond the foot of the steps
(the ROADS footpath of a building starts there).

## Consumers affected

- worldgen: `atlas/{mod.rs,sites.rs}`, `chunk.rs` (settlement scatter
  radius), `town/{layout,kit,jigsaw,geom,paths(new)}.rs`, `lib.rs`
  (`GEN_VERSION`), examples `poi_density.rs` (new), `town_stats.rs`, tests
  `towns.rs`, golden tables + `golden/review.ts` (new), `scripts/test-golden.mjs`,
  harness `go/golden_test.go`, `js/test/wasm.ts`, `js/src/town.ts`
  (`TOWN_STRUCTURE_KINDS`, piece kinds, `ROAD_CLASS`, building flags).
- server: `pkg/towns` (constants, door vectors), `pkg/worldhost` (archive,
  tests), `pkg/worldhost/mintdb` (renewal), `pkg/cmd/mintworld` (`-renew`),
  `account/main.go` (dev renewal), `zone/terrain.go`, `zone/internal/npc`
  (NPCs walk the footpaths to back-lane doors), `tools/bots/terrain.go`.
- client: `world/core/{runtime.ts,wasmFor.ts}`, `world/WorldCanvas.tsx`,
  `net/NetPlay.tsx` (1 prop), `world/buildings/{kit.ts,roads.ts,structures.ts,
  buildings.worker.ts,protocol.ts,townsManager.ts (1 line),townsDebug.ts}`,
  dev scripts, WP10 goldens (genVersion field only).

## Compatibility

A world row on genVersion 1 keeps working: zone, bots and client load the
archived genVersion 1 build for it (same bytes as before, golden-checked).
A world renewed onto genVersion 2 needs zone, client and bots from this
build. Mixed deployments (a pre-CR-014 zone with a genVersion 2 row) refuse
to start with the usual pin error (decision 0007).
