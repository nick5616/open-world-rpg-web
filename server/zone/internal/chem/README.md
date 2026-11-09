# server/zone/internal/chem

The chemistry engine (WP15, spec 8 "Systems"): a 2 m grid of material
states, fire that spreads cell to cell along the seeded wind and makes
updrafts, ice sheets, earth pillars, rain. Decision:
docs/decisions/0015-night-chemistry.md; wire: contracts/events.md 520-526.

- `material.go`: what a cell is made of (`TerrainMaterial`: water from the
  wasm heights, nothing in settlements, a seeded mix by biome).
- `sim.go`: the deterministic simulation (`Sim`: ops, timers, melt, rain,
  spread; `LiftAt` is the movement step's `UpdraftField`; `Hash` is the
  state digest clients compare).
- `overlay.go`: ice sheets and pillars on the movement ground (`Overlay`
  publishes an immutable snapshot; `Ground`/`Level` wrap a ground with it).
- `codec.go`: Event payloads (ops, chunk baselines, 2-bit bitmaps).

The TS twin is `client/src/systems/chem/` (line for line). Both replay
`testdata/sim_vectors.json`.

Test (from `server/zone`): `go test ./internal/chem`. After changing a rule,
regenerate the vectors with `go test ./internal/chem -run SimVectors -update`
and run `npm test -w client`.
