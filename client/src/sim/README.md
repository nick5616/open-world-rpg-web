# client/src/sim: movement contract

Pure TypeScript, no React or three.js. This is the movement step that client
prediction runs and that the Go zone server (WP03) mirrors. If the two ever
disagree, the player sees reconciliation snaps, so this document is the spec
both sides are checked against, and `golden/` holds trajectories both must
reproduce.

| File | What |
| --- | --- |
| `movement.ts` | `stepMovement(state, input, ground, dt, env)`: one fixed step (walk/air, climb, glide, swim, stamina; WP10). Source-style helpers, `slopeAt`, `findShore`. |
| `ground.ts` | `GroundQuery` interface (`heightAt`, optional `waterAt`), `FlatGround` (the WP02 world), `PlaneGround` (goldens only). |
| `worldgenGround.ts` | `WorldgenGround`: `heightAt` = wasm `collision_height`, `waterAt` = wasm `water_height` (what the zone simulates on). |
| `moveWire.ts` | MoveState <-> SelfState (protocol v2: mode, flags, `moveExt`). |
| `weather.ts` | Rain stub `isRaining(seed, worldTime)` until WP15 (Go twin `server/pkg/weather`). |
| `updraft.ts` | `UpdraftColumns` (debug implementation of the updraft hook) and the `x,z,r,top,lift` parser. |
| `stepEnv.ts` | Where the client's StepEnv comes from (synced server time online, `?rain=`, `?updraft=`). |
| `dev/` | Node acceptance harness (`traversalRun.ts`, `traversal-acceptance.ts`), browser run (`traversal-browser.ts`), divergence probe (`window.__lodestone.probe()`). |
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

WP02's walk/air core below; since WP10 the walk step runs, in order:
grounded test -> slope under the feet (slide?) -> friction+accel / slide accel /
air accel -> gravity -> jump, double jump or glider opening -> integrate ->
wall rule or wall grab -> snap -> water entry -> sprint/regen stamina, and
`stepMovement` dispatches on the carried mode first and runs the shared
stamina/timer bookkeeping (`finish`) last (see the WP10 section).

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
- The step above is the walk/air core; WP10 (next section) adds slopes,
  climb, glide, swim and stamina around it. No capsule sweeps against walls
  or cave meshes yet (caves are WP09). Dropped from wizard-wars: arena clamp,
  barriers, mobility spells, status-effect speed, gravity wells.

## WP10: traversal (climb, glide, swim, slopes, stamina)

Everything below is in the same pure step, identical in Go
(`server/pkg/movement`). The world enters only through `ground.heightAt`
(wasm `collision_height`) and `ground.waterAt` (wasm `water_height`, the
same triangle mesh over the chunk water lattice), plus a `StepEnv`:
`raining` (weather stub at world time) and an `updraft` field (debug
columns until WP15). Only + - * / sqrt floor and comparisons are used beyond
the existing yaw sin/cos, and slope thresholds are literal constants, so the
TS and Go steps agree to the last bit on every terrain golden.

### State (all of it rides in SelfState)

`{pos, vel, airJumps, mode, stamina, staminaMax, timer, lunge, flags}`:
`mode` is MoveMode (ground/air are re-derived from position each step as
before; climb/glide/swim are carried); `stamina` is an integer in fine units
(STAMINA_FINE_PER_POINT = 60 per point, so 10/s is exactly 10 per step);
`timer` (0..255) counts steps in the current mode family: the regen delay on
the ground, the rain-slip phase on a wall, the drowning countdown in water,
reset whenever the family (walk = ground+air, climb, glide, swim) changes;
`lunge` is the climb-jump steps left; `flags`: 1 exhausted, 2 drowned,
4 sliding. Wire: SelfState.flags = flags | lunge << 4, SelfState.moveExt =
stamina | timer << 16 (`moveWire.ts`), so a replay starts from the exact
server state.

### Slopes (deferred from WP07)

`slopeAt(x, z)` = central differences of heightAt at +-SLOPE_PROBE_M (over
1 m): `gx, gz`, `t2 = gx^2 + gz^2 = tan(slope)^2`. Walkable: `t2 <=
WALKABLE_TAN_SQ` (50 deg); climbable: up to `CLIMB_MAX_TAN_SQ` (89 deg).
In a grounded step:
- **Sliding:** standing on `t2 > WALKABLE`: no friction, no control,
  horizontal accel `-GRAVITY * t / (1 + t2)` downhill (gravity along the
  surface), capped at SLIDE_MAX_SPEED; no ground jump.
- **Wall:** a move whose rise is steeper than walkable (`rise > 0 && rise^2 >
  WALKABLE_TAN_SQ * d^2`) onto steep ground is refused, unless it is a
  **step**: ground STEP_PROBE_M ahead walkable and at most MAX_STEP_UP_M above
  the feet. A refused move keeps only its along-contour part (and velocity
  loses its into-wall part); if that is a wall too, the player stays.
- Downhill onto steep ground is allowed (then you slide).

### Climb

Start (any of): a refused wall move, standing on a slide, or an airborne
step touching steep ground, while **holding forward into it**: forward held,
stamina usable (not exhausted, > 0), `WALKABLE < t2 <= CLIMB_MAX`, and
`wish . g >= CLIMB_FACING_MIN * |g|` (within 60 deg of uphill). The climber
stands on the surface at the wall point.

Each climb step, with `u = g/|g|` (uphill) and `r = (-u.z, u.x)`:
- Let go (run the walk step from rest) if stamina is unusable or the slope
  here is walkable or beyond CLIMB_MAX: on a heightfield letting go means
  sliding down the face.
- `jump_edge` (not slipping, no lunge running): with **back** held, kick off
  (`vel = -u * CLIMB_KICK_SPEED + up JUMP_FORCE`, mode air, free); otherwise
  a **lunge**: CLIMB_JUMP_STAMINA, then CLIMB_JUMP_TIME_S (15 steps) straight
  up at CLIMB_JUMP_SPEED, input ignored (2 m).
- **Rain:** speed x CLIMB_RAIN_MULT, and while `timer >= period - slip`
  (the last CLIMB_SLIP_TIME_S of every CLIMB_SLIP_PERIOD_S) the climber slips
  down at CLIMB_SLIP_SPEED ignoring input. `timer = (timer + 1) % period`.
- Otherwise input is relative to the wall: forward = up, back = down,
  left/right = along the contour (diagonals scaled by sqrt(1/2)); moving
  costs STAMINA_CLIMB_PER_S, hanging still is free.
- Move `a * speed / sqrt(1 + t2)` horizontally along u (so the distance
  along the surface is `speed * dt`) and `b * speed` along r, then stand on
  the surface there. `vel` reports the displacement (never fed back).
- If the slope there is walkable: moving up = **mantle** (mode ground, forward
  push MANTLE_SPEED along u), else reached the foot (ground, still). Beyond
  CLIMB_MAX: ground (slides next step). Deep water: swim.

### Glide

Opened in a walk-family air step (`!grounded`, stamina usable, falling
`vy < 0` after gravity, more than GLIDE_MIN_FALL_M above the ground below)
by `glide_toggle` (the G key; skips the double jump) or by a `jump_edge`
when the double jump is spent (Space: jump, double jump, third press opens).
Opening spends the air jumps, so closing never grants a double jump.

Each glide step: a `jump_edge` or `glide_toggle` press, or an unusable
wheel, **closes** it (the step runs as an air step with those presses
masked). Otherwise horizontal velocity moves toward `wish * GLIDE_SPEED`
by GLIDE_ACCEL*dt (no keys = drift to a hover), vertical toward
`-GLIDE_SINK_SPEED + lift` by GLIDE_VERTICAL_ACCEL*dt, where `lift =
clamp(env.updraft.liftAt(pos), 0, UPDRAFT_MAX_LIFT)`; drains
STAMINA_GLIDE_PER_S. Touching ground (`y <= ground`) lands (or grabs the
wall when holding into a climbable slope); deep water swims.

### Swim

Water at (x, z) is swum when `waterAt - heightAt >= SWIM_DEPTH_M` and the
feet are at or below `waterAt - SWIM_FLOAT_DEPTH_M`; the swimmer floats
there (feet 1.4 m under the surface). Entered from walk, glide or climb.
Each swim step: horizontal velocity toward `wish * SWIM_SPEED` by
SWIM_ACCEL*dt; stamina drains always (STAMINA_SWIM_PER_S). Shallower than
SWIM_DEPTH_M ahead: if the bank is higher than MAX_STEP_UP_M above the feet
it is a wall (climb it when holding into it, else stop), otherwise stand up
(snap like a landing) or drop. Stamina reaching 0 while swimming =
**drowned**: frozen for DROWN_TIME_S (timer), then the step itself teleports
to `findShore` (rings every 2 m to 64 m, then 8 m to SHORE_SEARCH_M, eight
directions, first dry + walkable point in the world) with a full wheel.
Client and server compute the same shore, so a drowning costs no correction;
the zone also sends Event 100 `drowned` for UI.

### Stamina wheel

Sprint drains (grounded, not sliding, wish non-zero, sprint held and usable)
STAMINA_SPRINT_PER_S and resets the timer; every other grounded walkable step
counts the timer up and, from STAMINA_REGEN_DELAY_S on, refills
STAMINA_REGEN_PER_S (walking regenerates too). Air and slides neither drain
nor count. After every step: clamp to [0, max]; 0 sets **exhausted**, full
clears it. Exhausted = no sprint, no climb, no glide.

### Jump semantics, precisely

| Situation | jump held | jump_edge | glide_toggle |
| --- | --- | --- | --- |
| Grounded, walkable | jump (auto-hop while held) | (with held) jump | - |
| Sliding | - | - | - |
| Air, double jump left | - | double jump | open glider if allowed |
| Air, double jump spent | - | open glider if allowed | open glider if allowed |
| Gliding | - | close | close |
| Climbing | - | lunge (with back: kick off) | - |
| Swimming | - | - | - |

The client sets `jump_edge` on exactly one step per Space press and
`glide_toggle` on one step per G press (`JumpEdgeLatch`). Note: keys are
sampled per rendered frame, so at very low frame rates (headless
SwiftShader ~10 fps) a tap shorter than a frame can be missed (WP02
behavior).

### Towers (WP12)

Since WP12 the game and the zone simulate on terrain + the structure overlay
(`StructureGround` / `structures.Ground`: height = max(terrain, structure
tops)). The step only reads `heightAt`/`waterAt`, so tower walls (80°) are
climbed like any steep slope, the ledge is walkable (resting there refills
the wheel), the top is mantled and glided from. Water passes through to the
terrain's. On a slope a tower's downhill face can be taller than one wheel
climbs; approach from the uphill side.

### Env (rain, updrafts)

Online, `NetPlay` builds the env per step from the zone's seed and the
clock-synced server time (`envAt`), exactly what the zone evaluates per tick
(`weather.IsRaining(seed, serverTime/1000)`). The two can disagree for a few
ms around a 10-minute weather window boundary: at worst one correction while
climbing. Each predicted step stores its env and replays reuse it. Dev
overrides: `?rain=1|0` and `?updraft=x,z,r,top,lift` (zone:
`LODESTONE_ZONE_DEBUG_RAIN`, `LODESTONE_ZONE_DEBUG_UPDRAFTS`).

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

WP10 adds nine **terrain goldens** (`golden/movement_wp10_*.json`, format
version 2) on the official world (seed 20261108) through worldgen.wasm:
`climb`, `climb_rain`, `climb_kick`, `glide`, `glide_updraft`, `swim`
(incl. drowning), `slope`, `stamina`, and `tower` on the combined ground
(terrain + WP12's tower overlay, `ground.structures: "towers"`): climb the
80° lower wall, rest on the ledge, climb the upper wall, mantle, glide from
the top. Scripts in `golden/wp10.ts` (`planClimb` = Go `movement.PlanClimb`);
sites in `docs/evidence/wp10-sites.txt`. Rows are
`[x,y,z,vx,vy,vz,airJumps,mode,stamina,timer,lunge,flags]`; the header
carries `env` (raining, updraft columns) and `staminaMax`. They need
`npm run build:wasm`; the TS test (`traversal.test.ts`) and the Go replay
(`server/pkg/movement/terrain_golden_test.go`, on the wasm and on the zone's
cached-chunk fast path) skip without it. Go matches TS within 2e-15 m and
every discrete field exactly.

WP02's two files below are unchanged and still reproduce bit for bit (the
walk/air arithmetic on walkable ground did not change).

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

## Caves (WP09)

The step (WP10) is a heightfield state machine; caves plug in through two optional hooks, identical in TS (`client/src/sim/caves.ts`, `GroundQuery.atLevel` / `collide`) and Go (`server/pkg/movement/caves.go`, `LevelGround` / `Collider`):

1. At the start of a step the ground is viewed at the player's feet height (`AtLevel(y)`). In a cave (a mouth hole, or more than 1 m under the surface) that view's `HeightAt` is the highest cave floor in [y - 34, y + MAX_STEP_UP_M]; with none, the lowest ledge within 3 m above (a real step: the walk/step-up/climb rules decide), else `y` inside rock (walls are never slopes to climb), else y - 35 over an open pit. Its water is -Inf (no swimming in the lake overhead). Elsewhere it is the surface ground (terrain + WP12 structures) unchanged, so every mode, slope probe and climb works on it as on terrain.
2. After the mode step, one wall/ceiling push-out (not while climbing): horizontal velocity slides along the push (`v -= n * min(0, v.n)`), a ceiling stops a rising jump, a grounded player is re-snapped to the floor at the pushed point.

Grounds without caves implement neither and step exactly as before (every WP02/WP10 golden unchanged). `server/pkg/caves.Ground`, `worldhost.CaveTerrain` and the client's `CaveGround` (over `StructureGround`) implement both. Golden cave walk: `client/src/world/caves/cavePath.test.ts` (TS) replayed by `server/pkg/caves/path_test.go` (Go).
