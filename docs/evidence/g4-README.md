# G4 acceptance: fight, loot, mine, forge a sunsteel blade, socket, survive a night in a town

Gate G4 (spec 15): "Full loop: fight, loot, mine ore and a gem, forge a
sunsteel blade, socket the gem, survive a night in a generated town." One
end-to-end automated session on the merged main (WP00-WP18 + WP20), one
character, with the real services and a headless Chromium player that drives
the real client UI. This is the first live run of WP14's inventory, crafting
and socketing UI against a zone (WP14 had only tested it offline with sample data).

## Re-run

```
npm ci && npm run build:wasm   # once per checkout
npm run migrate                # only if the shared dev DB lacks migrations (the run uses its own scratch DB)
node tools/acceptance/g4.mjs [--keep-db] [--stop-after <1..8>] [--no-bots]
```

About 11 minutes. Needs Go, Playwright Chromium, the shared dev infra
(Postgres 55432, Redis 56379; `npm run infra:up`) and a GPU (ANGLE/D3D11).
`--stop-after N` ends after phase N (iterating on the early phases).
`--no-bots` makes the ward falter from the browser and leaves the player to defend it alone.
`--defense-only` is for debugging the harness: it goes straight to phase 7 and records nothing for 1-6.

What it starts, all on random free ports in 20000-45000, killed at the end:
account, director, zone and social (built from this checkout into a temp dir
with per-run binary names `g4<run>-*.exe`), the WP15 night bots, and Vite.
It uses a scratch database `lodestone_wp04_g4_<run>`, dropped at the end
unless `--keep-db`, so every run mints a fresh official world (seed
20261108) with its own world id. Service logs are kept in the temp dir
printed on the first lines of the log.

## Dev shortcuts used (all already used by earlier harnesses)

| Shortcut | Why |
|---|---|
| `LODESTONE_ZONE_DEV_SPAWN=1`: rejoins at `?spawn=` points (`window.__lodestone.rejoinAt`, which gets a fresh director ticket for the same character; the zone is first allowed to drop the character) | To reach the two sunsteel veins (2 km and 2.7 km from the town, 55-110 m underground) and the topaz vein, and to come back to the camp outside the town after mining. The walk from the camp into the town and the smithy is on foot. |
| `LODESTONE_ZONE_DEBUG_CAMP=2085,2385,1,boar boar` (WP13/WP14) | A level-1 camp 200 m outside Draedmore, outside its ward. |
| `LODESTONE_ZONE_TIME_OFFSET_S` (start at 08:00) and the dev set-time Interact 52/2 (`__lodestoneNight.setTime`) | Jumps from the forge (~09:30) to 18:15, so dusk comes naturally 40 s later; jumps from ~21:00 to 05:50, so sunrise comes naturally 25 s later. The night between was not lived through in real time (an in-game night is 29 minutes). |
| Dev defense Interact 52/1 (sent by the WP15 night bots, as WP15's acceptance) | Draedmore was not on that night's seeded defense list (`planned` in the log), so the ward is made to falter (the same `StartDefense` a seeded night uses). |
| Night bots Ana (sword) and Bo (spear) with dev sunsteel (Interact 50/6) | They are the second and third players at the defense. The browser player uses only the blade it forged. |
| `LODESTONE_ZONE_DEBUG_RAIN=0` and `?rain=0` | Dry weather, as in G3. |
| `LODESTONE_ZONE_DEV_COMBAT=1`, `LODESTONE_ZONE_DEV_NIGHT=1` | Enable the knobs above. |

Look is scripted through `window.__lodestone.setLook`, because headless Chromium has no pointer lock. Everything else is real input: W/Shift/Space to move, left click to swing, F to dodge a telegraphed wind-up, R to drink, X to swap loadouts, E to interact, I for the inventory, and clicks on the shop's Buy button, the forge's Craft buttons and the inventory tiles and buttons.

## Result (final run, `g4-acceptance.txt`): ALL PASS, 32/32 checks

| G4 step | Numbers |
|---|---|
| Fight a camp | Walked 200 m out of the town along its streets in 44 s. The two boars died to the starting sword: 9 accepted client-predicted hits (18-31 damage), 2 kills, camp-cleared Event 211, 0 downs |
| Loot | Personal kill loot was taken by walking over it (4 grants: gold, wolf pelt, raw meat). Two chests were opened with E (+38 gold, leather cap and jerkin, iron spear, gems, an iron cuirass blueprint). Gold went 20 -> 67 |
| Mine ore + a gem | Two sunsteel veins (8 E swings each, +3 ore each) and a topaz vein (7 swings, Rough Topaz), all mined with the real cave HUD target and E: 6 sunsteel ore (the recipe needs 2 per ingot) |
| Travel to the town | From the camp, 205 m from the centre, on foot through the square and in at the smithy door in 46 s |
| Buy the blueprint | E on "[E] Talk to Selina (blacksmith)" showed 8 wares. Buy on the Sunsteel Blade blueprint: gold 67 -> 27 (Event 807, price 40) |
| Smelt + forge | E at the town forge opened the crafting panel (Event 805). Craft smelt_sunsteel twice: 2 sunsteel ingots. Craft forge_sunsteel_blade: a Sunsteel Blade, item level 10, 1 socket |
| Socket + equip | Inventory (I): blade, then "Socket a gem", then the topaz. Then "Equip · Loadout 2": slot eq:main1, combat_sync gem element 2 (lightning). Loadout 1 keeps the ordinary starting sword. The looted cap and jerkin were also put on (health max 139) |
| Night: demons | Dusk (Event 501) at 18:30, moon 7. 14 m outside the 140 m ward, 4 Gloamlings rose naturally after 2 s. Starting sword for 25 s: 17 accepted hits, 384 damage, 17 "shrugged" Events (504), 0 deaths, 4/4 alive, the lowest at 71 % health. X to the forged blade: 4/4 dead in 25 s from 17 accepted hits (22-38 damage, 0 shrugs) |
| Night: town defense | The ward of Draedmore faltered: warning, then waves 1, 2 and 3 (34 demons including a grave brute), fought at the ward garden by the player and two bots. HELD after 182 s; the garden never dropped below 1000/1000. Brannoc killed 12 and the bots 22. All three got +300 XP (Event 514) |
| Survive to dawn | Sunrise (Event 502) at 06:01: the 4 demons left in the open burned. Brannoc was alive at 199/199; his lowest health in the night fights was 90/189. Downed 0 times all session (Event 221 count). The zone's live inventory still holds the socketed Sunsteel Blade |

Other numbers: 0 page errors. Prediction since the last rejoin: 0
corrections in 12,379 agreeing snapshots. Render rate at the start 27-62 fps
(WP19 was profiling on the same machine).

Of the earlier full runs, run 5 passed every phase too. Run 6 failed at the
chests (bug 3, fixed below). Run 4 failed at night: the player was downed
before the harness dodged, and the bots never fought (bug 2). Each run varies
in its loot rolls and in which demons rise.

## Integration bugs found and fixed

1. **Cave manager leaked across a world remount** (WP05 x WP09, client).
   `WorldScene` never called `CaveManager.dispose()`. After leaving the play
   screen and coming back (back to the character list and Play, or the
   rejoins here), the old manager's DOM HUD stayed on screen with a frozen
   "Vein broken" toast. Its window E/mouse listeners also kept swinging at
   the old vein. Fix: one call in `client/src/world/WorldScene.tsx` cleanup,
   with a note in `client/src/world/caves/README.md`. Regression check: the
   harness asserts one `cave-hud` after 4 rejoins. A unit test was not
   practical, because it needs a full R3F scene.
2. **Leashed bots locked onto unreachable enemies** (WP13 `combatbot` x
   WP15). A bot with a goal and leash (the night bots at the ward garden)
   picked the nearest demon anywhere, which was an older pack asleep 160 m
   away. It then stood at its 40 m leash edge with 0 attacks for the whole
   defense, so the event never ended (first full run: 600 s, not held).
   Fix: `server/zone/internal/combat/combatbot/brain.go` skips enemies
   beyond leash + reach, with a note in `server/zone/internal/combat/README.md`.
   Test: `combatbot/brain_test.go`.
3. **The container list was not resent when a chunk finished late** (WP14 x
   WP07). Event 406 lists only containers in chunks that the zone's terrain
   cache has already generated, and it was sent once per chunk entered. A
   player who sprinted up to a chest whose chunk finished after they arrived
   never got the [E] prompt. One run walked to 4 chests and none would open.
   Fix: `server/zone/internal/game/loot.go` (+ the `contSig` field in
   `items.go`) resends whenever the listed set changes. Note in
   `server/zone/README.md`. Test: `TestContainerListResentWhenALateChunkArrives`.

## Harness additions in the client (dev handle, debug builds only)

`window.__lodestone`: `session()` (character id for the zone's debug
endpoints), `rejoinAt({x, z, y?})` (fresh director ticket + dev spawn),
`tap()` / `tapped(kinds, since)` (records the live session's Events and
HitResults) and `selfHealth()` (health from SelfState). They are in
`client/src/devHandle.ts`.

## Observations, not fixed

- The combat HUD store's `health`/`healthMax` are never fed: they stay at 100 while the bar reads SelfState. Only the harness read them (it now uses `selfHealth()`).
- The forge's crafting panel shows no Smithing level: Event 805 carries none, unlike 404.
- Each craft raises two toasts: "Crafted X" (405) and "X" (the 401 grant).
- The HUD names loadout 2 "Sword" (the weapon type), not "Sunsteel Blade".
- Ward-garden demons stand inside or behind the garden building at times (WP13/WP15 known gap: enemies ignore buildings).
- A player who fights a pack of 3 Gloamlings with the starting sword at level 2, without dodging or drinking, can be downed in about 35 s (run 4, before the harness learned to dodge). This is by design.

## Not verified

- A whole night in real time (29 minutes). The clock was moved twice (to dusk, then to just before dawn); dusk and sunrise themselves happened naturally.
- A seeded (unforced) defense event at the player's town. Draedmore was not planned that night.
- Starting the loop by walking to the cave veins: they were reached by dev spawn. G3 covers walking into a cave.
- A second browser player. The night bots were the other two players.

## Evidence

- `g4-acceptance.txt`: the log, with every number and PASS/FAIL.
- `g4-acceptance.json`: the samples, events, zone inventories and bot log tail.
- `g4-acceptance-console.txt`: the browser console.
- `g4-NN-*.png`: screenshots per step, from the camp (01-05) and the veins (06-11), through the town, shop, forge and inventory (12-20), to dusk, demons, the defense waves and dawn (21-31).
