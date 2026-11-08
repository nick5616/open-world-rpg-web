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

## What it does (one session)

1. Corin and Della sign in, touch the spawn waypoint, become friends (friends panel request, accept).
2. Proximity voice: both hold V. Della walks from 4 m in front of Corin to 62 m on his right and back (fade and earshot measured on Corin's actual audio output), then Corin `/invite`s her, she accepts in the party frame (the zone's party ring shows the same party id), and she walks on to 80 m (party radio).
3. Both walk 510 m to "The Forgotten Spire" and climb its west wall with the stamina wheel (climb to the 1.4 m ledge, rest until the wheel is full, climb on, mantle onto the top). Prediction vs server per movement mode from inside the game loop (`window.__lodestone.probe()`, WP10's probe, reset per phase).
4. The top reveals the region and unlocks the tower for both. Corin drops a party pin on the nearest cave mouth (Shift+right-click on the map); Della sees it on her map and compass, and Corin as a party member. Corin fast travels to the spawn waypoint and back to the tower top through the map UI.
5. Both glide off the top toward the cave mouth (~160 m out, ~56 m down), walk to it; Corin walks in while Della waits on the surface 90 m from the mouth (outside the 48 m mouth band of interest clipping): they must still see each other (party exemption). Then both walk the generated cave system (system 10, ~280 m of route) down to the deepest chamber 190 m below the mouth, Corin leading and waiting for Della, sampling every ~350 ms: mutual visibility, Corin's audio of Della, the zone's earshot sets from Redis `voice:{worldId}`. Corin mines the nearest vein (E) and gets the drop.

Evidence: `g3-acceptance.txt` (log with every number and PASS/FAIL), `g3-acceptance.json`
(all samples), `g3-acceptance-console.txt` (browser consoles), `g3-NN-*.png` (screenshots per step).

Window handles used (debug builds): `__lodestone` (player, netDebug, voiceDebug,
probe, probeReset, setLook), `__lodestoneMap` (state, towers, sites, compass,
mapScreenPos), `__lodestoneCaves` (systems, route, veins, info). `probeReset`
and the probe's per-snapshot `mismatches` list were added for this run
(`client/src/sim/dev/divergenceProbe.ts`).
