# CR 051: The first hour (arrival, errands, one thing at a time)

Playtest 4 (branch `pt4/first-hour`). Nicole: "I load the game and idk what to
do. There's too much and nothing pulling me." Audit:
`docs/evidence/pt4-first-hour-audit.md`.

No protocol, no new Event kind (1940-1949 stay unused), no Interact kind
(181 unused), no migration (0036 unused), no content/YAML change, no worldgen
change. New server behaviour on existing wire: Event 1930 (the shared bark),
Event 951/955 (offers and started quests), Event 952/953.

## 1. The arrival

A brand-new character (no quest log, so "Slimes in the meadows" starts for
them at join) is called over by name:

- 3 s after joining, the mentor (the slimes' giver: the town's farmer, else a
  guard, innkeeper, villager or merchant; `meadowsGiverRoles`) barks "<Name>!
  Over here! Yes, you, ..." to that player only (`npcBark(..., to = player,
  7.5 s)`, Event 1930). The mentor has to be an active NPC (a player is near
  the town): the call retries once a second for 25 s.
- 40 s later, if the slimes quest is still on its talk step and the mentor is
  within 90 m, a second call: "... Walk up close and press E to talk."
- Talking to them (the existing talk step) starts the slimes; the line they
  say is the existing one.
- Old characters (the Ward or the slimes already started) never get it:
  `fhArrive` is only called where the slimes were just added at join.

Drawing the bubble is pt4/lively-npcs' (`npcFocus.say` from Event 1930); this
branch only sends it.

## 2. The errands

Six short quests (`internal/quests/errands.go`, keys `story:errand:<id>`, kind
`KindStory`), each given by a person of the town and pointing at one system.
Lines in the person's voice; markers on the person, the cave, the water or
the tower.

| id | giver | what | reward |
| --- | --- | --- | --- |
| `ore` First ore | blacksmith | mine 3 veins (pickaxe) in the nearest cave with copper or iron, smelt one ingot at the forge | 15 g, 70 XP, a copper sword, a whetstone |
| `timber` Timber | the mentor | fell 3 trees (axe; 3 logs given), build any piece with the hammer (key 9) | 15 g, 70 XP, a bedroll, 4 firewood |
| `torch` The dark mouth | guard | light the torch (key 8), walk to the nearest cave mouth | 20 g, 80 XP, 2 draughts |
| `pond` Something for the pot | innkeeper | a rod is given; catch one fish at the nearest deep water | 20 g, 70 XP, a draught |
| `steed` Faster legs | merchant | a Spirit Whistle is given; whistle (H), mount (E) | 25 g, 60 XP |
| `tower` A view of the land | bounty keeper | climb and attune the nearest approachable tower (reveals the map; the closing line hands over to the innkeeper's story, Act I, and "ask around" for rumours) | 40 g, 120 XP |

XP is tuned against CR 048's curve (level 2 = 360 XP, level 3 = 660): the
spawn town's discovery (100), the slimes (60) and the three prologue errands
(220) reach level 2 around the third errand, the Ward (200) and the rest
level 3; all six errands pay 470. Gold is small on purpose
(the Ward's smith coin and the sunsteel blueprint stay a purchase).

### New objective kind `do`

`ObjDo`: do the deed named `Family` `N` times (counted in `Quest.Count`, saved
like kill counts; shown as `n/N` through the wire's `need`). The glue signals
deeds from the systems themselves, event-driven (`questsDeed`; a no-op unless
a current step is a `do` step): `mine` (`breakVein`, the breaker), `fell`
(`harvest`, a tree felled with the axe), `smelt` (`craft`, a `smelt_*`
recipe), `build` (`buildPlace` and a camp kit placed), `torch` (lit with key
8), `fish` (`fishLanded`), `steed` (`steedSummon`), `ride` (`steedMount`). The
torch errand's second step and the tower's use the existing `reach` and
`attune` kinds.

### Chain and offers

- A **new character** (started the slimes, no Ward yet): finishing or
  dropping the slimes, and then each of the first three errands (ore, timber,
  torch), starts the next by itself, tracked, with a talk step to its giver
  first (so the tracker always points at a person). The Ward follows the third
  (`questsWardHandoff` -> `errandChain`); until then the blacksmith does not
  offer it (`wardWaitsForErrands`). Dropping a chain errand skips it (marks
  it done without a reward). Errands 4-6 (pond, steed, tower) are **offered
  on a talk**, in order, after the previous one is done.
- **Everyone else** (characters from before this change, or a new one who has
  skipped past): nothing starts by itself; each giver offers their errand when
  talked to (`errandsTalk`, the same Event 951 card as every side quest; an
  accepted errand starts at its first deed, no talk step), in any order. An
  errand offer goes before a side quest or story from the same person; after
  accepting it the next talk offers the side quest.
- A town that cannot give an errand (no cave nearby, no water, no tower) skips
  it; resolution (`errandsAt`) happens once per settlement per process.

## 3. One thing at a time (client)

`client/src/ui/tips/firstHour.ts`: while a character has the slimes in their
log (`story:meadows`) and less than 10 minutes of the session have passed,
`firstHourHold` is true. Then:

- tips: only `look`, `quest`, `fight` and `heal` show (`PRIMARY_TIPS`);
  `talk` is the mentor's to say and is marked seen; `climb`, `glide`,
  `skills` and `night` wait (and then come in that order);
- the What's new welcome card waits (`cardMayShow(held)`); it comes up after
  the slimes are handed in, with a line that no longer tells a new player to
  find "a first job".

## 4. Not done / gaps

- No marker for "trees" (the world has no spatial query for scatter), so the
  timber errand's markers are the mentor only; any tree works.
- The mentor stays where they stand: they do not walk to the player.
- The arrival happens wherever the spawn is (50 m from the mentor in the
  official world), at whatever hour the world clock is.
- The ore and torch errands may share a cave (the nearest one: 490 m from
  Draedmore); no dwarven camp is marked.
- The steed errand needs a dry spot and daylight; the bonding can be refused
  (the player sees the refusal and tries again).
- Errand quests count toward the "stories" feat like any other story quest.
