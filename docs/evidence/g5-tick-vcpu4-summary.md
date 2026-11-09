# G5 4 vCPU follow-up: scenario 1 on two cores + SMT (2026-11-09, desktop, no cloud)

Branch `g5-tick-vcpu4` (on main `ee7902a`). Goal: scenario 1 (300 bots + 2,000 awake enemies, tick
p99 <= 12 ms per 60 s window) on a real 4 vCPU slice (2 physical cores + their SMT siblings), which failed 3/3 on the G5
Linux VM (worst p99 12.96-13.24 ms; in-process p99 11.47 ms). No behavior or wire change (see "Exactness").

## Reproducing 2C/4T on the desktop

i7-11700K, Windows 11. `GetLogicalProcessorInformation` (a 30-line Go probe): physical core k = logical CPUs 2k and 2k+1.
`start /affinity F000` = logical CPUs 12-15 = cores 6-7 with their siblings (4 vCPU); `5500` = CPUs 8,10,12,14 = four
cores, one thread each. With `GOMAXPROCS=4` the in-process benchmark on F000 reproduces the Linux 4 vCPU numbers within
~10 % (base p50 6.4-6.6 / p99 10.2-11.6 ms here vs 7.27 / 11.47 on the EPYC); the live soak uses
`scale-soak.mjs --zone-affinity F000 --bots-affinity 0FFF` (bots on cores 0-5).

Caveats: the desktop is shared (other agents, a WSL VM whose load the Windows CPU counters do not show); Go's clock on
Windows steps ~0.5 ms (benchmark quantiles are quantized), so the benchmark also reports CPU cycles per tick
(`cpu-Mcycles`, QueryProcessCycleTime). Every comparison below alternates base and after on the same machine.

## In-process benchmark (`g5-tick-vcpu4-inprocess.txt`, 5 alternating runs each, quiet machine, medians and ranges)

| | 2C/4T base | 2C/4T after | 4 cores base | 4 cores after |
| --- | --- | --- | --- | --- |
| tick p50 | 6.55 (6.42-6.60) | **6.14** (5.96-6.33) | 5.18 (5.02-5.51) | **4.51** (4.51-5.02) |
| tick p99 | 10.48 (10.24-11.59) | **9.38** (8.46-9.54) | 8.61 (7.47-10.26) | **7.35** (6.62-9.24) |
| tick max | 21.6 (13.6-25.4) | 11.9 (11.2-13.0) | 15.6 | 9.0 |
| CPU per tick (Mcycles) | 86.4 | **79.1** (-8 %) | 66.1 | **56.4** (-15 %) |
| snapshots (mean / p99) | 5.12 / 8.02 | 4.93 / 7.24 | 3.73 / 6.05 | 3.51 / 5.51 |
| combat (mean / p99) | 1.08 / 2.68 | 0.93 / 2.07 | 1.06 / 2.63 | 0.73 / 2.00 |
| inputs + movement | 0.34 | 0.21 | 0.38 | 0.16 |
| views + grid | 0.13 | 0.14 | 0.12 | 0.11 |
| world | 0.09 | 0.09 | 0.09 | 0.10 |

(The benchmark has no caves, towns or chemistry overlay: the world-phase changes only show live.)

## Live scenario 1, 2C/4T (F000), 3 min, clean, `LODESTONE_ZONE_NO_DEMONS=1`

| Run | worst 60 s p99 (t >= 60 s) | after ramp | windows > 12 ms | p50 | GC cycles in the 135 s | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| base-run1 | 14.71 | 14.46 | 28 / 28 | 8.52-9.41 | 8 | FAIL |
| base-run2 | 12.24 | 11.53 | 5 / 28 | 7.94-8.88 | 9 | FAIL (strict) |
| base-run3 | 13.94 | 13.94 | 28 / 28 | 8.08-9.21 | 9 | FAIL |
| **after-run1** | **11.02** | 10.57 | 0 / 28 | 7.58-8.31 | 3 | **PASS** |
| after-run2 | 15.72 | 15.72 | 17 / 28 | 7.81-8.35 | 3 | FAIL: from t = 85 s bursts of 24-40 ms ticks with every phase inflated (a 27.8 ms snapshot phase); right after the run the hypervisor counters showed 29 % logical-CPU run time while Windows showed 2 % (load outside the zone, e.g. a WSL VM) |
| **after-run3** | **11.35** | 10.91 | 0 / 28 | 7.35-8.23 | 3 | **PASS** |
| dev v6, GOGC=100 | 14.33 | 14.33 | 22 / 28 | 7.64-8.77 | 8 | FAIL |
| dev v6, GOGC=400 | 11.98 | 11.10 | 0 / 28 | 7.58-8.53 | 2 | PASS |

Base = main's zone (`ee7902a` code; GOGC 100). After = this branch (GOGC 300 by default). Downlink max 150.4-150.6 kbps in
every run (budget 160), 300/300 connected, 2,006-2,009 awake. Live phase means (ms), base -> after: snapshots 4.36-4.70 ->
4.25-4.65, combat 1.39-1.50 -> 1.22-1.39, inputs 1.09-1.21 -> 0.79-0.88, world 0.75-0.85 -> 0.72-0.76.

Reading: the same v6 code fails at GOGC=100 (22 windows over) and passes at GOGC=400 (0 over); every run with ~9 GC cycles in
the window failed, every quiet run with 2-3 passed. On two cores with SMT a GC mark phase takes one of the four Ps (a
hyperthread whose sibling runs a tick worker) for tens of milliseconds, and at ~4 cycles a minute that lands in the 18
slowest ticks of a window. The code changes lower the work (p50 -0.4 to -0.8 ms live, CPU per tick -8 % on 2C/4T) and the
spikes (combat p99, the once-a-second spawn pass); the GC pacing removes most of what was left in the p99.

## Exactness

`TestWireDigest` (`LODESTONE_WIRE_DIGEST=1`): SHA-256 of every snapshot and reliable byte of two deterministic scale runs
(90 clients / 600 enemies / 400 ticks: 21,071,537 bytes `42e9486e...021d`; 300 clients / 2,000 enemies / 300 ticks:
55,566,968 bytes `a19100cb...1de0`) identical on main and on every step of this branch. Plus the new
`snapshot/history_test.go` (History vs own-state vs pre-WP19 reference encoder, byte-identical with ack lags past the
ring and starved budgets; mutation-tested), `aoi` tests (QueryMark = Query, QueryMarkWithin keeps everything < r,
DueAll = Due, Classify ignores `known` outside UsesKnown), and the existing parallel-vs-serial tick tests.

## Files

`g5-tick-vcpu4-inprocess.txt` (benchmark runs), `g5-tick-vcpu4-s1-{base,after}-run{1,2,3}-clean.{txt,json,prom}`,
`g5-tick-vcpu4-s1-dev-v6-gogc{100,400}.*` (the GC A/B on the same build).
