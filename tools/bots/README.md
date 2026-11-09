# tools/bots

Headless Go bot players for zone soak tests (spec 14). Each bot signs a dev
connect ticket, connects over WebSocket, runs Hello, sends 30 Hz `Input`
packets carrying 60 Hz frames (two new plus one repeat), acks every snapshot,
decodes every frame with the generated codec (`server/pkg/proto`) and the
reference snapshot decoder (`server/pkg/snapshot`), and predicts its own
movement with `server/pkg/movement` to check the server agrees to the
centimeter.

Movement personas (ideas from wizard-wars `server/src/systems/BotAI.js`):
walker (long straight segments, occasional sprint), strafer (left/right flips
every 0.4-0.9 s), jumper (jumps every 1-3 s, half of them double jumps), idler
(mostly standing). Headings change every 2-6 s and turn at most 3 rad/s.

## Run

The zone must run with the dev ticket key (the default when
`LODESTONE_TICKET_PUBLIC_KEY` is unset), which also enables the dev-only
`?spawn=x,z` the bots use to place themselves.

```
go run ./server/zone
npm run bots -- -n 20                      # same as go run ./tools/bots -n 20
go run ./tools/bots -n 150 -mode spread    -duration 75s -json spread.json    -metrics-out spread.prom
go run ./tools/bots -n 150 -mode clustered -radius 300 -duration 75s -json clustered.json
```

| Flag | Default | |
| --- | --- | --- |
| `-url` | `ws://localhost:8092/ws` | zone endpoint |
| `-n` | 150 | bots |
| `-mode` | spread | `spread`: uniform over the world (typical exploring, budget 64 kbps). `clustered`: uniform in a disc of `-radius` around `-center`, steering back inside (100+ players in view, budget 160 kbps) |
| `-radius`, `-center` | 300, `2048,2048` | cluster disc |
| `-duration` | 60s | play time after connecting |
| `-warmup` | 8s | excluded from bandwidth rates (connect ramp, first full snapshots) |
| `-ramp` | 4s | connects spread over this long |
| `-zone`, `-world` | env `LODESTONE_ZONE_ID` / `LODESTONE_WORLD_ID`, else read from the zone's `GET /debug/zone` | ticket audience and world (the zone may serve WP04's official world, a generated uuid) |
| `-ticket` | | connect ONE bot with this ticket, or `@file`, e.g. from the director's `POST /v1/connect` (no dev spawn: the character row decides) |
| `-json` | | write the summary (plus per-bot rows) as JSON |
| `-metrics`, `-metrics-out` | derived from `-url` | scrape the zone's `/metrics` before disconnecting and save it |
| `-terrain` | auto | `auto`: when the zone reports terrain (`atlasHash` in `/debug/zone`), rebuild the same world with `worldgen.wasm` (refusing if the atlas hash differs), predict on it, spawn on dry land, turn back from the sea; `on` requires it; `off` predicts on flat ground |

The summary prints downlink/uplink kbps (avg/p50/p95/max across bots,
including WebSocket framing, excluding TCP/IP), entities in view, snapshot
sizes, decode/apply errors, prediction checks, kicks, and the zone's tick and
AOI metrics, then `PASS` or `FAIL` against the WP03 budgets (exit code 3 on
FAIL). RTT is measured with `time.Now`, which moves in ~0.5 ms steps on
Windows, so local RTTs read as 0-0.1 ms.

## Terrain (WP07)

With terrain, all bots share one `worldhost.Terrain` (a thread-safe chunk
cache) built from the zone's `/debug/zone` (seed, spec, genVersion,
atlasHash). Their chunks are generated before connecting, each bot keeps
asking for chunks around itself, and on Welcome a dev-spawned bot takes y
from its own terrain (Welcome's y is cm-rounded; the server stands exactly
on the ground). The summary adds `predictionMismatches` (checks off by >= 1
cm before that bot's first resync; after a resync a bot replays from
cm-quantized state, so 1 cm rounding noise is expected) and a `terrain`
block (world, the bots' height range, cache counters), and prints the zone's
`zone_terrain_*` metrics. Use `-ramp 10s` on a busy machine: starved bots
send bunched packets that trip the zone's frame budget (dropped frames show
up as resyncs, unrelated to terrain).

## Test

Exercised end to end by the soaks (`docs/evidence/wp03-soak-*`,
`docs/evidence/wp07-soak-*`); the zone's own tests cover the protocol paths.
`go test ./...` covers personas, the verdict and (with the built wasm) land
spawns and sea avoidance. `go vet ./...` must stay clean.

## Multiple zones (WP16)

`-cluster http://127.0.0.1:18310,http://127.0.0.1:18312` points the bots at cluster zones' `/debug/cluster` (any live one; the list of live zones is learned from the registry). Each bot then follows the handoff protocol exactly like the browser client: pre-connects on `ZoneTransfer` kind 0, switches to a standby connection when its Welcome arrives (resending unacknowledged frames, keeping its prediction), keeps the old connection as a standby, and fails over (owner of its position, fresh dev ticket, no spawn hint: the zone loads the last checkpoint) when its active zone dies.

- `-mode cross`: `-cross-frac` (0.4) of the bots spawn within `-border-spawn` (150 m) of a border between zones and keep walking 40-120 m past the nearest one and back; the rest walk the world like `-mode spread`.
- `-sample-every 2s`: polls every live zone's owned characters; a character owned by two zones, or a playing bot owned by none for two samples in a row, fails the run.
- Verdict (spec 14 scenario 2): every bot still connected at the end, no failover gave up, no entity id change across a switch, no duplicated discovery grant (WP12 discovery XP is once per character per site: the stand-in for items until WP14), ownership never duplicated; plus the usual budgets and each zone's tick p99 against `-tick-budget` (12 ms with `-cluster`).
- Reported: handoffs and the gap between the old zone's last snapshot and the new zone's first, prediction checks right after each switch (must be 0 cm), pre-connects, failovers (time to reconnect, rewind distance to the checkpoint), per-zone ticks and handoff counters.
- `-print-characters -n N` prints the bots' deterministic character ids; `go run ./tools/bots/cmd/seedbots` inserts them into a scratch database (`lodestone_wp*` only) so zones checkpoint them like real characters (`-move "Name:x,z;..."` places characters by name). `-find-border X` prints a walkable crossing of the region line x = X.

The whole acceptance run (scratch database, director, N zones, netsim per zone, bots, an optional hard kill of a pool zone):

```
node tools/bots/handoff-soak.mjs --bots 1000 --zones 3 --duration 10m
node tools/bots/handoff-soak.mjs --bots 1000 --zones 3 --duration 6m --profile thailand --kill-after 3m --tag thailand-failover
```

Evidence goes to `docs/evidence/wp16-soak-<tag>.txt|json`.

## Scale soaks (WP19)

`scale-soak.mjs` runs spec 14 soak scenario 1 (300 bots in one region plus
2,000 awake enemies): one zone on the official world's terrain with
`LODESTONE_ZONE_DEBUG_HORDE`, no Postgres/Redis, a fresh world id, the zone
at `GOMAXPROCS=4`, bots clustered in a 300 m disc inside region (1,1).
Every 5 s it samples `/debug/tickstats` (60 s window quantiles + phases) and
`zone_combat_awake`; evidence `docs/evidence/wp19-s1-<tag>.txt|json|prom`.

```
node tools/bots/scale-soak.mjs --bots 300 --enemies 2000 --duration 3m
node tools/bots/scale-soak.mjs ... --profile thailand      # scenario 4 variant
node tools/bots/scale-soak.mjs ... --zone-bin base.exe     # a prebuilt (baseline) zone
node tools/bots/scale-soak.mjs ... --zone-affinity F000 --bots-affinity 0FFF   # pin (Windows)
node tools/bots/scale-soak.mjs ... --pprof                 # 10 s CPU profile at t=90 s (diagnostic)
```

`handoff-soak.mjs` (scenario 2) gained `--zone-bin`, `--evidence-prefix` and
`--base-port`/`--db` are used to keep runs apart; binaries get unique names
per run (`soak-<name>-<run>.exe`).
