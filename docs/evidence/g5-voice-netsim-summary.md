# G5: voice under thailand, root cause and fix (2026-11-09, local desktop)

Branch `g5-voice-netsim` (from main `0ef4626`). Everything ran on the Windows desktop (i7-11700K, 16 threads, shared with
other agents): zone and social spawned by `voicebots -spawn` on ports 18492/18493 (netsim proxies on 18592/18593), the
shared LiveKit (127.0.0.1:7880, muxed UDP 7882) and Redis, a scratch Postgres database `lodestone_wp04_g5vnet`, a fresh
world id per run. No cloud resources. The voice soak's spawned zone is standalone (no cluster mode), so no director was
needed. Night or day was pinned with `LODESTONE_ZONE_TIME_OFFSET_S` (inherited by the spawned zone).

## Root cause

**Night demons, not netsim.** The spawned zone runs the WP15 world clock: game hour = ((unix s + offset) mod 3600) / 150,
night from 18.5 to 6, i.e. every real hour from :46:15 to :15:00. At night lesser demons rise around players in the open,
kill the standing bots, and the zone respawns each at the world spawn (`Server.Teleport(RespawnPoint)`). The bot ignored the
teleport Event and kept simulating its own position, so from then on the zone's earshot followed positions the scenario never
had: up to 98 m from where the bot thought it was (`g5-voice-netsim-positions.txt`). Teleports move a player into or out of
12 sets at once, a bot that keeps "walking" from the spawn crosses the cluster, and that is where the extra decisions (25-35 %),
the zone flaps and the late reshuffles came from.

- Linux clean (868/868 PASS) ended 16:45:49 UTC: day (hour 17.7-18.3). Thailand run 1 (8 missed, 1 flap) ran 16:45:40-16:47:09:
  dusk fell at 16:46:15 mid-run. Run 2 (26 missed, 3 flaps) ran 16:52:43-16:54:12: night. The WP19/WP19b desktop thailand passes
  ran at :16-:18 past the hour (day).
- **All 34 "missed" of the two Linux thailand runs were zone decisions in the last second before "end"** (run 1: all 8 at
  67.7 s; run 2: all 26 at 67.0 and 67.8 s, of a 68 s scenario, made while the bots stood still: the dead bots' reshuffles). An unsubscribe is observed when the track ends,
  ~1 s after the decision (LiveKit's flushTimeout), and the analysis dropped every event after "end", so such a decision could
  never match: a checker blind spot that only bites when something changes at the very end.

## Hypotheses tested

| Hypothesis | Test | Result |
| --- | --- | --- |
| Netsim makes positions jittery/bursty and moves players across the 40/48 m band | Zone-side position dump vs the bots' own positions (temporary instrumentation, not committed); same code and profile by day vs by night | Thailand by day: zone lags the bot by at most 2.19 m, never backwards; **862/862, 0 flaps, PASS**. By night: 1,280 decisions, 35 missed, 4 zone flaps, zone positions 98 m off. Clean (no netsim) by night fails the same way (1,194 / 7 missed / 3 flaps; 1,188 / 17 / 5). **Refuted**; unit test `earshot_bursty_test.go` |
| The checker compares with bot ground truth | `analyze.go` | It compares with the zone's published decisions (correct), but could not match decisions in the last ~1 s before "end". **Fixed** (end tail) |
| Social reconcile drops/reorders deltas in bursts | All runs: 0 extra, every decision before the tail matched; `reconcile_order_test.go` (burst cancel, delta-then-full, reversal in flight, 50 random streams batched randomly = per message) | **Refuted** |
| LiveKit subscribe/unsubscribe race on a quick reversal | Linux run 2 missed pairs: every one was a decision in the last second, none a reversal; local night runs the same | **Not observed** |

## Fix (`server/social/voice/voicebots`, the soak harness)

- `-spawn` starts the zone with `LODESTONE_ZONE_NO_DEMONS=1` (`-demons` keeps them).
- Bots follow the zone's teleport Event for their own entity (like the real client) and record it; any teleport makes the
  verdict **INVALID** (with `-demons` at night: 19 teleports, `g5-voice-netsim-after-thailand-night-demons-on`; with the bots
  following teleports and the tail, even that run reflected 1,032/1,032 with 0 flaps).
- The bots stand 2.5 s after "end"; listener events in that tail match decisions made before "end".
- Zone scrape adds `zone_input_frames_*` (all 0 dropped/skipped/synthesized in every run) and `zone_drowned_total`.

No zone, earshot or social code changed: the earshot rules (join 40 / leave 48 m, cap 12 with an 8 m head start) and the
reconcile were correct.

## Before (old harness)

| Run | Decisions | Reflected | Missed | Zone flaps | Listener flaps | Extra | Teleports | p50 / p99 / max ms | Within 500 ms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux clean (day) | 868 | 868 | 0 | 0 | 0 | 0 | - | 24 / 234 / 238 | 100.00 % | PASS |
| Linux thailand run 1 (dusk mid-run) | 1182 | 1174 | 8 | 1 | 0 | 0 | - | 20 / 239 / 376 | 100.00 % | FAIL |
| Linux thailand run 2 (night) | 1084 | 1058 | 26 | 3 | 0 | 0 | - | 22 / 240 / 803 | 99.91 % | FAIL |
| local thailand, day | 862 | 862 | 0 | 0 | 0 | 0 | - | 31 / 276 / 345 | 100.00 % | PASS |
| local thailand, night | 1280 | 1245 | 35 | 4 | 0 | 0 | - | 29 / 297 / 345 | 100.00 % | FAIL |
| local clean, night, run 1 | 1194 | 1187 | 7 | 3 | 0 | 0 | - | 29 / 284 / 320 | 100.00 % | FAIL |
| local clean, night, run 2 | 1188 | 1171 | 17 | 5 | 0 | 0 | - | 30 / 309 / 933 | 99.83 % | FAIL |

## After (fixed harness, all at night: game hour ~2 at start)

| Run | Decisions | Reflected | Missed | Zone flaps | Listener flaps | Extra | Teleports | p50 / p99 / max ms | Within 500 ms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S4 thailand, night, run 1 | 874 | 874 | 0 | 0 | 0 | 0 | 0 | 36 / 314 / 390 | 100.00 % | PASS |
| S4 thailand, night, run 2 | 866 | 866 | 0 | 0 | 0 | 0 | 0 | 35 / 319 / 352 | 100.00 % | PASS |
| S4 thailand, night, run 3 | 874 | 874 | 0 | 0 | 0 | 0 | 0 | 34 / 301 / 356 | 100.00 % | PASS |
| S3 clean, night, run 1 | 868 | 868 | 0 | 0 | 0 | 0 | 0 | 33 / 288 / 346 | 100.00 % | PASS |
| S3 clean, night, run 2 | 876 | 876 | 0 | 0 | 0 | 0 | 0 | 35 / 298 / 361 | 100.00 % | PASS |
| S3 clean, night, run 3 | 868 | 868 | 0 | 0 | 0 | 0 | 0 | 34 / 275 / 335 | 100.00 % | PASS |

Decision counts are back at the clean Linux number (866-876 vs 868). Distance crossing -> listener: clean p99 362-382 ms,
thailand 500-562 ms (includes the 80 ms one-way delay and RTO stalls of the input stream plus the 250 ms interval; not the
spec's measure, which starts at the zone decision). Zone tick p99 1.5-2.2 ms; social apply p99 26-63 ms on the busy desktop
(6-8 ms on Linux). p99 decision -> listener 275-319 ms here vs 234-240 ms on the dedicated Linux VM: desktop noise.

## Files

`g5-voice-netsim-before-{thailand-day,thailand-night,clean-night-run1,clean-night-run2}` (old harness; the `clean-night-run2`,
`thailand-day` and `thailand-night` zones also carried the temporary position dump), `g5-voice-netsim-after-{thailand,clean}-night-run{1,2,3}`,
`g5-voice-netsim-after-thailand-night-demons-on` (INVALID by design), `g5-voice-netsim-positions.txt` (zone vs bot position
deviation per run, and every missed/flapped pair of Linux run 2 with its timeline). `.txt` = report, `.json` = summary + events.
