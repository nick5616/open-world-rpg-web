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
