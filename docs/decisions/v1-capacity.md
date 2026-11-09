# v1 capacity: soak results, players per zone, bandwidth and cost

WP19 · 2026-11-08 · Spec 9 (budgets), 12 (render budgets), 13 (cost, "monthly cost / peak CCU"), 14 (soak scenarios, benchmarks)

All numbers come from one Windows 11 desktop (i7-11700K, 8 cores / 16 threads, RTX 3070, 32 GB), shared during the runs with two other heavy agents, a running `npm run dev` stack and the owner's desktop apps. The bots ran on the same machine as the zones they loaded (300-1,000 bot connections decoding every snapshot), so every zone number here is pessimistic and noisy. Key runs were repeated; where windows differ, the spread is given. Evidence: `docs/evidence/wp19-*` (first pass), `docs/evidence/wp19b-*` (second pass).

## Dedicated Linux measurement (G5, 2026-11-09)

The step this doc asked for ("run the zones on Linux VMs and re-measure on dedicated cores"), done on two temporary GCP VMs in us-central1-a: `lodestone-soak-zone` (c2d-standard-16, AMD EPYC 7B13, running nothing but zone processes, pinned with `taskset`) and `lodestone-soak-bots` (c2d-standard-16, resized to c2d-standard-8 halfway to free project CPU quota for the live game VM) for the bots, netsim proxies, director, Postgres/Redis/LiveKit containers and the soak drivers, over the internal network. Same code as main after WP19b (`1d1f626`), same drivers with flags added for prebuilt binaries and a remote zone host (`tools/soak/linux/README.md`). Evidence: `docs/evidence/g5-linux-*`, overview in `g5-linux-summary.md`. Every VM, disk and firewall rule was deleted afterwards; cost ~$1.50.

"4 vCPU" turned out to be the question, so scenario 1 was measured two ways, both with `GOMAXPROCS=4`: **vcpu4** = CPUs 0,1,8,9, two physical cores and their SMT siblings, which is what a 4 vCPU cloud VM (c2d-standard-4, e2-standard-4...) is; **cores4** = CPUs 0-3, four physical cores with their siblings idle, which is what `GOMAXPROCS=4` got on the 8-core desktop in every WP19 run.

| # | Scenario | Dedicated Linux result | Verdict |
| --- | --- | --- | --- |
| 1 | 300 bots + 2,000 awake enemies | **cores4** (3 runs): worst 60 s p99 10.36 / 10.26 / 10.20 ms, 0 of 40 windows over 12 ms in each run, p50 6.5-7.5 ms, max tick 15-16 ms, downlink max 150.5 kbps, 2,006 awake. **vcpu4** (3 runs): worst p99 13.09 / 13.24 / 12.96 ms, 18-21 of 40 windows over 12, p50 8.8-10.2 ms | **PASS on 4 cores; FAIL on a 4 vCPU slice** |
| 2 | 1,000 bots, 4 zones (each on its own 4 vCPU slice), crossings | 1000/1000, 5,390 handoffs, 0 owned twice, 0 unowned, 0 duplicated, 4 load moves to 262/241/258/240; zone p99 5.7-7.1 ms | **PASS** |
| 3 | 50 voice bots | 868/868 reflected, 0 flaps, p99 234 ms | **PASS** |
| 4 | thailand | S1 (netsim): cores4 worst p99 11.42 ms, 0 windows over 12 (**PASS**); vcpu4 14.25 ms (FAIL). S1 under real `tc netem` thailand between the VMs, cores4: 11.67 ms, 0 windows over 12 (**PASS**). S2 + SIGKILL of a pool zone with 253 players: 227/227 failovers (p50 2.7 s), 0 owned twice, **0 unowned two samples running**, 0 duplicated, surviving zones p99 7.0-8.7 ms (**PASS**; the desktop failure was the desktop). Voice: **FAIL in 2 of 2 runs**: 8 and 26 of 1,182 / 1,084 zone decisions never reflected, 1 and 3 zone flaps; reflected latency p99 240 ms | S1 (4 cores) and S2 + failover PASS; **voice FAIL** |

What this settles:

- **The desktop noise is gone, and the tick fits on 4 cores.** On four dedicated cores scenario 1 passes every window of every run with ~1.6 ms of p99 headroom (and ~0.5 ms under thailand), the in-process benchmark on the same VM matches the desktop's (p50 5.4 ms, p99 8.3 ms vs 5.1-5.4 / 8.2-8.9), and nothing in the live series looks like the desktop's bursts.
- **A 4 vCPU VM is not four cores.** On two cores with SMT the parallel phases run on hyperthreads that share execution units: snapshots 5.3-5.5 ms instead of 3.8, combat 1.7 instead of 1.35, p50 +2.5 ms; in-process p99 11.5 ms before any socket work. So the plan's "4 vCPU per zone" holds for ordinary load (scenario 2's zones idle at p99 6-9 ms on exactly such slices, also after a failover pushed them to 290-360 players) but **not for the worst-case density of scenario 1**. Spec 9's "4 vCPU" budget line should read "4 cores" (8 vCPU) for a zone that must hold 300 players in one crowd with 2,000 awake enemies, or the scenario stays a FAIL at 4 vCPU. Cost impact on the tables below: "4 zone processes = 16 vCPU" for the 1,000 CCU world becomes 32 vCPU (four c2d-standard-8, one zone each, ~$0.36/h on demand or ~$0.10/h spot per VM) if every zone must survive scenario 1's density; at ordinary density 4 vCPU per zone stays enough. *(Superseded by the 4 vCPU follow-up: after it, scenario 1 passes 5/5 on this 4 vCPU slice, so 4 vCPU per zone holds; see "Linux confirmation" at the end.)*
- **Failover is sound under thailand on quiet hardware.** The "playing but unowned for two samples" failure of the second pass does not occur with zones at single-digit p99: it was a symptom of 270-390 ms ticks.
- **Voice under thailand is a real, reproducible failure, not capacity**: the zone tick is 0.8 ms and social applies in 6-8 ms. With the bots' zone socket through the netsim proxy (TCP-style stalls of an RTO on a "lost" frame), the zone makes 25-35 % more earshot decisions than in the clean run (1,084-1,182 vs 868) and some reverse within 2 s (zone flaps), so a few subscriptions are undone before LiveKit reflects them ("missed"). The desktop's two thailand runs had 870 decisions and 0 flaps; why the impaired stream produces bouncier positions here was not established before the VMs had to go. Next step (no VMs needed: the zone at 50 players is idle): reproduce `voicebots -netsim thailand` locally on Linux or WSL, log the bot positions the zone used around each flapped pair, and decide between a zone-side fix (earshot evaluated on smoothed or stall-aware positions, or a minimum dwell before publishing a reversal) and accepting flaps caused by a stalled client.

Remaining for G5: (1) decide the zone size (4 cores per zone, or accept scenario 1 at 4 vCPU as out of budget), (2) the voice-under-thailand flapping, (3) "deployed" (not part of this measurement).

**Voice under thailand, resolved (branch `g5-voice-netsim`, local, no VMs).** Not capacity and not netsim: the voice soak's spawned zone ran the WP15 world clock, and at night (every real hour :46:15-:15:00) demons killed the standing bots; the zone's respawn teleports moved them up to 98 m from where the bots kept simulating themselves, which produced the extra decisions and the zone flaps. The Linux clean run was by day, thailand run 1 straddled dusk, run 2 was night; all 34 "missed" were decisions in the last second before the analysis cut-off. Same code locally: thailand by day 862/862 PASS, by night FAIL (35 missed, 4 flaps), clean by night FAIL too. Under thailand the zone's positions lag at most 2.2 m and never backwards, so the earshot rules (40/48 m, cap 12) need no change. The harness now spawns the zone without demons, follows (and flags) teleports, and gives listener events a 2.5 s tail after "end". After, at night, 3 runs each: thailand 874/866/874 and clean 868/876/868 decisions all reflected, 0 flaps, p99 275-319 ms on the desktop: **scenario 4 voice PASS**. Evidence `docs/evidence/g5-voice-netsim-summary.md`. So (2) is closed; (1) and (3) remain.

**Scenario 1 at 4 vCPU, follow-up (branch `g5-tick-vcpu4`, desktop pinned to two cores + SMT):** a cheaper tick (in-process 2C/4T p50 6.55 -> 6.14 ms, p99 10.48 -> 9.38 ms, CPU per tick -8 %) and GC pacing (GOGC 300 + soft limit) took live scenario 1 on 2C/4T from FAIL 3/3 (worst p99 12.2-14.7 ms) to PASS 2/3 (11.0 / 11.4 ms; the third run hit outside bursts). Details in "4 vCPU follow-up" at the end of this doc. **Confirmed on Linux** (same c2d-standard-16, zone on CPUs 0,1,8,9, main @ `7ac9da4`): **PASS 5/5**, worst 60 s p99 11.04-11.56 ms, 0 of 40 windows over 12 ms in every run, and PASS under netsim thailand (11.89 ms). So (1) is settled: **4 vCPU per zone holds for scenario 1**; the "4 cores (8 vCPU)" sizing above is no longer needed, at the price of thin p99 headroom (0.4-1.0 ms clean). See "Linux confirmation" at the end.

## Second pass (WP19b, 2026-11-09)

The second pass fixed the four G5 failures the first pass left (serial tick, downlink headroom, uneven zones after failover, client long tasks) and re-ran everything. **The machine was much busier than on 2026-11-08**: other agents ran headless Chromium (G4 acceptance) and their own soaks during most runs, and the same main-branch zone binary measured 2-3x slower than the day before (scenario 1 baseline today p99 12.4-13.7 ms vs 11.3 yesterday; under thailand p50 24-27 ms vs 10 ms; scenario 2 baseline busiest zone p99 276 ms vs 13 ms). So every live comparison below is **A/B on the same day**, baseline = the main-branch zone binary at WP19b start (`--zone-bin`), and the in-process benchmark is the noise-free reference.

### Verdict per scenario (second pass)

| # | Scenario | Baseline today (main zone binary) | After WP19b | Verdict |
| --- | --- | --- | --- | --- |
| 1 | 300 bots + 2,000 awake enemies, 4 procs | tick p50 8.9-9.3 ms, 60 s p99 12.4-13.7 ms (every window over 12), downlink max 159.3 kbps | quiet runs (4, incl. one on the code merged with main's playtest work): p50 6.5-8.2 ms, 60 s p99 8.5-10.7 ms in most windows, but one or two bursts per run lift a window to 14.5-17.7 ms; busy run (another agent's browsers at 3.7 cores): p99 28-50 ms. Downlink max 148.2-150.6 kbps | **FAIL (strict)**: the worst window misses 12 ms in every run, though most windows pass; downlink PASS with 9-12 kbps headroom (was 0.7) |
| 2 | 1,000 bots, 4 zones, crossings | PASS: 1000/1000, 0 owned twice, 0 duplicated; zones 440/370/103/86 players, busiest p50 16 ms | PASS: 1000/1000, 3,782 handoffs, 0 owned twice, 0 duplicated, 0 sustained-unowned; 4 load moves, zones **263/254/251/231**; per-zone p50 12-14 ms | **PASS** |
| 3 | 50 voice bots | first pass 868/868, p99 277 ms | quiet: 872/872 reflected, p99 268 ms, 100 % within 500 ms, 0 flaps. Under 14 cores of another agent's Chromium: 796/796, p99 557 ms (social apply p99 401 ms, zone p99 29 ms at 50 players) | **PASS** (quiet run; the busy run failed on latency, attributable to the machine) |
| 4 | thailand | S1 (busy hour): p50 24-27 ms, p99 78-233 ms; S2 + kill (main zone binary): 84/84 failovers, 0 owned twice, 0 duplicated, zones 586/317/92 (p99 266-290 ms), **6 bots unowned two samples running: FAIL** | S1 on a quiet machine: **PASS** once (`after-thailand3`: every window p99 9.4-10.4 ms, p50 6.3-6.9 ms, downlink max 151.8 kbps); merged code: p99 10-10.5 ms between two bursts that lift windows to 24.8 ms (max tick 113 ms); busy hour: p50 13-26 ms. S2 + kill: 216/216 failovers (p50 6.0 s), 0 owned twice, 0 duplicated, zones **370/305/305** after 5 load moves (p99 270-390 ms), 4 bots unowned two samples running (run 1: 11): **FAIL**. Voice: 870/870, p99 270 ms, 0 flaps: **PASS** | voice PASS; S1 PASS in 1 of 2 quiet runs (strict FAIL overall); S2+kill FAIL on this desktop today, the main-branch binary failing the same check in the same conditions |

### What changed (all wire-identical; determinism tests in each package)

| Fix | Where | Effect (scenario 1, mean ms per tick, same day) |
| --- | --- | --- |
| Inputs: plain-movement sessions apply their frames on the tick's workers; anything else (Interact, HitClaim, attack/cast/drink/dash frames, leaves) runs in session order on the tick goroutine after the run before it. Exact: plain sessions touch only themselves | `server/zone/internal/game/inputs.go` | inputs 1.85 -> 1.0-1.1 |
| Combat AI partitioned by group: simple groups think on workers on private World copies, outputs merged in spawn order; bosses, demons, DOT-carrying enemies stay serial; the two-wind-ups cap counts other groups as of the tick start and admits requests in spawn order (exact cap) | `server/zone/internal/combat/par.go` | combat 2.49 -> 1.35-1.83 |
| Combat glue on workers: enemy -> entity mirror, event delivery per session (same per-connection order) | `internal/game/combat.go` | (in combat above) |
| Views: extrapolation + quantization per entity on workers | `internal/game/server.go` | grid 0.46 -> 0.2-0.33 |
| Worker pool waits for items, not goroutines (a helper the OS has not scheduled yet no longer holds the tick) | `internal/game/par.go` | fewer straggler ticks |
| Writers held during the tick: ~300 writer goroutines no longer compete with the tick's workers mid-tick; clock pongs bypass the hold | `server/pkg/transport` (`Holder`), `inputs.go` | snapshots 3.65 -> 3.45-3.6 |
| Reliable bytes charged to the per-client budget | `snapshot.Encoder.Charge`, `transport.Stats.ReliableQueued`, decision 0005 | downlink max 159.3 -> 148-151 kbps |
| `playerUpkeep` in id order (respawns and upkeep events were in map order) | `combat/ai.go` | determinism (needed for the equivalence test) |
| Director load moves (`zoneregistry.Rebalance`, per-region load in the heartbeat, one move per 10 s, held after a Plan change) | `server/pkg/zoneregistry/rebalance.go`, `server/director` | S2 zones 440/370/103/86 -> 263/254/251/231 |
| Shader warm-up at load (`renderer.compileAsync` on a render target + warm extras) | `client/src/world/warmup.ts`, `warmExtras.ts` | traversal long tasks 1 (357 ms) / 2 (175 ms) -> 0 / 0 |

Tests: `TestPartitionedAIMatchesAcrossWorkers` (serial vs 4 goroutines vs reverse hand-out: identical enemies and events every tick for 900 ticks), `TestParallelTickMatchesSerial` (whole tick on 1 vs 4 workers: identical snapshot and reliable bytes per client and identical entity states), `TestHoldDefersWakeups`, `zoneregistry/rebalance_test.go`, `TestAssignerRebalancesByLoad`. All existing tests, golden movement trajectories and combat tests pass unchanged. No `-race` (no cgo toolchain): the design keeps every worker on its own items and shared state read-only during a phase.

### In-process benchmark (no sockets, no other processes in the tick; `go test ./internal/game -bench Scale/p300_e2000 -cpu 4`)

On the official world's terrain (`LODESTONE_BENCH_TERRAIN=1`), 900 ticks, alternated 3x with the main-branch code on a quiet machine (`wp19b-inprocess-bench.txt`):

| | Before (main) | After (WP19b) |
| --- | --- | --- |
| tick p50 | 6.19-6.31 ms | **5.08-5.35 ms** |
| tick p99 | 9.29-9.91 ms | **8.20-8.92 ms** |
| combat phase (mean) | 1.75-1.78 ms | 1.03-1.06 ms |
| inputs + movement | 0.50 ms | 0.37-0.39 ms |
| views + grid | 0.19-0.22 ms | 0.11-0.13 ms |
| snapshots (parallel already) | 3.83-3.84 ms | 3.64-3.95 ms |
| downlink per client (snapshots + reliable) | 141.2 kbps | 135.1 kbps (reliable bytes now inside the 150 budget) |

The in-process movement is cheaper than live (bots send bunched frames, the live terrain cache misses more), which is why the live input phase gains more (1.85 -> 1.0 ms). What is left is mostly the snapshot phase (~3.7 ms, already parallel) and ~1 ms of serial combat glue; a 4 vCPU zone at this density has ~4 ms of slack against 12 ms.

### Scenario 1 in detail

`wp19b-s1-before-main-clean` (baseline), `wp19b-s1-after{2,4,6}-clean` and `wp19b-s1-merged-clean` (quiet; merged = after merging main's playtest progression, quests, doors and audio work), `wp19b-s1-after-thailand3` (quiet, PASS), `wp19b-s1-merged-thailand`, `wp19b-s1-after3-clean` (my own Go tests ran during it: discard), `wp19b-s1-after5-clean` (G4's headless browsers at ~3.7 cores; slow-tick log shows a 555 ms tick of which 542 ms in the parallel snapshot phase and a 36 ms "towns" phase, which is otherwise 0.05 ms: the process was descheduled), `wp19b-s1-before-main-thailand`, `wp19b-s1-after-thailand{,2}`.

- p50 drops by ~2 ms (8.9-9.3 -> 6.5-8.2) and the quiet-window p99 by ~3-4 ms (12.4-13.2 -> 8.5-10.7), as the in-process numbers predict. The merged code (main's per-tick difficulty lookups, quests, doors) measures the same: p50 6.5-7.1 ms, p99 9.4-10.7 ms until one burst at t = 235 s (a 29 ms snapshot phase) lifted the last windows to 14.5 ms.
- Thailand on a quiet machine passed once outright (`after-thailand3`, worst window 10.4 ms); the merged thailand run sat at 10-10.5 ms between two bursts (max tick 113 ms, windows 24.8 ms).
- The windows that still miss 12 ms are bursts of slow ticks in the parallel phases (the slowest tick of each minute is a 18-26 ms snapshot phase): a worker descheduled by the OS or a GC cycle holds the whole phase. The tick now has six parallel phases instead of one, so on an oversubscribed desktop (300 bots, the zone and other agents on 16 threads) it meets more of them; on a dedicated 4 vCPU VM they should not occur. That is the remaining gap, and why the strict verdict is FAIL here.
- `--prefix`, the GC column and the post-ramp window are in `tools/bots/scale-soak.mjs`; the post-ramp window drops windows that still contain the 300 joins, 500 camps spawning and every first-sight record.

### Scenarios 2 and 4 (handoff, failover) in detail

- **Found on the way**: the soaks' own director never assigned anything. The user's long-running dev director (`npm run dev`, main code) scans the same Redis and took every soak world's assignment lease (`zoneassignlead:{world}`; the shared Redis holds leases for dozens of test worlds), so the first-pass S2/S4 splits came from it, and so did the first two WP19b runs (`wp19b-s{2,4}-*-devdirector`: 0 load moves). `handoff-soak.mjs` now starts its director before the zones with `LODESTONE_DIRECTOR_ONLY_WORLD`, so it holds the lease from the start.
- With load moves the director needs 3-5 moves (one per 10 s) from the region-count split to an even one; after a pool zone dies it waits two cooldowns (players are failing over, reported loads are stale), then spreads the dead zone's regions (`wp19b-s4-after-1000-4z-thailand-failover`: moves of 92 and 63 players after the kill, final 370/305/305).
- More balance also means the killed zone held more players (215-219 instead of 79-84), hence 216 failovers and 8-9 discoveries re-granted after the failover (lost with the dead zone's unsaved write-behind queue, by design: rewind to the last checkpoint).
- The "playing but unowned for two samples" failures appeared only today, with zone ticks of p99 270-390 ms on all three surviving zones, and the main-branch zone binary fails the same check in the same conditions (6 bots, `wp19b-s4-before-main-zone-*`); the clean S2 run with load moves had 0. Not reproducible as a code defect here; to be re-checked on a quiet machine.

### Client render and turn benchmarks (second pass)

| Budget | Before (same build, `?nowarmup`) high / low | After high / low |
| --- | --- | --- |
| Long tasks > 50 ms during traversal | 1 (357 ms) / 2 (62, 175 ms), each one shader program linked (`physical ... lodestone-cave-rock-1` in the flight, `town-decal` in the walk) | **0 / 0**, 0 programs linked during walk and flight |
| First playable | 7.2 s / 2.8 s | **4.7-5.0 s / 2.0-2.5 s** |
| Draw calls, visible triangles, chunk gen, download, frame p99 | 294 / 136, 1.20 M / 0.74 M, p95 6.0 / 6.6 ms, 4.8 / 2.5 MB, 16.8 ms | 298 / 135, 1.22 M / 0.75 M, p95 6.5 / 7.5 ms, 4.8 / 2.5 MB, 16.8 ms |
| Turn benchmark (`bench/turn.mjs`, 360 deg/s pan + 180 deg flicks): frames over 50 ms | main (orchestrator): pan max 533 ms, 4 long tasks; here 1 of 2 high runs 333 ms frame / 344 ms long task | **0 in 8/8 runs (5 high, 3 low)**, worst frame 33.4 ms (one missed vsync), 0 long tasks |

Evidence: `wp19b-traversal-run.txt`, `wp19b-traversal-{high,low}.json`, `wp19b-nowarmup-traversal-*`, `wp19b-turn.txt`.

After merging main again (playtest progression, quests, doors, weapon models, audio system): the warm-up list gained the weapon material (first person and remote players), enemy bars and the additive glow decal; the turn benchmark stays at 0 frames over 50 ms (6/6 runs, worst frame 16.8 ms) and the traversal at 0 programs linked. The merge brought one new long task: main's audio engine synthesized ~1 M samples of noise and a reverb IR synchronously when it booted, 67-86 ms on the first key press of the walk; now synthesized in slices (`client/src/audio/{ambience,sfx}.ts`). What remains on low is one 52 ms task on that first key press: creating the AudioContext (native: the Windows audio device opens), which the benchmark's `?autoplay=1` moves from the title screen's Play click into the world; high: 0. First playable on the merged build: 3.7 s high, 2.0 s low (`wp19b-merged-traversal-*`). Heap max on high read 125 MB in the after run (78 MB before); within the 600 MB budget, GC timing in the sampler, not investigated further.

## Verdict per scenario (spec 14), first pass (2026-11-08)

| # | Scenario | Before (main at WP19 start) | After (WP19, main incl. WP14 + WP15 merged) | Verdict |
| --- | --- | --- | --- | --- |
| 1 | 300 bots in one region + 2,000 awake enemies: tick p99 within 12 ms, no client over the downlink budget | tick p50 ~250 ms, worst 60 s p99 811 ms (the zone fell to ~4 Hz; downlink max 19.8 kbps only because snapshots starved) | tick p50 8.5-10 ms; 60 s window p99 11.3-11.4 ms in the quiet windows, 13-31 ms in windows with machine noise; downlink max 158.3 kbps (budget 160); 2,006 enemies awake throughout | **FAIL (borderline)**: p50 ~9 ms, p99 meets 12 ms only in quiet windows; downlink PASS |
| 2 | 1,000 bots across the world, continuous crossings: no dropped players, no duplicated items | PASS: 1000/1000, 3,646 handoffs, 0 owned twice, 0 duplicated grants; zone tick p99 53 / 52 / 14 / 12 ms at 440 / 357 / 111 / 92 players | PASS: 1000/1000, 3,385 handoffs, 0 lost states, 0 owned twice, 0 duplicated grants; tick p99 13.4 / 10.5 / 7.1 / 5.1 ms at 430 / 343 / 150 / 77 players; downlink max 123 kbps | **PASS** |
| 3 | 50 voice bots clustered and dispersing: subscriptions follow earshot within 500 ms, no flapping | PASS: 864/864 reflected, p99 271 ms, 0 flaps | PASS: 868/868, p99 277 ms, 0 flaps | **PASS** |
| 4 | All of the above under "thailand" | n/a (WP16 measured scenario 2 + failover pre-WP13/20) | S1: tick p50 10 ms, p99 14-17 ms, downlink max 159.2 kbps (RTT 210 ms). S2 + hard kill of a pool zone: PASS, 1000/1000, 71/71 failovers (p50 4.9 s), 0 owned twice, 0 duplicated; pool zone p99 49 ms at 612 players (see "uneven split"). S3: PASS, 864/864, p99 286 ms, 0 flaps | **S2, S3 PASS; S1 FAIL (p99)** |

Evidence: `wp19-s1-before-clean`, `wp19-s1-merged-clean`, `wp19-s1-after{1..6}-*`, `wp19-s1-after-8procs`, `wp19-s1-after4-pinned`, `wp19-s1-merged-thailand`; `wp19-s2-{before,after}-1000-4z-clean`; `wp19-s3-{before,after}-50`, `wp19-s4-voice-thailand-50`; `wp19-s4-after-1000-4z-thailand-failover` (`.txt|.json|.prom`).

Scenario 1 at 4 vCPU (`GOMAXPROCS=4`) breaks down as (mean ms per tick, `/debug/tickstats` phases): snapshots 3.4-4.1 (parallel, 4 workers), combat 2.2-2.8, inputs + movement 1.5-2.2, world 0.5-0.6, grid 0.4-1.5. The serial part (everything but snapshots) is ~5 ms, so 8 cores only bring p50 from ~9 to 8 ms (`wp19-s1-after-8procs`: p99 14-15). Pinned to 2 physical cores (4 logical, `--zone-affinity F000`) it is p50 10.5 ms. The in-process benchmark without sockets or other load (`go test ./internal/game -bench Scale -cpu 4`) gives p50 5.5 ms, p99 7.9-9.4 ms (before: p50 136-146 ms in the same harness): the remaining distance to 12 ms p99 live is the shared machine (bots on the same box, socket syscalls at ~0.3 cores on Windows, other agents).

## What was fixed (all wire-identical; equivalence tests in each package)

| Fix | Where | Effect |
| --- | --- | --- |
| Parallel snapshot phase (GOMAXPROCS workers, chunks of 2 sessions) | `server/zone/internal/game/snapshots.go` | the 68 % of the tick spent in per-client snapshots now spreads over the cores |
| Interest from a bitset in id order instead of a per-client sort; mirrors sorted once per tick and merged | same | the sort was 20 % of the scenario 1 tick |
| Two AOI grids: players 616 m, everything else 200 m | `internal/aoi`, `snapshots.go gridFor` | clients stop walking 2,000 enemies they can never be sent |
| Compact per-tick entity views, `Known` cursor, `Sqrt` instead of `Hypot` | `snapshots.go`, `server/pkg/snapshot` | removes a cache miss per candidate per client |
| Budgeted encoder: lazy diffs, heap selection | `server/pkg/snapshot/codec.go` | deferred records (most of a crowd) cost no Diff; no full sort |
| Compact pointer-free baseline frames (interned names) | `server/pkg/snapshot/compact.go` | 32 frames x ~1,300 entities x 300 clients was ~700 MB of pointerful memory the GC scanned every cycle (p99 spikes); now 40-byte noscan records |
| `windupsOn` index | `internal/combat/ai.go` | was O(enemies) per chasing enemy: 22 % of the tick |
| Player grid inside combat `Step` (acquire, playersNear, wake) | `internal/combat/world.go` | O(enemies x players) scans gone |
| `/debug/combat` built on demand; `zone_combat_awake` metric | `internal/game/combat.go` | removed a 1.5 ms every-30th-tick spike |
| Tick phase timing in `/debug/tickstats`, slow-tick log | `internal/game/phases.go` | where a slow tick went, without the CPU profiler |
| Auto quality steps no longer recompile shaders (`shaderTier`) | `client/src/stores/qualityStore.ts`, `WorldScene.tsx`, `GameCanvas.tsx` | the remote "lurch" (below) |

### The remote "lurch" (WP16 known gap): real, fixed

In the two-browser border runs each browser showed one eased remote jump of 0.6-2.8 m a few seconds after the harness's screenshot. Reproduced 5/5 on the merged tree (90-211 cm). It was not netcode: interpolation diagnostics (new `alongCm`, `lagStepMs`, `gapMs` fields) showed steady render clocks; the zone showed both players' input stopping for 4.2 s; a CDP profile showed 4.6 s in `getProgramInfoLog` compiling 26 shader programs, right after both pages' auto quality stepped high -> medium (the two headless pages share the GPU at ~25-38 fps, under drei's 40 fps bound). A tier step recompiled every lit material and the post chain synchronously (~4.7 s on ANGLE/D3D11); WP13/WP20 added the materials that made it long. Fix: shader-shaping knobs follow a separate `shaderTier` that auto steps never change. After: both pages still step down, 0 programs compile, eased remote discontinuities 0 cm / 0 cm (two runs). `docs/evidence/wp19-lurch-investigation.txt`, `wp19-lurch-{before,after}-border-browsers.*`.

## Client render benchmarks (spec 12)

| Budget | WP05 (pre-towns) | Now (main + WP19), high 1920x1080 | Now, low 1280x720 |
| --- | --- | --- | --- |
| Draw calls <= 400 | 215 / 79 | max 303 | max 132 |
| Visible triangles <= 1.5 M | 1.01 M visible | 1.19 M visible (2.04 M incl. shadow passes) | 0.73 M |
| Long tasks > 50 ms: none | 0 / 0 | **1 (347 ms)** | **2 (max 157 ms)** |
| JS heap <= 600 MB | 73 MB | 78 MB | 69 MB |
| Chunk generation <= 8 ms | p95 5.8 ms | p95 5.9 ms | p95 7.7 ms |
| Download <= 15 MB gz | 4.3 MB | 4.8 MB | 2.5 MB |
| Frame time | p99 16.8 ms (vsync) | p99 16.8 ms | p99 16.8 ms |
| First playable <= 8 s | 3.05 s | 6.7 s | 2.8 s |

Towns (`wp19-town-drawcalls.txt`): 167-292 draw calls per view, frame 3.1-3.6 ms mean, identical to WP20's numbers. Regressions since WP05, not fixed here: the long tasks (most likely first-use shader compiles of WP13/WP14/WP15/WP20 materials during the flight: spec 12's shader warmup at load is still not built) and first playable at high (6.7 s vs 3 s, still under 8 s). Evidence `wp19-traversal*.{md,json,txt}`.

## Players per zone and per VM

- **One zone process on 4 vCPU**: ~300-430 players spread over its regions with normal activity (scenario 2: 430 players, tick p99 13.4 ms, 343 players 10.5 ms, on the loaded desktop). Plan for **300 per zone** (2x spec 9's 150 soft cap per region) and alert at p99 > 10 ms.
- **Worst-case density** (300 players and 2,000 awake enemies inside one 600 m disc): p50 ~9 ms, p99 at the budget in quiet windows. It fits a 4 vCPU zone only with nothing else on those cores.
- **Memory**: a zone with 300 clients in one crowd holds ~660 MB of snapshot baselines (32 frames x ~1,300 entities x 40 B per client) plus the terrain cache: size zone VMs at >= 2 GB per zone process (>= 3 GB since the G5 4 vCPU follow-up: GOGC 300 lets the heap reach ~4x live, baselines are ~40 % smaller).
- **v1 world (1,000 CCU)**: 4 zone processes (one per 1024 m stripe, as the director plans today) = 16 vCPU for zones, plus Postgres, Redis, social and LiveKit (2-4 vCPU at 1,000 CCU; LiveKit to its own VM above ~100 concurrent speakers).

## Bandwidth per player (measured)

| Situation | Downlink (incl. WebSocket framing) | Uplink |
| --- | --- | --- |
| Exploring, spread out (WP03/WP07 soaks) | 13-22 kbps | 11 kbps |
| 1,000 players crossing borders (scenario 2) | avg 71, max 123 kbps | 11 kbps |
| Dense crowd + combat (scenario 1) | avg 154, max 158 kbps (thailand 159) | 11 kbps |
| Proximity voice (Opus, up to 12 heard) | +~24-32 kbps per audible speaker | +~32 kbps while talking |

The snapshot byte budget is 150 kbps; until WP19b reliable traffic (combat telegraphs, events) rode on top and scenario 1 reached 158-159 kbps against the 160 budget. WP19b charges reliable bytes to the same budget (decision 0005 amendment): scenario 1 max 148-151 kbps.

For cost: an average session of ~40 kbps game traffic + ~20 kbps voice is ~27 MB per player-hour.

## Cost (list prices, us-central1, Nov 2026; check against the bill)

Formula (spec 13 rule 6): **monthly cost / peak CCU**, where monthly cost = idle floor (~$12: static IP, disks, secrets; `infra/cost/README.md`) + VM hours x rate + egress GB x ~$0.12 (premium tier; standard tier ~$0.085). Grafana's "Lodestone cost per player" dashboard computes it from the real bill and `max_over_time(sum(zone_players)[30d])`.

| Peak CCU | VMs (awake hours/month) | VM cost | Egress (avg CCU x hours x 27 MB) | Total / month | Per peak CCU |
| --- | --- | --- | --- | --- | --- |
| 10 | e2-standard-2 ($0.067/h), ~120 h | $8 | 3 x 120 x 27 MB = 10 GB -> $1 | ~$21 | ~$2.10 |
| 100 | e2-standard-4 ($0.134/h), ~480 h | $64 | 30 x 480 x 27 MB = 390 GB -> $47 | ~$123 | ~$1.25 |
| 300 | e2-standard-8 ($0.27/h) primary, 730 h | $197 | 100 x 730 x 27 MB = 2.0 TB -> $237 | ~$446 | ~$1.50 |
| 1,000 | n2d-standard-8 primary ($0.34/h) + 2 spot c2d-standard-8 (~$0.10/h each), 730 h | $394 | 300 x 730 x 27 MB = 5.9 TB -> ~$650 (tiered) | ~$1,060 | ~$1.05 |

Egress dominates from ~100 CCU up, as spec 13 predicted; the static IP question (decision 0018) is noise next to it. Cloud Run (director/account/creator) stays near zero. These are estimates from list prices and measured per-player traffic, not a bill: the first real month should replace the table (`infra/cost/README.md` checklist).

## What to do when load grows (in order)

1. **Run the zones on Linux VMs and re-measure on dedicated cores.** Every number above shares one Windows desktop with the bots that load it; socket writes alone cost ~0.3 cores of WSASend at 300 clients. Expect scenario 1 to pass on a quiet 4-vCPU Linux zone; prove it there (`tools/bots/scale-soak.mjs` from a second machine).
2. ~~**Rebalance regions by load.**~~ Done in WP19b (`zoneregistry.Rebalance`): scenario 2 zones 440/370/103/86 -> 263/254/251/231; after a thailand failover 370/305/305 (was 612/284/99).
3. ~~**Shrink the serial tick.**~~ Done in WP19b: inputs, combat AI, combat glue and views run on the workers (in-process p50 6.2 -> 5.2 ms). Next, if a dedicated VM still misses: the snapshot phase (~3.7 ms, parallel; per-client candidate walks and the encoder) and fewer parallel phases per tick (each one is a chance for an OS-descheduled worker to hold the tick on a busy host).
4. ~~**Budget reliable bytes.**~~ Done in WP19b (decision 0005 amendment): downlink max 148-151 kbps.
5. **Reduce per-client baseline memory** further (shared per-tick entity history with per-client references) before raising players per zone past ~400.
6. **Voice**: LiveKit on its own VM above ~100 concurrent speakers; region-sharded rooms beyond 1,000 CCU (decision 0011).
7. **Egress**: standard-tier networking (~30 % cheaper) once latency is acceptable from the target regions; keep hashed assets on the CDN.
8. ~~**Client shader warm-up.**~~ Done in WP19b (`client/src/world/warmup.ts`): 0 traversal long tasks, 0 turn hitches; keep `warmExtras.ts` in step with new materials (the traversal benchmark lists every program linked during play).

## 4 vCPU follow-up (G5, 2026-11-09): scenario 1 on two cores + SMT

Branch `g5-tick-vcpu4`. The G5 Linux measurement left scenario 1 failing on a real 4 vCPU slice (2 cores + their SMT siblings: worst p99 12.96-13.24 ms, in-process p99 11.47 ms) while passing on 4 whole cores. This pass makes the tick cheaper on exactly that shape, with no change to behavior or the wire, and measures it on the desktop pinned to two cores' hyperthread pairs (no cloud resources). Evidence: `docs/evidence/g5-tick-vcpu4-*`, overview `g5-tick-vcpu4-summary.md`.

**Reproduction.** The i7-11700K's logical CPUs 2k and 2k+1 are one core (`GetLogicalProcessorInformation`); `start /affinity F000` (CPUs 12-15) is a 4 vCPU slice, `5500` four cores. The in-process benchmark on F000 reproduces the Linux 4 vCPU result within ~10 % (p50 6.4-6.6, p99 10.2-11.6 ms vs 7.27 / 11.47); the live soak runs with `--zone-affinity F000 --bots-affinity 0FFF`. Base and after alternate on the same machine; Go's clock on Windows steps ~0.5 ms, so the benchmark now also reports CPU cycles per tick.

### What changed (all exact: `TestWireDigest` gives identical bytes on main and after)

| Change | Where | Why |
| --- | --- | --- |
| Snapshot baselines refer to a shared per-tick state store (`History`): frames hold 24-byte references (id, tick, index, fingerprint) instead of 40-byte copies; references older than 16 ticks are carried into the encoder's own arena, so every state a usable baseline refers to is younger than the 64 kept ticks. "Changed since the baseline" comes from the fingerprint and the entity's unchanged-since tick, without reading the baseline state; baseline names compare by id | `server/pkg/snapshot` (`compact.go`, `codec.go`), `internal/game/snapshots.go` | the 40-byte copy per entity per client per tick, then the random baseline reads, were the encoder's memory traffic; baseline memory per crowded client -40 % (step 5 of "What to do when load grows") |
| Due rings once per entity per tick (`aoi.DueAll`); bitset filled straight from the grid (`QueryMark`); the second grid skips the 200 m square's corner cells (`QueryMarkWithin`); the newest frame is binary-searched only for players at the far ring's edge (`aoi.UsesKnown`) | `internal/aoi`, `snapshots.go` | a modulo, a closure call and a frame walk per candidate per client |
| Terrain cache read without a lock: flat atomic index over every chunk, hit counter sharded by chunk | `server/pkg/worldhost/terrain.go` | ~10,000 ground queries a tick on the workers each did three contended atomics (RWMutex reader count, shared counter) |
| Every entity's cave system on the workers | `internal/game/caves.go` | a ground query per entity, serial |
| `spawnTick` marks groups with a pass number and skips groups already marked | `internal/combat/world.go` | 300 players x 500 camps: ~150,000 `Hypot` and ~40,000 map writes once a second, +1.2 ms on every 30th tick (inside p99) |
| No allocation per ground query (the chem overlay boxed its inner ground on every call) or per QPC clock read (Windows) | `server/zone/night.go`, `server/pkg/gameloop/clock_windows.go` | ~11 MB/s of garbage on the live zone |
| Name lookups without a lock | `server/pkg/snapshot/compact.go` | an RWMutex reader count written by every snapshot worker |
| **Zone GC pacing**: GOGC 300 and a 3 GiB soft memory limit by default (`LODESTONE_ZONE_GOGC`, `_MEMLIMIT_MB`; the standard `GOGC` / `GOMEMLIMIT` win when set) | `server/zone/gc.go` | at GOGC 100 the crowded zone (~40 MB/s allocated on ~450 MB live) collected every ~15 s; each mark phase takes one of the four Ps, on 2C/4T a hyperthread whose sibling runs a tick worker |
| Soak drivers start zones with `LODESTONE_ZONE_NO_DEMONS=1` | `tools/bots/scale-soak.mjs`, `handoff-soak.mjs` | at night (real clock, :46:15-:15:00) demons kill standing bots and the zone teleports them; the G5 Linux S1 runs (15:50-16:30 UTC) ran at night with demons on |

### Results (2C/4T unless noted)

| | Base (main) | After |
| --- | --- | --- |
| In-process p50 / p99, 2C/4T (5 runs, medians) | 6.55 / 10.48 ms | **6.14 / 9.38 ms** (p99 8.46-9.54) |
| In-process p50 / p99, 4 cores | 5.18 / 8.61 ms | **4.51 / 7.35 ms** |
| In-process CPU per tick, 2C/4T / 4 cores | 86.4 / 66.1 Mcycles | 79.1 / 56.4 Mcycles (-8 % / -15 %) |
| In-process phase means, 2C/4T: snapshots, combat, inputs | 5.12, 1.08, 0.34 ms | 4.93, 0.93, 0.21 ms |
| In-process p99 of snapshots / combat, 2C/4T | 8.02 / 2.68 ms | 7.24 / 2.07 ms |
| **Live scenario 1, worst 60 s p99** (3 runs each, interleaved) | 14.71 / 12.24 / 13.94 ms; 28 / 5 / 28 of 28 windows over 12: **FAIL 3/3** | **11.02** / 15.72 / **11.35** ms; 0 / 17 / 0 windows over 12: **PASS 2/3** (run 2: bursts from outside the zone from t = 85 s, 24-40 ms ticks with every phase inflated) |
| Live p50 | 7.94-9.41 ms | 7.35-8.35 ms |
| Live phase means: snapshots, combat, inputs, world | 4.36-4.70, 1.39-1.50, 1.09-1.21, 0.75-0.85 ms | 4.25-4.65, 1.22-1.39, 0.79-0.88, 0.72-0.76 ms |
| GC cycles in the 135 s steady state | 8-9 | 3 |

The GC A/B on one build: GOGC 100 failed with 22 of 28 windows over 12 ms (worst 14.33), GOGC 400 passed with 0 (worst 11.98). Every live run with ~9 collections in the window failed, every quiet run with 2-3 passed: on two cores with SMT the collector, not the tick's code, sat in the p99. The code changes take ~0.4-0.8 ms off the live p50 and the periodic spikes; the pacing takes out most of the rest. Downlink max 150.4-150.6 kbps in every run.

**Behavior changes: none.** No AI level-of-detail was needed: in scenario 1 every enemy is within 96 m of a player (all 2,000 are awake by the spec's own wake rule), so a far-AI tier would not apply; combat tests, golden movement and the G4 loop are untouched (only `spawnTick`'s bookkeeping changed, with identical marks). The one operational change is memory: with GOGC 300 a zone's heap peaks at ~4x its live heap (this scenario: ~1.6-2 GB at ~450 MB live; the 3 GiB soft limit makes larger zones collect earlier). Size zone VMs at >= 3 GB per zone process (was 2).

**Remaining risk.** (1) The desktop is not the Linux VM: on the EPYC the 4 vCPU in-process tick was ~10 % slower than here, so the expected Linux in-process p99 is ~10.3 ms (the target was ~9) and the live worst window ~11-11.5 ms: a pass, with ~0.5-1 ms of headroom rather than the ~1.6 ms the 4-core runs had. It needs the confirmation run (done: see "Linux confirmation" below; in-process 9.3 ms, live 11.04-11.56 ms) (`tools/soak/linux/README.md`: `build.sh` now also stages `bin/game.test` and `bench-inprocess.sh` runs the in-process benchmark on both CPU sets; then `run-s1.sh vcpu4-run{1,2,3}-clean 0,1,8,9`; the drivers now disable demons). (2) A collection that lands in a window still costs ~2-4 ms on its slowest ticks; the next lever is allocation (~40 MB/s: coder/websocket's per-message contexts and timers, `io.ReadAll` per message, a fresh snapshot buffer per client per tick). (3) One more parallel phase (cave systems) is one more place for an OS-descheduled worker to hold a tick on a busy host. (4) The snapshot phase is still ~55 % of the tick; what remains is per-candidate work (classification, two merge passes, the priority heap for a budget that cannot keep up with a crowd, accumulator walks) that cannot shrink further without changing who gets which record when.

### Linux confirmation (2026-11-09, branch `g5-linux-vcpu4-confirm`)

Main @ `7ac9da4` (this follow-up merged), no code change, the recipe in `tools/soak/linux/README.md`: `lodestone-soak-zone` c2d-standard-16 (AMD EPYC 7B13, the same type as the first G5 Linux run) running only the zone, `lodestone-soak-bots` c2d-standard-8, 18:52-19:34 UTC, ~$0.80, everything deleted afterwards. Evidence `docs/evidence/g5-linux-vcpu4-confirm-*`, overview `g5-linux-vcpu4-confirm-summary.md`.

| | First G5 Linux run (`1d1f626`) | After the follow-up (`7ac9da4`) |
| --- | --- | --- |
| In-process 4 vCPU (0,1,8,9) p50 / p99 | 7.27 / 11.47 ms | **6.79-6.82 / 9.25-9.38 ms** (3 runs; CPU per tick 25.8-26.1 ms) |
| In-process 4 cores (0-3) p50 / p99 | 5.43 / 8.27 ms | 4.99-5.00 / 6.92-7.04 ms (CPU per tick 18.5-18.6 ms) |
| **Live scenario 1, vcpu4, worst 60 s p99** | 13.09 / 13.24 / 12.96 ms, 18-21 of 40 windows over 12: FAIL 3/3 | **11.30 / 11.40 / 11.06 / 11.56 / 11.04 ms, 0 of 40 over in each: PASS 5/5** |
| vcpu4, after the join ramp | 12.42-12.53 | 10.56-10.83 |
| vcpu4 p50 | 8.8-10.2 | 7.7-9.3 |
| vcpu4 under netsim thailand | 14.25 ms, 31 of 40 over: FAIL | 11.89 ms, 0 of 40 over: PASS |
| cores4 (control) | 10.20-10.36 (3 runs) | 8.94 / 8.99 (2 runs) |
| Live phase means vcpu4: snapshots, combat, inputs, world | 5.33-5.46, 1.68-1.72, 0.83-0.85, 0.70-0.72 ms | 5.02-5.14, 1.33-1.39, 0.64-0.66, 0.39-0.47 ms |
| GC cycles, 200 s steady state | 10 | 4 |

Downlink max 150.4 kbps (151.9 under thailand), 2,006 awake, 300/300 connected, 0 kicks, 0 input frames dropped in every run.

**Decision (1) settled: a zone fits scenario 1 on 4 vCPU** (2 cores + SMT, measured on c2d / AMD EPYC 7B13 as in c2d-standard-4; other families such as e2 were not measured), so the cost tables' "4 zone processes = 16 vCPU" for a 1,000 CCU world stand; the "4 cores (8 vCPU) per zone" alternative in "Dedicated Linux measurement" is not needed. Caveats: the headroom is 0.4-1.0 ms on the worst window (1.2-1.4 ms after the join ramp) and 0.1 ms under thailand, against ~3 ms on 4 whole cores; the slowest tick of each minute is still a 7.6-9.8 ms snapshot phase. Treat scenario 1 on 2C/4T as a regression gate for anything that adds per-entity or per-client tick work, and keep zone VMs at >= 3 GB per zone process (GOGC 300).
