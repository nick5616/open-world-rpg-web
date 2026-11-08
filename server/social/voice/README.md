# server/social/voice

The social service's half of proximity voice (spec 10, WP11): LiveKit join
tokens for `voice_token`, and the reconciler that turns the zones' earshot
sets into LiveKit subscriptions with auto-subscribe off. Decisions:
`docs/decisions/0011-proximity-voice.md`; message format: CR 005 and
`server/pkg/earshot`.

| File | What |
| --- | --- |
| `token.go` | HS256 JWTs: participant tokens (identity = character id, name = character name, `canPublish` false = listen-only, microphone only, no data channel) and short admin tokens for the server API |
| `api.go` | LiveKit RoomService over Twirp/JSON: `ListParticipants`, `UpdateSubscriptions` (no SDK, see 0011) |
| `reconcile.go` | `Reconciler`: earshot (per zone, full/delta/gone, stale zones dropped) ∪ party − blocks (both ways) − mutes (one way), mapped to the roster's audio tracks, diffed against what we told LiveKit (keyed by participant sid and track sid). Pure, unit-tested |
| `service.go` | `Service`: tokens, per-world leader lease `voicelead:{worldId}`, the leader loop (Redis `voice:{worldId}` subscription, roster poll 500 ms / 1.5 s empty, relations every 2 s or on a nudge, heal every 10 s), parallel API calls, metrics, `/debug/voice` |
| `voicebots/` | The 50-voice soak (separate Go module, see its README) |

The social package wires it in: `internal/social/voice.go` (the
`voice_token` handler and the `Host` that reads parties, blocks and mutes),
`voicecfg.go` (env), `/debug/voice`.

## Configuration (social service env)

| Env | Default | Meaning |
| --- | --- | --- |
| `LODESTONE_LIVEKIT_URL` | `ws://localhost:7880` | URL handed to browsers in `voice_token` |
| `LODESTONE_LIVEKIT_API_URL` | derived (ws→http) | Server API base, if the SFU is reached differently from the service |
| `LODESTONE_LIVEKIT_KEY` / `_SECRET` | `devkey` / `secret` | LiveKit `--dev` keys; the dev secret is refused in production |
| `LODESTONE_VOICE` | `1` | `0` turns voice off (`voice_token` answers "not available") |

## Metrics

`voice_leader_worlds`, `voice_participants`, `voice_subscriptions`,
`voice_sub_changes_total{op}`, `voice_api_errors_total{method}`,
`voice_earshot_msgs_total`, `voice_apply_latency_ms{q}` (zone decision →
LiveKit answered), `voice_pass_ms`, `voice_tokens_total{mode}`.

## Test

```
cd server/social && go test ./voice/          # unit (tokens, reconcile rules) + LiveKit API smoke (skips without LiveKit)
                                              # + TestVoiceAcrossProcesses: two social binaries, Redis, scratch Postgres, fake LiveKit
cd server/social/voice/voicebots && GOWORK=off go run . -spawn   # the 50-voice soak (README there)
node client/src/voice/dev/walkapart.mjs        # two browsers walking apart (client/src/voice/README.md)
```

`TestVoiceAcrossProcesses` checks: `voice_token` URL, room and grants (publish
for accounts, listen-only for local profiles); that each change reaches
LiveKit exactly once with two processes running (one leader); that an
earshot message becomes the right `UpdateSubscriptions` calls within 500 ms
(measured: under 1 ms), that a delta unsubscribes, and that a block in
Postgres keeps a pair silent both ways.
