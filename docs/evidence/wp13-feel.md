# WP13 combat feel targets: measured

Every spec 8 "Combat feel" target with the number that proves it. Two
sources:

- **Probe** = the client's input-to-hit timing probe (`client/src/combat/probe.ts`)
  inside the real game client: headless Chromium on the real GPU (RTX 3070,
  ANGLE/D3D11, 60 fps), real mouse and keyboard events, connected to the real
  zone binary on the official world (seed 20261108).
  Run: `npm run combat:browser -w client` -> `wp13-feel.json`, `wp13-feel.txt`,
  screenshots `wp13-browser-hud.png`, `wp13-browser-fight-{1,2,3}.png`.
  Session 1 runs the feel sequences with no enemies around (nothing disturbs
  the timing); session 2 fights a level-1 boar.
- **Sim** = the zone's combat world in-process with the bot fighter (the real
  weapon timelines and claims, simulated time): `wp13-sim.txt`
  (`node server/zone/internal/combat/evidence.mjs`). The networked party run
  (`wp13-party-clear.txt`) confirms the boss length against a real zone.

All times in ms unless noted; "real" = wall-clock in the browser, which
includes waiting for the next 60 Hz step and a rendered frame.

| Target (spec 8) | Measured | Source | Met |
| --- | --- | --- | --- |
| Light attack startup <= 100 ms | press -> first hit frame: p50 66.7, p95 67.4, max 67.6 (n 44, every weapon's light moves are 4 steps = 66.7 ms in the table; the generator refuses > 100) | probe, session 1 | yes |
| Recovery after a light attack <= 250 ms; cancelable into a dodge once its hit frames end | hit frames end -> next attack (buffered press): 200 (n 8; table max 250 for the sword's 3rd hit); through a dodge: 100-117 (n 8) | probe, session 1 | yes |
| Dodge available almost anytime; 150 ms i-frames | i-frames 150 / 150 / 150 (n 16: 9 steps); any time the previous dash is over (12 steps), in walk, air and glide; costs 12 stamina | probe + `client/src/sim/dash.test.ts`, Go dash goldens | yes |
| Input buffer 150 ms, presses never lost | a second press ~100 ms before the move ends fires on its first legal step: waited 49-67 (n 8), 52 presses -> 52 starts | probe, session 1 | yes |
| Hitstop 40-80 ms, local only | requested 60; measured on screen 66.1-66.6 (n 4, frame-quantized at 60 fps); the world and the zone never pause (local freeze of the weapon and the struck enemy) | probe, session 2 | yes |
| Consumable <= 400 ms, walk while using | press -> heal 309-316 (n 2) while strafing; speed during / before 1.0-1.2 | probe, session 1 | yes |
| Enemy wind-ups 300-600 ms, readable | telegraphed 400-550 in the fight (n 6); every enemy attack in the table 300-600 (generator + Go + TS tests); the telegraph decal shows the exact strike shape and fills over the wind-up | probe session 2, tests | yes |
| Common enemy dies in 2-5 hits; fight 3-10 s | all 22 commons x sword / spear / charged bow: 2-5 hits, fights 3-10 s (means 4.9 / 4.1 / 4.3 s); in the browser a level-1 boar died in 4 sword hits | sim, probe session 2 | yes |
| Elite 10-30 s | 12 elites (fast / warded / sundering x boar, cutthroat, brute, ember imp): 11.4-28.6 s | sim | yes |
| Boss 2-5 minutes, 2 or 3 phases | Warden 175 / 182 / 165 s and Archon 179 / 156 / 149 s for 1 / 2 / 4 players, 3 phases each; networked party of two vs the Warden on the official world: 201 s, 3 phases (`wp13-party-clear.txt`) | sim, party run | yes |

Network confirmation (not a feel target): local hit -> HitResult 28 ms on
localhost; the spark and hitstop never wait for it.

Caveats: one desktop with a real GPU; SwiftShader (software GL) headless runs
are not representative because the frame period dominates every number.
Fight lengths are with an optimal bot; humans take longer, which only moves
the numbers toward the middle of the ranges.
