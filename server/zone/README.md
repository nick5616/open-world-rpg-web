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

G3 integration fix: the hand-off now fills `Player.Cave` (cave system + 1 from WP09's per-tick `caveSys`, as interest clipping uses) and `Player.Mouth` for someone in open air within 48 m of a system's opening; before, the cave rule never fired (a cave dweller was "heard" by the meadow 30 m above). Test `TestEarshotCarriesCaveSystem`, `TestCaveMouthRule`.

The client's `InputFlag.speaking` is mirrored into the entity's
`Activity.speaking` (never for local profiles, `Entity.ListenOnly`).

Tests: `internal/voice` (hysteresis, cap with incumbency, 3D, caves, deltas,
no flapping in a jittery crowd, grid == brute force, runner messages),
`internal/game/earshot_test.go` (cadence, speaking bit),
`zone_earshot_integration_test.go` (zone binary -> Redis: sets, 2 s fulls,
a sprinting player leaves earshot after ~5 s). Decisions: 0011.

G5 voice under thailand (`internal/voice/earshot_bursty_test.go`): the voice
soak replayed through the netsim "thailand" model of the input stream (80 ms
+ N(0, 20 ms), 3 % of packets stall an RTO, in order) lags each position by
at most ~2.1 m and never backwards, far inside the 8 m band: same number of
decisions as the smooth feed, 0 flaps. The G5 failure was not the earshot
rules: night demons killed the soak's bots and the respawn teleport moved
them where the bots did not think they were (`server/social/voice/voicebots`
README "G5"). `TestTeleportChangesSetsOnce`: a teleport changes sets once.

## Caves and mining (WP09)

Code: `caves.go` (wiring, package main), `internal/game/caves.go` (cave
interest, clipping, `Do`), `internal/game/mining.go` (veins, drops,
pickups, edits, respawn), `internal/game/edits_store.go` (`world_edits`).

- **Ground.** With a WP09 wasm the zone simulates on
  `worldhost.CaveTerrain`: heightfield on the surface, cave floors, walls
  and ceilings in mouth holes and underground (the same queries the
  client predicts with: `server/pkg/caves`, bit-exact vs TS). Validation
  (`verticalOK`), spawn lifting and dev spawns (`?spawn=x,y,z` lands on the
  floor under y) use `movement.GroundAt`. Cells are wanted for players
  underground or within 64 m of a mouth (48 m + 3 s of travel, one cell up
  and down); a cell asked for and not cached is built synchronously
  (`zone_cave_builds_total{path="sync"}`, rare).
- **Interest clipping (spec 9).** Each tick every entity gets its cave
  system (`SystemAt`, -1 on the surface). A viewer in system S sees
  entities in S and players on the surface within 48 m of S's openings; a
  viewer on the surface sees cave dwellers only from within 48 m of their
  system's openings. Party members are exempt.
- **Mining.** `Interact{targetKind 40, targetId vein id, action 1}` is a
  pickaxe swing: 25 damage, at most one per 250 ms, the vein within 4.5 m of
  the eye; refusals are `EventMineRefused`. `Server.DamageVein(player,
  veinID, amount, source)` is the hook combat (WP13) calls: pickaxe and
  Earth spells full damage, any other spell impact half. Hit points start
  at the generator's value.
- **Break.** Every player who hit the vein in the last 2 minutes gets a
  personal drop from a seeded roll (`mix64(worldSeed ^ veinID ^ editID ^
  fnv(characterID))`, logged with the seed): ores `ore:<name>` x 1-4 by
  cluster size, gems `gem:<name>:rough|cut|brilliant` (deeper is better).
  Drops spawn as `pickup` entities only their owner receives; walking
  within ~1.6 m (or `Interact{targetKind 41}`) takes it through
  `Config.Granter` (WP14's inventory; the default logs) and sends
  `EventItemGranted`. Pickups despawn after `PICKUP_DESPAWN_S`.
- **World edit.** `vein_mined(id, respawnAt)`: carve sphere 1.5 m in
  `params` (16 bytes, f32 x, y, z, r), applied to the cave cells at once
  (`CaveTerrain.SetEdit` rebuilds the touched cached cells synchronously,
  so collision changes in the same tick), sent as `WorldEdits` to every
  client with the chunk in interest, persisted to `world_edits` through the
  write-behind queue (`edit_id` = mix64(vein id, break time) >> 1).
- **WorldEdits delivery.** Each client's interest square is the 5 x 5
  chunks around it (re-evaluated twice a second): a chunk entering it
  sends all its active edits ("first interest"), then edits come as live
  deltas (a list of one). Chunks leaving it are forgotten.
- **Respawn.** A seeded `VeinRespawnMin + (Max - Min) * u` after the break
  (spec 7: 6-24 h; `LODESTONE_ZONE_VEIN_RESPAWN_MIN/_MAX` shorten it for
  tests): hit points restored, the edit removed from the cave cells, a
  delta with `expiresAt` = now sent, the row deleted.
- **Restart.** `RestoreEdits` loads unexpired `world_edits` rows at startup
  (before the first tick): mined veins stay mined, carves stay carved, the
  respawn time is kept.
- `GET /debug/caves`: cave cache counters and mining state (veins touched,
  hit points, respawn times). Metrics: `zone_cave_*`, `zone_veins_mined_total`,
  `zone_veins_respawned_total`, `zone_items_granted_total`,
  `zone_world_edits_sent_total`.

Tests: `internal/game/mining_test.go` (in-process, real cave world: break
after ceil(hp/25) swings, personal pickup and grant, carve applied, late
joiner gets the edit, respawn restores, persisted edits restored; cave
movement == prediction; interest clipping) and `zone_caves_integration_test.go`
(zone binary + scratch Postgres: mine over the wire, `world_edits` row,
kill + restart restores it, respawn on a 14-15 s schedule deletes it;
evidence `docs/evidence/wp09-mining-respawn.txt`).

## Multiple zones and handoff (WP16)

Decision: `docs/decisions/0016-handoff.md`. Contract: `docs/cr/008-zone-handoff.md` (protocol v5 `ZoneTransfer`). Code: `cluster.go` (env wiring, `/debug/cluster`), `internal/cluster` (Redis: pub/sub, keys, registry heartbeat and ownership table), `internal/game/{cluster,handoff,ghosts}.go` (simulation side).

**Off by default.** A zone started as `npm run dev` starts it owns the whole world exactly as before. Cluster mode:

| Env | Meaning |
| --- | --- |
| `LODESTONE_ZONE_CLUSTER=1` | join the world's cluster as the primary (owns what nobody claims; failover target) |
| `LODESTONE_ZONE_ROLE=pool` | own only the regions the director assigns (`zoneassign:{worldId}`) |
| `LODESTONE_ZONE_REGIONS="x,z;x,z"` | regions pinned by config |
| `LODESTONE_ZONE_HEARTBEAT_MS` / `_TTL_MS` | registry heartbeat (1000) and the staleness others apply to us (3000) |
| `LODESTONE_ZONE_DEBUG_URL` | HTTP base announced for tools (`http://127.0.0.1:<port>`) |
| `LODESTONE_ZONE_PPROF=1` | Go profiler on `/debug/pprof/` (any mode, off by default). Diagnostic only: on Windows a CPU profile crashed a zone once (`runtime.sigprof` unwinding wazero JIT frames) |

Every zone of a world must run in cluster mode. Each needs its own port (and WebTransport UDP port).

```
# two zones + director on the dev infra (the director splits the regions)
go run ./server/director
LODESTONE_ZONE_CLUSTER=1 LODESTONE_ZONE_ID=zone-a go run ./server/zone
LODESTONE_ZONE_ROLE=pool LODESTONE_ZONE_ID=zone-b LODESTONE_ZONE_PORT=8192 go run ./server/zone
curl http://127.0.0.1:8092/debug/cluster   # owners grid [x][z], live zones, handoff counters, owned characters
```

What a cluster zone does each tick (`handoffTick`, after inputs):

- **Ownership checks** at 10 Hz per player: within `GHOST_BAND_M` of a region another zone owns → pre-connect (`ZoneTransfer` kind 0 with a single-use token); 2 m inside such a region and that zone has a standby connection → transfer; out of the band by 16 m → cancel (kind 1). A player whose client never pre-connects stays here (simulated past the border) rather than being dropped.
- **Standby sessions**: a Hello carrying a `ho1.` token joins as a standby (no entity, ClockPong only) and the owner is told `ready`. On `transfer` the standby is admitted with the `HandoffState` (exact movement state, input seq, observers' view, progress, party, epoch): same entity id, input continues at `lastSeq + 1`, and its Welcome tells the client to switch. After a transfer out, the old connection stays as this zone's standby for the way back.
- **Mirrors**: entities within 64 m of a foreign region are broadcast every tick, within 200 m at 10 Hz (`ghost:{worldId}`); every player once a second in `worldpos:{worldId}`. Received ones become mirrored entities (never in `Server.ents`; AI and every per-entity loop ignore them), extrapolated to this tick, sent to clients like local ones.
- **Duplicate login across zones**: a login swaps `owner:{worldId}:{charId}`; a live previous owner releases the character with its live state (and kicks its session `duplicate_login`).
- **Checkpoints** carry the owner's epoch (`characters.position.e`); Postgres refuses older epochs, so a late write from the previous owner never overwrites the new one. The new owner checkpoints in full at admission.

Per-character state of other packages (WP13 combat, WP14 items, ...) must ride the handoff: register a `game.HandoffField{Name, Save, Load}` from an `init` function, or it resets when a player crosses a border. Items in Postgres are read on admission like on login (spec 11: "reads happen on login and zone transfer").

Metrics: `zone_cluster_*` (handoffs in/out, pre-connects, standbys, releases, mirrored entities, ghost frames, fenced checkpoints, lost states).

Tests: `internal/game/cluster_test.go` (two zones in one process on an in-memory cluster: handoff with prediction agreeing to the cm and the same entity id, observer continuity on the old zone, no pre-connect = stay, duplicate login across zones, presence feed, checkpoint fencing, re-admission), `internal/cluster` (Redis), director `assign_test.go`. Soak and browser acceptance: `tools/bots/handoff-soak.mjs`, `client/src/net/dev/handoff-acceptance.mjs`.
## Combat (WP13)

Code: `internal/combat` (pure rules, its own README) and the glue
`internal/game/combat.go`; wiring `combat.go` (package main). Decision 0013,
CR 009.

- Every applied input frame first goes through the combat layer
  (`combatFrame`): attack/cast/form starts are logged at the frame's seq, an
  illegal mobility dash is stripped before the movement step, and after the
  step the frame's outcome (position, i-frames, parry) is recorded for the
  strike grace window. Synthesized and extrapolated frames never repeat
  attack/cast/dodge/interact.
- HitClaims are validated after the tick's frames (a claim can overtake its
  frame: it waits up to 0.5 s). Claims that name a player are refused with
  code 1 before anything else; the only path that lowers a player's health
  is an enemy strike or enemy projectile (`combat.(*World).hurtPlayer`).
- Enemies are entities (`EntityKind enemy`, `typeId` = combatdefs.TypeID,
  `healthPct`, the Activity casting bit while winding up) on the existing
  snapshot/AOI path, spawned only within ENEMY_SPAWN_M of a player.
- Groups come from the atlas (camps, bandit camps, guardians, boss arenas at
  wizard towers / sunken temples / demon lairs / large ruins) plus seeded
  wild packs (enemyDensity from the WorldSpec); towns are safe.
- Enemies (and demons) respect buildings (`internal/game/obstacles.go`):
  `combat.World.Obstacles` refuses an enemy step (and a demon's shadow
  step) into a solid town box, the same boxes the players' push-out uses
  (`towns.Blocker` over the zone ground's `towns.Collision`), or a closed
  door; an enemy already overlapping one may move anywhere. Broadphase: a
  bitmask of 8 m squares near a solid box (~3 % of the official world), one
  array read per query outside towns (~4 ns), ~100 ns hugging a building.
- Persistence: `character_progress.skill_tree / spells_known /
  spells_equipped` (accounts, write-behind), the same fields of the local
  save blob (local profiles). No migration.
- Env: `LODESTONE_ZONE_DEV_COMBAT` (default with the dev ticket key) enables
  `LODESTONE_ZONE_DEBUG_CAMP="x,z,level,key key...[,affix][;...]"`,
  `LODESTONE_ZONE_DEBUG_BOSS="x,z,level,boss[,element]"` and the gem Interact;
  `LODESTONE_ZONE_CAMP_RESPAWN_S`, `LODESTONE_ZONE_BOSS_RESPAWN_S`,
  `LODESTONE_ZONE_NO_WILD_PACKS`, `LODESTONE_ZONE_NO_ATLAS_ENEMIES`.
- `GET /debug/combat`: every group (kind, anchor, level, members with
  position/health/state) and the counters, published once a second.
- Metrics: `zone_combat_claims_accepted_total`,
  `zone_combat_claims_refused_total{reason}`, `zone_combat_enemies`,
  `zone_combat_kills_total`, `zone_combat_player_hits_total`,
  `zone_combat_evaded_total`, `zone_combat_downs_total`.
- Acceptance: `node server/zone/cmd/combatbots/acceptance.mjs` (the zone
  binary on the official world; a party of two `cmd/combatbots` clears a
  camp and a boss).
## Towns and NPCs (WP20)

Wiring: `towns.go` (main package) builds the towns layer from the wasm
(`worldhost.World.TownsBytes`, ~0.2 s), wraps the cave terrain so the
movement ground has building floors, walls and ceilings (`server/pkg/towns`;
the cave terrain's methods are promoted, so chunk interest, spawns and
caves are unchanged) and fills `Config.Towns` (`internal/npc`). Game glue:
`internal/game/towns.go`.

- **NPCs** are snapshot entities (kind npc, `typeId` = role | variant << 8,
  `level` = merchant kind, `name`) while a player is within 200 m of their
  settlement's edge (dropped beyond 260 m, checked twice a second); they
  walk their schedule on the movement ground (not pushed by walls: their
  routes go through doors). NPC day = zone clock + `LODESTONE_ZONE_TIME_OFFSET_S`
  (WP15 owns world time later).
- **Interact** (contracts/events.md, reach 4.5 m from the eye):
  `30 npc` (targetId = entity id; 1 talk -> 800 + 801 shop / 802 bounties,
  2 buy (arg item index) -> 807 via `Config.Granter`, 3 rest at the inn ->
  804, 4 accept bounty), `31 board` (prop id; 1 read -> 802, 2 accept ->
  803), `32 station` (forge/anvil prop id; 1 use -> `Config.Stations`
  (WP14) or 805), `33 shaft` (mineshaft structure id; 1 descend: teleport
  into a chamber of the linked cave system below the shaft). Refusals: 806.
- **Bounties**: seeded per settlement per in-game day; since playtest 1 an
  accepted one is a quest in the character's persisted quest log (max 5
  bounties; see "Quests" below); `Server.AcceptedBounties` /
  `Server.CompleteBounty` read and drop them.
- **Doors** (`internal/game/doors.go`, playtest follow-up; contracts/events.md
  Interact 34, Events 970-972): every building door with a closed front
  opens and closes with Interact 34 (open 1, close 2, toggle 3; 4.5 m from
  the eye). Doors start open. A change is never "now": each player within
  260 m of the settlement gets Event 970 stamped with the input seq it
  applies from (newest applied frame + round trip in frames from the ack
  lag, capped at 60, + 12), and `applyFrames` steps that player's frames on
  `frameGround(sess, seq)` (the zone ground with the doors closed for that
  frame, `towns.WithDoors`): old state before the stamp, new from it on,
  exactly what the client predicts. The change settles once every stamped
  player passed its seq (or after 3 s). Refused (972): a body in the
  doorway when closing (players and active NPCs, radius + 0.1 m + 0.25 s
  of their speed), a change still pending, already in that state, too far,
  unknown. Players coming within 200 m of a settlement whose doors changed
  since they last heard get a baseline (971). NPCs (`npc.DoorGate`) open
  a closed door on their route, wait, walk through and close it behind
  them once the doorway is clear. Cost: the ground is only wrapped while
  some door is not open; the tick touches doors only while a change is
  pending, and checks baselines twice a second only for settlements whose
  doors ever changed. **Persistence and zones** (`doors_sync.go`,
  `doors_store.go`, migration 0024 `door_state`): the zone owning a door's
  region decides it; other zones forward their players' (and NPCs')
  requests to it (control message `door`, refusals come back as `doorno`
  -> 972) and mirror its decisions (`doorset`, applied with their own
  stamps; the owner's doorway check also sees ghost-band players). Only the
  owner writes: the doors changed in the last second as one multi-row
  upsert through the write-behind queue (a stale row never overwrites a
  newer one), flushed again on shutdown; every zone reads the table before
  ticking (`RestoreDoors`), so a restart or a region takeover keeps closed
  doors closed and newcomers get them in the baseline. Tests:
  `doors_persist_test.go` (restart, batching, shutdown flush, two zones),
  `doors_store_test.go` (Postgres); `internal/game/doors_test.go` (close, walk
  into it, open, walk in, close from inside, push, refused on a body,
  second player gets every change, late joiner's baseline, prediction ==
  server; NPCs open and close behind them), cross-process
  `client/src/world/buildings/doorWalk.integration.test.ts` (evidence
  `docs/evidence/pt-ux-door-walkthrough.txt`).
- `LODESTONE_ZONE_NO_TOWNS=1` turns the layer off; a pre-WP20 wasm logs
  NO TOWNS and keeps the old ground.
- Tests: `internal/npc` (schedules, street walking, bounties),
  `internal/game/towns_test.go` (in-process zone on the official world:
  NPCs in snapshots, talk/shop/buy, board read/accept, inn, forge, night
  closing, mineshaft descent), and the cross-process walk into buildings
  (`client/src/world/buildings/walkIntoBuilding.integration.test.ts`,
  evidence `docs/evidence/wp20-walk-into-building.txt`: 0 corrections).


## Quests (playtest 1, CR 013)

Rules: `internal/quests` (pure: the log, steps, objectives, markers, the
starter line, bounties as quests, the wire JSON). Glue:
`internal/game/quests.go`.

- **The log** is server-authoritative: a list of quests, each a list of
  steps with one objective and the map markers of that step (`x`, `z`, an
  area radius `r` or a point, a label). Objectives: talk to an NPC role in
  a settlement, hold items (alternatives), reach a place, know a spell,
  clear a site's enemies (a group of that site wiped with you eligible, or
  arriving while it is quiet), kill a demon near a site, hand items in at a
  settlement's board/bounty keeper, kill N enemies of a family (playtest 2;
  the count is the quest's saved `tally`, kills arrive through combat's
  OnKill hook for every eligible player). A step whose objective already holds
  completes when it becomes current. Steps can hand over items (gold, a
  tome) exactly once (`loot_grants` marker `quest:<key>:<step>`); a
  finished quest pays its gold and XP. Event 950 (whole log, JSON) after
  join and on every change; 951 offer, 952 step, 953 completed, 954
  refused, 955 started; Interact 60 (accept, abandon, hand in, track).
- **Slimes in the meadows** (playtest 2, `quests.Meadows`): a brand-new
  character's first quest, at the settlement nearest them: talk to a
  townsperson (a farmer, else a guard, innkeeper, villager or merchant),
  kill 5 slimes (markers: the three nearest wild packs in the Haven, which
  the Haven tier makes all slimes, within 480 m of the town), go back.
  15 gold + 60 XP, 2 healing draughts and a leather cap; the last line
  sends you to the blacksmith. Finishing or abandoning it starts the Ward
  (tracked). No giver or no Haven packs: the Ward starts at once.
  Characters who already started the Ward never get it.
- **Ward against the night** (`quests.Ward`): starts after the slimes (it
  started on a character's first login before playtest 2; never again once
  started or done) at the settlement nearest them: talk to its blacksmith (25 gold and the line
  that explains sunsteel), mine 4 sunsteel ore (marked: the nearest cave
  whose sunlit/entrance chambers hold sunsteel veins, as an area around the
  veins plus its mouth), buy the Sunsteel Blade blueprint, forge the blade
  (marker: the forge), seek Light magic at the nearest shrine (else wizard
  tower, else structure; arriving hands over `tome:glint`) and read the
  tome (Glint goes into the first empty spell slot: there is no spellbook
  screen yet). 30 gold + 200 XP. A blacksmith re-offers it (951, with every
  step's markers) to a character who abandoned it. Places resolve once per
  settlement per process (log line `ward places`).
- **Bounties**: accept -> `quests.FromBounty` (clear: the site's area;
  slay: a demon kill within 250 m of the site; explore: reach the site's
  discovery radius; deliver: hand in at the board/keeper, which reading the
  board or talking to the keeper does automatically). 802's accepted byte
  is 2 for a job you completed (the log remembers the last 64 bounty keys).
- **Cost per tick**: nothing for players without a reach/clear objective;
  those are checked at 2 Hz (staggered). Inventory and spell changes set a
  recheck flag; kill hooks queue the group to look at on the next ticks.
- **Persistence**: accounts in `character_quests` (migration 0023, `log`
  jsonb, fenced by the WP16 epoch), through the write-behind queue on every
  change and at logout; local profiles in their save blob
  (`localsave.State.Quests`); across a handoff as the `quests` HandoffField.
- Tests: `internal/quests` (every objective kind, limits, round trip, wire),
  `internal/game/meadows_test.go` (the slimes on the official world with the
  real atlas enemies and the Haven tier: the giver, packs that spawn slimes,
  kills through OnKill, the reward, the hand-off to the Ward, abandoning,
  old characters), `internal/game/quests_test.go` (official world in process: the Ward from
  login to the Light tome incl. the blacksmith's line, the purchase and the
  slotted spell, saved and not restarted; every bounty kind on today's
  board accepted, persisted over a reconnect, deliveries handed in at the
  board, explores completed on arrival, abandon; the handoff field).

## Items and loot (WP14)

Decision 0014, CR 010, wire in `contracts/events.md` (Events 400-411,
Interact 20-22 and 41), item table `contracts/items.yaml`. Code:
`internal/items` (pure: rolls, loot tables, inventory, gear),
`internal/game/items.go` (inventory per session, gear into combat,
consumables, stations, purchases, Bitchin'), `loot.go` (kill/boss/
container/vein loot, pickups, TransferItem), `items_journal.go` (the
ordered item transaction queue), `items_store.go` (Postgres),
`items_handoff.go` (WP16), `items.go` in this directory (wiring, debug).

Playtest 2 ground loot (CR 037, `loot_ground.go`): chest items (all but
the gold) pop out onto the ground as personal pickups, kill loot scatters
0.9-2.1 m; walking over takes gold, vein drops and (auto-collect setting,
Interact 21/10, echoed as Event 400 `auto`) common/uncommon materials,
everything else needs E; a full bag stays quiet; a lost race on a public
drop gets 403/2; rare+ pickups ride the snapshot mid ring (200 m) so their
beams are seen from afar. Rolled loot stays personal (owner-only), dropped
items stay public.

- **Inventory** in zone memory, loaded at connect (Postgres for accounts,
  the signed blob for local profiles, memory only without a row); 40 slots,
  gem pouch, ore pouch, purse (`currency:gold`), equipment (two loadout
  weapons, head, body, legs). Sent whole as Event 400 (JSON) on every change.
- **Persistence**: every change is one transaction on the item journal, in
  order, retried until it commits; rolls and takes carry a `loot_grants`
  marker (exactly once, spec 11); ops are fenced by the WP16 ownership epoch.
  Shutdown flushes the journal after the write-behind queue.
- **Loot**: combat's `OnKill` → personal owner-only pickups per eligible
  player (logged seed), boss weekly lockout; containers (worldgen chunk
  records, listed by Event 406 within 96 m) open once per character into the
  bag, rolled at the area's discovery-stamped level (the level its enemies
  have: the Haven's chests give starter gear; worldgen's region-danger
  curve only while the area is unknown or difficulty is off,
  `lootLevelAt`); vein drops (WP09) are granted through the same path.
- **Drops**: Interact 21/2 → TransferItem → a public pickup for 10 minutes
  (`LODESTONE_ZONE_DROP_DESPAWN`), a world row in Postgres restored after a
  restart; Interact 41 takes it; local-profile drops are unverified.
- **Stations**: forge/anvil (WP20 `Config.Stations`; 805 still opens the
  UI), hearth/campfire (Interact 22/2, Event 404); craft with Interact 22/1.
  Unsocketing keeps the gem within 8 m of a town forge/anvil; gems combine
  within 8 m of a waypoint.
- **Env**: `LODESTONE_ZONE_DROP_DESPAWN` (default 10m),
  `LODESTONE_ZONE_TEST_ITEM_TX_DELAY_MS` / `_COMMIT_DELAY_MS` (kill-mid-grant
  test hooks only).
- **Debug**: `GET /debug/items?char=<id>`, `GET /debug/containers?x=&z=&r=`.
- **G4 fix**: Event 406 is resent whenever the set of listed containers changes, not only on a new chunk (a chunk the terrain cache finished after you entered used to leave its chest without an [E] prompt; `TestContainerListResentWhenALateChunkArrives`).
- **Tests**: `go test ./internal/items/`, `./internal/game/ -run "Item|Drop|Loot|Smelt|Buy"`
  (in process, incl. the real 10-minute despawn on the zone clock and the
  handoff), `TestItemOpExactlyOnceAndFence` (Postgres), and the process
  tests here: `TestZoneProcessKillMidGrantNeverDuplicates`,
  `TestZoneProcessDropPickupDespawn`, `TestG4LoopForgeSunsteelBlade`
  (`bash testdata_evidence_wp14.sh` writes their logs to `docs/evidence/wp14-*`).

## Night, demons and chemistry (WP15)

Decision `docs/decisions/0015-night-chemistry.md`, contract
`docs/cr/011-wp15-night-chemistry.md`, wire `contracts/events.md` 500-526 and
Interact 50/6, 51, 52.

- **World clock**: world time = wall clock + `LODESTONE_ZONE_TIME_OFFSET_S`
  (set the same value on every zone of a world). Event 500 tells clients the
  offset; NPC schedules (towns.go), rain (traversal.go) and demons use it.
- **Demons** (`internal/game/night.go`, `internal/night`, `internal/combat/demon.go`):
  lesser packs around players in the open at night, greater demons by region
  element, lords at demon lairs on new moons; regenerate from ordinary damage,
  die to sunsteel (loadout material `sunsteel`), Light, or sunrise (those near
  a lair or cave mouth flee). Wards (settlement radius + 10 m) block them;
  players inside are left alone. `LODESTONE_ZONE_NO_DEMONS=1` stops night spawns.
- **Town defense**: seeded per town per night; `LODESTONE_ZONE_DEBUG_DEFENSE=spawn|<town>[,delay]`
  forces one; dev Interact 52 action 1 starts one at the nearest town.
- **Chemistry** (`internal/chem`): fire, ice, pillars, rain on a 2 m grid,
  ops scheduled 3 steps ahead and broadcast within 256 m; chunk baselines for
  newcomers; `LODESTONE_ZONE_CHEM_SYNC=bitmap` (or a client's Interact 51/10)
  switches to 2 Hz bitmaps. Ice sheets and pillars are on the movement ground
  (night.go wraps the production ground, keeping its methods). Fire feeds the
  movement step's updrafts. `LODESTONE_ZONE_NO_CHEM=1` turns it off.
- **Dev** (`LODESTONE_ZONE_DEV_NIGHT`, default on with the dev ticket key):
  Interact 51 actions 1-4 (ignite, freeze, extinguish, pillar), 52 actions
  1-3 (defense, set the clock offset, raise demons); with
  `LODESTONE_ZONE_DEV_COMBAT`, Interact 50 action 6 sets the weapon material
  (sunsteel = 3).
- `GET /debug/night` (`?hashes=1` chemistry digests per step, `?towns=1` wards).
- Acceptance: `node server/zone/cmd/nightbots/acceptance.mjs` (demon immunity
  vs sunsteel vs sunrise; a two-bot town defense), `npm run fire:accept -w client`.

## Scale (WP19)

Fixes from the spec 14 soaks (details and numbers:
`docs/decisions/v1-capacity.md`, `docs/evidence/wp19-*`). Wire format and
per-client output are unchanged; equivalence tests prove it.

- **Parallel snapshot phase** (`internal/game/snapshots.go`): each client's
  interest + delta snapshot is built on `GOMAXPROCS` workers
  (`Config.SnapshotWorkers`; serial below 32 sessions), claiming 2 sessions
  at a time. It must stay the tick's last phase: workers only read the
  world. `TestParallelSnapshotsMatchSerial` checks every client gets the
  same bytes as the serial build.
- **Interest without sorting**: grid hits go into a bitset read back in
  index (= id) order; WP16 mirrors are sorted by id once per tick
  (`gridRemotes`) and merged. "Known" hysteresis walks the encoder's last
  frame with a cursor (`snapshot.KnownCursor`). Distances use
  `Sqrt(dx²+dz²)`. `TestGatherInterestMatchesReference` compares with the
  old gathering.
- **Two AOI grids**: players (and anything with a party id) in the 616 m
  grid, everything else (enemies, townsfolk, pickups) in a second grid
  queried 200 m out (`aoi.QueryRadiusOthers`): Classify never sends those
  beyond the mid ring, so interest sets are the same; clients just stop
  walking 2,000 distant enemies.
- **Compact per-tick views** (`buildViews`): the interest loop reads a
  contiguous array (position, id, kind, party, owner, cave system, name id)
  and the quantized states instead of chasing `*Entity`.
- **Combat debug on demand**: `/debug/combat` is built only while it is read
  (10 s after the last read; a read waits up to ~1 s for a fresh one). New
  metric `zone_combat_awake`.
- **Tick phase timing**: `/debug/tickstats` adds `phases` (mean, max and the
  slowest tick's split of inputs / world / combat / towns / grid /
  snapshots over the last minute), `internal/game/phases.go`.
- Dev knob `LODESTONE_ZONE_DEBUG_HORDE="cx,cz,radius,enemies[,level]"`:
  camps of four over a disc (scenario 1's 2,000 awake enemies).
- Benchmark: `go test ./internal/game -run '^$' -bench Scale -cpu 4`
  (`scale_bench_test.go`: in-process tick at 150/300/460 players, 300 + 2,000
  enemies; flat ground, fake connections, no profiler hazards).

### Second pass (WP19b)

The serial part of the scenario 1 tick (input + movement ~1.8 ms, combat AI
~2.5 ms) now fans out over the same workers. The rule everywhere
(`internal/game/par.go`): a worker writes only the items it was handed;
shared state is read-only during the phase; anything order-dependent is
put together on the tick goroutine afterwards in a fixed order, so the
result does not depend on the number of workers.

- **Worker pool** (`parallelFor`): the wait counts items, not goroutines, so
  a phase never waits for a helper the OS has not scheduled yet (it would
  find nothing left and exit). Snapshots use it too.
- **Inputs** (`internal/game/inputs.go`): inboxes are taken first; a session
  whose input this tick is plain movement (no attack, cast, drink, mobility
  dash, Interact or HitClaim) applies its frames on a worker; everything
  else (and leaves) runs on the tick goroutine at its place in session
  order after the plain run before it. Exact: plain sessions touch only
  themselves. One atomic per session for the frame counter.
- **Combat AI** (`internal/combat/par.go`): simple enemy groups think on
  workers, each group on one worker, outputs (events, strikes, enemy
  shots) merged back in spawn order; bosses, demons and enemies with a
  damage-over-time status stay on the old path. The one cross-group rule,
  "at most two wind-ups on one player", counts other groups' wind-ups as
  they were at the start of the tick, and requests are admitted in spawn
  order against the live count, so the cap holds exactly (a refused enemy
  stands still that tick). `TestPartitionedAIMatchesAcrossWorkers`.
- **Combat glue**: the enemy -> entity mirror and the delivery of combat
  Events run per entity / per session on workers (`deliverCombatAll`: each
  connection gets its events in the same order).
- **Views**: view extrapolation + quantization per entity on workers; the
  AOI grids still fill in id order on the tick goroutine.
- **Downlink budget includes reliable traffic** (decision 0005): the
  transport counts reliable bytes when queued (`Stats.ReliableQueued`), and
  each snapshot first charges what was queued since the last one to the
  client's budget (`snapshot.Encoder.Charge`, debt capped at one burst).
  Snapshot + events stay within 150 kbps. Metric
  `zone_budget_reliable_charged_bytes_total`.
- **Per-region load** in the registry heartbeat (`Entry.Load`, counted once a
  second): the director moves regions off an overloaded zone
  (`server/director/README.md`, `zoneregistry.Rebalance`).
- Benchmark on real terrain: `LODESTONE_BENCH_TERRAIN=1 go test ./internal/game
  -run '^$' -bench Scale/p300_e2000 -cpu 4` (needs `npm run build:wasm`; no
  `-cpuprofile` with it on Windows). It reports per-phase means
  (`inputs-ms`, `combat-ms`, ...).

### G5: 4 vCPU (2 cores + SMT siblings)

Scenario 1 passed on 4 dedicated cores but not on a real 4 vCPU slice (two
cores and their hyperthreads share execution units). Less work per tick,
nothing changed on the wire (`docs/decisions/v1-capacity.md` "4 vCPU
follow-up"; a digest of every snapshot and reliable byte of two
deterministic scale runs, 90 clients x 400 ticks and 300 clients x 300
ticks with 600 / 2,000 enemies, is identical before and after):

- **Shared state store for snapshot baselines** (`server/pkg/snapshot`
  `History`, `snapshots.go buildViews`): the tick's quantized states are
  written once into a store every client's encoder refers to; frames hold
  24-byte references instead of 40-byte copies, and "changed since the
  baseline" is answered from a fingerprint and the entity's
  unchanged-since tick (`Entity.histSince`) without touching the baseline
  state. Baseline memory per crowded client ~40 % smaller.
- **Interest loop**: due rings per entity once per tick (`aoi.DueAll`,
  was a modulo per client per entity); the second grid skips the 200 m
  square's corner cells (`aoi.QueryMarkWithin`); grid hits go straight into
  the bitset (`aoi.QueryMark`); the newest frame is searched only for
  players at the far ring's edge (`aoi.UsesKnown`).
- **World phase**: every entity's cave system on the workers
  (`caveTick`); the terrain cache answers without a lock or a shared
  counter (`worldhost.Terrain`); the chem ground no longer boxes its inner
  ground on every query (`night.go`).
- **Combat**: `spawnTick`'s once-a-second spike (`internal/combat`).
- Benchmark: `scale_bench_test.go` adds the process CPU per tick
  (`cpu-ms` on Linux, `cpu-Mcycles` on Windows, where process times are
  sampled too coarsely) and `snapshots-p99-ms` / `combat-p99-ms`.
  Reproduce the 4 vCPU case on Windows with `start /affinity F000`
  (logical CPUs 12-15 = cores 6-7 and their siblings; check the topology)
  and on Linux with `tools/soak/linux/bench-inprocess.sh`.


## Progression and difficulty (playtest 1)

Decision: `docs/decisions/0021-discovery-difficulty.md`. Contract: `docs/cr/012-progression-difficulty.md`.

- **Discovery-stamped areas** (`internal/difficulty`, glue
  `internal/game/difficulty.go`, wiring `difficulty.go`): 256 m areas are
  stamped once, first writer wins in Postgres `area_difficulty` (migration
  0021; `MemStore` without a database), from the level of the first player
  to come within 200 m, smoothed against stamped neighbours. The Haven (420 m
  around the world spawn) is level 1 forever. Lookups on the tick are O(1)
  (a flat array); claims go to one worker goroutine over a channel and come
  back over another, so no tick touches the database. Atlas groups spawn
  only in known areas at the area's level and tier (slimes in the Haven,
  half slimes in quiet lands, elites scaled); Event 901 tells the player
  the area they stand in. `GET /debug/difficulty` lists known areas,
  claim counters and players. `LODESTONE_ZONE_NO_DIFFICULTY=1` restores the
  WP13 region danger curve.
- **Demon pacing** (`night.go` hooks): hunters, greater demons, lords and
  defense events scale by the area's tier (none in the Haven and quiet
  lands; a slowed straggler in the wilds); players below level 6 are not
  hunted within 90 m of a ward; demons never rise in an area whose tier has
  none. Dev raises (Interact 52/3) ignore tiers. WP15's rules are unchanged.
  Also fixed: zones without a cave world read every entity's `caveSys` as
  0 ("underground"), so natural hunts never ran in flat test zones.
- **Leveling** (`internal/game/progression.go`, `combat.yaml leveling`):
  health +12, damage +10 % (every attack, spell and DOT), stamina +2 (the
  movement state's `StaminaMax`, on `SelfState`) and a skill point per
  level; spell tiers gated by level for skill-point learning (`LearnWith`).
  Every level-up goes through `levelChanged`: 604, a full refill,
  combat_sync, Event 900 `character_stats` (reason 1). 900 also goes out at
  join and after attunements.
- **Crystal attunement**: Interact 10 action 2 on a tower's top
  (`explore.World.Attune`, server-validated like the unlock): the first
  time per tower, a permanent boon (+8 stamina, +5 health, +1 skill point,
  +100 XP; derived from `character_progress.attuned`), Event 902
  `tower_attuned` (the hook for the client's discovery moment), else 903.
- Tests: `internal/difficulty` (rule, Haven, first writer wins in memory
  and on Postgres), `internal/game/progression_test.go` (Haven at night,
  level-15 stamp, quiet lands, two in-process zones agree, wilds night
  pacing, level-up stats, attunement once + saved, wire vectors),
  `internal/combat/sim_test.go` (beginner time to kill, the level curve),
  `zone_progression_integration_test.go` (zone processes + Postgres:
  `docs/evidence/pt-progression-process.txt`).

## World content (playtest 2, CR 023)

`contracts/content.yaml` (generated `server/pkg/contentdefs`) is the data;
`internal/content` the pure logic (side quest generator, story builder,
per-character state, herb patches, vault plans and seals, event picks; all
seeded, no I/O); the glue is `internal/game/content.go` (state, persistence
in `character_content` / the local blob / the `content` handoff field,
Interact 80, regions, feats, titles, places near you, renown and shop
stock), `content_quests.go` (offers on talk, accept, rewards, rescued
villagers), `worldevents.go` (scheduler, the five events, personal rewards)
and `dungeons.go` (sealed vaults: discovery, packs, seals, the Vault Keeper,
the chest). Everything is off in worlds without an atlas or towns
(`contentOn`), which keeps the scale scenario's wire digest unchanged.
Events 1000-1022 and Interact 80: `contracts/events.md`. Env:
`LODESTONE_ZONE_NO_WORLD_EVENTS=1` (kill switch), `LODESTONE_ZONE_VAULT_PACKS=0`
(evidence runs). `GET /debug/content`: vault plans, live events, tablets,
quest givers.

## Camps (playtest 2, CR 025)

`internal/game/camps.go` (state, Interact 90, Events 1100-1107, area baselines, Rested, respawn, decay,
night hooks, WP16 `campset`), `camps_chest.go` (storage chests through the item journal), `camps_store.go`
(`camp_pieces`, migration 0026; `PGCampStore`); pure rules and the Go half of the collision twin in
`server/pkg/camps`; data in `contracts/camps.yaml` (`server/pkg/campdefs`).

- Placement: `camps.Check` (reach, settlements, slope, water, caves, overlaps with town boxes and other
  pieces, someone else's camp, one camp of at most 6 pieces) plus bodies for solid pieces. The kit is spent,
  the row written once that committed.
- Solid pieces (chest, workbench, signpost) are pushed out of after the doors in the movement step
  (`frameGround` -> `campWrap`, within 24 m of one) and block enemies (`enemyBlocked`).
- A burning campfire (`burn_until` on the world clock): no demon rises within its circle + 6 m, none steps
  in, players inside are sheltered and get no hunters (`campSafeAt`, read by the AI workers from a list the
  tick replaces).
- Bedroll: `RespawnPoint` puts its owner beside it; resting gives Rested (`combat.Player.RegenMult`,
  `ManaRegenMult`, the stamina wheel through `applyProgression`).
- Decay: the authority removes a camp whose owner has not been within `decay.visitM` for `decay.days`
  (checked every `decay.checkEveryS`; never while the owner is online).
- `GET /debug/camps`: every piece (kind, owner, position, fuel, chest fill, which zone is its authority).
- `CampStore` is `nil` without a database (dev tickets, evidence runs: memory only).

## Mounts (playtest 2, CR 027)

`internal/game/mounts.go` (`docs/cr/027-mounts.md`). A Spirit Whistle (general stores) bonds a spirit steed on its first call
(Interact 110/1); every call brings it (gallops in over `STEED_ARRIVE_S`, or materializes). Owned steeds load before join
(`MountStore`: `character_mounts`, migration 0028; local saves: `mounts`) and ride a handoff field (`steed`).

- Mount (110/2: within `STEED_MOUNT_REACH_M`, on the ground, not dashing) sets `movement.FlagMounted` on the player's state;
  only the zone sets it, the shared step only clears it (`server/pkg/movement/ride.go`). Get off: 110/3, or the step (Space
  at a standstill, a hard landing, deep water). `mountsTick` watches riders: dropped by the step or a teleport (the steed
  stands beside you, or stays behind), hits (`STEED_HIT_DISMOUNT_CHANCE`), demons at night (`STEED_SPOOK_*`: thrown, the
  steed bolts, a cooldown).
- `mountedFrame` (in `combatFrame`) strips dodges, dashes and sword/spear moves from a rider's frames; bows, staves, wands
  and spells work. Validation: mounted speeds only while mounted (`movement.MaxHorizontalSpeed`).
- Wire: player typeId bit 14 (`TypeRiding`) while riding; Events 1140-1143 (your steed; steeds within `STEED_SEE_M` on
  change and to newcomers every 2 s; refusals; thrown). Nothing is sent while nobody has a steed (wire digest unchanged).

## Pets (playtest 2, CR 029)

`internal/game/pets.go` (the glue), `internal/combat/pets.go` (the companion in the combat world), `internal/content/pets.go`
(records, the taming roll, levels and stats; pure). `docs/cr/029-pets.md`; data: `contracts/content.yaml` `taming`.

- Taming: the combat world reports a tameable creature (`World.Tameable`, set only when content is on) hurt below
  `taming.weakenPct` (`PetOutputs.Weakened`); if the player who hurt it, or anyone within `smellM`, carries a food it likes,
  `World.Calm` stops it (it stands and sniffs; a hit breaks it: `CalmBroken`) and Event 1201 tells players near. Interact
  130/1 feeds it (one food spent, the favourite first) and starts the meter (1202); `tameTick` interrupts it when the tamer
  walks off (`stayM`), is hurt, goes down, or the calm ends; at the end `content.RollTame` (world seed, character, roll count,
  creature) decides: `World.Tame` removes the creature (no XP, no loot, its group quietly cleared) and the pet is added (the
  active one when none is out), or it fights on.
- The pet out is an Enemy with an ally record (the CR 020 summon machinery: `allyStrike` / `allyHit`, `moveToward`) kept in
  `World.pets` and `summonIdx` (so the host mirrors it as EntityKind effect, `combat.PetTypeID`, named "Owner's Name").
  `petThink`: follow (a spot behind its owner, catching up faster the farther it is; beyond `warpM` it is set down beside
  you), stay (holds its spot, guards `stayGuardM`), an attack order (Interact 130/2); it only joins fights (never wakes a
  sleeping or idle creature), uses its ability (heal, buff, charge, strike) and regenerates out of a fight.
- Enemies: a pet's bites build `petThreat`; while it beats the player threat the creature chases the pet (`chasePet`, a
  serial-AI path, `windupAt`), and enemy strikes (`strikePets`) and shots (`shotHitsPet`) hit pets in their area. At 0 health
  the pet is knocked out (`PetOutputs.KO`): removed, its record recovers at home for `koRecoverS`, then it comes back to you.
  The creature a pet bit last gives it XP when it falls (`PetOutputs.XP`; `content.PetRec.GainXP`, stats `content.PetStats`).
- Persistence: one JSON per character (`PetStore`: `character_pets`, migration 0029, epoch-fenced; local saves `pets`),
  a handoff field `pets` (the next zone puts the pet out beside you). Stables: within `stableM` of one of your camp pieces,
  or in a town (anywhere in a world with neither).
- Wire: pets are ordinary snapshot entities (one per player with one out); Events 1200-1205 go to pet owners, tamers and
  players within 48 m of a calm creature or a pet's act. The scale world has no content, so `LODESTONE_WIRE_DIGEST=1` is
  unchanged.

## Vertical world (playtest 2, CR 038)

genVersion 3 adds sky archipelagos, the Underground and the Depths
(`worldgen/README.md` "Vertical world", `docs/cr/038-vertical-world.md`).
The zone runs them when the wasm has the vertical exports;
`LODESTONE_ZONE_NO_VERTICAL=1` turns them off, `_LAYER_CACHE` / `_LAYER_WORKERS`
size the LOD 0 layer-tile cache (`worldhost.Layers`: pure Go collision from
cached tiles, a wasm `layer_height` on a miss, background builds fed by
interest). `GET /debug/vertical`: cache counters and descriptor counts.

- **Ground** (`caves.go` `withVertical`): `worldhost.CaveTerrain.WithVertical`
  wraps the cave ground in `server/pkg/vertical.Ground`, the line-for-line twin
  of `VerticalGroundCore` (worldgen/js): island tops and undersides, the
  Underground and Depths floors and ceilings, tunnel / cenote holes in the
  terrain, Depths gates in the Underground floor, columns, shaft walls. The
  towns layer stays on top (sky towns' buildings work like any town's).
  `CaveTerrain.LayerAt(x, y, z)`: 0 surface (and caves), 1 sky (on an island
  or in the sky band over an archipelago), 2 Underground, 3 Depths.
- **Movement env**: the descriptor's wind columns (sky lifts 18 m/s, wind
  columns and currents 10, geysers 10) join the updraft field
  (`night.go nightUpdraft`, `vertical.Wind`); gliding is free in an updraft of
  at least `UPDRAFT_FREE_LIFT` (8) and anywhere in the sky band over an
  archipelago (`movement.FreeGlider`). Constants v8: `UPDRAFT_MAX_LIFT` 20,
  `TERMINAL_FALL_SPEED` 54.
- **Per-entity layer** (`internal/game/vertical.go verticalTick`, on the
  workers like `caveSys`) and **3D interest**: entities in different layers
  more than 80 m apart vertically are not in each other's snapshots (party
  exempt). Flat and atlas-less worlds have no vertical world: the G5 wire
  digests are unchanged.
- **Fall damage** (server-authoritative): a step that lands from the air
  faster than 18 m/s costs (v - 18) x 3.2 % of max health (no armor), none in
  swimmable water, gliding, climbing, dashing or riding; Event 1700.
  **Lava**: the Depths' water surface is lava: 35 %/s, Event 1701 on/off.
- **Difficulty per layer** (`internal/difficulty`): the sky, the Underground
  and the Depths have their own 256 m areas (index `layer * 256 + cell`; the
  store row's `cell_z = layer * 16 + z`, no migration), stamped like the
  surface's but never below sky 10, Underground 6, Depths 20 (the top tier).
  A player stamps and is told (Event 901, `y` = layer) the areas of the layer
  they stand in.
- **Enemies** (`addLayerGroups`): packs on dry, walkable cavern and Depths
  floors (1-5 per chamber, never within 45 m of an underground camp or by a
  column) and on sky islands that are not a town or palace;
  `combat.LayerTables` (caverns: crawlers, gloom bats, crystal golems,
  shades, void mites; the Depths: gloamlings and greater demons of the
  Starless host, CR 035; the sky: harpies, wisps, moths). Layered groups
  spawn, wake and walk in 3D on their layer's floor and take the layer's
  area level. Depths kills pay like elites with 2.5x luck.
- **Mining**: the descriptor's veins (bands 3 and 4) are in the vein
  registry (`layerVein`); a mined one vanishes (edit radius 0) and respawns.
- **Sky towns**: townsfolk placed on the island (`npc.Place`) and woken by
  3D distance (a player on the ground below never wakes them); shops, inns,
  boards and forges work as anywhere. Story, content and quest picks keep to
  base sites and surface towns (`skyTown`, `structures.Site.IsBase`), so
  every existing sequence and the Heartfall stay where they were.
- **Exploration**: discovery XP for the new sites (tunnel 50, cavern 70,
  depths 90, gate 40, archipelago 40, sky lift 20, palace 100, sky ruin 50,
  sky towns as towns) within a vertical reach (sky 45 m, archipelago 260,
  underground 110); sky-town and camp waypoints touch and fast travel on
  their layer's floor.
- **Mounts**: the whistle is refused underground (4) and in the sky (11).
- **Vibe explorer**: landmark filters tunnel, cavern (crystal / cenote /
  river / fungal), depths, depths_gate, archipelago, sky_town, sky_palace,
  sky_ruin, sky_lift; a layer filter (`layer=` / packed bits 54-56); results
  carry `y` and `l` and the layer's area; landings on the layer's floor (dry,
  walkable, off columns and buildings).
- **Saved positions** (`safeSaved`): a character saved on terrain that is now
  a hole lands on the opening's rim, one inside an island's rock on its top,
  one in rock with nothing under it at the spawn. World renewal 2 -> 3
  (`mintdb.RenewOfficial`) resets characters saved within an opening's
  radius + 8 m to the spawn marker.
- **Hooks for the follow-up agents**: the **sky palace** is an atlas
  structure site of kind 9 (`sky_palace`, layer 1) on a big island, drawn
  from its PALACE decoration (`aux` = the site index); Interact **150**
  (target = that site index, action 1) answers Event **1702** (value 0: the
  doors are sealed). The **sky activity** spot is a towns prop of kind 31
  (`ACTIVITY`) in every sky-town square; Interact **151** (target = its
  stable id, action 1) answers Event **1703** (value 0). Replace the stubs in
  `internal/game/vertical.go verticalInteract`.

Tests: `internal/game/vertical_test.go` (official world: layers, interest,
safe saved positions, a sky town's townsfolk in 3D + a merchant + the
activity hook, fall damage, lava, packs per layer and layered areas, vibe
layer filters and landings), `server/pkg/vertical` (golden vectors),
`server/pkg/movement/vertical_golden_test.go` (the TS movement goldens on the
vertical ground), `mintdb` `TestRenewOfficialToVertical`.
