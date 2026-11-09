# client/src/net

The client's zone connection (WP06): it connects to the zone the director
picked, predicts the local player, interpolates everyone else and draws
remote players. Decisions and measurements are in
`docs/decisions/0006-netcode-transport.md`.

| File | What |
| --- | --- |
| `transport.ts` | `connectTransport()` tries WebTransport first (HTTP/3 datagrams + one length-prefixed reliable stream; a dev zone's cert is pinned from the endpoint's `#certHash=` fragment) and falls back to WebSocket after 2.5 s. Both carry the same binary frames. Also handles byte accounting. |
| `zoneSession.ts` | `ZoneSession`: Hello, Welcome or Kick, 30 Hz `Input` (new frames + `INPUT_REDUNDANCY` repeats, `ackTick`), snapshot apply + ack, ClockPing at 4 Hz then every second, kbps. No React or three.js, so it runs in Node tests. |
| `snapshotDecoder.ts` | Port of `server/pkg/snapshot` `Decoder.Apply`: 32-frame baseline ring, masked records applied onto the baseline (or onto zero at first sight), removals, stale or no-baseline rejection. |
| `prediction.ts` | Port of wizard-wars `ClientPrediction`. It runs on WP02's `stepMovement` and checks the server's SelfState against the predicted step at `ackInputSeq`, replaying only when they disagree. Since WP10 the check also covers mode, flags and `moveExt` (exact stamina and timers), replays start from `fromSelf` (the whole movement state) and reuse each step's stored env (rain, updrafts). |
| `interpolation.ts` | Port of wizard-wars `EntityInterpolation`. Render clock from arrivals, delay adapted to jitter with per-ring floors (`INTERP_DELAY_*`) and per-entity spacing floors, dead reckoning from the velocity on the wire, teleport cuts, eased discontinuities, counters. |
| `clockSync.ts` | Port of wizard-wars `ClockSync` (lowest-RTT sample, slewed offset). |
| `avatar.ts` | Player model (remote players, and your own body in third person via `scene/LocalAvatar.tsx`) with 3 LODs switched by hand (only the figure in use is in the scene graph): a jointed rig to 25 m (fewer when a crowd exceeds `FullRigBudget`'s 32 full rigs), capsule + weapon pivot to 80 m, a box beyond (no animation); a canvas nameplate (name, level, activity chips), built imperatively. Playtest 2. |
| `avatarAnim.ts` | Playtest 2: the procedural animation state machine (pure, allocation-free): locomotion locked to ground speed (idle breathing, walk/run, sprint, jump/fall, landing, glide, climb, swim), head/torso follow the look pitch, actions over the upper body classified from Event 214 ids (sword slash/spin/plunge, spear thrust, bow draw/release, staff/wand bolts, casts with an element-coloured hand glow, shields, beams, forms, dashes, CR 018 parry/charge/draw and mining), a dodge roll derived from a ground-speed burst, hurt flinch (222), downed (health 0 / 203). |
| `RemotePlayers.tsx` | Draws every remote from the interpolation each frame, routes 214/222/203/707/2 Events to their avatars' animators, and fills the HUD net slots (transport, RTT, ↓/↑ kbps, a sync line). |
| `NetPlay.tsx` | The online play screen: connect, "Connecting…", the world with a `PlayerDriver`, and on a kick or drop "Reconnect" (fresh director ticket) or "Characters". |
| `netStore.ts` | The `ReadySession` hand-off from the account screen, the live session for `window.__lodestone.netDebug()`. |
| `dev/devTicket.ts` | Node-only: signs dev tickets for tests. |
| `dev/acceptance.mjs` | The two-browser G2 acceptance run (below). |
| `dev/solo-smoke.mjs` | Checks that `dev:solo` still works with no servers. |
| `dev/third-person-shots.ts` | Playtest 2 evidence: two browsers on a private zone, one in third person acting, the other photographing its avatar mid-action (`docs/evidence/pt2-third-person-*`). |
| `dev/avatar-bench.ts` | Playtest 2: main-thread cost of N animated avatars per frame (`npx vite-node client/src/net/dev/avatar-bench.ts 300`, `NEAR=1` for everyone within 25 m). |

## Screen flow

```
title -> AccountScreen (WP04, mounted in screens/AccountSlot.tsx) --onReady(ReadySession)--> netStore
      -> PlayScreen: online when a ReadySession is set (NetPlay), else the offline world
```

"Continue offline" on the account screen and `npm run dev:solo` skip the
servers entirely. Online, fly and teleport are refused, because they are
client-only debug tools. `?transport=ws|wt` forces a transport.

## How a frame flows

```
LocalSim step (60 Hz) -> PlayerDriver.onStep -> ZoneSession.pushStep (prediction history + input queue)
render frame end      -> flushInput: Input{ackTick, unsent frames + 3 repeats}   (~30/s)
Snapshot              -> decoder.apply -> interpolation.record (entities with a record)
                                       -> prediction.reconcile(self, ackInputSeq)
next render frame     -> takeCorrection -> LocalSim.rebase + decaying camera offset (90 ms)
                      -> session.views() -> Avatar.update
```

## Test

```
npx vitest run --root client src/net      # unit tests + zone process integration (needs Go; LODESTONE_SKIP_GO=1 skips)
node client/src/net/dev/solo-smoke.mjs    # dev:solo still works offline
node client/src/net/dev/acceptance.mjs    # two browsers, director tickets, "thailand", ws then wt (infra up)
node client/src/net/dev/acceptance.mjs --profile mobile
```

`zone.integration.test.ts` builds the zone binary and runs it with
`tools/netsim/proxy.mjs` (thailand) as child processes. Two `ZoneSession`s
with real `LocalSim`s talk over real WebSockets, one of them through the
proxy, and the test checks that prediction agrees, that the observer draws
the walker close to the walker's true position without teleports, and that
uplink stays under 24 kbps.

`acceptance.mjs` uses a scratch database (`lodestone_wp04_wp06e2e`, dropped
afterwards) and private ports: account 18191, director 18190, zone 18192
tcp+udp, netsim 8095/8096, Vite 5191. It refuses to start if one of them is
taken. Evidence goes to `docs/evidence/wp06-*`.

## Multiple zones (WP16)

`ZoneSession` handles zone handoffs and failover internally, so `NetPlay`, `RemotePlayers` and the HUD keep one session object for the whole play session (decision 0016, CR 008):

- `ZoneTransfer` kind 0 → open a standby connection to the named zone (WebTransport or WebSocket, as for the first connection) and send Hello with the one-time token; kind 1 → close it.
- A `Welcome` on a standby connection → `switchTo`: that connection becomes active, the old one becomes a standby (the old zone keeps it for the way back), the snapshot decoder is replaced (each zone has its own baselines), every frame after the last acknowledged one is resent. Prediction, interpolation (entity ids are world-stable) and clock sync carry on. `session.zoneId` follows; `session.transfers` logs each switch with its gap.
- The active connection dropping without a terminal kick, with `reconnect` given (NetPlay passes one that asks the director for a fresh ticket) → `failover`: reconnect to whoever owns the region now (backoff 0.25 → 2 s, gives up after 60 s), then snap to the checkpoint from the first snapshot (`ClientPrediction.force`; no input goes out until the renderer took that correction). No "connection lost" overlay unless it gives up.
- `netDebug()` adds `zoneId`, `standby` and `transfers`.

Acceptance: `node client/src/net/dev/handoff-acceptance.mjs [--profile thailand] [--failover]` (two Chromium processes walk across a border between two zone processes and back; `--failover` then kills the zone owning them).

## Diagnostics (WP19)

Each entry of `interp.metrics.jumps` also carries `alongCm` (jump along +
or against - the motion), `lagStepMs` (render-clock baseline change that
frame), `delayMs` and `gapMs` (server-time spacing of the samples drawn):
enough to tell a render-clock jump from a server-side burst. The remote
"lurch" of the WP16 border runs was neither: an auto quality step recompiled
every shader and froze the page (`docs/evidence/wp19-lurch-investigation.txt`).
`handoff-acceptance.mjs` gained `--prefix` (evidence names) and
`--cpu-profile` (CDP profile of browser A during the walk back, plus the
shader programs compiled and the quality tier changes,
`window.__lodestone.quality()`).
