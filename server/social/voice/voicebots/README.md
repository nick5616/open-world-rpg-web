# voicebots: the voice soak (spec 14 scenario 3)

50 bots, each a zone player, a social session and a LiveKit participant
publishing synthetic Opus speech, cluster within 14 m, walk outward for 20 s
(4.9 m/s), stand, walk back, stand. The tool records every earshot decision
the zone publishes (`voice:{worldId}`) and every subscription change each bot's
LiveKit client sees, then reports:

- **latency** from the zone's decision to the listener hearing (TrackSubscribed)
  or stopping hearing (last audio packet + 20 ms), and separately the
  track-ended event (LiveKit's 1 s downtrack flush) and the geometric latency
  from the distance crossing 40 m / 48 m;
- **missed** decisions (never reflected within 5 s) and **extra** changes (no
  decision behind them);
- **flaps**: a pair whose subscription reverses within 2 s without the zone
  asking, and zone decisions that reverse within 2 s; changes per pair.

Verdict PASS = nothing missed, nothing extra, no flaps, p99 ≤ 500 ms.

## Run

It is its own Go module, outside `go.work`, so pion and the LiveKit SDK stay
out of the services' dependency graph:

```
cd server/social/voice/voicebots
GOWORK=off go run . -spawn -out ../../../../docs/evidence/wp11-voice-soak-50
```

`-spawn` builds the zone and social binaries from the workspace and runs them
on ports 18392/18393 (refuses if taken) against the shared Redis and Postgres,
with flat ground. Flags: `-bots`, `-hold`, `-disperse`, `-regroup`, `-cluster`,
`-livekit` (the URL the spawned social hands out), `-trace-bot N` (one bot's
SDK debug log: SDP timing).

**LiveKit must use a muxed UDP port** (`rtc.udp_port`). The compose file does
since WP11; a container still running the old `port_range` 7900-7950 config
fits ~25 participants (two PeerConnections each) and bots 26+ fail to connect.
Recreate it (`docker compose -f infra/docker-compose.yml up -d livekit`) or run
a private one:

```
docker run -d --name wp11-livekit-soak -p 17880:7880 -p 17881:17881 -p 17882:17882/udp \
  livekit/livekit-server:v1.8 --dev --bind 0.0.0.0 --node-ip 127.0.0.1 \
  --config-body "rtc: {udp_port: 17882, tcp_port: 17881, use_external_ip: false}"
GOWORK=off go run . -spawn -livekit ws://localhost:17880
```

## Files

| File | What |
| --- | --- |
| `main.go` | Flags, spawning, phases, pacer (one 20 ms ticker writes every bot's next Opus packet), report |
| `bot.go` | One bot: zone session (Hello, 30 Hz input, own movement simulated with the zone's Go step), social `voice_token`, LiveKit join with auto-subscribe off, microphone track, RTP reader (the Go SDK has no event for a server-side unsubscribe; the track ending is it) |
| `record.go` | Event log; rebuilds the zone's sets from the earshot messages |
| `analyze.go` | Matching, latencies, flaps, verdict (`analyze_test.go`) |
| `testdata/speech.opus.bin`, `gen-opus.mjs` | 4 s of speech-like synthetic voice as 20 ms Opus packets, encoded once by headless Chromium (WebCodecs) because there is no cgo/libopus here |

## Test

```
GOWORK=off go test .     # verdict logic on hand-made timelines
GOWORK=off go vet . && gofmt -l .
```

(`npm run lint` / `npm run test:go` walk the `go.work` modules only, so run
these by hand when changing this module.)

## Scenario 4 (WP19)

`-netsim thailand` (with `-spawn`) starts `tools/netsim/proxy.mjs` in front
of the spawned zone and social (ports +100) and points the bots at the
proxies; scrapes keep the direct URLs. LiveKit media is not impaired (that
needs Linux netem). Binaries are named `voicesoak-<svc>-<pid>`. Pass a fresh
`-world <uuid>` per run on shared infra.

## G5: night demons, not netsim (branch `g5-voice-netsim`)

The G5 Linux soak's voice-under-thailand runs failed (8 and 26 decisions
"missed", 1 and 3 zone flaps, 25-35 % more decisions than clean). Cause: the
spawned zone runs the WP15 world clock, and from dusk to dawn (every real
hour from :46:15 to :15:00, `DayLengthS` 3600, `DuskHour` 18.5, `DawnHour` 6)
**night demons rise around the standing bots and kill them**; the zone
respawns each at the world spawn (`Teleport`), the bot ignored the Event and
kept simulating where it thought it was, so the zone's positions (up to 98 m
off) produced decisions the scenario never had. The clean Linux run ended at
16:45:49 (day), thailand run 1 straddled dusk, run 2 was all night; netsim was
a bystander (same code, thailand by day 862/862 PASS, by night 1,280
decisions, 35 missed, 4 zone flaps FAIL; clean by night fails the same way).
All 34 "missed" of the two Linux runs were also decisions in the last second
before "end", which the analysis could never match (an unsubscribe is observed when
the track ends ~1 s later).

Changes:

- `-spawn` starts the zone with `LODESTONE_ZONE_NO_DEMONS=1` (`-demons` keeps
  them, e.g. to soak voice with deaths).
- Bots follow the zone's teleport Event (kind 2) for their own entity and
  record it (`tp`); the summary reports `teleports` and any teleport makes the
  verdict **INVALID** (the run is not the scenario).
- After "end" the bots stand `endTailMs` (2.5 s) more; listener events in the
  tail count as reflecting decisions made before "end" (decisions after "end"
  still do not count, unmatched tail events are not extras).
- The zone metrics scrape adds `zone_input_frames_*` and `zone_drowned_total`.

Pin the clock to measure night or day on purpose: the spawned zone inherits
`LODESTONE_ZONE_TIME_OFFSET_S` (seconds added to the wall clock; game hour =
((unix + offset) mod 3600) / 150). After the fix, at night, 3 runs each:
thailand 874/866/874 decisions all reflected, clean 868/876/868, 0 missed,
0 flaps, 0 teleports, p99 275-319 ms (desktop). Evidence:
`docs/evidence/g5-voice-netsim-*` (overview `g5-voice-netsim-summary.md`).
