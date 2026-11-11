# CR 035: The main story and the endgame (playtest 2)

Branch `pt2/main-story`. Nicole: the game has no way to *beat* it; she wants a two-player "trying to beat the game" evening that is fun and immersive. Design and lore: `docs/decisions/0024-main-story.md` (all names and lines are proposals).

## Summary

- **"The Last Song"**, six acts after the prologue ("Slimes in the meadows", "Ward against the night"): The Fading Hum, The Tuning Forks, Verses in the Deep, The Night Unsung, Dawnforged, The Heartfall. Each act is a quest of a new kind, **3 "Main story"** (key `story:main:<act>`, id `0x4d4e0000 | act`), started by the zone when the last ends (Act I when the Ward is done), with a title card (Event 1602) and a level gate (5, 8, 10, 12, 14: a new objective `level`). It cannot be abandoned (Event 954 value 7).
- **World-global places** (internal/game/story.go `resolveStory`, deterministic): the Haven town's innkeeper, the Last Keeper's lore stone, the nearest tower and three more in three regions, two sealed vaults any party can open (levers or weighing stones), a vigil town with a guard or bounty keeper 700-1900 m out, the master smith of the last (most dangerous, most remote) region and the nearest sanctum (a wizard tower's Archon), that region's tower and **the Heartfall** (open level dry ground 220-1300 m from it, clear of every site). A world missing any place has no main story (the flat and scale worlds).
- **New objectives**: `level` (Facts' optional `Leveler`), `story` (a happening the glue signals: the vigil held, the Sovereign fell, the Hush fell); `attune` steps may name their tower (`Site`), and attuning a crystal you attuned before now counts for such a step (both old and new attune steps).
- **Act IV, the vigil**: "light the beacon" starts the vigil town's defense (WP15's `StartDefense`, day or night); held, the **Starless Sovereign** (the existing demon lord, at the party's level + 1) walks out of the dark at the town's edge; it falling ends the vigil. A broken ward or an abandoned vigil rolls the act back to "light the beacon".
- **The finale** (internal/game/finale.go): the Hush (`the_hush`, a new boss, 3 phases) at the Heartfall: the entrance (Event 1604), the shroud (only sunsteel or Light), the choir of Hollow Bells (`hollow_bell`, a new Unsung: only sunsteel or Light), the endless night and its wells of dawn (one player each), scaling 1-4, the Starless Vow (hard mode). Victory: the ending (Event 1605) and the credits on the client.
- **Two players**: party-shared steps (within 200 m, same act and step), each member's progress in the tracker (Event 1601), **catch up** to the furthest member (Interact 140/2), **revives** (Interact 140/3-4, Events 1610-1612).
- **Post-game**: calmer nights for those who beat it (0.6x hunters), the **Starless Vow** (Interact 140/5: 1.5x hunters and the hard Hush), the rematch, 11 achievements in a new category "The Last Song" with titles (the Dawnsinger, the Dawnsworn, the Unbroken, of the Long Night, the Vigilant, the Steadfast).

## Contracts

- `combat.yaml`: enemies `the_hush` (id 103, boss, dark) and `hollow_bell` (id 112, demon, lesser, speed 0.1); attacks 89-95 (`hush_rend`, `hush_toll`, `hush_lance`, `hush_fall`, `hush_chorus` and `hush_night` (struck only by the zone), `bell_toll`); `bosses.the_hush` (3 phases at 1.0 / 0.7 / 0.35, transition 3 s, arena 30 m); names.
- `items.yaml`: quest items `quest:keepers_fork`, `quest:verse_dawn`, `quest:verse_dusk`, `quest:archon_lens`, `quest:dawnheart` (appended).
- `achievements.yaml`: 11 achievements appended (earlier ids unchanged); stats `acts`, `finale`, `finaleparty`, `finalehard`, `finalehardparty`, `shrouds`, `revives` (codegen's list); category `story` appended to `ACH_CATS` (earlier indexes unchanged).
- `content.yaml`: codex entries for the Hush and the Hollow Bell.
- `events.md`: Events **1600-1612** (range 1600-1629 claimed), Interact **140 `story`**, dev console action **28** (`/story`). No protocol change, **no migration** (acts ride in `character_quests`, the post-game counters and the vow flag in the `character_content` stats).

## Server

- `internal/story` (new, pure): the acts, progress, catch-up.
- `internal/quests`: `KindMain`, `ObjLevel`, `ObjStory`, `Leveler`, attune by site, `ForceStep` (a shared step), `SetStep`, `MarkDone`, `Forget`.
- `internal/combat/story.go` (new): `Enemy.Guard` (a hook in `applyDamage`), `Enemy.HeldUntil` (checked in `disabled`), `StoryStrike`/`SettleStoryStrikes`, `HurtPlayerBy`, `Hold`, `MoveEnemy`, `SpawnNow`, `HoldDowned`, `RespawnNow`, `DownedLeft`, `Revive`, `ApplyDevDamage`. One-line hooks in `enemy.go`, `validate.go`, `world.go`.
- `internal/game`: `story.go`, `finale.go`, `revive.go`, `story_dev.go` (new); hooks in `server.go` (field, init, tick, join, leave), `session.go` (Interact 140), `quests.go` (`Level` fact, `storyAfter`, no abandoning the main story), `content.go`/`progression.go` (attune with its site, also when already attuned), `night.go` (`storyHunters`, `storyDefenseEnded`), `combat.go` (`storyCombatEvent`), `devconsole.go` (action 28).

## Client

`client/src/ui/story` (new; README there); hooks in `net/NetPlay.tsx` (hook, `FinaleLayer`), `screens/PlayScreen.tsx` (`StoryHud`), `ui/quests/{QuestHud.tsx,events.ts}` (party line, journal bar, kind 3, no Abandon for the main story), `input/{interact,bindings}.ts` (E_ORDER `revive`; contexts `downed`, `ending`), `ui/menu/controls.ts`, `ui/devconsole/{commands,events}.ts` (`/story`), `combat/enemies/spec.ts` (the Hush draws as an archon, its bells as shades).

## Tests

- Go `internal/story/story_test.go`: every act builds (markers, text, gates), progress, gates by level, attune by tower, `ForceStep`, catch-up (relics, half XP, never backwards).
- Go `internal/combat/story_test.go`: the guard (shrouded, killing hits, a staggered x2), hold, a story strike telegraphed and landing, a held down survives the 3 s respawn, revive, respawn now.
- Go `internal/game/story_game_test.go`: **two players in a party play the whole questline in process on the official world** (Acts I-VI: shared steps, a real attunement on a tower top, the gates, the vaults' signals, one player wandering off and catching up with the verses, the vigil's town defense and the Sovereign, the archon's sanctum and the lens, the Dawnheart, the Heartfall's arming and entrance, scaling for two, the shroud, the choir of three bells, the endless night (one well each: spared; both in one: struck), a revive, the ending for both (together), achievements and titles, calmer nights, the vow and the harder rematch, the state after a reconnect).
- Vitest `client/src/ui/story/story.test.ts`, `devconsole.test.ts` (`/story`), `bindings.test.ts`, `enemies.test.ts`.

## Evidence

`node tools/playtest/stack.mjs --zone-env LODESTONE_ZONE_DEV=1`, then `LODESTONE_CLIENT_URL=<url> node tools/playtest/story-shots.mjs`: two browsers, a party, `docs/evidence/pt2-main-story-*.jpg`.

## Known gaps

- The Heartfall's pillars are drawn by the client only (no collision); the arena has no worldgen structure.
- Shared steps and the party line work for party members on the same zone (like the party ring).
- The vigil uses the town defense as it is (its waves scale with defenders, not the story); a town under a vigil can't also have a natural defense that night.
- The Hush's model borrows the archon's (a dark floater); the bells the shade's.
- Names, lines and numbers are proposals for Nicole.
