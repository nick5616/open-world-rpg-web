# CR 040: World edits (playtest 3)

Branch `pt3/world-edits`. Playtest feedback: "Make it like the world is breakable like Minecraft, and building your own base is a lot more desirable." The base building branch (CR 041) owns placing pieces; this one owns **breaking and reshaping the generated world**, and the materials building uses.

## Summary

- **Chop, break, clear.** Trees fall to an axe, rocks shatter to a pickaxe, bushes give way to anything (bare hands slowly). Each swing does damage against hit points that scale with the object's size; at zero the object is gone for everyone, its drops land as the breaker's personal pickups (walk over them), and it grows back after a long time (trees 3-6 h, rocks 8-16 h, bushes 1-2 h, seeded) or never inside a player's base. A tree tips over on the mesh and material it was drawn with, thuds, shakes leaves and dust loose and sinks away; a rock bursts into chunks; every hit throws chips.
- **Dig and fill.** The shovel lowers or raises the 1 m lattice in quarter-metre steps, a brush of 1.6 m (half a metre in the middle), swinging 4 times a second while the button is held. The surface stays walkable (neighbouring edits differ by at most 3 steps per metre along an axis and 4 along a diagonal, so no cell triangle is steeper than 47 degrees and the walls of a pit stay walkable (WALKABLE_SLOPE_DEG is 50): a pit is a bowl, a mound a cone), within +-6 m of the generated ground, never below the water line plus 0.3 m (holes stay dry), never in towns, along roads, on sites and structures, over cave roofs and mouths, or at the world's edge. A dig pays dirt (stone from deep ground), a fill costs it. Dug and filled ground turns to bare soil.
- **New items.** `wood:log`, `wood:stick`, `wood:resin`, `stone:stone`, `stone:flint`, `earth:dirt`, `plant:fiber`, `plant:berries` (new categories `stone`, `earth`, `plant`, all materials), and the tools `tool:axe` and `tool:shovel` (the pickaxe was already implicit). Every new character starts with all three tools; an older one gets the axe and shovel once (marker `starter:worktools`, like the pickaxe). `kit_axe`, `kit_shovel`, `kit_pickaxe` recipes (camp station: anywhere) make replacements from logs, stone and fibre.
- **Controls.** Key 8 cycles the work tool (chop and break, dig, fill, away); with one up the left mouse button swings it and the weapon stays sheathed; the Esc menu's Controls list it. A ring on the ground shows the strike (the brush, or the object), a hit bar shows the object's health, and the HUD shows the depth edited and your dirt and stone.
- **Persistence and streaming.** Everything is stored per zone and sent to clients with their chunks: removed objects are `world_edits` rows (kind `object_destroyed`, the table mined veins use) and `WorldEdits` records; terrain deltas are `terrain_edits` rows (migration 0031, one per 64 m chunk) and the new `TerrainEdits` message (id 73, **protocol v7**).

## The overlay (the part that must be bit-exact)

Generated heights never change (the golden tests stay green). An edit is a signed `i8` delta in 0.25 m steps per lattice vertex, held in one 64 x 64 block per chunk (a block owns the vertices x, z = 0..63 of its square; the +1 edge belongs to the next chunk). Every host adds it to the f32 lattice value before the collision interpolation:

```
h' = f32(f64(h) + f64(d) * 0.25)         (0.25 is a power of two: the f64 sum is exact)
surface = the collision formula of worldgen/README.md "Collision" on the four lifted corners
```

- Go: `worldhost.Terrain.HeightAt` (cached chunk path and the wasm miss path) asks `worldedit.Overlay` for the cell's four corner deltas and, when any is non-zero, interpolates the lifted corners (`server/pkg/worldedit`, `worldhost/terrain.go editedHeight`). Everything wrapping the terrain (caves, towns, structures, chemistry, the vertical layers) sees the edited surface. A query costs one atomic load when nothing is edited and four block lookups when something is.
- TS: `WorldGround.heightAt` does the same (`client/src/world/edits/overlay.ts`), so prediction, remote avatars, enemies and the camera agree with the zone.
- **Golden**: `contracts/golden/world_edits.json` holds 700 edits straddling two chunk borders and 580 sample points with the f64 bits of the zone's `HeightAt`; `server/pkg/worldhost/edits_test.go` writes it (`LODESTONE_UPDATE_GOLDEN=1`) from the real world through both the cached and the cold wasm path, and `client/src/world/edits/overlay.test.ts` replays it bit for bit in TS. `world_edits_plan.json` does the same for the dig planner (`dig.go` and `planner.ts`: a scripted sequence of swings on a fake world, the volumes of each and every edited vertex after).
- Storage is bounded: 640 chunks of edits per zone (`MaxBlocks`, refused with reason 7), 3 bytes per edited vertex on the wire and in the database (`u16 local index, i8 delta`), at most 30,000 cleared objects.

## Wire

| | |
| --- | --- |
| Interact 42 `harvest` | `targetId` = scatter id, action 1 = swing |
| Interact 43 `earth` | `targetId` = `x cm \| z cm << 32` of the strike, action 1 dig, 2 fill |
| Events 1800-1807 | hit, others' hit, felled, refusals, earth fx, earth refusals, dirt grant (contracts/events.md) |
| WorldEdits (68) | `object_destroyed` (EditKind 4, already in the contract): `targetId` = scatter id, `params` = x, y, z f32, `expiresAt` = when it grows back (0 never); a later record with `expiresAt` in the past is the regrowth |
| TerrainEdits (73, s2c, chunk) | `cx, cz, data` = n x (u16 LE local vertex index z*64 + x, i8 delta); on first interest every non-zero vertex of the chunk, then live deltas with the NEW value of the vertices a swing changed (0 clears one) |

Interest: chunks within 6 of a player (13 x 13) for both, scanned twice a second like the cave edits (`editInterest`); late joiners get the active edits on first interest.

## Server (`server/zone/internal/game/worldedit.go`, `server/zone/worldedit.go`)

- **Harvest**: the zone looks the record up in its chunk cache by id (`worldedit.ScatterID` inverts the id to the chunk), checks reach to the object's axis, the tool in the pack, the swing gap (170 ms, under the client's 250 ms so tick quantisation never refuses an honest swing), keeps per-object hit points in memory (a half-chopped tree heals after 2 minutes), and on the last hit removes the object (map, per-chunk list, regrow queue sorted by time, `world_edits` row through the write-behind queue), tells everyone, and rolls the breaker's drops (a seeded, logged roll; `veinDrop` pickups, so walking over them collects).
- **Earthworks**: `worldedit.PlanSwing` plans the swing (brush, slope cascade, water floor, protected ground; refused as a whole if anything it touches is protected), the overlay applies it copy-on-write per block, clients get the changed vertices, the touched chunks' whole blocks go to the write-behind queue (coalesced by chunk key: a burst writes once). Dirt grants and fill costs are batched per player (at 6 or after 1.5 s) so digging is not four inventory writes a second.
- **Protected ground** (`server/zone/worldedit.go buildProtectMask`): a 4 m bit grid built at start from the atlas sites (layer 0), settlements (radius or wall plus 12 m) and their roads and streets (width/2 + 5 m), structures, cave chambers and tunnels whose ceiling is within 24 m of the surface, cave openings, and the vertical world's tunnel and cenote openings. A cave roof is never dug through.
- **The zone tick stays flat**: edits are event-driven; per tick the cost is one comparison against the earliest regrow time, an empty map of pending grants, and (twice a second) the interest scan.
- **Hooks for CR 041**: `WorldEditSetup.InBase(x, z)` (ground inside a player's base: what is cleared there never grows back). Terrain in a base stays editable (levelling the ground is the point).

## Client (`client/src/world/edits/`)

- `overlay.ts` (the overlay and codec), `tileEdits.ts` (edits in a tile build: the worker lifts the lattice, the outside-height lookup and turns edited ground to bare soil with the splat weights still summing to 255), `planner.ts` and `harvestDefs.ts` (solo authority and targeting), `worldEdits.ts` (the manager: targeting, ring, hit bar, debris pool, felling, solo rules, session hooks), `toolState.ts`.
- **Terrain meshing**: `TerrainManager.setEdits` builds every new tile with the edits in its box (plus two samples of margin for edge normals), and rebuilds only the loaded tiles whose box overlaps a change, in place (geometry and water swapped, material, morph and edge state kept), a job at top priority that bypasses the IndexedDB mesh cache; tiles that hold edits are never cached. Neighbours that share the edge row are rebuilt too (the closed-interval overlap), at any LOD.
- **Removal mask**: `ScatterManager.hide(id)` (existing) and `unhide(id)` (new) are the whole interface; `forEachObject` and `propOf` are read-only helpers for targeting and the fall. Nothing else in `client/src/world/scatter` changed (pt3/vegetation rewrites the models).
- **Audio**: six cues (`work_chop`, `work_tree_fall`, `work_tree_thud`, `work_rock_break`, `work_dig`, `work_fill`) reuse the mining and step files pitched down (`rate`); real recordings are a follow-up.
- No light is added or removed, the debris, ring and felled-tree meshes use materials the warm-up has seen (the debris pool and ring sit in the scene from the start; a felled tree reuses its own instanced material).

## Not done / follow-ups

See `docs/STATUS.md`, "Playtest 3: world edits".

## Tests

`go test ./pkg/worldedit ./pkg/worldhost` (server/pkg), `go test ./internal/game -run 'Harvest|Earthwork|Tools|Starter'` (server/zone); `npx vitest run src/world/edits src/input src/audio src/ui/menu` (client). Screenshots: `client/src/world/edits/dev/edits-shots.ts` (`docs/evidence/pt3-world-edits-*.png`).
