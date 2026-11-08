# 0003: Zone server skeleton decisions (WP03)

Date: 2026-11-08

## Scheduler spins on QueryPerformanceCounter on Windows

Go's `time.Now` on Windows reads the kernel interrupt-time counter, which only
advances once per timer interrupt: 0.52-0.56 ms steps on the dev machine. A
spin tail polling it lands anywhere in that step, and jitter measured with it
is quantized the same way: the first measurement showed jitter p50
0.16-0.33 ms whether the tail was 0 or 3 ms
(`docs/evidence/wp03-jitter-idle-windows-timenow.txt`). The scheduler now
spins on and measures with QPC (10 MHz, ~85 ns per call;
`server/pkg/gameloop/clock_windows.go`). Other OSes use the monotonic
`time.Now`, which is already nanosecond-precise.

Idle 30 Hz loop on this Windows 11 box (16 cores, Go 1.27.3), two 20 s samples
per spin tail (`wp03-jitter-idle-windows.txt`, `-run2.txt`):

| spin tail | jitter p50 | jitter p99 | jitter max | CPU spent spinning |
| --- | --- | --- | --- | --- |
| 0 ms | 0.16-0.19 ms | 0.53-0.59 ms | 1.2-2.4 ms | 0% |
| 0.5 ms | 0.02 ms | 0.21-0.23 ms | 0.24-0.34 ms | 0.5% |
| 1 ms | 0.00 ms | 0.13-0.14 ms | 0.17-1.25 ms | 2% |
| 2 ms (default) | 0.00 ms | 0.10-0.81 ms | 0.14-1.76 ms | 5% |

Under load (150 bots, zone metrics over the last 60 s): spread p99 0.18 ms /
max 0.44 ms, clustered p99 0.04 ms / max 2.47 ms. The default stays 2 ms on
Windows, 1 ms elsewhere (the wizard-wars split); 5% of one core is the price.
The spread across samples is noise from other agents building on the same
machine; re-measure on a quiet box before tuning. Linux numbers are still to
be measured (CI has never run).

## Delta snapshots: first sight is a diff against zero

Records for entities the baseline lacks are diffs against the zero state:
`kind` and `name` are always present, zero-valued fields are omitted. The
client applies such records onto a zeroed entity. This keeps "unchanged costs
nothing" true at first sight too (vy, pitch, typeId, partyId are usually 0)
and needs no contract change; it is documented in `server/zone/README.md`
for WP06.

## Slower rings skip by omission

An entity that is in the client's interest set but whose ring is not due this
tick is simply not sent, and the server's frame records the baseline state
for it (what the client still believes). The next due tick diffs against
that, so nothing is lost when a ring changes rate. Phases are staggered by
entity id so a client's mid-ring entities spread over three ticks.

## Far-ring hysteresis

A player the client already knows stays in the far ring until 616 m (600 +
16), so walking along the boundary does not cost a removal plus a full
first-sight record every few ticks.

## Unreliable over WebSocket = latest-wins queue

WebSocket cannot drop on the wire, so `SendUnreliable` replaces a not-yet-
written frame with the same message id. A slow reader sheds stale snapshots
instead of accumulating latency; deltas against acked baselines make skipping
safe. Reliable frames always go first.

## Frame budget is the speed-hack defense

Movement is simulated from input frames, so a client cannot claim positions,
only send frames. Each frame is 1/60 s of simulation, so the zone budgets 60
frames per second per session with a 30-frame burst; extra frames are dropped
and counted. The max-speed check (25.6 m/s horizontal) remains as a sanity
bound that snaps violators back, as spec 9 asks, but legit play never trips
it.

## Duplicate login: newest wins

A second connection for the same character kicks the old one with
`duplicate_login` and resumes at its live position. Locking out the new
connection would strand players whose old socket is a half-dead ghost.

## Dev spawn

Bots need to place themselves (spread vs clustered). The zone honors
`/ws?spawn=x,z` only when it runs with the development ticket key or
`LODESTONE_ZONE_DEV_SPAWN=1`. Real spawns come from `characters.position`.

## Which world a zone serves

WP04's director routes players to zones announced in
`zones:{officialWorldId}` and signs tickets for `zone:<announced zoneId>`, and
the official world's id is a generated uuid. So when `LODESTONE_WORLD_ID` is
unset the zone reads `worlds WHERE official` at startup (id, seed,
gen_version; the row is authoritative). With no database or no official row
it falls back to dev defaults: world `00000000-0000-0000-0000-000000000001`,
seed 1, genVersion `dev`. Zone id defaults to `zone-dev-1`. Verified end to
end against WP04's account service and director:
`docs/evidence/wp03-e2e-director.txt`.

## Movement agrees with WP02's TypeScript port

`server/pkg/movement` replays WP02's goldens (`client/src/sim/golden`, 690
frames each on flat and tilted ground): max difference 1.4e-14 m
(`TestReplaysClientGoldens`).

## Budget gap at extreme density

The spec 9 rings send every player inside 64 m at 30 Hz. With ~14 bytes per
moving player per update, 143 players inside 64 m cost ~530 kbps per client
(`docs/evidence/wp03-soak-dense-info.txt`), far over 160 kbps. The WP03
acceptance (100+ in view, clustered within 300 m) passes at 131 kbps max.
Recommended follow-up for WP06 (owns snapshot handling): a per-client byte
budget with a priority accumulator (distance x staleness) inside the near
ring, so crowds degrade update rate gracefully instead of blowing the budget.
That changes the spec 9 ring table's meaning, so it needs a decision first.
