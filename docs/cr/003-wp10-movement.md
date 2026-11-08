# CR 003: Movement extensions (WP10)

Author: WP10 · Date: 2026-11-08 · Status: applied on `wp/10-movement`

All changes are additive: no existing field, value or meaning changed.

## What

### `contracts/constants.yaml` (version 1 → 2)

New `movement` constants (tuning of the shared step; algorithm in
`client/src/sim/README.md`, "WP10"):

| Constant | Value | Use |
| --- | --- | --- |
| `WALKABLE_TAN_SQ`, `CLIMB_MAX_TAN_SQ` | tan(50°)², tan(89°)² as literals | slope thresholds without a per-language `tan()` (V8 and Go may differ by an ulp) |
| `SLOPE_PROBE_M` | 0.5 | slope = central differences over 1 m |
| `STEP_PROBE_M` | 0.8 | step-up probe distance |
| `CLIMB_FACING_MIN` | 0.5 | "holding into the wall" cone (60°) |
| `CLIMB_JUMP_SPEED`, `CLIMB_JUMP_TIME_S` | 8, 0.25 | climb-jump lunge (2 m) |
| `CLIMB_KICK_SPEED` | 5 | jump + back off a wall |
| `CLIMB_SLIP_PERIOD_S`, `CLIMB_SLIP_TIME_S`, `CLIMB_SLIP_SPEED` | 3, 0.5, 3 | rain slips |
| `MANTLE_SPEED` | 3 | push onto the top |
| `SLIDE_MAX_SPEED` | 12 | slide cap (keeps slides under the zone's speed bound) |
| `GLIDE_ACCEL`, `GLIDE_VERTICAL_ACCEL` | 6, 20 | glide steering / canopy catch |
| `UPDRAFT_MAX_LIFT` | 10 | clamp on the updraft hook (validation relies on it) |
| `SWIM_ACCEL`, `SWIM_DEPTH_M`, `SWIM_FLOAT_DEPTH_M` | 6, 1.5, 1.4 | swimming |
| `DROWN_TIME_S`, `SHORE_SEARCH_M` | 1.5, 256 | drowning respawn |
| `STAMINA_FINE_PER_POINT` | 60 | stamina is integer fine units in the step |

New `gameplay` constants for the weather stub (until WP15): `WEATHER_STUB_WINDOW_S` 600, `WEATHER_STUB_RAIN_PCT` 25.

### `contracts/protocol.yaml` (version 1 → 2)

- `SelfState` gains `moveExt: u32` (appended, masked field bit 14): stamina in
  fine units (bits 0-15) and the mode timer (bits 16-23). The existing
  `stamina: u16` (x10) stays for display; it cannot carry 1/60 point steps.
- `SelfState.flags` (u8, "WP10 defines") is defined: bit 0 exhausted,
  bit 1 drowned, bit 2 sliding, bits 4-7 climb-jump lunge steps.
- `InputFlag.glide_toggle` (already in v1) is defined: set by the client on
  exactly one step per press of the glider key (G).
- `SelfState.mode` now carries climb/glide/swim (values already in v1).
- Activity bits `climbing`, `gliding`, `swimming`, `airborne` are now set by
  the zone (values already in v1).

`PROTOCOL_VERSION` becomes 2: the zone kicks v1 clients with
`version_mismatch`, so old and new builds never talk.

### `contracts/events.md`

Kind 100 `drowned` (range 100-199 is WP10's).

### Worldgen (no output change)

New wasm export `water_height(atlas, x, z)` (and TS `waterHeight`,
`chunkWaterHeight`; Go `World.WaterHeight`, `Terrain.WaterAt`). Golden hashes
and `npm run test:golden` unchanged; the wasm file hash changes, so
`worldhost` now requires the export (rebuild with `npm run build:wasm`).

## Why

Spec 8 movement: climb, glide, swim, stamina, rain. Client prediction must
replay from SelfState bit-exactly, so everything the step carries (mode,
exact stamina, timers, flags) must be on the wire. One u32 instead of two
fields leaves one mask bit free in SelfState's u16 mask.

## Consumers affected (all fixed in this change)

| Consumer | Change |
| --- | --- |
| `client/src/sim` (WP10) | the step, wire mapping, goldens |
| `client/src/net` (WP06) | `prediction.ts` compares/replays the whole state with stored env; `snapshotDecoder.ts` ZERO_SELF has `moveExt`; `NetPlay.tsx` env + debug ground; `avatar.ts` poses |
| `server/pkg/snapshot` (WP03/WP06) | `DiffSelf`/`ApplySelf` handle `moveExt` |
| `server/zone` (WP03/WP06/WP07) | SelfState via `movement.SelfFields`, env per tick, per-mode validation, Event 100 |
| `tools/bots` (WP03/WP07) | predict with `NewState` and the weather env; resync with `FromSelf` |
| `worldgen` (WP01), `server/pkg/worldhost` (WP07) | `water_height` export and wrappers (additive) |
| Generated code | `npm run gen` (TS, Go, Rust constants; protocol TS/Go; golden vectors) |
