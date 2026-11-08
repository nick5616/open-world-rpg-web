# 0011: Proximity voice (WP11)

Date: 2026-11-08

## Pipeline

```
zone tick (every 250 ms)  -> copy player positions -> voice.Runner goroutine: earshot sets
   -> Redis PUBLISH voice:{worldId} (full every 2 s, deltas otherwise)
social voice leader (one process per world, Redis lease voicelead:{worldId})
   -> Reconciler: earshot ∪ party − blocks (both ways) − mutes (one way), × roster tracks
   -> LiveKit RoomService.UpdateSubscriptions (Twirp/JSON, HS256 admin JWT)
browser: livekit-client, autoSubscribe off -> TrackSubscribed -> Web Audio graph
```

## Earshot rules (zone, `server/zone/internal/voice`)

- 3D distance between feet (every head is the same height above them). Join at 40 m, leave at 48 m (`EARSHOT_*`).
- At most 12, nearest first, **but a current member competes as if it were 8 m closer** (the same 8 m as the leave band). Without that head start, a crowd swaps near-equal neighbours in and out of the top 12 every few intervals: the soak's cluster phase is exactly that case. Unit test `TestNoFlappingRandomWalk` (60 walkers with jitter) and the 50-bot soak both show no pair reversing within 2 s.
- Caves: the rule is in place (same system: 30 m / 38 m; different systems or one underground: never) with `Player.Cave` always 0 until WP09 fills it. Cave mouths are WP09's to refine.
- Party members are not added by the zone: the social service owns parties (Redis) and the zone's party ids are still a stub (WP03 gap). The reconciler adds them.
- The computation runs on its own goroutine, not in the tick: 300 players packed into earshot of each other cost ~1.5 ms (brute force benchmark), which would show in the tick p99 every 8th tick. The tick only copies positions.

## Why a dedicated channel

Spec 11 puts earshot sets on `social:{worldId}`. Every social process decodes every bus envelope; earshot sets are the largest stream (4 Hz per zone) and only one process per world needs them. `voice:{worldId}` keeps them off the chat bus. Full messages every 2 s bound the damage of a lost delta (pub/sub is fire-and-forget); a zone silent for 6 s has its sets dropped.

## Server API without the LiveKit SDK

The social service needs three calls (ListParticipants, UpdateSubscriptions, and JWTs). LiveKit's server API is Twirp with JSON bodies, and its tokens are HS256 JWTs, so `server/social/voice` does both in ~200 lines. The Go SDK would pull pion, gRPC and protobuf into the social module (and, through the shared go.work build list, bump x/crypto, x/net... for every service). The soak bots, which do need WebRTC, are a separate module outside `go.work` (`server/social/voice/voicebots`, `GOWORK=off`).

## Who reconciles

One LiveKit room per world, so exactly one reconciler per world: the social process holding `voicelead:{worldId}` (SET NX PX 3 s, renewed every 1 s with compare-and-PEXPIRE, released on shutdown). Every process campaigns for every world in `social:worlds`. The integration test runs two processes and checks each subscription change reaches LiveKit exactly once.

The roster (who is in the room, which audio tracks) comes from polling ListParticipants every 500 ms (1.5 s while the room is empty). Webhooks would remove the poll but need LiveKit config (and a reachable URL) — STATUS. The "applied" state is keyed by participant sid and track sid, so a reconnect (new sid) or a republish (new track) re-subscribes. Every 10 s a heal pass re-sends every desired subscription (idempotent in LiveKit).

## Measured latencies

From `docs/evidence/wp11-voice-soak-50.txt` (50 bots, 872 earshot changes):

- Zone decision -> `UpdateSubscriptions` answered: p50 4.9, p99 65 ms (social `voice_apply_latency_ms`; the integration test measures under 1 ms against a fake API).
- Zone decision -> listener's `TrackSubscribed`: p50 52, p99 275, max 306 ms. Subscribing needs an SDP renegotiation of the listener's subscriber PeerConnection.
- Zone decision -> listener stops receiving audio: p50 14, p99 70, max 79 ms. **But the `TrackUnsubscribed` event (track ended) comes ~1 s later:** LiveKit 1.8 mutes the downtrack at once and removes the transceiver after its flush (`sfu/downtrack.go` `flushTimeout = 1 s`, not configurable). The soak measures "stops hearing" as the last received audio packet + 20 ms (the bots send continuously) and reports the track-ended time separately (p50 1016 ms). The two-browser test sees the same: A's output is silent past 48 m + 0.5 s of walking, the track object goes ~1 s later.
- Geometric (distance crosses 40 m / 48 m -> listener event), which adds the 0-250 ms decision interval: p50 168, p99 343, max 414 ms.
- Joining: a pair already in earshot when both become voice-ready is subscribed p50 1.1 s, max 2.0 s later (roster poll + 50 simultaneous joins renegotiating).

## Bots, not browsers, for the 50-voice soak

50 headless Chromium pages each encoding and decoding Opus through WebRTC is ~50 renderer processes on a desktop shared with other agents. Go bots with pion (LiveKit server-sdk-go v2.19) are real WebRTC participants — ICE, DTLS, SRTP, a renegotiation on every subscription change — which is what subscription latency depends on. They publish real Opus (a synthetic speech-like signal encoded once by Chromium's WebCodecs, `testdata/speech.opus.bin`, because there is no cgo/libopus here). The browser audio path is proven by the two-browser walk-apart test instead.

## LiveKit: UDP mux instead of a port range (infra change)

With `port_range_start/end` LiveKit gives every PeerConnection its own UDP port, and every participant has two. The compose range 7900-7950 therefore capped a room at ~25 participants: the 50-bot soak against it had bots 26-49 fail with "could not connect after timeout" (`docs/evidence/wp11-voice-soak-compose-port-range.txt`). `infra/docker-compose.yml` now uses `rtc.udp_port: 7882` (one muxed port, mapped 7882/udp) and keeps TCP 7881. The passing soak ran against a private container with exactly that configuration on other ports (`wp11-livekit-soak`: udp 17882, tcp 17881), so the shared container did not have to be recreated under other agents. Recreate it with `docker compose -f infra/docker-compose.yml up -d livekit` after merging.

## livekit-client pinned to 2.15.16

livekit-client 2.20+ (2.23.0 tested) cannot publish to LiveKit server 1.8.4: it tries the newer `/rtc/v1` signalling path, falls back, and then every publish fails with "negotiation timed out". 2.9.9 and 2.15.16 work. 2.15.16 is the newest that worked; upgrading the client means upgrading the server image too (STATUS).

## Client audio graph

`source → analyser` (speaking indicator) and `source → gain (volume/mute) → low-pass (occlusion) → [spatial gain → PannerNode HRTF (inverse, ref 2 m, max 40 m)] + [radio gain → 300 Hz-3 kHz band → soft clip]` into one master in one AudioContext. A party member beyond 48 m (or not drawn at all) crossfades to the radio branch; the same track serves both. Remote WebRTC audio is also attached to a muted `<audio>` element, without which Chrome feeds silence into Web Audio. Occlusion samples the shared `GroundQuery` along the segment between heads at 4 Hz per speaker instead of a wasm raycast: the client does not load worldgen.wasm yet (WP05), and for heightfield terrain the two are equivalent; caves will need the raycast (WP09).

## Defaults that keep strangers safe

Push-to-talk on V; the microphone is requested on the first push (or when the player opts into voice activation), never at connect; listen-only tokens (`canPublish: false`) for local profiles and moderator-muted players, enforced by LiveKit, not just the UI. Blocks remove voice both ways and mutes one way within 2 s (immediately when the block is made on the leader process). The debug hotkey V (fly) is ignored online, where fly is refused anyway.

## Known trust gap

Server-side subscriptions need `canSubscribe` in the token, so a modified client could subscribe itself to any track in its world's room. Fixes, in order of cost: per-track subscription permissions set by each publisher's client from a server-sent allow list (the honest publisher protects itself), or region-sharded rooms. Recorded in STATUS.
