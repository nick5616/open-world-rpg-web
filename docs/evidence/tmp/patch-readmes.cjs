const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (a === null) {
      s += b;
      continue;
    }
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}

patch('server/pkg/movement/README.md', [
  [`Zone-only extras (not in the step, so the client gets corrections for them):
world-edge clamp to [0, WORLD_SIZE_M), a horizontal speed sanity bound
(\`MaxLegitHorizontalSpeed\`, 25.6 m/s) that snaps violators back, and a
60 frames/s budget per session.`, `Zone-only extras (not in the step, so the client gets corrections for them):
world-edge clamp to [0, WORLD_SIZE_M), per-mode speed and vertical bounds
(\`MaxHorizontalSpeed\`, zone \`verticalOK\`) that snap violators back, and a
60 frames/s budget per session.

## WP10: climb, glide, swim, slopes, stamina

The full step (\`StepEnv(state, flags, yaw, ground, env)\`) adds spec 8's
traversal; the algorithm is written out once, in
\`client/src/sim/README.md\` ("WP10"). Files:

| File | What |
| --- | --- |
| \`movement.go\` | \`State\` (+ mode, stamina in fine units, timer, lunge, flags), \`stepWalk\` / \`stepClimb\` / \`stepGlide\` / \`stepSwim\`, \`SlopeAt\`, \`FindShore\`, \`Activity\`, \`MaxHorizontalSpeed\` |
| \`wire.go\` | \`SelfFields\` / \`FromSelf\`: State <-> SelfState (protocol v2: flags + lunge, \`moveExt\` = stamina + timer) |
| \`updraft.go\` | \`Columns\` (debug UpdraftField) and \`ParseColumns\` (\`x,z,r,top,lift;...\`) |

\`Ground\` stays \`HeightAt\`; water is the optional \`Water\` interface
(\`WaterAt\`, implemented by \`worldhost.Terrain\` with the wasm
\`water_height\`); grounds without it have no water. \`Env\` carries rain (the
\`server/pkg/weather\` stub) and the \`UpdraftField\` hook WP15 will feed.
Construct states with \`NewState(pos)\` (full wheel): a zero \`State\` has no
stamina and cannot sprint.

Bitwise: all WP10 arithmetic is + - * / sqrt and comparisons on the same
inputs as TS, products are wrapped in \`float64()\` so Go never fuses an FMA,
and \`dt\` is a run-time variable because Go folds constant expressions
exactly (V8 multiplies the rounded 1/60). Slope thresholds are the literal
constants \`WALKABLE_TAN_SQ\` / \`CLIMB_MAX_TAN_SQ\`, not a tan() per language.`],
  [`## Cross-language check`, `## Cross-language check

\`terrain_golden_test.go\` replays WP10's eight terrain goldens from
\`client/src/sim/golden/movement_wp10_*.json\` on the official world through
worldhost, both on the wasm and on the zone's cached-chunk fast path, and
requires every position/velocity within 1e-9 m and every discrete field
equal (measured: <= 2e-15 m). \`traversal_test.go\` pins each rule on
synthetic ground. Both need the built wasm for the terrain part
(\`LODESTONE_REQUIRE_WASM=1\` makes a missing wasm fail).
`],
]);

fs.writeFileSync('server/pkg/weather/README.md', `# server/pkg/weather

WP10's deterministic weather stub until the night/chemistry package (WP15)
owns weather. Spec 8: weather is a function of world time and the seed, so
it needs no sync beyond the clock. Movement needs one bit, rain (climb speed
halved, slips every few seconds), so:

\`\`\`
window = floor(worldTime / WEATHER_STUB_WINDOW_S)       // 600 s
rain   = fmix32(seedLo ^ seedHi*0x9e3779b1 ^ window*0x85ebca6b) % 100 < WEATHER_STUB_RAIN_PCT   // 25
worldTime = serverTimeMs / 1000                          // the zone clock (Unix), which clients sync
\`\`\`

The TS twin is \`client/src/sim/weather.ts\`; both test the same hash vectors
(\`weather_test.go\`, \`client/src/sim/traversal.test.ts\`). The zone evaluates
it once per tick (\`game.Server.stepEnv\`), clients per predicted step at
their synced estimate of the server clock; a few ms of disagreement at a
window boundary costs at most one correction while climbing.
\`LODESTONE_ZONE_DEBUG_RAIN=1|0\` overrides it on the zone (client: \`?rain=1|0\`).

Test: \`cd server/pkg && go test ./weather\`.
`);

patch('server/zone/README.md', [
  [`- **Validation.** Besides WP03's horizontal bound, \`verticalOK\` checks each
  step rises at most one jump step (or onto the ground it snapped to) and
  never ends below the ground; both hold exactly for \`movement.Step\`, so this
  only trips on bugs or unsimulated modes (WP10 must extend it for
  climb/glide).
- **Not yet:** slope limits (\`WALKABLE_SLOPE_DEG\`, \`MAX_STEP_UP_M\`) are not
  applied on either side; the client and server stay identical, and WP10
  adds them to both together with climb/slide.`, `- **Validation.** Besides WP03's horizontal bound, \`verticalOK\` checks each
  step rises at most one jump step (or onto the ground it snapped to) and
  never ends below the ground. WP10 made both per mode (see "Traversal").
- Slope limits (\`WALKABLE_SLOPE_DEG\`, \`MAX_STEP_UP_M\`) are applied in the
  shared step on both sides since WP10.`],
  [null, `
## Traversal (WP10)

The zone steps every frame with \`movement.StepFrameEnv\` (climb, glide, swim,
slopes, stamina; algorithm in \`client/src/sim/README.md\`). Zone side, in
\`internal/game/traversal.go\`:

- **Env per tick** (\`stepEnv\`): rain from \`server/pkg/weather\` at the tick's
  server time and the seed, unless \`LODESTONE_ZONE_DEBUG_RAIN=1|0\`; updrafts
  from \`Config.Updraft\` (\`LODESTONE_ZONE_DEBUG_UPDRAFTS="x,z,r,top,lift;..."\`
  debug columns until WP15 feeds the hook). The view extrapolation uses the
  same env.
- **Validation per mode** (spec 9: "validated against max speed for the
  player's current mode; violations snap back"): \`horizontalOK\` uses
  \`movement.MaxHorizontalSpeed\` (walk/air 25.6 m/s; climb <= lunge speed;
  glide and swim <= max(their speed, previous speed); a mode-changing step
  gets the larger of both bounds), \`verticalOK\` allows a rise of one step at
  the fastest legal upward speed (jump, carried vy, strongest updraft minus
  sink, lunge) or onto the ground / the swimmer's float level, never below
  ground; a drowning respawn (drowned flag cleared) must land on dry ground at
  rest. Every terrain golden passes it frame by frame
  (\`TestValidationPassesEveryLegitMode\`); \`TestPerModeValidationRejects\`
  shows violations still snap back.
- **SelfState** carries the whole movement state (\`movement.SelfFields\`:
  mode, exact stamina in \`moveExt\`, timers, flags), so clients replay
  exactly; **Activity** bits (climbing, gliding, swimming, airborne) come from
  the step's mode (\`movement.Activity\`).
- **Drowning**: the step respawns the player at the nearest shore by itself;
  the zone sends Event 100 \`drowned\` (contracts/events.md) and counts
  \`zone_drowned_total\`.
- Join starts players with a full wheel (\`movement.NewState\`); stamina is not
  persisted (a reconnect refills it).
`],
]);

patch('server/pkg/worldhost/README.md', [
  ["| `World` | `world.go` | One world's atlas copied into a lazily grown pool of instances (instances are single-threaded, ABI rule 4; a trapped one is replaced). `CollisionHeight`, `GroundNormal`, `Raycast`, `ChunkBytes`, `SpecJSON`, `Header` (spawn, sea level). |", "| `World` | `world.go` | One world's atlas copied into a lazily grown pool of instances (instances are single-threaded, ABI rule 4; a trapped one is replaced). `CollisionHeight`, `WaterHeight` (WP10), `GroundNormal`, `Raycast`, `ChunkBytes`, `SpecJSON`, `Header` (spawn, sea level). |"],
  ["`Chunk` exposes heights, water and the scatter/container/spawn records. |", "`Chunk` exposes heights, water and the scatter/container/spawn records. `WaterAt` (WP10, `movement.Water`) answers the water surface the same way from the cached water lattice, falling back to wasm `water_height`. |"],
  ["- `TestFastPathBitwise`: 20,011 points, fast path == wasm bit for bit.", "- `TestFastPathBitwise`: 20,011 points, fast path == wasm bit for bit (heights and, since WP10, water)."],
]);

patch('worldgen/README.md', [
  ["| `ground_normal(atlas_ptr, x, z, out_ptr)` |", "| `water_height(atlas_ptr, x, z)` | `(i32, f64, f64) -> f64` | WP10: water surface height, the same triangle mesh as `collision_height` over the f32 water lattice the chunks carry (so it equals interpolating LOD 0 chunk water); sea level where no lake or river covers the point (under dry land); -1e9 on an invalid atlas or non-finite input. Added after genVersion 1 shipped: outputs and golden hashes are unchanged |\n| `ground_normal(atlas_ptr, x, z, out_ptr)` |"],
]);

patch('worldgen/js/README.md', [
  ["wg.groundNormal(atlas, x, z);                      // { normal, slopeDeg }", "wg.waterHeight(atlas, x, z);                       // water surface (WP10): swim where it is >= 1.5 m above the ground\nchunkWaterHeight(c, x, z);                         // same bits from the chunk's water samples\nwg.groundNormal(atlas, x, z);                      // { normal, slopeDeg }"],
  ["| `chunkSurfaceHeight` | The collision formula evaluated on LOD 0 chunk heights |", "| `chunkSurfaceHeight` | The collision formula evaluated on LOD 0 chunk heights |\n| `chunkWaterHeight` | The `water_height` formula on LOD 0 chunk water samples (WP10; WP05's streamed ground should implement `GroundQuery.waterAt` with it) |"],
  ["| `Worldgen` | `specFromSeed`, `buildAtlas`, `loadAtlas`, `buildChunk`, `buildChunkBytes`, `collisionHeight`, `groundNormal`, `raycast`, `hash` |", "| `Worldgen` | `specFromSeed`, `buildAtlas`, `loadAtlas`, `buildChunk`, `buildChunkBytes`, `collisionHeight`, `waterHeight`, `groundNormal`, `raycast`, `hash` |"],
]);
console.log('ok');
