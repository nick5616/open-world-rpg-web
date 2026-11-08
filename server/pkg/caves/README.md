# server/pkg/caves

Pure-Go readers for worldgen's cave buffers and the cave queries the zone
needs (WP09): `ParseCell`, `ParseGraph`, `FloorAt`, `Collide`, `Raycast`, `Masked` /
`TriMasked` (mouth masks), `Graph.SystemAt` (cave-system id: AOI clipping
and WP11's voice "same cave system" rule), `Graph.Vein` (vein registry),
`EncodeEdits` / `Edit.Touches`, and `Ground`, the cave-aware
`movement.LevelGround` + `movement.Collider` over a surface ground (terrain + structures).

A line-for-line port of `worldgen/js/src/cave.ts` (client prediction runs
that): same f64 operation order, f32 buffer values widened exactly, and
products wrapped in `float64()` so arm64/ppc64 never fuse them into FMAs.
Algorithm: `worldgen/README.md` "Cave collision and ground dispatch".

Building cells needs the wasm: `server/pkg/worldhost` (`caves.go`) wraps
the exports and keeps the cave cell cache (`Caves`) and `CaveTerrain`, the
zone's ground (Terrain + caves).

## Test

```
npm run build:wasm
cd server/pkg && go test ./caves     # golden cave vectors (bit-exact vs TS) + the golden cave walk (TS frames replayed in Go)
```

- `TestGoldenCaveQueries`: 585 floor heights, 540 collide results, 405
  ray distances and 150 system ids from `worldgen/golden/golden.json`, bit for bit.
- `TestGoldenCavePath`: the TS walker's 4,146 frames from in front of a
  mouth to the deepest chamber (181 m down) replayed through WP10's Go step
  on the Go cave ground: max |Go - TS| 8.9e-16 m over 139 sampled states (118
  bit-exact; the rest differ in the last ulp of Go vs V8 `sin`/`cos`, the
  known WP02/WP03 caveat).
