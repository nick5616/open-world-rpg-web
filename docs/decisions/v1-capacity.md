# v1 capacity: soak results, players per zone, bandwidth and cost

WP19 · 2026-11-08 · Spec 9 (budgets), 12 (render budgets), 13 (cost, "monthly cost / peak CCU"), 14 (soak scenarios, benchmarks)

All numbers come from one Windows 11 desktop (i7-11700K, 8 cores / 16 threads, RTX 3070, 32 GB), shared during the runs with two other heavy agents, a running `npm run dev` stack and the owner's desktop apps. The bots ran on the same machine as the zones they loaded (300-1,000 bot connections decoding every snapshot), so every zone number here is pessimistic and noisy. Key runs were repeated; where windows differ, the spread is given. Evidence: `docs/evidence/wp19-*`.

## Verdict per scenario (spec 14)

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

The snapshot byte budget is 150 kbps but reliable traffic (combat telegraphs, events) rides on top: scenario 1 reached 158-159 kbps against the 160 budget. Next step (WP06's path): charge last tick's reliable bytes against the snapshot budget, or lower the default to 140 kbps.

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
2. **Rebalance regions by load.** In the thailand failover run the director's sticky plan left one pool zone with 612 players (p99 49 ms) while others had 100-280. The assigner should move regions off a zone above ~300 players (decision 0016 "never rebalances" gap).
3. **Shrink the serial tick (~5 ms at scenario 1).** Combat AI (2-3 ms) and input/movement (1.5-2 ms) run on the tick goroutine; movement steps are per-player independent apart from the combat hooks (`World.Frame` emits shared events), so splitting those hooks from the step would let movement run on the snapshot workers. Combat AI can be partitioned by group cell.
4. **Budget reliable bytes** against the 160 kbps downlink (above).
5. **Reduce per-client baseline memory** further (shared per-tick entity history with per-client references) before raising players per zone past ~400.
6. **Voice**: LiveKit on its own VM above ~100 concurrent speakers; region-sharded rooms beyond 1,000 CCU (decision 0011).
7. **Egress**: standard-tier networking (~30 % cheaper) once latency is acceptable from the target regions; keep hashed assets on the CDN.
8. **Client**: shader warmup per tier at load (spec 12) to remove the remaining traversal long tasks and the freeze of an explicit quality change.
