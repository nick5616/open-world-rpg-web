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
