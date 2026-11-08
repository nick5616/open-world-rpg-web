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
| `avatar.ts` | Remote player model with 3 LODs (`THREE.LOD`: limbs to 25 m, capsule to 90 m, box beyond) and a canvas nameplate (name, level, activity chips), built imperatively. |
| `RemotePlayers.tsx` | Draws every remote from the interpolation each frame and fills the HUD net slots (transport, RTT, ↓/↑ kbps, a sync line). |
| `NetPlay.tsx` | The online play screen: connect, "Connecting…", the world with a `PlayerDriver`, and on a kick or drop "Reconnect" (fresh director ticket) or "Characters". |
| `netStore.ts` | The `ReadySession` hand-off from the account screen, the live session for `window.__lodestone.netDebug()`. |
| `dev/devTicket.ts` | Node-only: signs dev tickets for tests. |
| `dev/acceptance.mjs` | The two-browser G2 acceptance run (below). |
| `dev/solo-smoke.mjs` | Checks that `dev:solo` still works with no servers. |

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
