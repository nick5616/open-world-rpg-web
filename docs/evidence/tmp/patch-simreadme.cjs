const fs = require('fs');
const p = 'client/src/sim/README.md';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep("| `movement.ts` | `stepMovement(state, input, ground, dt)`: one fixed step. Source-style helpers. |", "| `movement.ts` | `stepMovement(state, input, ground, dt, env)`: one fixed step (walk/air, climb, glide, swim, stamina; WP10). Source-style helpers, `slopeAt`, `findShore`. |");
rep("| `ground.ts` | `GroundQuery` interface, `FlatGround` (the WP02 world), `PlaneGround` (goldens only). |", "| `ground.ts` | `GroundQuery` interface (`heightAt`, optional `waterAt`), `FlatGround` (the WP02 world), `PlaneGround` (goldens only). |\n| `worldgenGround.ts` | `WorldgenGround`: `heightAt` = wasm `collision_height`, `waterAt` = wasm `water_height` (what the zone simulates on). |\n| `moveWire.ts` | MoveState <-> SelfState (protocol v2: mode, flags, `moveExt`). |\n| `weather.ts` | Rain stub `isRaining(seed, worldTime)` until WP15 (Go twin `server/pkg/weather`). |\n| `updraft.ts` | `UpdraftColumns` (debug implementation of the updraft hook) and the `x,z,r,top,lift` parser. |\n| `stepEnv.ts` | Where the client's StepEnv comes from (synced server time online, `?rain=`, `?updraft=`). |\n| `dev/` | Node acceptance harness (`traversalRun.ts`, `traversal-acceptance.ts`), browser run (`traversal-browser.ts`), `?ground=worldgen` debug play (`WorldgenDebugCanvas`, `DebugTerrain`), divergence probe. |");
rep("## Go port notes (WP03)", `## WP10: traversal (climb, glide, swim, slopes, stamina)

Everything below is in the same pure step, identical in Go
(\`server/pkg/movement\`). The world enters only through \`ground.heightAt\`
(wasm \`collision_height\`) and \`ground.waterAt\` (wasm \`water_height\`, the
same triangle mesh over the chunk water lattice), plus a \`StepEnv\`:
\`raining\` (weather stub at world time) and an \`updraft\` field (debug
columns until WP15). Only + - * / sqrt floor and comparisons are used beyond
the existing yaw sin/cos, and slope thresholds are literal constants, so the
TS and Go steps agree to the last bit on every terrain golden.

### State (all of it rides in SelfState)

\`{pos, vel, airJumps, mode, stamina, staminaMax, timer, lunge, flags}\`:
\`mode\` is MoveMode (ground/air are re-derived from position each step as
before; climb/glide/swim are carried); \`stamina\` is an integer in fine units
(STAMINA_FINE_PER_POINT = 60 per point, so 10/s is exactly 10 per step);
\`timer\` (0..255) counts steps in the current mode family: the regen delay on
the ground, the rain-slip phase on a wall, the drowning countdown in water,
reset whenever the family (walk = ground+air, climb, glide, swim) changes;
\`lunge\` is the climb-jump steps left; \`flags\`: 1 exhausted, 2 drowned,
4 sliding. Wire: SelfState.flags = flags | lunge << 4, SelfState.moveExt =
stamina | timer << 16 (\`moveWire.ts\`), so a replay starts from the exact
server state.

### Slopes (deferred from WP07)

\`slopeAt(x, z)\` = central differences of heightAt at +-SLOPE_PROBE_M (over
1 m): \`gx, gz\`, \`t2 = gx^2 + gz^2 = tan(slope)^2\`. Walkable: \`t2 <=
WALKABLE_TAN_SQ\` (50 deg); climbable: up to \`CLIMB_MAX_TAN_SQ\` (89 deg).
In a grounded step:
- **Sliding:** standing on \`t2 > WALKABLE\`: no friction, no control,
  horizontal accel \`-GRAVITY * t / (1 + t2)\` downhill (gravity along the
  surface), capped at SLIDE_MAX_SPEED; no ground jump.
- **Wall:** a move whose rise is steeper than walkable (\`rise > 0 && rise^2 >
  WALKABLE_TAN_SQ * d^2\`) onto steep ground is refused, unless it is a
  **step**: ground STEP_PROBE_M ahead walkable and at most MAX_STEP_UP_M above
  the feet. A refused move keeps only its along-contour part (and velocity
  loses its into-wall part); if that is a wall too, the player stays.
- Downhill onto steep ground is allowed (then you slide).

### Climb

Start (any of): a refused wall move, standing on a slide, or an airborne
step touching steep ground, while **holding forward into it**: forward held,
stamina usable (not exhausted, > 0), \`WALKABLE < t2 <= CLIMB_MAX\`, and
\`wish . g >= CLIMB_FACING_MIN * |g|\` (within 60 deg of uphill). The climber
stands on the surface at the wall point.

Each climb step, with \`u = g/|g|\` (uphill) and \`r = (-u.z, u.x)\`:
- Let go (run the walk step from rest) if stamina is unusable or the slope
  here is walkable or beyond CLIMB_MAX: on a heightfield letting go means
  sliding down the face.
- \`jump_edge\` (not slipping, no lunge running): with **back** held, kick off
  (\`vel = -u * CLIMB_KICK_SPEED + up JUMP_FORCE\`, mode air, free); otherwise
  a **lunge**: CLIMB_JUMP_STAMINA, then CLIMB_JUMP_TIME_S (15 steps) straight
  up at CLIMB_JUMP_SPEED, input ignored (2 m).
- **Rain:** speed x CLIMB_RAIN_MULT, and while \`timer >= period - slip\`
  (the last CLIMB_SLIP_TIME_S of every CLIMB_SLIP_PERIOD_S) the climber slips
  down at CLIMB_SLIP_SPEED ignoring input. \`timer = (timer + 1) % period\`.
- Otherwise input is relative to the wall: forward = up, back = down,
  left/right = along the contour (diagonals scaled by sqrt(1/2)); moving
  costs STAMINA_CLIMB_PER_S, hanging still is free.
- Move \`a * speed / sqrt(1 + t2)\` horizontally along u (so the distance
  along the surface is \`speed * dt\`) and \`b * speed\` along r, then stand on
  the surface there. \`vel\` reports the displacement (never fed back).
- If the slope there is walkable: moving up = **mantle** (mode ground, forward
  push MANTLE_SPEED along u), else reached the foot (ground, still). Beyond
  CLIMB_MAX: ground (slides next step). Deep water: swim.

### Glide

Opened in a walk-family air step (\`!grounded\`, stamina usable, falling
\`vy < 0\` after gravity, more than GLIDE_MIN_FALL_M above the ground below)
by \`glide_toggle\` (the G key; skips the double jump) or by a \`jump_edge\`
when the double jump is spent (Space: jump, double jump, third press opens).
Opening spends the air jumps, so closing never grants a double jump.

Each glide step: a \`jump_edge\` or \`glide_toggle\` press, or an unusable
wheel, **closes** it (the step runs as an air step with those presses
masked). Otherwise horizontal velocity moves toward \`wish * GLIDE_SPEED\`
by GLIDE_ACCEL*dt (no keys = drift to a hover), vertical toward
\`-GLIDE_SINK_SPEED + lift\` by GLIDE_VERTICAL_ACCEL*dt, where \`lift =
clamp(env.updraft.liftAt(pos), 0, UPDRAFT_MAX_LIFT)\`; drains
STAMINA_GLIDE_PER_S. Touching ground (\`y <= ground\`) lands (or grabs the
wall when holding into a climbable slope); deep water swims.

### Swim

Water at (x, z) is swum when \`waterAt - heightAt >= SWIM_DEPTH_M\` and the
feet are at or below \`waterAt - SWIM_FLOAT_DEPTH_M\`; the swimmer floats
there (feet 1.4 m under the surface). Entered from walk, glide or climb.
Each swim step: horizontal velocity toward \`wish * SWIM_SPEED\` by
SWIM_ACCEL*dt; stamina drains always (STAMINA_SWIM_PER_S). Shallower than
SWIM_DEPTH_M ahead: if the bank is higher than MAX_STEP_UP_M above the feet
it is a wall (climb it when holding into it, else stop), otherwise stand up
(snap like a landing) or drop. Stamina reaching 0 while swimming =
**drowned**: frozen for DROWN_TIME_S (timer), then the step itself teleports
to \`findShore\` (rings every 2 m to 64 m, then 8 m to SHORE_SEARCH_M, eight
directions, first dry + walkable point in the world) with a full wheel.
Client and server compute the same shore, so a drowning costs no correction;
the zone also sends Event 100 \`drowned\` for UI.

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

The client sets \`jump_edge\` on exactly one step per Space press and
\`glide_toggle\` on one step per G press (\`JumpEdgeLatch\`). Note: keys are
sampled per rendered frame, so at very low frame rates (headless
SwiftShader ~10 fps) a tap shorter than a frame can be missed (WP02
behavior).

### Env (rain, updrafts)

Online, \`NetPlay\` builds the env per step from the zone's seed and the
clock-synced server time (\`envAt\`), exactly what the zone evaluates per tick
(\`weather.IsRaining(seed, serverTime/1000)\`). The two can disagree for a few
ms around a 10-minute weather window boundary: at worst one correction while
climbing. Each predicted step stores its env and replays reuse it. Dev
overrides: \`?rain=1|0\` and \`?updraft=x,z,r,top,lift\` (zone:
\`LODESTONE_ZONE_DEBUG_RAIN\`, \`LODESTONE_ZONE_DEBUG_UPDRAFTS\`).

## Go port notes (WP03)`);
rep("## Golden trajectories", `## Golden trajectories

WP10 adds eight **terrain goldens** (\`golden/movement_wp10_*.json\`, format
version 2) on the official world (seed 20261108) through worldgen.wasm:
\`climb\`, \`climb_rain\`, \`climb_kick\`, \`glide\`, \`glide_updraft\`, \`swim\`
(incl. drowning), \`slope\`, \`stamina\` (scripts in \`golden/wp10.ts\`; sites in
\`docs/evidence/wp10-sites.txt\`). Rows are
\`[x,y,z,vx,vy,vz,airJumps,mode,stamina,timer,lunge,flags]\`; the header
carries \`env\` (raining, updraft columns) and \`staminaMax\`. They need
\`npm run build:wasm\`; the TS test (\`traversal.test.ts\`) and the Go replay
(\`server/pkg/movement/terrain_golden_test.go\`, on the wasm and on the zone's
cached-chunk fast path) skip without it. Go matches TS within 2e-15 m and
every discrete field exactly.

WP02's two files below are unchanged and still reproduce bit for bit (the
walk/air arithmetic on walkable ground did not change).`);
fs.writeFileSync(p, s);
console.log('ok');
