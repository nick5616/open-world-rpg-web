# server/pkg/structures

The structure overlay on the ground query (WP12): towers today, WP20's
buildings tomorrow, as extra height functions combined with the terrain by
`max`, so movement walks, snaps to and climbs them like terrain. The model,
the determinism rules and the "add a structure kind" recipe are in
`client/src/world/structures/README.md` (the TS twin); this package must
stay bit-identical to it.

| File | What |
| --- | --- |
| `overlay.go` | `Structure` interface, `Overlay` (64 m grid index, read-only after build), `Ground` (a `movement.Ground`: base + overlay; `WaterAt` passes the base's water through for WP10 swimming), `StructureAt`, `NormalAt` |
| `radial.go` | `Radial`: solid of revolution with a piecewise-linear profile (towers) |
| `tower.go` | Tower constants and `NewTower` (samples the plain terrain at fixed points) |
| `sites.go` | Go reader of the atlas SITES / REGIONS / NAMES sections (`ParseAtlas`), `Towers(atlas, terrain)` |
| `testdata/golden.json` | Heights, structure indices and normals at ~4,400 points (plane + real world); replayed by `client/src/world/structures/overlay.test.ts` |

## Use

```go
a, _ := structures.ParseAtlas(world.Atlas)
overlay, towerSites := structures.Towers(a, terrain) // plain terrain!
ground := structures.Wrap(terrain, overlay)          // a movement.Ground
```

The zone wraps its `worldhost.Terrain` this way (`server/zone/explore.go`,
embedding the Terrain so its optional `Want`/`SpawnPoint` still work), and
the bots do the same for their prediction (`tools/bots/terrain.go`).

Cost: ~30 ns per `HeightAt` near a tower on top of the terrain query (one
grid lookup, a sqrt per covering structure).

## Test

```
cd server/pkg
go test ./structures                         # unit + golden (real-world case needs worldgen.wasm)
go test ./structures -run Golden -update     # after an intentional geometry change; then rerun the TS test
```

If the generator's output changes (a new genVersion from WP09/WP20), the
real-world golden case changes with it: regenerate with `-update` and rerun
`npx vitest run --root client src/world/structures`.
