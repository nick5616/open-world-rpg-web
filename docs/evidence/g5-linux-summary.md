# G5: spec 14 soaks on dedicated Linux VMs (2026-11-09, 15:48-16:56 UTC)

Code: main @ `1d1f626` (WP19 second pass merged), branch `g5-linux-soak`; the drivers gained flags only (`tools/soak/linux/README.md`).
Machines (GCP sw-viz, us-central1-a, Ubuntu 24.04, kernel 7.0.0-1017-gcp, all deleted after the runs):

- `lodestone-soak-zone`: c2d-standard-16 (AMD EPYC 7B13, 8 cores / 16 threads, SMT siblings n and n+8), nothing but zone processes.
- `lodestone-soak-bots`: c2d-standard-16 until 16:35, then **c2d-standard-8** (resized mid-session: the two 16 vCPU VMs used the
  project's whole 32 vCPU quota and blocked the live `lodestone-game` VM from starting). Bots, netsim proxies, director,
  Postgres/Redis/LiveKit containers, the drivers. S1 runs and S2 clean ran with 16 vCPU here, S4 + S3 runs with 8 (load average
  logged at each run start: 0.2-1.8; not sampled during runs). Every bot run: 0 kicks, 0 decode/apply errors.
- Internal network between them (same zone, ~0.6 ms RTT through the bots' stack). Netsim proxies ran on the bots VM, so the zone's
  cores never relay traffic.

"4 vCPU" was measured two ways: `vcpu4` = taskset `0,1,8,9` (2 physical cores + their SMT siblings, what a 4 vCPU cloud VM such as
c2d-standard-4 gives you) and `cores4` = taskset `0-3` (4 physical cores, siblings idle; what `GOMAXPROCS=4` got on the 8-core desktop
in WP19). Both with `GOMAXPROCS=4`.

## Verdicts

| # | Scenario | Result | Verdict |
| --- | --- | --- | --- |
| 1 | 300 bots + 2,000 awake enemies, tick p99 <= 12 ms, downlink <= 160 kbps | **cores4**, 3 runs: worst 60 s p99 10.36 / 10.26 / 10.20 ms (after the join ramp 9.77 / 9.89 / 9.78), 0 of 40 windows over 12 in every run, p50 6.5-7.5 ms, max tick 15.4-16.0 ms, downlink max 150.4-150.5 kbps, 2,006 awake, 300/300 connected. **vcpu4**, 3 runs: worst p99 13.09 / 13.24 / 12.96 ms (after ramp 12.53 / 12.53 / 12.42), 18-21 of 40 windows over 12, p50 8.8-10.2 ms, downlink max 150.4 kbps | **PASS on 4 dedicated cores (3/3); FAIL on a 4 vCPU (2-core SMT) slice (0/3)** |
| 2 | 1,000 bots, 4 zones (4 vCPU each), crossings, 5 min | 1000/1000 connected, 5,390 handoffs by 731 bots (gap p50 60 ms, max 110 ms), 0 entity id changes, 0 owned twice, 0 unowned two samples running, 0 duplicated discoveries (758 granted), 0 drops, 4 load moves, final 262/241/258/240 players; zone tick p50 4.1-5.4 ms, p99 5.7-7.1 ms, max 10-17 ms; downlink max 142 kbps | **PASS** |
| 3 | 50 voice bots | 868/868 earshot changes reflected, 0 missed, 0 extra, 0 flaps (listener and zone), latency p50 24 / p99 234 / max 238 ms, 100 % within 500 ms; social apply p99 6.3 ms | **PASS** |
| 4a | S1 under thailand (netsim proxy, RTT p50 209-211 ms) | cores4: worst p99 11.42 ms (after ramp 10.70), 0/40 windows over 12, downlink max 152.4 kbps. vcpu4: worst p99 14.25 ms (13.46), 31/40 windows over 12 | **PASS on 4 cores, FAIL on 4 vCPU** |
| 4a' | S1 under real `tc netem` thailand both ways between the VMs (delay 80 ms 20 ms normal, loss 3 %; ping RTT avg 164 ms, measured drops 3.4 % / 4.1 %; bots' RTT p50 266 ms incl. TCP recovery), cores4 | worst p99 11.67 ms (after ramp 11.04), 0/36 windows over 12, p50 7.4-8.5 ms, one 62.7 ms tick, downlink max 152.8 kbps, 300/300 | **PASS** (extra; fewer samples: joins took longer) |
| 4b | S2 + thailand + hard kill (SIGKILL) of a pool zone at 3 min, 6 min | 1000/1000 connected, kill of zone-pool-3 with 253 players, regions re-owned after 2.1 s, **227/227 failovers** (p50 2.7 s, max 3.0 s, rewind p50 38 m), 0 gave up, 0 owned twice, **0 unowned two samples running** (max 8 in one sample), 0 duplicated, 0 re-granted; 4,914 handoffs; final 310/293/363; surviving zones p99 7.0-8.7 ms (max 13-65 ms); downlink max 144 kbps | **PASS** (desktop WP19b: FAIL with 4-11 unowned at p99 270-390 ms) |
| 4c | Voice under thailand (netsim on the zone and social sockets; LiveKit media unimpaired) | run 1: 1,182 zone changes, 1,174 reflected, **8 missed**, **1 zone flap**; run 2: 1,084 changes, 1,058 reflected, **26 missed**, **3 zone flaps**, one 803 ms subscribe. Latency of the reflected ones p99 239-240 ms, social apply p99 6.2-7.7 ms, zone tick p99 0.8 ms | **FAIL (2/2)**: not capacity; the zone's earshot decisions flip under the impaired input stream (1,084-1,182 decisions vs 868 clean and 870 on the desktop) |

Overall G5 on this evidence: scenarios 2 and 3 PASS; scenario 1 PASS only with 4 whole cores per zone (FAIL on a 4 vCPU SMT slice);
scenario 4 PASS for S1 (4 cores) and S2 + failover, **FAIL for voice under thailand**.

## In-process benchmark on the zone VM (`g5-linux-inprocess-bench.txt`)

| | p50 | p99 | snapshots phase |
| --- | --- | --- | --- |
| 0,1,8,9 (4 vCPU, 2 cores + SMT) | 7.27 ms | 11.47 ms | 6.05 ms |
| 0-3 (4 physical cores) | 5.43 ms | 8.27 ms | 4.20 ms |
| desktop i7-11700K (WP19b, `-cpu 4`) | 5.08-5.35 ms | 8.20-8.92 ms | 3.64-3.95 ms |

Live tick phases (mean ms, last minute): cores4 snapshots 3.79-3.83, combat 1.34-1.39, inputs 0.71-0.72, world 0.56-0.61;
vcpu4 snapshots 5.33-5.46, combat 1.68-1.72, inputs 0.83-0.85, world 0.70-0.72.

## Files

`g5-linux-s1-{vcpu4,cores4}-run{1,2,3}-clean`, `g5-linux-s1-{vcpu4,cores4}-thailand`, `g5-linux-s1-cores4-netem-thailand`
(`.txt` = driver log incl. bots summary and 5 s tick series, `.json` = series + bots summary, `.prom` = final zone scrape; the
vcpu4 run 1 was started with tag `run1-clean` and renamed), `g5-linux-netem-setup.txt` (qdiscs, ping, netem drop counters),
`g5-linux-s2-1000-4z-clean`, `g5-linux-s4-1000-4z-thailand-failover`, `g5-linux-s3-50`, `g5-linux-s4-voice-thailand-50-run{1,2}`,
`g5-linux-inprocess-bench.txt`. A first S4/S2 attempt (16:33) was aborted by the bots VM resize and left no evidence.

Bot-side `predictionResyncs` varied 12k-160k between otherwise identical S1 runs (desktop 15-25k) while the zone applied every
input frame (`zone_input_frames_dropped/synthesized_total` 0): a bot-side counter, not part of any verdict, not investigated.

Cost: zone VM 1.12 h x $0.726 + bots VM 0.78 h x $0.726 + 0.30 h x $0.363 + disks/IPs ~ **$1.50** (list prices).
