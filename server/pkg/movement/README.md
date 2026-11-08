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
world-edge clamp to [0, WORLD_SIZE_M), a horizontal speed sanity bound
(`MaxLegitHorizontalSpeed`, 25.6 m/s) that snaps violators back, and a
60 frames/s budget per session.

## Cross-language check

`testdata/vectors.json` holds scripted trajectories (frames in, every state
out). A TS port should replay them and match within 1e-9 (V8 and Go may differ
in the last ulp of sin/cos). Regenerate with
`go test ./movement -run TestTrajectoryVectors -update`.

## Ground

`Ground` is `HeightAt(x, z) float64` (feet height). `Flat{Y}` until WP07
plugs in the wasm terrain behind the same interface.
