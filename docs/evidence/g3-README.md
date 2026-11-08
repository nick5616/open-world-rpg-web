# G3 acceptance: two friends, a cave, voice, climb + glide, map + towers

Gate G3 (spec 15): "Two friends explore a cave together with proximity voice,
climb and glide, use the map and towers." One end-to-end automated session on
the merged main, with real services and two headless Chromium browsers.

## Re-run

```
npm run migrate            # only if the shared dev DB lacks migrations (the run itself uses a scratch DB)
node tools/acceptance/g3.mjs [--livekit ws://127.0.0.1:7880] [--keep-db]
```

Needs: Go, `npm run build:wasm` (worldgen/pkg/worldgen.wasm), Playwright Chromium,
the shared dev infra up (Postgres 55432, Redis 56379, LiveKit 7880 with the UDP
mux on 7882; `npm run infra:up`), Docker CLI (the earshot tap runs a read-only
`redis-cli SUBSCRIBE` inside the `lodestone-redis-1` container), and a GPU
(Chromium runs ANGLE/D3D11, as WP05/WP11/WP12). About 7 minutes.

What it starts, all on random free ports in 20000-45000 and killed at the end:
account, director, zone, social (built from this checkout into a temp dir, with
per-run binary names so nothing else on the machine stops them by image name),
Vite. A scratch database `lodestone_wp04_g3_<run>` (created by
`server/account/cmd/devdb`, dropped at the end unless `--keep-db`), so the
account service mints a fresh official-world row and every run has its own
world id (Redis keys, LiveKit room). Two Chromium processes with a fake
microphone (a steady 220 Hz harmonic tone, as WP11's walk-apart test) sign in
with dev auth and play with real key events; look is scripted through
`window.__lodestone.setLook` (headless has no pointer lock).

Weather is pinned dry (zone `LODESTONE_ZONE_DEBUG_RAIN=0`, client `?rain=0`,
as WP10's runs). One attempt started inside a seeded rain window: with half
climb speed and slips both players ran out of stamina 5.5 m up the Spire's
14.8 m wall to the ledge, three times each (prediction still 0 corrections).
That is WP10's rain rule working, not a bug, but it makes the gate depend on
the wall clock.

## What it does (one session)

1. Corin and Della sign in, touch the spawn waypoint, become friends (friends panel request, accept).
2. Proximity voice: both hold V. Della walks from 4 m in front of Corin to 62 m on his right and back (fade and earshot measured on Corin's actual audio output), then Corin `/invite`s her, she accepts in the party frame (the zone's party ring shows the same party id), and she walks on to 80 m (party radio).
3. Both walk 510 m to "The Forgotten Spire" and climb its west wall with the stamina wheel (climb to the 1.4 m ledge, rest until the wheel is full, climb on, mantle onto the top). Prediction vs server per movement mode from inside the game loop (`window.__lodestone.probe()`, WP10's probe, reset per phase).
4. The top reveals the region and unlocks the tower for both. Corin drops a party pin on the nearest cave mouth (Shift+right-click on the map); Della sees it on her map and compass, and Corin as a party member. Corin fast travels to the spawn waypoint and back to the tower top through the map UI.
5. Both glide off the top toward the cave mouth (~160 m out, ~56 m down), walk to it; Corin walks in while Della waits on the surface 90 m from the mouth (outside the 48 m mouth band of interest clipping): they must still see each other (party exemption). Then both walk the generated cave system (system 10, ~280 m of route) down to the deepest chamber 190 m below the mouth, Corin leading and waiting for Della, sampling every ~350 ms: mutual visibility, Corin's audio of Della, the zone's earshot sets from Redis `voice:{worldId}`. Corin mines the nearest vein (E) and gets the drop.

## Result (final run, main + the fixes below): ALL PASS, 45/45 checks

| G3 item | Numbers |
|---|---|
| 1. Sign in, friends, party | dev auth -> director -> zone for both; friend request/accept, each online with region; `/invite` + party frame, the zone's party ring puts both in the same party id |
| 2. Proximity voice | 336 samples of Corin's actual output: -24.6 dB at 3-7 m, -40.8 dB at 30-40 m (16.2 dB drop, model 17.1), Spearman -0.99; subscribed in 132/132 samples inside 38 m; silent in 46/46 past 51.5 m (not partied); party radio past 56 m: 46/46 subscribed, radio branch, audible (-15.7 dB), flat (\|R-L\| 0 dB); zone speaking bit in 336/336 |
| 3. Climb + glide | both climbed the Spire's wall (ledge rest, lowest stamina 25.5 / 26.2) and glided 160 m out, 56 m down; prediction vs server max 0.83 / 0.82 cm climbing, 0.79 / 0.80 cm gliding, 0 corrections; after the two fast-travel teleports (one correction each) 0 disagreeing snapshots |
| 4. Map + towers | region 5 revealed and the tower unlocked for both (+150 XP, toast); party member on compass and map; party pin on the cave mouth on the other's map (1.8 m off) and compass (314 m); fast travel waypoint (514 m) and back to the tower top (y 188.95), 2 teleport Events, 2 remote teleports seen by Della |
| 5. Cave together | Corin 12 m down while Della waits 92 m from the mouth: they see each other 10/10 (party exempt from clipping); both walk 190 m down to the deepest chamber in 60 s: mutual visibility 143/143 (max 15 m apart), Corin hears Della 143/143 (spatial, mean -32.3 dB at 9.2 m), occluded 0/143, Della in Corin's zone earshot set 143/143; prediction max 0.83 / 0.82 cm, 0 corrections, 0 remote teleports; iron vein mined in 5 swings, "+2 iron ore" (zone logged drop + grant) |

The one correction during mining (8.2 cm, the floor under the miner moved
when the carve remeshed the cell) is reported, not hidden: the zone carves at
once, the client learns of it one round trip later.

## Integration bugs found and fixed

1. Zone earshot ignored caves (WP09 x WP11). `server/zone/internal/game/earshot.go` never filled `voice.Player.Cave`, so the 30 m same-system rule never applied and a cave dweller was in earshot of the meadow above (heard flat, since interest clipping hides them). Now Cave = system + 1 from the per-tick `caveSys`, plus a new `Mouth` field for a surface player within 48 m of one of the system's openings (same band as interest clipping), heard with the cave radii (`server/zone/internal/voice/earshot.go`). Tests `TestEarshotCarriesCaveSystem`, `TestCaveMouthRule`.
2. Voice occlusion muffled everyone underground (WP09 x WP11). `terrainBetween` sampled the surface heightfield, which is above both heads in a cave: 140/148 cave samples were low-passed in run 2. Samples in open cave air (new optional `GroundQuery.caveAir`, `CaveGround.caveAir` from loaded cells only, forwarded by NetPlay's ground) no longer count: 0/143 now. Test in `client/src/voice/voice.test.ts`.
3. Endless corrections after any correction while standing (WP06 x WP10). The replay started from SelfState's cm-rounded y, up to 0.5 cm above the ground; the first replayed step was a tiny fall, so WP10's grounded-only timer (regen delay) skipped a step and every later snapshot disagreed again until the timer saturated or the mode changed: 108 corrections in 3 s after a fast travel. `client/src/net/prediction.ts` now puts a grounded server state back on the ground before replaying (as the spawn already does). Test in `client/src/net/net.test.ts`.

Harness-only issues met on the way: another agent stopped this run's zone by
image name (binaries are now `g3<run>-zone.exe` etc. and a service exiting
fails the run at once); clicks on the chat button landed on the 3D canvas
after the AudioContext gesture click (chat opens with Enter, the party accept
and map travel buttons get a dispatched click, as WP11 did).

Evidence: `g3-acceptance.txt` (log with every number and PASS/FAIL), `g3-acceptance.json`
(all samples), `g3-acceptance-console.txt` (browser consoles), `g3-NN-*.png` (screenshots per step).

Window handles used (debug builds): `__lodestone` (player, netDebug, voiceDebug,
probe, probeReset, setLook), `__lodestoneMap` (state, towers, sites, compass,
mapScreenPos), `__lodestoneCaves` (systems, route, veins, info). `probeReset`
and the probe's per-snapshot `mismatches` list were added for this run
(`client/src/sim/dev/divergenceProbe.ts`).
