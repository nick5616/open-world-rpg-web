# v1 capacity: soak results, players per zone, bandwidth and cost

WP19 · 2026-11-08 · Spec 9 (budgets), 12 (render budgets), 13 (cost, "monthly cost / peak CCU"), 14 (soak scenarios, benchmarks)

All numbers come from one Windows 11 desktop (i7-11700K, 8 cores / 16 threads, RTX 3070, 32 GB), shared during the runs with two other heavy agents, a running `npm run dev` stack and the owner's desktop apps. The bots ran on the same machine as the zones they loaded (300-1,000 bot connections decoding every snapshot), so every zone number here is pessimistic and noisy. Key runs were repeated; where windows differ, the spread is given. Evidence: `docs/evidence/wp19-*` (first pass), `docs/evidence/wp19b-*` (second pass).

## Second pass (WP19b, 2026-11-09)

The second pass fixed the four G5 failures the first pass left (serial tick, downlink headroom, uneven zones after failover, client long tasks) and re-ran everything. **The machine was much busier than on 2026-11-08**: other agents ran headless Chromium (G4 acceptance) and their own soaks during most runs, and the same main-branch zone binary measured 2-3x slower than the day before (scenario 1 baseline today p99 12.4-13.7 ms vs 11.3 yesterday; under thailand p50 24-27 ms vs 10 ms; scenario 2 baseline busiest zone p99 276 ms vs 13 ms). So every live comparison below is **A/B on the same day**, baseline = the main-branch zone binary at WP19b start (`--zone-bin`), and the in-process benchmark is the noise-free reference.

### Verdict per scenario (second pass)

| # | Scenario | Baseline today (main zone binary) | After WP19b | Verdict |
| --- | --- | --- | --- | --- |
| 1 | 300 bots + 2,000 awake enemies, 4 procs | tick p50 8.9-9.3 ms, 60 s p99 12.4-13.7 ms (every window over 12), downlink max 159.3 kbps | quiet runs: p50 6.8-8.2 ms, p99 9.6-10.4 ms in the windows after the join ramp, but 14.5-17.7 ms in some windows of the same runs; busy run (G4 browsers at 3.7 cores): p99 28-50 ms. Downlink max 148.2-150.6 kbps | **FAIL (strict)**: under budget only in quiet windows; downlink PASS with 9-12 kbps headroom (was 0.7) |
| 2 | 1,000 bots, 4 zones, crossings | PASS: 1000/1000, 0 owned twice, 0 duplicated; zones 440/370/103/86 players, busiest p50 16 ms | PASS: 1000/1000, 3,782 handoffs, 0 owned twice, 0 duplicated, 0 sustained-unowned; 4 load moves, zones **263/254/251/231**; per-zone p50 12-14 ms | **PASS** |
| 3 | 50 voice bots | first pass 868/868, p99 277 ms | quiet: 872/872 reflected, p99 268 ms, 100 % within 500 ms, 0 flaps. Under 14 cores of another agent's Chromium: 796/796, p99 557 ms (social apply p99 401 ms, zone p99 29 ms at 50 players) | **PASS** (quiet run; the busy run failed on latency, attributable to the machine) |
| 4 | thailand | S1: p50 24-27 ms, p99 78-233 ms; S2 + kill (main zone binary): 84/84 failovers, 0 owned twice, 0 duplicated, zones 586/317/92 (p99 266-290 ms), **6 bots unowned two samples running: FAIL** | S1: p50 13-26 ms, p99 46-213 ms. S2 + kill: 216/216 failovers (p50 6.0 s), 0 owned twice, 0 duplicated, zones **370/305/305** after 5 load moves (p99 270-390 ms), 4 bots unowned two samples running (run 1: 11): **FAIL**. Voice: 870/870, p99 270 ms, 0 flaps: **PASS** | voice PASS; S1 and S2+kill **FAIL** on this desktop today, the main-branch binary failing the same checks in the same conditions |

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

`wp19b-s1-before-main-clean` (baseline), `wp19b-s1-after{2,4}-clean` (quiet), `wp19b-s1-after3-clean` (my own Go tests ran during it: discard), `wp19b-s1-after5-clean` (G4's headless browsers at ~3.7 cores; slow-tick log shows a 555 ms tick of which 542 ms in the parallel snapshot phase and a 36 ms "towns" phase, which is otherwise 0.05 ms: the process was descheduled), `wp19b-s1-before-main-thailand`, `wp19b-s1-after-thailand{,2}`.

- p50 drops by ~1.5-2 ms (8.9-9.3 -> 6.8-8.2) and the quiet-window p99 by ~3 ms (12.4-13.2 -> 9.6-10.4), as the in-process numbers predict.
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

Evidence: `wp19b-traversal-run.txt`, `wp19b-traversal-{high,low}.json`, `wp19b-nowarmup-traversal-*`, `wp19b-turn.txt`. Heap max on high read 125 MB in the after run (78 MB before); within the 600 MB budget, GC timing in the sampler, not investigated further.

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
- **Memory**: a zone with 300 clients in one crowd holds ~660 MB of snapshot baselines (32 frames x ~1,300 entities x 40 B per client) plus the terrain cache: size zone VMs at >= 2 GB per zone process.
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
