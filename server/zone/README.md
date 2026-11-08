# server/zone

The zone server (module `lodestone/server/zone`, WP03): the authoritative
simulation for a set of regions. In v1 one process owns the whole world.

| Piece | Where |
| --- | --- |
| Entry point, env config, registry heartbeat, shutdown order | `main.go` |
| Tick, joins/leaves, checkpoints | `internal/game/server.go` |
| Handshake, rate limits, input drain, interest + snapshot per client | `internal/game/session.go` |
| Entity, quantization, movement validation | `internal/game/entity.go` |
| Postgres reads/writes (`characters.position`) | `internal/game/persist.go` |
| Prometheus metrics | `internal/game/metrics.go` |
| 32 m cell grid and AOI rings | `internal/aoi` |

Shared building blocks live in `server/pkg`: `gameloop` (30 Hz scheduler),
`transport` (WebSocket, WebTransport), `movement` (the step WP02 ports to
TS), `snapshot` (delta encoder/decoder), `ratelimit`, `writebehind`, plus
`proto`, `ticket`, `zoneregistry`.

## Run

```
npm run infra:up                    # Postgres + Redis (optional: the zone runs without them)
go run ./server/zone                # from the repo root, listens on :8092
go run ./tools/bots -n 20           # watch it work
curl localhost:8092/metrics         # Prometheus text
curl localhost:8092/debug/tickstats # scheduler summary as JSON
```

Configuration is env only; every variable and default is listed in the
`main.go` header. The ones you will touch: `LODESTONE_ZONE_PORT` (8092),
`LODESTONE_ZONE_ID` (`zone-dev-1`, tickets must target `zone:<id>`),
`LODESTONE_WORLD_ID` / `_WORLD_SEED` / `_GEN_VERSION` (sent in Welcome; when
the id is unset the zone serves WP04's official world row, which is what the
director routes to, else a dev world),
`LODESTONE_SPIN_MS` (scheduler spin tail), `LODESTONE_ZONE_EXIT_AFTER`
(graceful exit after a duration, for soaks: Windows can't send SIGINT to a
background process).

## Transports (WP06)

- WebSocket `GET /ws` on TCP (the mandatory fallback), plus WebTransport
  over HTTP/3 at `/wt` on UDP. UDP defaults to the same port number;
  `LODESTONE_ZONE_WT_ADDR=off` disables it. Session code is
  transport-blind (`AcceptWebTransport` runs the same handshake).
- Without `LODESTONE_ZONE_WT_CERT/_KEY` the zone mints a 10-day self-signed
  ECDSA certificate at startup. It announces
  `wtEndpoint = https://localhost:<port>/wt#certHash=<sha256 b64>` in the
  registry; browsers pin the cert with `serverCertificateHashes`.
  `GET /debug/wt` shows the endpoint and hash.
- `LODESTONE_ZONE_PUBLIC_URL` / `LODESTONE_ZONE_WT_PUBLIC_URL` override the
  announced endpoints, for example to route players through
  `tools/netsim/proxy.mjs`.
- On shutdown the zone kicks everyone, drains WebTransport sessions (their
  kick frame and close code) and only then closes the UDP listener.
- Details and the Safari status: `docs/decisions/0006-netcode-transport.md`.

## Session protocol (what WP06's client must do)

1. Connect `ws(s)://host:port/ws`, binary frames, one message per frame (or
   WebTransport: open one bidirectional stream, u32-LE length-prefixed frames
   on it, unreliable messages as datagrams).
2. Send `Hello{protocolVersion, ticket, clientTime, transport}`. The zone kicks
   with `version_mismatch` (checked from the first bytes, before full decode),
   `bad_ticket` (signature, expiry, audience `zone:<zoneId>`, world id, missing
   character), `server_full`, or `shutdown`. Kicks are a `Kick` frame and close
   code `4000 + KickCode`.
3. Receive `Welcome{entityId, tick, tickRate, serverTime, worldId, seed,
   genVersion, x/y/z (cm, feet), name}`.
4. Send `Input` 30 times a second with the newest frames plus repeats (up to
   3). Each `InputFrame` is one 1/60 s step; `seq` increases by one per frame.
   The server applies every NEW frame in seq order and acks the newest applied
   one in `Snapshot.ackInputSeq`. Put the newest snapshot tick you applied in
   `Input.ackTick`.
5. Receive a `Snapshot` every tick (30 Hz). Apply it as described below.
6. `ClockPing{t1}` -> `ClockPong{t1, t2 = server receive, t3 = server send}`,
   server time is Unix ms (float, sub-ms). Answered on the connection's
   goroutine, not the tick, so t2/t3 are tight.
7. A second login for the same character kicks the older connection
   (`duplicate_login`); the new one resumes at the old live position.

Rate limits (token buckets per connection and message type, the-circle
pattern): Input 60 burst / 40 per s, ClockPing 16 / 4, HitClaim 30 / 15,
Interact 10 / 5. Dropped messages count against a violation bucket (100 / 10
per s); emptying it kicks with `rate_limited`. Separately, movement frames are
budgeted at 60 per second with a 60-frame burst (WP06 raised it from 30:
chained TCP stalls under "thailand" overflowed it). Frames are simulation
time, so this is what stops a client from moving faster by sending more
frames.

Input handling (WP06):
- Frames from all of a tick's packets are applied in seq order. When a frame
  is missing (datagrams reorder), later frames wait up to 2 ticks for it.
- A frame still missing after that was lost in every redundant copy. It is
  replaced by the player's previous input (minus jump edges; at most 8 in a
  row, `zone_input_frames_synthesized_total`), so walking through a loss
  matches the client's prediction exactly.
- What other clients see of a player is a view that runs ahead of the
  confirmed state by the steps real time owes when input is late, at most
  16 (267 ms), repeating the last input. A wrong guess is eased out over
  about 4 ticks. SelfState, validation, AOI and persistence use the
  confirmed state only.

### Applying snapshots

`server/pkg/snapshot` is the reference (`Decoder.Apply`); port it.

- `baselineTick == 0`: full snapshot. Otherwise it is a delta against the
  frame you built for `baselineTick` (an earlier snapshot you acked). Keep
  your last 32 frames.
- New frame = baseline frame, minus ids in `removed`, with each `EntityRecord`
  applied: fields whose mask bit is set replace the baseline value. A record
  for an id the baseline lacks applies onto the ZERO state: first sight always
  carries `kind` and `name` but omits fields that are zero.
- Entities in the baseline without a record are unchanged. That is how slower
  rings work: mid-ring entities appear in records every 3rd tick (10 Hz),
  far-ring and party every 15th (2 Hz), phase-staggered by entity id.
- `self` (SelfState) is diffed the same way against the baseline's self.
  It carries position (cm), velocity (cm/s) and airJumps, which is all a
  replay from the acked input needs; grounded is derived from position.
- Ignore a snapshot whose tick is not newer than the newest you applied.

Byte budget (decision 0005, WP06): `LODESTONE_ZONE_DOWN_BUDGET_KBPS`
(default 150, 0 = off) caps each client's snapshot bytes, transport framing
included. When a tick's records don't fit, they go out in priority order:
party first, then by distance, with an accumulator so starved entities win
a turn. A deferred entity keeps its baseline state and later sends the
whole accumulated change; the ring table stays the maximum rate. Dense case
(150 bots in a 40 m disc): 504 → 150 kbps (`docs/evidence/wp06-dense-budget-*`).

Interest: 32 m grid, rings near < 64 m (everything, 30 Hz), mid < 200 m
(players/enemies/effects, 10 Hz), far < 600 m (players only, 2 Hz; a player
you already know stays until 616 m so the edge doesn't flap), party any
distance (2 Hz; `partyId` is a stub until WP08).

## Persistence

Never in the tick. Login reads `characters.position` (1 s timeout, connection
goroutine); a missing row spawns near the world center (or at `?spawn=x,z`
when dev spawn is on). Every character is checkpointed every SAVE_INTERVAL_S
(staggered by entity id), on logout and on shutdown, through the write-behind
queue (`server/pkg/writebehind`). Rows that don't exist yet (WP04 creates
characters) are logged once and skipped.

## Test

```
cd server/zone && go test ./...          # unit + in-process sessions + subprocess end-to-end
cd server/zone && go test -short ./...   # skip the subprocess test
```

`zone_wt_integration_test.go` (WP06) runs the binary with WebTransport. It
pins the dev cert by the hash from `/debug/wt`, handshakes on the stream,
sends Input as datagrams, has a WebSocket player watch the WebTransport
player walk, and checks the registry `wtEndpoint`, the per-transport
session metrics and that the shutdown kick arrives with its close code.
`internal/game/view_test.go` covers view extrapolation and easing,
reordered input and lost-frame fill.

`zone_integration_test.go` builds the binary, runs it as a subprocess against
a refusing Postgres URL and the shared Redis (registry checks are skipped if
Redis is down), drives Hello/Input/Snapshot over a real socket, checks the
server position equals local prediction to the centimeter, scrapes
`/metrics`, and verifies the graceful shutdown kick, exit code and registry
removal.

Soak: see `tools/bots/README.md`. Evidence: `docs/evidence/wp03-*`.

## Metrics

`zone_tick_ms{q=p50|p99|max}` (last 60 s) and `_lifetime`,
`zone_tick_jitter_ms{...}`, `zone_tick_spacing_ms`, `zone_players`,
`zone_client_down_kbps` / `zone_client_up_kbps{q=p50|p99|max|avg}` (per client,
5 s window, incl. WebSocket framing), `zone_bytes_{in,out}_live_clients`,
`zone_aoi_entities_avg{ring=...}`, `zone_aoi_entities_max`,
`zone_snapshot_bytes_avg`, `zone_writebehind_depth` and `_*_total`,
`zone_kicks_total{code=...}`, `zone_rate_limited_total`,
`zone_input_frames_total`, `zone_input_frames_dropped_total`,
`zone_speed_violations_total`, `zone_snapshots_shed_total`,
`zone_spin_seconds_total`; WP06: `zone_input_frames_skipped_total`,
`zone_input_frames_synthesized_total`, `zone_budget_records_sent_total`,
`zone_budget_records_deferred_total`, `zone_downlink_budget_kbps`,
`zone_sessions{transport=websocket|webtransport}`.

## Terrain (WP07)

The zone simulates on the generated world: `terrain.go` (package main) loads
`worldgen.wasm` (`LODESTONE_WORLDGEN_WASM`, default
`worldgen/pkg/worldgen.wasm`), opens the world it serves with
`server/pkg/worldhost` and passes a `worldhost.Terrain` as `Config.Ground`.
Game-side hooks live in `internal/game/terrain.go` (optional interfaces on
the ground, so tests and the flat fallback need nothing new in `Config`).

- **Pin.** A minted world row must have the wasm's `gen_version` and its
  rebuilt atlas must hash to `atlas_hash`, or the zone exits 1 ("refusing to
  serve this world"). A placeholder row (or `LODESTONE_GEN_VERSION=dev`) is
  opened from `spec_from_seed(seed)`. Welcome carries the real seed and
  genVersion (`"1"`); `/debug/zone` adds `spec` and `atlasHash` (bots use them).
- **No wasm** (not built): flat ground with a loud warning, as in WP03; fatal
  with `LODESTONE_ZONE_REQUIRE_TERRAIN=1` or `LODESTONE_ENV=production`.
- **Chunk cache.** Every player re-announces interest twice a second
  (staggered): 48 m around it plus 3 s of travel at its speed. Ground queries
  hit cached chunk heights (~25 ns); a miss is a direct `collision_height`
  call (~3-5 us, same bits) and never waits for generation. Env:
  `LODESTONE_ZONE_CHUNK_CACHE` (3072 chunks), `LODESTONE_ZONE_CHUNK_WORKERS`
  (GOMAXPROCS/4, 1-4), `LODESTONE_ZONE_WASM_INSTANCES` (query pool,
  GOMAXPROCS up to 8). Metrics `zone_terrain_*`, JSON at `GET /debug/terrain`.
- **Spawns.** Saved positions are respected (lifted onto the ground if below
  it). New characters (no row, or WP04's creation placeholder
  `(2048, 0, 2048)`) start on a dry cell within 8 m of the atlas spawn
  settlement. Dev `?spawn=x,z` is put on the ground.
- **Validation.** Besides WP03's horizontal bound, `verticalOK` checks each
  step rises at most one jump step (or onto the ground it snapped to) and
  never ends below the ground. WP10 made both per mode (see "Traversal").
- Slope limits (`WALKABLE_SLOPE_DEG`, `MAX_STEP_UP_M`) are applied in the
  shared step on both sides since WP10.
- **For client netcode (WP06):** Welcome's position is cm-quantized while the
  server stands exactly on the ground; a client should take y from its own
  terrain (`collisionHeight`) at the spawn x/z, as the bots do, or its first
  steps start a few mm off the ground and reconcile once.

Tests: `internal/game/terrain_test.go` (prediction on terrain to the cm,
spawns, validation), `zone_terrain_integration_test.go` (zone binary on
terrain vs a client predicting with its own worldhost; refusal of a wrong
genVersion). Both skip without the wasm unless `LODESTONE_REQUIRE_WASM=1`.

## Traversal (WP10)

The zone steps every frame with `movement.StepFrameEnv` (climb, glide, swim,
slopes, stamina; algorithm in `client/src/sim/README.md`). Zone side, in
`internal/game/traversal.go`:

- **Env per tick** (`stepEnv`): rain from `server/pkg/weather` at the tick's
  server time and the seed, unless `LODESTONE_ZONE_DEBUG_RAIN=1|0`; updrafts
  from `Config.Updraft` (`LODESTONE_ZONE_DEBUG_UPDRAFTS="x,z,r,top,lift;..."`
  debug columns until WP15 feeds the hook). The view extrapolation uses the
  same env.
- **Validation per mode** (spec 9: "validated against max speed for the
  player's current mode; violations snap back"): `horizontalOK` uses
  `movement.MaxHorizontalSpeed` (walk/air 25.6 m/s; climb <= lunge speed;
  glide and swim <= max(their speed, previous speed); a mode-changing step
  gets the larger of both bounds), `verticalOK` allows a rise of one step at
  the fastest legal upward speed (jump, carried vy, strongest updraft minus
  sink, lunge) or onto the ground / the swimmer's float level, never below
  ground; a drowning respawn (drowned flag cleared) must land on dry ground at
  rest. Every terrain golden passes it frame by frame
  (`TestValidationPassesEveryLegitMode`); `TestPerModeValidationRejects`
  shows violations still snap back.
- **SelfState** carries the whole movement state (`movement.SelfFields`:
  mode, exact stamina in `moveExt`, timers, flags), so clients replay
  exactly; **Activity** bits (climbing, gliding, swimming, airborne) come from
  the step's mode (`movement.Activity`).
- **Drowning**: the step respawns the player at the nearest shore by itself;
  the zone sends Event 100 `drowned` (contracts/events.md) and counts
  `zone_drowned_total`.
- Join starts players with a full wheel (`movement.NewState`); stamina is not
  persisted (a reconnect refills it).

## Exploration (WP12)

Towers, waypoints, discovery XP, fast travel, pins and the party ring. Rules
in `internal/explore` (README there); glue in `internal/game/explore.go`
(progress load/save, Events, fast travel, `Teleport`, `RespawnPoint`),
`internal/game/party.go` (party ring + party pins from the social service's
Redis keys) and `internal/game/persist_progress.go` (Postgres). Wiring in
`explore.go` (package main): the towers become a structure overlay on the
terrain ground (`server/pkg/structures`), so the zone's movement ground is
terrain + towers, exactly what clients predict on.

- **Events** 600-608 and **Interact** kinds 10 (fast travel) / 11 (pins):
  `contracts/events.md`. After Welcome every player gets `progress_sync` and
  `pins`; party changes send `party` (the snapshot `partyId`).
- **Party ring**: every 2 s an off-tick poller MGETs `partyof:{characterId}`
  for the hosted players; `Entity.PartyID` = FNV-32 of the party id.
- **Persistence**: changed progress is saved through the write-behind queue
  (coalesced per character), at the 30 s checkpoint and on logout. Needs
  migration `0012_exploration_pins` (`npm run migrate`). Local profiles: the
  `Hello.saveBlob` is verified with `server/pkg/localsave` and a new blob is
  sent (`SaveBlob`) when progress changes (at most every 5 s).
- **Hooks for later packages**: `Server.Teleport(e, pos)` (any server move:
  respawn, scripted travel) and `Server.RespawnPoint(e)` (spec 8 "death
  respawns you at the last waypoint", for WP13).
- Env: `LODESTONE_SAVE_PRIVATE_KEY` (local save signing; dev key + warning
  when unset, same as the account service).

## Proximity voice: earshot (WP11)

Every `EARSHOT_INTERVAL_MS` (250 ms) the tick copies player positions
(`internal/game/earshot.go`, a few microseconds) and hands them to a
`voice.Runner` (`internal/voice`), which computes earshot sets on its own
goroutine and publishes them to Redis `voice:{worldId}` (`voice.go`; message
format `server/pkg/earshot`, CR 005). Rules: 3D distance, join 40 m / leave
48 m, at most 12 with an 8 m head start for current members (no swapping in a
crowd), cave hook (`Player.Cave`, WP09), parties added by the social service.
Full message every 2 s, deltas only on change. `LODESTONE_ZONE_EARSHOT=0` (or
`LODESTONE_ZONE_NO_REDIS=1`) turns it off. Metrics `zone_earshot_*`.

The client's `InputFlag.speaking` is mirrored into the entity's
`Activity.speaking` (never for local profiles, `Entity.ListenOnly`).

Tests: `internal/voice` (hysteresis, cap with incumbency, 3D, caves, deltas,
no flapping in a jittery crowd, grid == brute force, runner messages),
`internal/game/earshot_test.go` (cadence, speaking bit),
`zone_earshot_integration_test.go` (zone binary -> Redis: sets, 2 s fulls,
a sprinting player leaves earshot after ~5 s). Decisions: 0011.
