# Playtest 2: co-op playthrough of "The Last Song"

Nicole: "go playtest mode, focused on the two player experience, trying to beat the game and how fun that is and just making it really good and immersive."

Two fresh characters, **Nell** (A) and **Rook** (B), played the prologue and the six acts of the main story in a party on a private stack (the official world, seed 20261108, `LODESTONE_ZONE_DEV=1` for the console), driven by two headless players that walk, talk (E), fight (mouse, 1-4, R, F), climb, mine, forge, buy, ride and revive through the real client. The driver keeps both players alive between commands so each step could be watched and judged: `tools/playtest/coop-driver.mjs` (two browser contexts, commands over a local port), `coop-helpers.mjs` (grid A* around town walls, talk, fight with focus/revive/draughts/dodge, climb, mine, forge, travel, gear), `coop-send.mjs`, and `zone-restart.mjs` (rebuild and restart only the zone mid-run to retry a section after a fix, keeping the database). Raw timestamped log: `docs/evidence/pt2-coop-playtest-log.txt`; the entries below are condensed from it. Screenshots: `docs/evidence/pt2-coop-*.jpg`.

**Dev console use** (every one is in the log): `/tp` for travel only (when my walker stuck on a town wall, a fence or a mountainside; each line says how far it walked first, and after deaths to get back), `/give ore:sunsteel 4` once (retrying the mining step after the party-vein fix), `/spawn sentinel` + `/despawn` once (checking my fight routine on open ground), and **`/god` for the last Hush run** (see Act VI). No `/story`, `/level` or `/quest` shortcuts: every act was played.

Times are wall clock from the first character. They include my tooling time (a lot of it: the walker, the bot's fighting) and eleven zone restarts for fixes, so they overstate what a pair would spend.

## Scores (fun / clarity, 1-10)

| Act | Before fixes | After fixes (re-run or verified) | Why |
| --- | --- | --- | --- |
| Prologue (slimes, the Ward) | 5 / 5 | 7 / 7 | Slimes are a good first fight and kill credit is shared. But both had to queue to hear Tammir and Selina; the sunlit shaft the quest sends you down was a lid; if one friend broke the seam the other got nothing for 6-24 h. All three fixed (the shaft and the seam re-played). |
| I The Fading Hum | 6 / 5 | 7 / 7 | Shared talk with Ulus is lovely (the friend hears his line). The keeper's stone marker sat 7 m off the stone; the first tower was unclimbable in the rain with no word why (13 minutes lost). Both fixed; the same climb in the same rain then took 20 s. |
| II The Tuning Forks | 3 / 4 | 6 / 6 | Three towers kilometres apart and nothing says a steed exists; one fork on a summit with a single 46 degree ridge (we fell off its cliffs, were downed at its foot at night and woke 900 m back). Fixed: Ulus hands a whistle, story forks must be walkable to, tower tops are respawn points, towers stay dry. Catch-up worked perfectly when Rook fell off a cliff. |
| III Verses in the Deep | 4 / 5 | 7 / 6 | The vaults are good co-op: the weighing stones need both of you, the levers' order is in the inscription, the Vault Keeper is a fair 30 s fight. But a "Quest offered" card sat over Nell's screen eating every click, and draughts healed a sixth of a level 12 bar: three lost yard fights before we saw why. Fixed and re-played (yard in 50 s). |
| IV The Night Unsung | 5 / 4 | 7 / 6 | The vigil is great fun with two (three waves in 80 s). Then the Starless Sovereign spawned 80 m out in the dark, outside its aggro and the marker: 8 minutes of looking. Fixed (it walks out to you). The fight (level 24, two players) took 3.5 min and two wipes; it does not reset on a wipe and the respawn is close. |
| V Dawnforged | 3 / 4 | 5 / 5 | Breus is 3 km away (the friend who had not attuned Craidath could not fast travel there). The Galeborn Archon keeps its distance and out-damages a melee pair; the lens step then completed with the Archon at 99 % (adds dying counted as "the place falls quiet"). Fixed (the guardian's fall). Still the least fun fight for a melee pair. |
| VI The Heartfall | 4 / 6 (entrance 9) | 7 / 8 (assisted) | The entrance and the ending are the best moments in the game. The shroud could not be broken by two level 30 players (8 % of a level- and party-scaled pool, from sunsteel/Light only, in 10 s). Fixed (a count of hits). The bots still could not survive the Hush unassisted; with `/god` the mechanics and pacing read well (about 4 minutes). |

## Top findings (and what was done)

1. **The sunlit shaft was a lid** (bug, prologue). The Ward quest says "jump down the shaft (G opens your glider)", the marker points at it, the hole is drawn dark; Rook walked straight across it 150 m above the seam. The cave ground returned the old surface in a masked opening with no floor within 34 m, a rule meant for missing cells. Fixed in Go and TS alike (one golden floor vector updated); Rook then fell to the seam. `b49dad6`
2. **A seam broken by one friend left the other nothing for 6-24 h** (co-op). Party members within 30 m now get their own drop. `457d5ef`
3. **Prologue talks were per player** (co-op). Two friends queued to hear Tammir and Selina. Their talk steps are now shared like the acts' (the friend hears the line, gets their own reward; the farmer's hand-in starts the Ward for both). `e344c88`
4. **Towers in the rain** (pacing). Half speed and a slip every 3 s: the wheel runs out 10 m below the ledge. Both fell off The Forgotten Spire six times; a 10 minute wait at its foot and it still rained. Tower walls are now dry to climb (the crystal hums the rain off its stone): Go `weather.Sheltered` in the zone's step env, TS `shelteredField` in the client's. `6349315`
5. **Act II's third fork was on an unreachable summit** (level design). The story only uses towers with a straight approach under 44 degrees from 150 m out (on the official world The Hollow Spire replaces the Howling Crags' tower). `67342a8`
6. **A quest offer card ate every attack click** (clarity, combat). "The Lodestone's Hum" (Ulus's grandmother and her hum: the main story's own premise as a side quest) popped up a second after a talk and sat over the fight; we lost three vault yard fights doing no damage before seeing it (`pt2-coop-offer-over-fight.jpg`). Story townsfolk make no side offers while the story needs them, and the hum story is retired once The Last Song begins. `8e54b7c`
7. **Draughts healed a flat 40** (balance). At level 12 (247 health) a sixth of the bar; Rook drank eight in one yard and still went down. The heal now scales with your pool from 100 ("Restores 40% of your health"). `f157238`
8. **Downed together, woke 900 m back** (pacing). Only waypoint stones were respawn points; tower tops are now too. Verified: a wipe at the sanctum respawned us on Craidath Spire; at the Hush, on Bukae Spire. `2c734c6`
9. **The Starless Sovereign stood in the dark 80 m out** (clarity). It now walks out 28 m from a defender, inside its aggro. `0edddcd`
10. **The sanctum's lens with the Archon at 99 %** (bug). The guardian's fall now hands over the lens. `a2a22de`
11. **The Hush's shroud could not be broken** (balance). A count of sunsteel/Light hits (4 + 4 per player; the Starless Vow 4 + 6) replaces 8 % of its health. Re-played: broken in ~10 s ("Unshrouded"). `2b02de8`
12. **Nobody tells you a steed exists** (pacing). Ulus hands each of you a spirit whistle with the fork at the end of Act I; the tower steps' note says to call it and that attuned crystals are fast travel points. `411765a`
13. **Fell 330 m through the world** (bug). After a gallop up the Howling Crags Nell stood under the terrain beside the tower (the zone agreed); a metre under the surface the cave rules found open air in a cell with no cave and dropped her. Safety net: under the ground where no cave is, the floor is the surface (Go and TS; goldens unchanged). The ride step that tunnelled is not found yet. `d56c403`
14. **The Last Keeper's stone marker was 7 m off the stone** (clarity). It now stands on it. `ea3ed22`
15. **"Level 33" over the endless night's warning** (clarity). The level-up fanfare came up over the Hush's bar and "The endless night falls on those without a well of their own" (`pt2-coop-hush-wells.jpg`); it now waits for the boss fight to end. `c441eb4`

## Play log (condensed)

### Prologue: Slimes in the meadows, Ward against the night (+0 to +54 min)

- +0:56 Fresh characters in Draedmore. Party: Nell invites, Rook accepts the toast. The tracker shows the partner's progress ("Rook · not started") from the first minute.
- +2 Both talk to Tammir the farmer. My first E went to Selina the blacksmith standing beside him (the prompt names who you'll talk to: clear). Each of us had to talk separately (#3).
- +6 Slimes: two meadows 180-200 m out, five kills in about a minute each, kill credit shared. Fun, quick, a good first fight. (Run 0, a first attempt before my walker worked: a slime dropped legendary leggings and the "Orange Is the New Loot" feat's XP took Nell from level 2 to 5 in one kill while Rook stayed at 2. Random, but the party's levels split at once.)
- +12-23 My walker got Nell stuck in a house and against the town wall; I rebuilt it (grid A* around the walls). Not a player problem.
- +24 Selina: "Bring back four ore, buy my blueprint". The shop says "Blueprint: Sunsteel Blade 1 in stock" but both could buy one (stock is not tracked): "1 in stock" reads as if the friend will miss out (note).
- +33 The sunlit shaft of Faeldstoich Deep (520 m): a lid (#1, `pt2-coop-shaft-lid-before.jpg`). After the fix Rook drops 150 m (no fall damage; the glider optional) and mines the seam alone (Nell's walker was stuck): she gets nothing (#2). Dev `/give` her 4 ore, what the fix gives a friend beside the vein.
- +50 The forge: smelt, smelt, forge, equip: smooth for both. Buying the blueprint on the first visit saves a trip.
- +54 The Forgotten Shrine and the Tome of Glint: Act I's card.

### Act I: The Fading Hum (+55 to +83 min; level 4-5 to 8)

- +55 Nell talks to Ulus; Rook beside her advances too and hears Ulus's line (`pt2-coop-ulus-shared.jpg`). The co-op moment the story was built for, and it works.
- +57 The Last Keeper's stone, 456 m, walked in 81 s. The marker is on the ruin; the stone 7 m off it (#14).
- +60 The Forgotten Spire in a thunderstorm: both fell off three times; the hint said nothing about the rain (#4). After the fix both were up in 20 s in the same rain (`pt2-coop-tower-rain-after.jpg`). Attuning shares the step; Rook attunes too for his boon.
- +83 Back to Ulus by fast travel from the tower. Level 8: the Act II gate (5) never showed.

### Act II: The Tuning Forks (+83 to +128 min; level 8 to 11)

- Bought Spirit Whistles at Fenia's (40 g); nothing in the game had mentioned them (#12). Rook galloped 810 m in 63 s: riding is a joy.
- Craidath Spire (850 m): Nell climbed and attuned; Rook stayed in the saddle at the foot (my bot) and got the step anyway.
- The Ironbound Spire: both walked 1.5 km in under 4 minutes. Rook climbed, Nell shared.
- The Forgotten Spire of the Howling Crags (top 449 m), the bad one (#5): Nell galloped up the mountainside and ended 330 m under the terrain (#13). Every side but one 46 degree ridge is cliff. Both were downed by Gloamlings at its foot at night (new moon) and woke in Draedmore 900 m back (#8), twice. Via the ridge Nell climbed it (`pt2-coop-crags-top.jpg`); Rook fell 320 m off the cliff while fighting at the foot, died, woke in Draedmore and **caught up from the journal**: one click, on Nell's step at once.
- +128 Ulus: Act III. Level 11.

### Act III: Verses in the Deep (+128 to +160 min; level 11 to 17)

- The Undervault of The Hollow Ruins (600 m): both downed within seconds of arriving, three times. The cause: the offer card (#6), and draughts healing 40 of 247 (#7). The herbalist (Caeleth) is the only seller of draughts and nothing points to her (general stores have none).
- After the fixes the yard fight, watched second by second: 9 elites (a level 4 area, "Swift" and "Warded" affixes), both in together on the nearest: cleared in 50 s, Nell low 41 %, Rook low 9 % with 8 draughts (`pt2-coop-vault-yard.jpg`). Hard and fair. Elite XP is large (12 to 15 in this vault).
- **The weighing stones** (three, all at once, each down 14 s): Rook holds the far one, Nell steps on the other two: open first try. A real two-player puzzle. The Vault Keeper: 31 s. The chest for both.
- The Undervault of The Moonlit Ruins (1.1 km): yard in 46 s; **the levers**: the inscription gives the order; pulled wrong first ("The levers clatter back"), then right. Vault Keeper 27 s.
- +160 Ulus: Act IV. Level 18 (the gate is 10).

### Act IV: The Night Unsung (+160 to +192 min; level 18 to 27)

- Teiraben (1.2 km west): Gartha twice ("Then we stand. Light the beacon!"). The vigil starts at once by day.
- **The vigil** (`pt2-coop-vigil.jpg`): "The ward of Teiraben falters! Demons are coming"; three waves (7, 9, 12 demons) in 80 s; the ward garden never dropped; +300 XP each. Fun, loud, quick.
- **The Starless Sovereign** spawned at the town's edge 80 m out, outside its 50 m aggro, and stood still in the dark; the marker covers the whole town (#9). A level 24 lord against two level 23s: 3.5 minutes, two wipes; each time we respawned 80 m away and it had kept its damage.
- +192 Gartha: Act V. Level 27.

### Act V: Dawnforged (+192 to +225 min; level 27 to 30)

- Fast travel to Craidath Spire, nearest attuned crystal to Steinmadun. Rook had never attuned Craidath (the step was shared), so his fast travel failed and he crossed 3 km on foot: a party member's crystals don't help you travel (note).
- The Sanctum of Bukefoim's **Galeborn Archon** (level 14, ranged, keeps its distance; its body holds a melee player at 5.3 m): two level 27 melee bots did 4-10 % per attempt at ~15 damage a second taken each. Then the lens step completed with the Archon at 99 % (#10).
- I noticed here that my bots had fought Acts III-V with the level 10 Sunsteel Blade and level 1-4 armour while twenty weapons piled up in their packs (a level 26 voidglass spear among them). A player sorts loot; the bots now do. The pack shows rarity colours but doesn't flag "better than what you wear" (note).
- Rook was 3 km away when Nell gave the lens: catch-up again.

### Act VI: The Heartfall (+225 to +290 min; level 30-33)

- Bukae Spire (Verdant Downs, an ordinary 30 m tower): both climbed in 20 s.
- The Heartfall, 220 m on: **the entrance** (letterbox, "The Heartfall / The Hush / Mother of the Unsung", its three lines, the HUD hidden; `pt2-coop-hush-entrance.jpg`): the best moment in the game. Two night Gloamlings stood in the arena during it (note).
- The first attempts were Nell alone (Rook had respawned on Bukae Spire and never re-entered; the Hush rose "for 1 player"); ~25 s each and it reset.
- **Two players, before the shroud fix**: 100 → 77 % in 2 minutes with revives back and forth (half health each time, "[E] Raise Rook (hold)"); every 26 s the shroud, never broken (100 → 92 → 84 → 67 % in its 10 s), so the Long Quiet (-40 %) and a 5 % heal every time (#11). Both down at 119 s; it reset.
- **After the shroud fix** (same pair, same level): the shroud broke in ~10 s ("Unshrouded", 100 → 34 → 0), but the bots still went down within 70-120 s each attempt and the Hush reset (a wipe resets it; respawns are 220 m away). With my fight routine dodging back on wind-ups aimed at it, no better (it dodged out of the arena). Measured: at level 33 (the party's level + 1) the Hush's rend (77) and toll (70) take a non-dodging level 32 (544 health) in ~25 s; revives were used constantly.
- **Assisted (dev `/god` on both, logged)**, to see the rest as a pair: 100 → 70 % in 37 s (the shroud broken by 12 hits); **the choir** (`pt2-coop-hush-choir.jpg`): 3 bells for two, the Hush untouchable; the bots needed 86 s (the last bell 70 s: my west/east split left both on the wrong side; a pair talking would not); the last bell: it reels, 70 → 34 % in 37 s; **the endless night** twice: each to their own well (golden columns, easy to see; the warning line is clear, but the level-up fanfare covered it once: #15); the shroud again; **silenced at 229 s**.
- **The ending** (`pt2-coop-ending.jpg`, `pt2-coop-credits.jpg`): "You have beaten Lodestone, together. Title earned: the Dawnsinger", the lines over a sunrise, "They will sing of Nell and Rook, who kept the last song together", then the credits ("Sung by Nell, Rook"). Both saw it; the journal shows the acts done and the Starless Vow (`pt2-coop-postgame.jpg`). A lovely payoff.
- **Verdict on the Hush**: the mechanics read well (the shroud's line, the bells, the wells); after the shroud fix the length is right (about 4 minutes for two who survive). Whether a human pair survives its damage I could not settle with bots that can't read telegraphs: **this is the one thing to play by hand**. If it proves too much, the lever is its level (party level + 1) or rend/toll damage, not the mechanics.

## Co-op, balance and immersion notes

- **Sharing**: talk, read, attune, vault and vigil steps shared reliably within 200 m; kill credit and kill XP shared; vault chests per player. Catch-up (twice) is excellent. Weak spots now fixed: prologue talks, vein drops. Still open: fast travel only to crystals *you* attuned; the shop's "1 in stock" reads as exclusive.
- **Being in different places**: the 200 m share radius is generous; the failures were respawns (each player wakes at their own last waypoint: we woke 3 km apart at Teiraben and Craidath, and Rook missed a shared step that way twice). The compass shows the friend's distance, which helped.
- **Revive**: works and feels good (raised at half health; the downed player sees "A friend can raise you"). Holding E twice failed when the raiser was hit or moved (the third hold worked).
- **XP and level gates**: level 8 at Act II (gate 5), 11 at III (8), 18 at IV (10), 27 at V (12), 30 at VI (14). The gates never bound; elite vault yards and the vigil give a lot of XP. Bosses scale to the party (+1), so this does not trivialise them; early ordinary enemies become trivial. Not changed.
- **Time to kill**: slimes 1-2 hits; vault elites 3 hits at level 15; Vault Keepers 30 s; the Sovereign 3.5 min (with wipes); the Archon very long for melee; the Hush ~4 min (assisted).
- **Damage taken**: vault yard (9 elites): 50-90 % of the bar each in 50 s; the Sovereign ~6 % a second on its target; the Hush ~4 % a second; the Archon ~3 % a second.
- **Mana / stamina**: never short of mana; stamina only on climbs (rain) and riding spurs.
- **Immersion breakers**: the offer card over a fight (#6); the Sovereign standing still in the dark (#9); the 330 m fall (#13); Gloamlings in the Hush's entrance; "Dodged!" toasts for lightning you never saw, mid-boss.
- **For the immersion/asset pass** (not touched here): world event cards (Wandering Behemoth, Caravan Ambush) sit top centre over the clock for minutes; night came by 18:15 on the clock; the boss bar reads "phase 1/3" through the Hush's choir.

## Fixes (commits)

| Commit | Fix | Test |
| --- | --- | --- |
| `b49dad6` | Caves: a sunlit shaft drops you down it (the old surface only stands in for missing cells) | Go `caves/shaft_test.go`; golden cave queries (one floor vector updated) |
| `457d5ef` | Mining: party members within 30 m of a breaking vein get their own drop | Go `TestMiningBreakSharesWithPartyBeside` |
| `e344c88` | Story: the prologue's talk steps are shared in a party | Go `TestMeadowsTalksSharedInParty` |
| `0d90a61` | Playtest tools: the co-op driver, helpers, zone restart; towns debug `solids` | (tooling) |
| `ea3ed22` | Act I's marker on the Last Keeper's stone | Go story e2e (marker = tabletPos) |
| `6349315` (`c3eee82` reverted by `636290c`) | Crystal towers stay dry to climb (Go `weather.Sheltered`, TS `shelteredField`) | Go `TestShelteredTowersAreDry`; vitest `sim/shelter.test.ts`; movement goldens unchanged |
| `411765a` | Ulus hands each player a spirit whistle; tower notes mention the steed and fast travel | Go `story_test` (act 1 grants) |
| `d56c403` | Caves: under the ground where no cave is, the floor is the surface | Go `shaft_test.go`; golden cave queries unchanged |
| `2c734c6` | A tower top is a respawn point | Go `TestTowerTopRevealsRegion` |
| `67342a8` | Act II's forks must be walkable to (44 degrees) | Go story e2e (every fork approachable; the Crags tower not) |
| `8e54b7c` | Story townsfolk make no side offers while needed; "The Lodestone's Hum" retired in the story | Go story e2e (no offer on B's talk) |
| `f157238` | Draughts heal a share of the health pool | Go `TestDrinkScalesWithHealthPool` |
| `0edddcd` | The Starless Sovereign walks out within aggro of a defender | Go story e2e (within aggro) |
| `a2a22de` | The sanctum's lens on its guardian's fall | Go story e2e (adds dying is not enough) |
| `2b02de8` | The Hush's shroud: 4 + 4 sunsteel/Light hits per player | Go story e2e (12 for two; one huge hit counts one) |
| `c441eb4` | The level-up fanfare waits for a boss fight | client typecheck, progression vitest |

## Verification

See docs/STATUS.md "Playtest 2: co-op playthrough" for the suite results after merging main (gen:check, go vet, go test, typecheck, eslint, client vitest 1241 tests; test:golden: every hash matches in every host, the Chromium chunk-time budget missed under machine load).
