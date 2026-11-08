# client/src/sim: movement contract

Pure TypeScript, no React or three.js. This is the movement step that client
prediction runs and that the Go zone server (WP03) mirrors. If the two ever
disagree, the player sees reconciliation snaps, so this document is the spec
both sides are checked against, and `golden/` holds trajectories both must
reproduce.

| File | What |
| --- | --- |
| `movement.ts` | `stepMovement(state, input, ground, dt)`: one fixed step. Source-style helpers. |
| `ground.ts` | `GroundQuery` interface, `FlatGround` (the WP02 world), `PlaneGround` (goldens only). |
| `inputFrame.ts` | Held keys to InputFrame flags, jump-edge latch, yaw/pitch quantization. |
| `fixedStep.ts` | Render-frame to fixed-step accumulator with a capped backlog. |
| `localSim.ts` | Per-frame driver: latch edges, run steps, interpolate the render pose. |
| `fly.ts` | Debug noclip step. Client only, NOT part of the contract. |
| `golden/` | Scripted inputs, scenarios, generator and the committed golden JSON. |

Ported from wizard-wars `shared/movement.js` (helpers, verbatim) and
`client/src/networking/ClientPrediction.ts` `predict()` (step order). Proof the
port is exact: `docs/evidence/wp02-movement-side-by-side.md` (max position
divergence 8.9e-16 m over 690 steps at the same dt).

## Units and conventions

- Meters, seconds, radians. y is up.
- `pos` is the **feet**. Standing means `pos.y == ground.heightAt(pos.x, pos.z)`.
  The eye is `PLAYER_HEIGHT` (1.8 m) above it. (wizard-wars stored the eye; the
  math is the same, but rounding in the last bit differs.)
- Yaw 0 faces **-Z**; positive yaw turns left (counterclockwise seen from above).
  Forward is `(-sin yaw, -cos yaw)`, right is `(cos yaw, -sin yaw)`.
  This is three.js' camera convention (Euler order YXZ).
- `dt = 1 / MOVE_STEP_HZ` = 1/60 s, always. One InputFrame is one step
  (decision 0001). The server applies every new frame in seq order, usually two
  per 30 Hz tick.

## Input

The step consumes the movement part of a protocol `InputFrame` in its **wire
units**: `flags` (u16 `InputFlag` bits), `yaw` (u16), `pitch` (i16).

```
yawRad = u16ToYaw(yaw) = yaw / 65536 * 2*pi       // contracts quant helpers
```

The client quantizes with `yawToU16` before stepping, so prediction uses the
exact angle the server decodes. Pitch does not affect walking.

Flags used: `forward 1, back 2, left 4, right 8, jump 16, jump_edge 32, sprint 64`.
`jump` is the key being held; `jump_edge` is set on exactly one frame per key
press (the client latches a press until a step consumes it, so a tap shorter
than a step is never lost). A press produces both bits on its first frame.

## Constants (contracts/constants.yaml)

`BASE_MOVE_SPEED 8`, `SPRINT_MULTIPLIER 1.6`, `JUMP_FORCE 6`, `GRAVITY -18`,
`GROUND_ACCEL 5.5`, `AIR_ACCEL 12`, `GROUND_FRICTION 9`, `STOP_SPEED 2.5`,
`AIR_CAP_SPEED 1`, `MAX_AIR_JUMPS 1`, `GROUND_SNAP_M 0.3`, plus `GROUND_EPS =
1e-4` (local to the step, same value as wizard-wars).

## The step, exactly

All arithmetic is IEEE double. Order of operations matters for bit-exactness;
keep it.

```
step(state{pos, vel, airJumps}, input{flags, yaw, pitch}, ground, dt):
  yaw   = u16ToYaw(input.yaw)
  speed = BASE_MOVE_SPEED * (flags & sprint ? SPRINT_MULTIPLIER : 1)

  // wish direction
  c = cos(yaw); s = sin(yaw); wx = 0; wz = 0
  if forward: wz -= c; wx -= s
  if back:    wz += c; wx += s
  if left:    wz += s; wx -= c
  if right:   wz -= s; wx += c
  len = sqrt(wx*wx + wz*wz)
  wish = len == 0 ? (0, 0) : (wx/len, wz/len)

  grounded = pos.y <= ground.heightAt(pos.x, pos.z) + 1e-4

  h = (vel.x, vel.z)
  if grounded:
    friction(h, GROUND_FRICTION, STOP_SPEED, dt)
    groundAccel(h, wish, speed, GROUND_ACCEL, dt)
  else:
    airAccel(h, wish, speed, AIR_ACCEL, AIR_CAP_SPEED, dt)

  vy = vel.y
  if !grounded: vy += GRAVITY * dt

  aj = airJumps
  if (flags & jump) && grounded:                                vy = JUMP_FORCE; aj = 0
  else if !grounded && (flags & jump_edge) && aj < MAX_AIR_JUMPS: vy = JUMP_FORCE; aj = aj + 1

  x = pos.x + h.x * dt
  y = pos.y + vy  * dt
  z = pos.z + h.z * dt

  gy = ground.heightAt(x, z)
  if y <= gy || (vy <= 0 && y - gy <= GROUND_SNAP_M):
    y = gy; vy = 0; aj = 0

  return {pos (x, y, z), vel (h.x, vy, h.z), airJumps aj}

friction(v, f, stop, dt):
  sp = sqrt(v.x*v.x + v.z*v.z)
  if sp < 0.01: v = (0, 0); return
  control = sp < stop ? stop : sp
  k = max(sp - control*f*dt, 0) / sp
  v.x *= k; v.z *= k

groundAccel(v, w, ws, a, dt):
  add = ws - (v.x*w.x + v.z*w.z)
  if add <= 0: return
  acc = min(a*dt*ws, add)
  v.x += acc*w.x; v.z += acc*w.z

airAccel(v, w, ws, a, cap, dt):        // Quake/Source PM_AirAccelerate
  add = min(ws, cap) - (v.x*w.x + v.z*w.z)
  if add <= 0: return
  acc = min(a*dt*ws, add)             // rate uses the UNCAPPED ws: strafe gain
  v.x += acc*w.x; v.z += acc*w.z
```

Consequences worth knowing:
- Held `jump` re-jumps on the first grounded step after every landing (auto-hop).
- The double jump needs a fresh press (`jump_edge`); holding space through the
  apex does not spend it. Landing (any snap) refreshes it.
- Effective top speed is `GROUND_ACCEL * wish / GROUND_FRICTION`: 4.89 m/s
  walking, 7.82 m/s sprinting. `BASE_MOVE_SPEED` is the wish speed. This is the
  tuned wizard-wars feel; do not "fix" it in one language only.
- No collision with walls yet: climb, glide, swim, stamina and capsule sweeps
  arrive with the wasm collision queries (spec 8). Dropped from wizard-wars:
  arena clamp, barriers, mobility spells, status-effect speed, gravity wells.

## Go port notes (WP03)

- Go may fuse `a*b + c` into an FMA on arm64/ppc64/s390x (the spec allows it),
  which changes the last bit. Force separate rounding with an explicit
  conversion: `x := pos.X + float64(h.X*dt)`. amd64 does not fuse.
- `math.Sin`/`math.Cos`/`math.Sqrt`: sqrt is exact (IEEE) everywhere; sin and
  cos may differ from V8 by an ulp for some inputs. Replay the goldens with a
  tolerance of 1e-9 m on position and velocity; on amd64 we expect exact or
  near-exact matches. If ulp drift ever matters, the u16 yaw makes a shared
  65536-entry sin table an easy fix.
- `heightAt` must be the same function on both sides (wasm collision queries,
  spec 8), or grounded tests disagree near slopes.

## Golden trajectories

`golden/movement_flat.json` (flat ground at y = 0, start 2048, 2048) and
`golden/movement_plane.json` (plane `h = 10 + 0.15 x - 0.08 z`, start 100, 100):
690 steps (11.5 s) of the script in `golden/script.ts`: idle, walk, sprint,
release, diagonal, ground jump + double jump + refused third jump, held-jump
air strafe while turning, backpedal, sprint diagonal, stop.

```
{
  "format": "lodestone-movement-golden", "version": 1,
  "scenario": "flat", "dt": 0.016666666666666666,
  "ground": {"kind": "flat", "height": 0}       // or {"kind":"plane","base","sx","sz"}: h = base + sx*x + sz*z
  "initial": [x, y, z, vx, vy, vz, airJumps],
  "frames":  [[seq, flags, yawU16, pitchI16], ...],
  "states":  [[x, y, z, vx, vy, vz, airJumps], ...]  // state AFTER frames[i]
}
```

Replay: start from `initial`, apply `frames[i]` with `dt`, compare with
`states[i]`. Numbers are JavaScript's shortest round-trip doubles, which Go's
`encoding/json` parses bit-exactly.

```
npm run golden -w client      # regenerate after an intended change (then update Go too)
npm run test -w client        # fails if stepMovement no longer reproduces the files bit-exactly
npm run compare:ww -w client  # re-run the wizard-wars side-by-side (needs refs/)
```
