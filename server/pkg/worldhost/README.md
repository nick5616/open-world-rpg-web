# server/pkg/worldhost

The Go host of `worldgen.wasm` (WP07, spec 4/5): the zone server and the bots
run the very same module the browser runs, through
[wazero](https://wazero.io), so server and client agree on the ground to the
bit. ABI and buffer layouts: `worldgen/README.md`.

| Piece | File | What |
| --- | --- | --- |
| `Module` | `module.go` | Compiled wasm (compile once per process, ~0.3-1 s). Refuses modules with any import (host math would break determinism) or another `abi_version`. `SpecFromSeed`, `BuildAtlas`, `Hash`, `GenVersion`, `SHA256`. Loaded from `LODESTONE_WORLDGEN_WASM` (default `worldgen/pkg/worldgen.wasm`, searched upward from the working directory); `LODESTONE_WORLDGEN_WASM_SHA256` optionally pins the content hash (full or prefix). |
| `World` | `world.go` | One world's atlas copied into a lazily grown pool of instances (instances are single-threaded, ABI rule 4; a trapped one is replaced). `CollisionHeight`, `WaterHeight` (WP10), `GroundNormal`, `Raycast`, `ChunkBytes`, `SpecJSON`, `Header` (spawn, sea level). |
| `Terrain` | `terrain.go`, `chunk.go` | Chunk cache by interest + `movement.Ground`. `HeightAt` answers from cached LOD 0 chunk heights in pure Go (~25 ns); on a miss it calls `collision_height` directly (~3-5 us, same bits) and queues the chunk; it never waits for a generation. Workers (own instances, so queries never queue behind a 3-6 ms `chunk_build`) fill the cache; `Want(x, z, margin)` asks for chunks ahead of players; LRU beyond `Capacity` (default 3072 chunks), never evicting chunks wanted in the current epoch. `Chunk` exposes heights, water and the scatter/container/spawn records. `WaterAt` (WP10, `movement.Water`) answers the water surface the same way from the cached water lattice, falling back to wasm `water_height`. |
| Pin + mint | `mint.go` | `Mint(seed, spec)` returns the row values; `OpenRow(row)` enforces the pin: placeholder rows open from `spec_from_seed(seed)`, otherwise `gen_version` must equal the wasm's (`ErrGenVersion`) and the rebuilt atlas must hash to `atlas_hash` (`ErrAtlasHash`). |
| Spawns | `spawn.go` | `SpawnPoint(characterID)`: a dry cell within 8 m of the atlas spawn settlement (stable per character), y on the ground. `DryPoint(x, z)`. |
| `SamplePoints` | `points.go` | Deterministic test points incl. lattice points, cell diagonals, chunk borders, out-of-world. |
| `mintdb/` | | Writes minted worlds into `worlds` rows (account service startup, `cmd/mintworld`). Kept separate so bots/zone terrain code don't link pgx. |
| `jscheck/` | | Node (`heights.mjs` via vite-node) and headless Chromium (`browser.mjs`, Web Worker) hosts for `cmd/heightcmp`. |

## Bitwise agreement

The playable surface is the triangle mesh over the f32 height lattice
(`worldgen/README.md`, "Collision"). `chunk.go` evaluates that formula on
cached chunk heights in the same f64 operation order as `ground.rs`, with
explicit `float64()` conversions that forbid fused multiply-add (Go may fuse
on arm64/ppc64/s390x/riscv64 and amd64 v3; core wasm never does). Proof:

- `TestFastPathBitwise`: 20,011 points, fast path == wasm bit for bit (heights and, since WP10, water).
- `TestGoldenCollision`: WP01's 320 golden collision heights (5 worlds), both paths.
- `go run ./server/pkg/cmd/heightcmp -n 10000`: Go compiler, Go interpreter,
  Go fast path, Node wasm, Node `chunkSurfaceHeight`, Chromium Web Worker wasm
  and `chunkSurfaceHeight`, all equal at 10,000 points
  (`docs/evidence/wp07-heights.txt`).

## Use

```go
mod, _ := worldhost.LoadFromEnv(ctx)                 // compile once
mt, _, err := mod.OpenRow(worldhost.WorldRow{Seed: s, Spec: spec, GenVersion: gv, AtlasHash: ah}, worldhost.WorldOptions{})
t := worldhost.NewTerrain(mt.World, worldhost.TerrainOptions{})
defer t.Close()
t.Want(x, z, 48)                                     // per player, a couple of times a second
y := t.HeightAt(x, z)                                // movement.Ground
```

## Test

```
npm run build:wasm
cd server/pkg && go test ./worldhost/... ./cmd/heightcmp      # skip without the wasm unless LODESTONE_REQUIRE_WASM=1
go test -run XXX -bench . ./worldhost                           # per-query and per-tick (150 players) cost
```

`mintdb` tests need the shared Postgres (`npm run infra:up`); they make their
own scratch databases. Numbers: `docs/evidence/wp07-bench.txt`.
