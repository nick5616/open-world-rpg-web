# server/pkg/towns

Pure-Go reader for worldgen's towns buffer (WP20, `LDTW`: settlements,
buildings, collision boxes, props, NPCs, roads, bridges, signposts,
structures, starmetal veins; layout in `worldgen/README.md` "Towns, roads
and structures") and the building collision the zone's movement ground
needs:

- `Parse(b)`: the buffer as Go structs (`Towns`).
- `Collision`: box index (8 m grid), `FloorAt(x, y, z)` (highest walkable
  top within a step of the feet), `Collide(x, y, z)` (push the body out of
  solid boxes, ceilings lower a jump), `TopAt`.
- `Ground` / `Level`: a `movement.LevelGround` + `movement.Collider` over a
  base ground (terrain + towers + caves): at the player's level the height
  is max(base view, town floor) and collide runs the base's push-out
  (caves) then the town's. The zone wraps its cave terrain with it
  (`server/zone/towns.go`), bots predict on it (`tools/bots/terrain.go`).

A line-for-line port of `worldgen/js/src/town.ts` (client prediction runs
that): same f64 operation order over f32 values widened exactly, products
wrapped in `float64()` so arm64/ppc64 never fuse them into FMAs, no host
math beyond sqrt (boxes carry their cos/sin). Algorithm:
`worldgen/README.md` "Town collision".

- `Doors` (`doors.go`, playtest follow-up): every closable door (buildings
  with floors and a closed front) with its box copied from the buffer (the
  lintel box lowered to the bottom of the other walls: no arithmetic, the
  same f32 values as TS `TownDoors`), `After(r, view)` (push the body out of
  the closed doors after the town collision: same per-box arithmetic, two
  passes, ascending door index; no closed door near = r unchanged),
  `Touches` (a body in the doorway) and `WithDoors(level, doors, view)` (a
  level view with doors). The golden town collision is untouched; doors
  start open. The zone's per-player, per-frame door state is
  `server/zone/internal/game/doors.go`.

The buffer comes from the wasm: `worldhost.World.TownsBytes()`.

## Test

```
npm run build:wasm
cd server/pkg && go test ./towns     # golden town floor/collide vectors (bit-exact vs TS), counts, every region settled; door vectors
cd server/pkg && go test ./towns -run DoorVectors -update   # rewrite testdata/doors.json (then npm test -w client replays it)
```

`TestGoldenTownQueries`: 1,750 floor heights and 1,750 collide results
(5 worlds) from `worldgen/golden/golden.json`, bit for bit. `TestDoorVectors`:
the door boxes (count, FNV hash, every 9th box) and 1,092 door push-out
vectors (door pass alone and after the town collision) on two
`spec_from_seed` worlds, in `testdata/doors.json`, replayed bit for bit by
`client/src/world/buildings/doors.test.ts`. `TestDoorsBlockWhenClosed`:
every inn/house door blocks from both sides when closed, open doors change
nothing.
