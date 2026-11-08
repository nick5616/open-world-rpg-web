# client/src/world/structures

Things that stand on the terrain and that movement walks, snaps to and
climbs (WP12): the **structure overlay** on the ground query, the towers
built from the atlas, and their visuals (towers, waypoint stones). The Go
twin is `server/pkg/structures`; the zone and the client must agree to the
bit, and a golden file proves they do.

| File | What |
| --- | --- |
| `overlay.ts` | `Structure` interface, `StructureOverlay` (grid index), `RadialStructure` (solid of revolution with a piecewise-linear profile), `StructureGround` (the `GroundQuery` = terrain + structures) |
| `towers.ts` | Tower constants and `newTower` / `towersFromAtlas` (twin of `tower.go`) |
| `StructuresLayer.tsx` | Towers (one merged mesh of the exact collision profile, procedural dressed stone, merlons, a lodestone crystal amber/cyan by unlock state, light pillar over unlocked towers) and instanced waypoint stones with a rune that lights when activated. Mounted by `WorldCanvas`; also hands the atlas to the map (`ui/map/world.ts`) |
| `overlay.test.ts` | Replays `server/pkg/structures/testdata/golden.json`: same towers, heights, structure index and normals as Go at ~4,400 points, bit for bit (synthetic plane + the real seed-20261108 world over wasm terrain) |

## The overlay

```
height(x, z) = max(terrain(x, z), max over structures covering (x, z) of structure.top(x, z))
```

A structure is a solid from its top surface down to the ground. Its walls
are just steep parts of the height function, so the movement code needs no
change: today the ground snap carries a walker up any slope (WP07 gap);
WP10's climbing works on any surface between 50 and 89 degrees, and tower
walls are 80 degrees (`TOWER_WALL_SLOPE` = tan 80 deg as a literal).
`WorldRuntime.ground` is a `StructureGround`; prediction, interpolation and
the zone all use the same combined ground. `normalAt` / `slopeAt` report the
structure's normal where a structure forms the ground (climbing reads them).

### Towers

Per atlas tower site: a 4 m flat top, a 13 m upper wall, a 1.4 m rest ledge,
then the lower wall down to 3 m below the lowest ground near the tower. The
top is 28 m above the highest ground under the platform and ledge. All of it
derives from the plain terrain at fixed sample points, so both hosts compute
the same tower. The zone validates "standing on the top" from the same
geometry (`server/zone/internal/explore`).

## Adding a structure kind (WP20)

1. Write the height function twice, in `server/pkg/structures` (Go) and
   here (TS), implementing `Structure`:
   - `bounds()` -> `[minX, minZ, maxX, maxZ]`: the top is never defined outside.
   - `top(x, z)` -> surface height, NaN outside the footprint (Go: `ok=false`).
   - `normal(x, z)` -> unit normal where `top` is defined.
2. Use only `+ - * /`, `Math.sqrt` and comparisons, in the same order on both
   sides. No `Math.sin/cos/tan/atan2/hypot/pow` at query time (host math
   differs in the last ulp); precompute angles as literals. In Go wrap every
   product that feeds a sum in `float64(...)` (prevents FMA fusion on arm64),
   and never build a value from a Go constant expression that TS computes at
   runtime (Go folds constants exactly; see `TowerProfile`).
3. Derive every parameter from the atlas (site position, seed, yaw) and the
   plain terrain at fixed points, identically on both sides.
4. Add the structures to the overlay in the same order on both hosts (order
   only matters for structure indices; heights are a max).
5. Extend the golden test (`go test ./structures -run Golden -update` in
   `server/pkg`) with points around the new shape and replay it here.

Limits: a heightfield has no overhangs, interiors, tunnels or parapets you
stand behind (tower merlons are decorative and can be walked through).
Buildings with interiors need real collision volumes (capsule sweeps, spec 8)
or caves' mesh collision (WP09); keep the overlay for solid exteriors,
platforms, walls, pillars and ramps.

## Test

```
npx vitest run --root client src/world/structures      # golden replay (needs npm run build:wasm for the world case)
cd server/pkg && go test ./structures                  # the Go side of the same file
```
