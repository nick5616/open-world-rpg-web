# client/src/world/caves

Caves, gems and mining in the browser (WP09, spec 7). Generation, the
buffer layouts and the collision rules are in `worldgen/README.md`
"Caves"; the zone side is in `server/zone/README.md` "Caves and mining".

| File | What |
| --- | --- |
| `caveStore.ts` | `CaveCellStore`: every cave cell the client has, shared by collision and rendering, plus the active world edits (mined veins). Cells come from the workers; a cell the ground needs first is built synchronously on the main thread (1-4 ms) because prediction must use the exact triangles the zone uses. Edits rebuild the touched cells at once. |
| `caveGround.ts` | `CaveGround`: WP05's `WorldGround` plus `floorAt` / `collide` from `CaveGroundCore` (`@lodestone/worldgen`): heightfield on the open surface, cave triangles in mouth holes and underground. `WorldRuntime.ground` is this when the wasm has caves. |
| `holes.ts` | Mouth holes in lod 0-1 terrain tiles (worker side): the tile's own index without the masked triangles and skirts. |
| `caveManager.ts` | Streaming (cells within 96 m while underground or within 200 m of a mouth, only cells inside some system's bounds), meshes straight from the buffers, instanced gem crystals / ore nuggets / glowing fungi, the point-light pool, rock arches, the underground factor WorldScene dims sky light by, mining (aim + E / click), pickups, HUD and toasts. |
| `caveVisuals.ts` | Materials and geometry: flat-shaded cave rock with volumetric noise, strata, damp floors and colder deep bands; gem crystals (wizard-wars `crystalMaterial`/`rupeeGeometry` look); ore nuggets; emissive mushrooms; boulders. |
| `caveAudio.ts` | Minimal WebAudio: dry + reverb bus with a synthesized impulse response sized by the current chamber's radius; synthesized pickaxe, crumble, chime and drips. |
| `caveDebug.ts` | `window.__lodestoneCaves` (systems, route, chambers, veins, info, swing) for headless scripts. |
| `autopilot.ts` | Route from in front of a mouth to the deepest chamber along the nav graph, and a dumb walker (steer at the next waypoint, hop when stuck). |
| `cavePath.test.ts`, `golden/cave_path.json` | Golden cave trajectory (TS generates it, Go replays it: `server/pkg/caves/path_test.go`) and walkability of every system of the default world. |
| `dev/caveWalk.mjs` | Headless evidence: real client, real GPU, real key events, mouth -> deepest chamber, screenshots. |

## Light underground

No sun or sky light below ground: `WorldScene` scales the sun, the sky
hemisphere (to 10%), fog and god rays by `caveManager.underground` (0 on
the surface, eased to 1 a few meters down), and raises exposure. Light
comes from emissive gems and fungi (bloom), a wisp lantern floating ahead
of the player, and a fixed pool of `min(8, maxLights)` point lights that
borrow the colors of the nearest glowing veins and fungi. The pool never
changes size (three.js bakes the light count into every program; wizard-wars
`LightPool`'s rule), so walking into a cave never recompiles shaders.

## Online vs solo

- Online: mining sends `Interact{targetKind 1, vein id, action 1}`; the zone
  decides damage, drops, the edit and the respawn. `ZoneSession.onWorldEdits`
  applies edits to the store (carve + mined flag; a delta with `expiresAt`
  in the past removes it), `onEvent` drives the HUD (hit points, break,
  grant). Pickups are snapshot entities of kind `pickup` (only the owner
  receives them); they fly to you when the zone grants them.
- Solo (`npm run dev:solo`): the same rules locally (25 per swing, carve
  1.5 m, a pickup that flies to you), no respawn.

## Run and test

```
npm run dev:solo        # walk to a cave mouth (debug panel teleports) or use window.__lodestoneCaves
npx vitest run src/world/caves                                     # cave path golden + walkability
LODESTONE_UPDATE_CAVE_GOLDEN=1 npx vitest run src/world/caves/cavePath.test.ts   # regenerate the golden path
node client/src/world/caves/dev/caveWalk.mjs                       # headless walk + screenshots -> docs/evidence/wp09-*
```

## Interface with movement (WP10)

`GroundQuery` (client/src/sim/ground.ts) gained two optional methods and
the step calls them; Go mirrors it with `movement.CaveGround`:

- `floorAt(x, y, z)`: feet height of the highest walkable surface at or
  below `y + MAX_STEP_UP_M` (the step searches from `max(old y, new y)`).
- `collide(x, y, z, out)`: wall push-out (horizontal) and ceiling (down);
  the step slides velocity along the push and stops a rising jump at a
  ceiling.

Grounds without caves omit both and step exactly as before. Climb, glide
and swim (WP10) should treat cave triangles like terrain: `collide` is the
wall query, `floorAt` the ground query; slope rules can read the triangle
normal from the same cells (not exposed yet; ask in this README's history).
