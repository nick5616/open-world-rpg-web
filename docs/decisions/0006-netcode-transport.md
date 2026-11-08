# 0006: Netcode integration decisions (WP06)

Date: 2026-11-08 · Decided by: WP06 agent, pending review

## Transport: WebTransport first, WebSocket fallback, same frames

- The zone serves WebTransport over HTTP/3 (`quic-go/webtransport-go`
  v0.13.0, quic-go v0.62.0) on UDP, by default on the same port number as
  its HTTP/WebSocket listener (8092/udp next to 8092/tcp). `LODESTONE_ZONE_WT_ADDR=off` disables it.
- Reliable frames: one bidirectional stream the client opens first, each
  frame prefixed with its length as u32 LE (Hello can carry a save blob of
  hundreds of KB). Unreliable frames: one QUIC datagram each; a frame over
  1100 bytes, or over the connection's datagram limit, goes on the stream
  instead, still latest-wins. Datagrams and stream data are not ordered
  relative to each other, so a snapshot can beat Welcome; the client drops
  snapshots until it has Welcome (the zone resends full snapshots until it
  gets an ack).
- The client tries WebTransport when the browser has it and the zone
  announces an endpoint, with a 2.5 s timeout, then falls back to
  WebSocket. `?transport=ws|wt` forces one. The debug HUD shows the
  transport, RTT (lowest in the clock-sync window) and up/down kbps.
- Byte accounting: WebSocket bytes include WS frame headers; WebTransport
  bytes include an estimated 27 bytes of QUIC packet + DATAGRAM framing per
  datagram and 8 per stream frame. Neither includes IP/UDP/TCP/TLS, so the
  two figures compare roughly, not exactly.

## Local TLS: a self-signed cert pinned by hash, carried in the endpoint URL

Browsers accept a self-signed certificate for WebTransport only through
`serverCertificateHashes`, and only an ECDSA certificate (Chromium refuses
RSA) valid for at most 14 days. The zone makes a fresh P-256 certificate
at startup, valid for 10 days (backdated 1 h), and announces
`https://localhost:8092/wt#certHash=<base64 sha-256>`. The hash rides in the
URL fragment so `zoneregistry.Entry.WTEndpoint`, the director and WP04's
`ReadySession.zoneWtEndpoint` carry it unchanged. No contract change, and a
fragment never reaches the server. With `LODESTONE_ZONE_WT_CERT/_KEY` (a
real certificate) the zone announces a plain URL and browsers check the
certificate normally. Gap: a dev zone running longer than 10 days needs a
restart, because the cert does not rotate.

## Safari WebTransport status (checked 2026-11-08)

Web search results agree that Safari 26.4 (March 2026) shipped WebTransport
on by default, which made it Baseline across Chromium, Firefox and Safari
([webrtc.ventures](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/),
[utsubo](https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready)).
An MDN browser-compat-data snapshot lists the constructor and
`options.serverCertificateHashes` as Safari 26.4
([BCD](https://chromium.googlesource.com/external/github.com/mdn/browser-compat-data/+/73d346309ee9d8be7e32fda8ff574d4c79dd4c51/api/WebTransport.json)).
Caveats from secondary sources, not verified against WebKit release notes:
the floor is the OS version (iOS/macOS 26.4), not the Safari version;
WKWebView and in-app browsers are unconfirmed; one guide claims Safari 17,
which conflicts with everything else. webtransport-go already sends the
`SETTINGS_WT_MAX_SESSIONS` setting Safari requires.

We did not test Safari, since there is no Mac in this environment. The
WebSocket fallback stays mandatory (spec 9) for older Safari, for networks
that block UDP and for in-app browsers. Re-check on a real Safari 26.4
before G2 sign-off.

## Prediction compares before it replays

SelfState is quantized (cm, cm/s), so replaying from it on every snapshot
injects up to 0.5 cm of error 30 times a second. The client first compares
the server's state with its own prediction for the acked frame. When they
match within 2 cm and 5 cm/s, which is always the case when both sides ran
the same frames, because the step is bit-exact, it does nothing. Otherwise
it replays the unacked inputs and eases the visual difference out over
90 ms. Corrections of 3 m or more snap, as in wizard-wars.

## Input packets

The client sends 30 Hz `Input` packets carrying every frame not sent yet
(usually 2) plus `INPUT_REDUNDANCY` (3) older frames, so 5 frames, 68 bytes
on the wire, about 16 kbps up (budget 24). When the simulation is paused it
still sends an ack-only packet every 100 ms.

## Interpolation: per-ring floors, per-entity spacing, wire-velocity dead reckoning

The interpolation ports wizard-wars EntityInterpolation: the render clock is
derived from snapshot arrivals, the link delay adapts to p95 jitter, the
buffer dead-reckons when it runs dry, and discontinuities are eased. Each
entity's delay is the maximum of three floors:
- the ring floor (`INTERP_DELAY_NEAR/MID/FAR_MS` by distance);
- the link jitter delay;
- 1.5 × its own recent sample spacing, which covers the byte budget below.

The delay is capped per ring at 400, 600 and 1600 ms, and slewed so that
crossing a ring never jumps. Dead reckoning uses the velocity on the wire. A
delta stream sends nothing for an unchanged entity, so a player standing
still is exact with velocity 0 and is not counted as extrapolation.

## The zone extrapolates late players for observers

Over WebSocket, a lost TCP segment stalls a player's input for about 250 ms.
The zone simulates only from input, so observers saw the player stop and
then lurch: in the integration test under "thailand", up to 40 cm per
stall. Each player now has a view state for others that runs ahead of the
confirmed state by the steps real time owes (2 per tick, minus the frames
applied, capped at 16 = 267 ms), repeating the last movement input without
jumps. When the late frames arrive, the confirmed state lands where the
view already is. The lead decays by one extra step per tick while frames
flow, which covers a hidden tab that never catches up. Same test after the
change: 6 cm worst, 0 extrapolations. SelfState, validation, AOI and
persistence use the confirmed state. Combat validation (WP10) must use
confirmed history too.

A wrong guess (the player turned a corner during the stall) was a 55 cm
one-tick jump in the two-browser run. The zone now eases it: the gap
between where observers expected the player (previous raw view plus
velocity × dt) and the corrected view becomes an offset that decays with a
50 ms time constant (`easeView`). Discontinuities of 3 m or more stay
visible.

## Input arrives out of order or not at all (WebTransport)

Datagrams reorder. Under "thailand", a packet overtook the one before it by
2 or more about 1% of the time, enough to defeat the 3-frame redundancy. The
zone applied the later frames, dropped the late one as stale, and the
player was snapped back 8–23 cm a few times per 20 s.

The zone now applies a tick's frames in seq order and holds frames behind a
gap for up to 2 ticks. A frame still missing then was lost in every copy.
It is replaced by the player's previous input, minus jump edges, at most 8
in a row (the "duplicate last command" idea from Quake). Synthesized frames
pass the frame budget like real ones. After this: 0 corrections on
WebTransport, 3 frames synthesized per run.

## Frame budget burst 30 → 60 (changes a WP03 decision)

A TCP retransmit stall in the WebSocket "thailand" run often chains into a
second one. The resulting 500–600 ms bunch of frames overflowed WP03's
30-frame burst, so honest players were snapped back. The burst is now 60
frames (1 s), and the rate is still 60 frames/s. The cost: a "lag switch"
can deliver at most 1 s of movement at once, which a player on a bad link
already does honestly.

## Acceptance result (2026-11-08)

Two headless Chromium processes signed in with dev auth, got tickets from
the director, and connected through `tools/netsim` "thailand"
(`docs/evidence/wp06-acceptance*.{txt,json}`, `wp06-{ws,wt}-*.png`). Each
played 18.5 s of scripted walking: two laps of a square at walking speed,
both players at once.

| | WebSocket | WebTransport |
| --- | --- | --- |
| RTT (A / B) | 163 / 158 ms | 169 / 160 ms |
| Local reconciliation corrections | 0 / 0 (273 / 261 agreements) | 0 / 0 (289 / 288) |
| Remote extrapolation events while walking | 0 / 0 | 0 / 0 |
| Remote teleports | 0 | 0 |
| Largest remote discontinuity (eased) | 3.4 cm | 0 cm |
| Drawn vs true position at the end | 0.4 cm | 0.8 cm |
| Uplink | 15.5 kbps | 20 kbps |

The "mobile" profile also passes on both transports, with 263–317 ms RTT,
0 corrections and a largest eased discontinuity of 22 cm
(`wp06-acceptance-mobile*`). Before the fixes above, the same "thailand" run
showed 4–9 local corrections (8–23 cm) on WebTransport and remote jumps of
40–55 cm. The first run's 1.5–2.6 m jumps were a client bug: under React
StrictMode, a session closed mid-connect still logged in. It is fixed in
`ZoneSession.start`.

## Byte budget (implements decision 0005)

- `LODESTONE_ZONE_DOWN_BUDGET_KBPS` (default 150, 0 = off) is applied in
  `snapshot.Encoder` per client. A token bucket refills budget/30 bytes per
  tick, carries over at most 3 ticks, and charges the full encoded snapshot
  plus transport framing.
- Records that could go out are new entities, and due entities whose state
  changed since the acked baseline. They are sent in priority order until
  the allowance is spent. Priority is a per-entity accumulator: weight =
  16 / (distance + 8), +2 for party members. Deferring an entity adds its
  weight; sending resets it, so starved entities eventually win (the age
  bonus). A deferred known entity keeps its baseline state in the frame and
  later sends the accumulated delta. A deferred new entity waits.
- Dense soak, 150 bots in a 40 m disc
  (`docs/evidence/wp06-dense-budget-*`): downlink averaged 504 kbps (max
  531) with the budget off, 150.2 kbps (max 150.3) at 150. Tick p99 went
  from 4.8 to 6.6 ms because sorting about 145 records per client per tick
  is real work. A fast path skips the sort whenever everything fits, which
  is every non-dense case.
- In the unit-test crowd, entities within 12 m update at about 27 Hz and
  those beyond 50 m at about 7 Hz. The worst gap is 6 ticks.

## Debug tools online

Fly and teleport are client-only and are refused while connected: the
controller ignores them and NetPlay turns fly off. Server-validated admin
teleport is left for a later package.

## Test ports

Acceptance and integration runs use private ports so a running dev stack,
or another agent's, is untouched: account 18191, director 18190, zone 18192
(tcp+udp), netsim 8095 (WS) and 8096 (UDP), Vite 5191 (5176 collided with another agent). The script refuses to start if any of them is taken.
