# 0024: The main story and the endgame ("The Last Song")

Status: built (playtest 2, CR 035, branch `pt2/main-story`). **Every name, line and number here is a proposal for Nicole.** Text lives in `server/zone/internal/story/story.go` (acts), `server/zone/internal/game/finale.go` (the Hush, the ending), `server/zone/internal/game/story.go` (vigil lines), `contracts/combat.yaml` (the Hush, its bells, attacks), `contracts/achievements.yaml` (the last 11 entries), `client/src/ui/story/credits.ts` (the credits' own lines).

## The problem

Lodestone had a world, quests, vaults, bosses and nights, but no way to *beat* it. Nicole wants a two-player "let's beat the game" evening: a main questline that paces a new character from the Haven to an ending in a few hours, a final boss worth calling a set piece, an ending with credits, and a world that carries on afterwards.

## The lore (tying what exists together)

Everything below was already in the game, scattered across lore tablets, the codex and quest lines; the story connects it.

- **The Lodestone** sleeps in the deep rock and *hums*. The first people built their fires where the hum was loudest (tablet "The First Hum").
- **The Breaking**: when it woke, the shards scattered (the **tower crystals**) and "the night grew teeth": the **Unsung** (the demons), "born where the hum went quiet" (tablet "The Breaking").
- The towers are **tuning forks**, not watchtowers ("The Lodestone's Hum" story; tablet "The Tower Builders").
- **Sunsteel** "remembers the sun" and **Light** magic: the only things that kill the Unsung (the Ward quest, "The Sunsteel Oath").
- The **vault wardens** sealed the deep vaults with riddles the Unsung cannot answer (tablet "The Vault Wardens").
- **The Last Keeper**: "I am the last who remembers the song... Listen." (tablet).
- **The Starless Sovereign**, the demon lord of new-moon nights.

New: the song is fading, so the nights get bolder. At the heart of the silence is **the Hush**, "mother of the Unsung", waiting at **the Heartfall**, where the Lodestone broke. To end it you wake the forks, recover the **Verses** the keepers sealed in the vaults, keep the **vigil** that draws out the Starless Sovereign, have a master smith forge a **Dawnheart** (sunsteel that holds a song), wake the last fork and face the Hush. Victory: the Lodestone sings again and the dawn comes.

## The acts

Places are **world-global**, resolved once per zone from the towns, the atlas, the vault plans and the terrain (deterministic, so every zone and every party member gets the same acts). On the official world (seed 20261108):

| Act | Title | Gate | Where (official world) | Steps |
| --- | --- | --- | --- | --- |
| Prologue | Slimes in the meadows; Ward against the night | | Draedmore (the Haven) | existing: slimes, the blacksmith, sunsteel ore, the blade, Light |
| I | The Fading Hum | - | Draedmore, the Watchtower of Droraeth (the Last Keeper's stone), The Forgotten Spire (Forgotten Heights) | talk to Ulus the innkeeper · read the Last Keeper's stone · attune the nearest tower · back to Ulus (the **Keeper's Tuning Fork**) |
| II | The Tuning Forks | level 6 (was 5) | Craidath Spire (Gilded Fields), The Ironbound Spire (Burning Leas), The Hollow Spire (playtest 2 co-op: the Howling Crags' summit tower was dropped, no walkable approach) | wake three forks in three regions (nearest-neighbour route; only towers with a straight approach under 44 degrees) · back to Ulus |
| III | Verses in the Deep | level 9 (was 8) | The Undervault of The Moonlit Ruins (levers), The Vault beneath Baimteick Ruins (weighing stones: two players hold them easily) | open two sealed vaults, beat their Vault Keepers (**Verse of Dawn**, **Verse of Dusk**) · back to Ulus |
| IV | The Night Unsung | level 13 (was 10) | Teiraben (the vigil town; Gartha, its bounty keeper) | find the captain · "light the beacon": a town defense (3 waves) · the **Starless Sovereign** walks out of the dark (mid-boss; only sunsteel and Light) · report |
| V | Dawnforged | level 18 (was 12) | Steinmadun (Breus, master smith), Sanctum of Bukefoim (an Archon) | the smith · clear the sanctum (the **Archon's Lens**) · give the lens (the **Dawnheart**) |
| VI | The Heartfall | level 22 (was 14) | Bukae Spire (Verdant Downs, the most dangerous and remote region), the Heartfall (open ground ~400 m from it) | wake the last fork · follow the Dawnheart to the Heartfall · silence the Hush |

Each act is an ordinary quest (kind 3 "Main story", key `story:main:<n>`): markers on the map and compass, the tracker, the journal, saving, the WP16 handoff all come for free. It starts by itself when the previous act ends (Act I when the Ward is done, or for a level 4+ character who dropped it), with a title card in the discovery-intro style. The main story cannot be abandoned.

### Pacing (estimates for one new player; a pair is a bit faster: steps done together count for both)

| Stretch | Levels | Time | What fills it |
| --- | --- | --- | --- |
| Prologue | 1-4 | 30-40 min | the first quest, sunsteel, Light |
| I | 3-5 | 20 min | ~2.5 km of walking, the first tower climb |
| II | 5-8 | 35 min | three regions, three climbs, discoveries on the way |
| III | 8-11 | 40 min | two vaults: yards of elites, a puzzle each, two keeper fights |
| IV | 10-13 | 25 min | travel, the defense waves, the Sovereign |
| V | 12-15 | 30 min | the far north-east, an Archon |
| VI | 14+ | 25-35 min | the last climb, the finale (5-8 min with two) |
| **Total** | | **~3.5-4 h** | |

Gates rarely bind if you play the acts (their rewards plus discovery XP keep you near the curve); they stop a player who catches up or rushes from walking into the Heartfall at level 6. Areas are stamped by the first visitor's level (CR 012), so the regions meet you where you are. Playtest 2 co-op polish: the playthrough reached the acts at 8, 11, 18, 27 and 30, so the gates now sit at about two thirds of that and the act card names them.

## Two players

- **Shared steps**: when a party member completes a step of an act, every member on the zone within 200 m who is on the same act and step completes it too (and gets the step's own items: each has their own relics). Talking, reading, the gates (a lower-level friend passes beside you), vaults, the vigil, the finale.
- **The leader**: the party member furthest along. Each member sees the others' act and current step in the quest tracker; the one behind is told so and gets **Catch up** in the journal: they jump to the leader's act and step, keep every relic of the skipped steps and get half the skipped acts' XP.
- **Revives**: a player an enemy downs with another player within 40 m waits 20 s instead of the 3 s respawn. A friend holding **E** beside them for 3 s raises them with half their health; **Space** respawns at once. Downs in PvP keep the plain respawn.
- **Scaling**: the existing party scaling (health +75 % per extra engaged player, damage +10 %, tuned to 4) on the Sovereign and the Hush; the finale's mechanics scale with the players in the arena (bells, wells).
- Loot stays personal (WP14).

## The finale: the Hush

A set piece at the Heartfall: a ring of broken obsidian pillars around a sigil, the Heart (a cracked dark crystal) floating over it. Armed when someone who may fight it (Act VI on its last step, or anyone who beat the game: a rematch) walks in with their party.

**Entrance** (7 s): letterbox bars, the title card "The Heartfall / The Hush / Mother of the Unsung" in the discovery-intro type, its three lines; it is untouchable and still meanwhile.

| Phase | Health | What it does | What it asks of two players |
| --- | --- | --- | --- |
| 1 | 100-70 % | rend (a wide cone), toll (a ring around it), falling stars (ground circles); every ~26 s **the shroud**: a ward that only **sunsteel or Light** breaks: 4 + 4 hits per player in the arena (playtest 2 co-op; it was 8 % of its scaled health, out of reach for two level 30s); ordinary hits do nothing | one keeps its attention, the one with Light breaks the shroud in 10 s: broken, it staggers and takes 1.5x damage; unbroken, **the Long Quiet** hits everyone for 40 % and it heals 5 % |
| 2 | 70-35 % | **the choir**: it is untouchable at the centre while its **Hollow Bells** (players + 1, 2-4, around the edge; Unsung: only sunsteel or Light cracks them) toll; the chorus falls under every player every 7 s | split up, each takes the bells on their side; the last bell shattered: it reels (6 s stagger, 2x damage for 8 s) |
| 3 | 35-0 % | faster, a lance; the shroud again; every ~30 s **the endless night** (7 s warning, the sigil burns red): only those in a **well of dawn** (golden columns, one per player, 2-4) are spared; **two in one well and it fails them both** (75 % of their health) | find a well each, revive whoever the night caught |

**Scaling 1-4**: health and damage by engaged players; bells and wells by players in the arena; adds (shades) at each phase change by party size. Solo, it is a long, careful fight; with two, a 5-8 minute one.

**Hard mode, the Starless Vow** (post-game, toggled in the journal): the Hush rises 4 levels higher, the shroud every 20 s (4 + 6 hits per player), the chorus every 5.5 s, the night every 24 s; your nights carry 1.5x hunters.

**Victory**: Act VI ends (600 gold, 2000 XP, two rolled rare+ items); everyone in the fight sees **the ending**: lines over a sunrise ("They will sing of Nicole and Friend, who kept the last song together."), then **the credits** (the game's own lines, then every section of CREDITS.md). The arena glows gold for a minute.

## Post-game

- The world carries on: your nights are calmer (0.6x hunters around you) once you have beaten it.
- **Titles and achievements** (a new category, "The Last Song"): The Last Song (beat the game: "the Dawnsinger"; "the Dawnbringer" was taken), Dawn, Together ("the Dawnsworn"), Starless and Unbroken (hard mode: "the Unbroken"), Two Against the Dark (hard mode together: "of the Long Night"), Unshrouded, Not Today / Second Wind (revives, "the Steadfast"), and a chain for Acts I, III, IV and V ("the Vigilant").
- **Rematch**: the Heartfall re-arms a minute after a victory for anyone who has beaten it (the Starless Vow makes it the hard one).

## Alternatives considered

- **Per-character places** (around each player's home town, like the CR 023 stories): rejected; party members would get different acts and could not share steps.
- **One long quest** instead of six: rejected; acts make the journal readable and give each a reward and a title card.
- **A generated arena structure in worldgen** (Rust): rejected for this pass; the Heartfall is a zone-chosen spot with a client-drawn arena (no collision on the pillars), cheaper and with no golden-world churn.
- **Waiting for nightfall for the vigil** (an in-game day is 60 minutes): rejected; the beacon brings the Unsung even by day.
