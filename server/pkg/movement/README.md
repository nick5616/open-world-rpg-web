# server/pkg/movement

The authoritative player movement step (WP03). The zone runs it for every
input frame; the Go bots run it for prediction; the browser client runs a
TypeScript port for prediction and reconciliation (WP02/WP06). Ported from
wizard-wars `shared/movement.js` and `ClientPrediction.ts predict()`.

## The contract (port exactly)

Per `InputFrame`, `dt = 1/60` (MOVE_STEP_HZ), `state = {pos (FEET), vel, airJumps}`:

1. `yaw = U16ToYaw(frame.yaw)` (the quantized value, same on both sides).
2. Wish direction from flags with `c = cos(yaw), s = sin(yaw)`:
   forward `wz -= c, wx -= s`; back `wz += c, wx += s`; left `wz += s, wx -= c`;
   right `wz -= s, wx += c`; normalize (zero stays zero).
3. `speed = BASE_MOVE_SPEED * (sprint ? SPRINT_MULTIPLIER : 1)`.
4. `grounded = pos.y <= ground(pos.x, pos.z) + 1e-4`.
5. Grounded: friction (`GROUND_FRICTION`, `STOP_SPEED`) then ground accel
   (`GROUND_ACCEL`). Airborne: air accel (`AIR_ACCEL`, `AIR_CAP_SPEED`).
6. `vy += GRAVITY * dt` if not grounded.
7. `jump && grounded` -> `vy = JUMP_FORCE, airJumps = 0`; else
   `!grounded && jump_edge && airJumps < MAX_AIR_JUMPS` -> `vy = JUMP_FORCE, airJumps++`.
8. Integrate `pos += vel * dt`.
9. Snap: `groundY = ground(x, z)`; if `y <= groundY || (vy <= 0 && y - groundY <= GROUND_SNAP_M)`
   then `y = groundY, vy = 0, airJumps = 0`.

With the wizard-wars constants the steady ground speed is
`GROUND_ACCEL * wish / GROUND_FRICTION`: 4.89 m/s walking, 7.82 m/s
sprinting. That is the tuned feel, not a bug.

Zone-only extras (not in the step, so the client gets corrections for them):
world-edge clamp to [0, WORLD_SIZE_M), per-mode speed and vertical bounds
(`MaxHorizontalSpeed`, zone `verticalOK`) that snap violators back, and a
60 frames/s budget per session.

## WP10: climb, glide, swim, slopes, stamina

The full step (`StepEnv(state, flags, yaw, ground, env)`) adds spec 8's
traversal; the algorithm is written out once, in
`client/src/sim/README.md` ("WP10"). Files:

| File | What |
| --- | --- |
| `movement.go` | `State` (+ mode, stamina in fine units, timer, lunge, flags), `stepWalk` / `stepClimb` / `stepGlide` / `stepSwim`, `SlopeAt`, `FindShore`, `Activity`, `MaxHorizontalSpeed` |
| `wire.go` | `SelfFields` / `FromSelf`: State <-> SelfState (protocol v2: flags + lunge, `moveExt` = stamina + timer) |
| `updraft.go` | `Columns` (debug UpdraftField) and `ParseColumns` (`x,z,r,top,lift;...`) |

`Ground` stays `HeightAt`; water is the optional `Water` interface
(`WaterAt`, implemented by `worldhost.Terrain` with the wasm
`water_height`); grounds without it have no water. `Env` carries rain (the
`server/pkg/weather` stub) and the `UpdraftField` hook WP15 will feed.
Construct states with `NewState(pos)` (full wheel): a zero `State` has no
stamina and cannot sprint.

Bitwise: all WP10 arithmetic is + - * / sqrt and comparisons on the same
inputs as TS, products are wrapped in `float64()` so Go never fuses an FMA,
and `dt` is a run-time variable because Go folds constant expressions
exactly (V8 multiplies the rounded 1/60). Slope thresholds are the literal
constants `WALKABLE_TAN_SQ` / `CLIMB_MAX_TAN_SQ`, not a tan() per language.

## Cross-language check

`terrain_golden_test.go` replays WP10's eight terrain goldens from
`client/src/sim/golden/movement_wp10_*.json` on the official world through
worldhost, both on the wasm and on the zone's cached-chunk fast path, and
requires every position/velocity within 1e-9 m and every discrete field
equal (measured: <= 2e-15 m). `traversal_test.go` pins each rule on
synthetic ground. Both need the built wasm for the terrain part
(`LODESTONE_REQUIRE_WASM=1` makes a missing wasm fail).


`testdata/vectors.json` holds scripted trajectories (frames in, every state
out). A TS port should replay them and match within 1e-9 (V8 and Go may differ
in the last ulp of sin/cos). Regenerate with
`go test ./movement -run TestTrajectoryVectors -update`.

## Ground

`Ground` is `HeightAt(x, z) float64` (feet height). `Flat{Y}` until WP07
plugs in the wasm terrain behind the same interface.
