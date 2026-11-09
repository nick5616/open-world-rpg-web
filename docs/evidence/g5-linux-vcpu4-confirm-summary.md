# G5 scenario 1 on a real 4 vCPU slice, Linux confirmation (2026-11-09, 18:52-19:34 UTC)

Code: main @ `7ac9da4` (the `g5-tick-vcpu4` merge: shared snapshot store, cheaper interest/terrain/combat phases, zone GOGC 300
+ 3 GiB soft limit, soak drivers start zones with `LODESTONE_ZONE_NO_DEMONS=1`), branch `g5-linux-vcpu4-confirm`. No game, server or
driver change for this run; binaries from `tools/soak/linux/build.sh`, run exactly as in `tools/soak/linux/README.md` with
`--prefix g5-linux-vcpu4-confirm`.

Machines (GCP sw-viz, us-central1-a, Ubuntu 24.04, kernel 7.0.0-1017-gcp, label `purpose=g5-soak`, IAP SSH only; all deleted after):

- `lodestone-soak-zone`: c2d-standard-16 (AMD EPYC 7B13, 8 cores / 16 threads; SMT siblings checked: cpu0 = 0,8, cpu1 = 1,9),
  nothing but the zone (and the in-process benchmark before the soaks). Same machine type as the first G5 Linux run.
- `lodestone-soak-bots`: c2d-standard-8: bots, netsim proxy, the driver. Load avg at each run start 0.07-0.98.
- Project quota before: 0 of 32 vCPU in use (`lodestone-game` stopped); the soak VMs took 24, so 26 with the game VM awake (it was
  woken during the runs and is running now: 2 of 32 after teardown).

`vcpu4` = zone pinned `taskset -c 0,1,8,9` (2 physical cores + their SMT siblings, what a 4 vCPU cloud VM is), `cores4` = `0-3`
(4 physical cores, siblings idle). Both `GOMAXPROCS=4`. Scenario 1 = 300 bots + 2,000 awake enemies in a 300 m disc, 4 min;
budget: every 60 s window's tick p99 <= 12 ms (windows sampled every 5 s, t >= 60 s with all bots in), downlink <= 160 kbps.

## Verdict

**Scenario 1 PASSES on a 4 vCPU (2 cores + SMT) slice: 5 of 5 clean runs**, worst 60 s p99 11.04-11.56 ms, 0 of 40 windows over 12 ms
in every run; also under netsim thailand (11.89 ms, 0 of 40 over). The first G5 Linux run on the same machine type failed 3/3 at
12.96-13.24 ms with 18-21 of 40 windows over. Headroom is thin: 0.4-1.0 ms clean (after the join ramp 1.2-1.4 ms), 0.1 ms under
thailand. 4 cores (control) pass with ~3 ms.

## Scenario 1 runs (`g5-linux-vcpu4-confirm-s1-*`)

| Run (in order) | CPUs | worst 60 s p99 (t >= 60 s) | after the join ramp | windows > 12 ms | p50 (window range) | max tick | downlink max | awake (min) | connected | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vcpu4-run1-clean | 0,1,8,9 | **11.30** | 10.56 | 0 / 40 | 7.93-9.20 | 22.9 | 150.4 | 2,006 | 300/300 | PASS |
| cores4-run1-clean | 0-3 | 8.94 | 8.93 | 0 / 40 | 6.05-6.91 | 14.2 | 150.4 | 2,006 | 300/300 | PASS |
| vcpu4-run2-clean | 0,1,8,9 | **11.40** | 10.72 | 0 / 40 | 7.89-9.25 | 21.7 | 150.4 | 2,006 | 300/300 | PASS |
| vcpu4-run3-clean | 0,1,8,9 | **11.06** | 10.74 | 0 / 40 | 7.84-9.19 | 18.0 | 150.4 | 2,006 | 300/300 | PASS |
| cores4-run2-clean | 0-3 | 8.99 | 8.75 | 0 / 40 | 5.79-6.84 | 15.6 | 150.4 | 2,006 | 300/300 | PASS |
| vcpu4-thailand (S4 / S1, netsim proxy, RTT p50 211 ms) | 0,1,8,9 | **11.89** | 11.31 | 0 / 40 | 8.00-9.64 | 20.5 | 151.9 | 2,006 | 300/300 | PASS |
| vcpu4-run4-clean | 0,1,8,9 | **11.56** | 10.83 | 0 / 40 | 7.93-9.29 | 21.3 | 150.4 | 2,006 | 300/300 | PASS |
| vcpu4-run5-clean | 0,1,8,9 | **11.04** | 10.61 | 0 / 40 | 7.72-9.26 | 13.7 | 150.4 | 2,006 | 300/300 | PASS |

Every run: 0 kicks, 0 decode/apply errors, `zone_input_frames_dropped_total` 0, GC cycles in the steady state 4 (cumulative counter
7 -> 11 over t = 60-260 s; the first G5 run: 10, 22 -> 32). Bot-side prediction resyncs 30k-219k (as before: a bot-side counter, not
part of any verdict).

### Against the first G5 Linux run (main @ `1d1f626`, same VM type, demons on, GOGC 100)

| vcpu4 | First G5 run (3 runs) | This run (5 clean runs) |
| --- | --- | --- |
| worst 60 s p99 | 13.09 / 13.24 / 12.96 ms | 11.30 / 11.40 / 11.06 / 11.56 / 11.04 ms |
| after the join ramp | 12.53 / 12.53 / 12.42 | 10.56-10.83 |
| windows over 12 ms | 18-21 of 40 | 0 of 40 |
| p50 | 8.8-10.2 | 7.7-9.3 |
| GC cycles, t = 60-260 s | 10 | 4 |
| thailand worst p99 | 14.25 (31 / 40 over) | 11.89 (0 / 40 over) |
| cores4 worst p99 | 10.20-10.36 | 8.94 / 8.99 |

Live tick phases, mean ms over the last minute (`/debug/tickstats`):

| Phase | vcpu4 first G5 run | vcpu4 now (5 clean) | vcpu4 thailand now | cores4 first G5 run | cores4 now |
| --- | --- | --- | --- | --- | --- |
| snapshots | 5.33-5.46 | 5.02-5.14 | 5.30 | 3.79-3.83 | 3.89-4.05 |
| combat | 1.68-1.72 | 1.33-1.39 | 0.99 | 1.34-1.39 | 1.01-1.06 |
| inputs | 0.83-0.85 | 0.64-0.66 | 0.66 | 0.71-0.72 | 0.46-0.47 |
| world | 0.70-0.72 | 0.39-0.47 | 0.34 | 0.56-0.61 | 0.30 |
| grid | - | 0.22-0.25 | 0.77 | - | 0.24 |

The slowest tick of the last minute was a snapshot phase of 7.6-9.8 ms in four of the five clean vcpu4 runs (run 4: a 7.3 ms combat
phase); under thailand a 14.5 ms snapshot phase plus 2.3 ms grid (the impaired input stream bunches frames). The snapshot phase is
still ~55-60 % of the tick and where the remaining p99 lives on 2C/4T.

## In-process benchmark on the zone VM (`g5-linux-vcpu4-confirm-inprocess.txt`, `bench-inprocess.sh 3`, alternating)

| | first G5 run (`1d1f626`) | now, 3 runs |
| --- | --- | --- |
| 0,1,8,9 tick p50 | 7.27 ms | 6.79-6.82 ms |
| 0,1,8,9 tick p99 | 11.47 ms | **9.25-9.38 ms** |
| 0,1,8,9 tick max | - | 12.5-14.9 ms |
| 0,1,8,9 snapshots mean / p99 | 6.05 / - | 5.85-5.89 / 7.89-7.96 |
| 0,1,8,9 combat mean / p99 | - | 0.79-0.83 / 1.15-1.24 |
| 0,1,8,9 CPU per tick | - | 25.8-26.1 ms |
| 0-3 tick p50 / p99 | 5.43 / 8.27 ms | 4.99-5.00 / 6.92-7.04 ms |
| 0-3 snapshots mean | 4.20 | 4.18-4.19 |
| 0-3 CPU per tick | - | 18.5-18.6 ms |

The in-process 4 vCPU p99 (9.3 ms) beat the follow-up's prediction for this VM (~10.3 ms) and matches its desktop 2C/4T number
(9.38). CPU per tick is 40 % higher on 2C/4T than on 4 cores for the same work: the SMT sibling tax.

## Cost and cleanup

Cloud wall time 18:51:53 (firewall rule) to 19:34:07 (last delete) = 42 min; VMs up ~0.69 h: c2d-standard-16 ~$0.50 + c2d-standard-8
~$0.25 + two 30 GB boot disks and ephemeral IPs ~$0.02 = **~$0.80** (list prices). Deleted: both instances (boot disks auto-deleted),
the `lodestone-soak-iap-ssh` rule. After: `instances list --filter labels.purpose=g5-soak` 0 items, `disks list --filter
name~lodestone-soak` 0 items, `firewall-rules list --filter name~lodestone-soak` empty; only `lodestone-game` remains.

## Files

`g5-linux-vcpu4-confirm-s1-{vcpu4-run{1..5}-clean,cores4-run{1,2}-clean,vcpu4-thailand}.{txt,json,prom}` (driver log with bots
summary and 5 s tick series / series + phases + bots summary as JSON / final zone scrape), `g5-linux-vcpu4-confirm-inprocess.txt`
(benchmark lines + VM topology), `g5-linux-vcpu4-confirm-queue.txt` (run order, start/end times, bots-VM load at each start).
