# CR 023: World content (side quests, world events, sealed vaults, codex and feats, foraging)

Branch `pt2/content`. Nicole: "add some other content to this game".

## Summary

A data-driven content bundle over the existing systems, all server-authoritative and persisted:

- **Townsfolk side quests**: 2-4 quest givers per settlement (seeded from the world and the settlement), each with a deterministic sequence of requests: hunts, gathering, deliveries to another town, exploration, and rescues (a lost villager follows you home). Rewards: gold, XP, items and **renown** with the town (four tiers; better shop stock at higher tiers).
- **Story quests**: three handcrafted multi-step quests (The Lodestone's Hum, Embers of the Old Watch, The Bell Beneath) whose places resolve around the town that offers them.
- **World events**: Starfall, Caravan Ambush, The Wandering Behemoth, The Wild Hunt (night), The Glintfox. Zone-scheduled near players, zone-owned, announced (toast, tracker, compass and map markers), scaled to the area's level, personal rewards.
- **Sealed vaults** (dungeons): one per region under a ruin or shrine; a seal puzzle (levers in an order, pressure stones, braziers lit with fire magic, a font stilled with ice magic), elite packs, the **Vault Keeper** (a boss with a telegraphed sigil), a chest with a guaranteed rare. Marked on the map once found.
- **Collectibles**: 16 lore tablets at ruins, shrines and watchtowers; a creature codex (unlocked on first kill); 25 feats with titles shown on nameplates; journal tabs Bestiary, Lore, Feats, Renown.
- **Foraging**: herb patches by biome (five herbs, one new each in four biomes plus heartleaf) feeding five new cooking/brewing recipes.

## Contract changes

- **New `contracts/content.yaml`** → `npm run gen` → `contracts/ts/src/gen/content.ts` (`CONTENT`) and `server/pkg/contentdefs/content_gen.json` (+ `contentdefs.go`). The generator (`contracts/codegen/lib/content.mjs`) checks every enemy, item, role, biome, rarity and feat stat, and that the codex covers every combat.yaml enemy.
- **combat.yaml** (no version bump: additive): enemies `glintfox` (70, family `critter`, behavior **`flee`**: never attacks, runs from the nearest player), `gloamhound` (71) and `hunt_master` (72) (family `hunt`), `starfall_sentinel` (73), `thornhide_behemoth` (74), boss `vault_keeper` (102) with a `bosses` entry (2 phases); attacks 80-88 (`keeper_sigil` is the telegraphed mechanic: a 4.5 m ground sigil under everyone in the fight, 600 ms wind-up). No existing table, id or number changed, so spawning and the scale scenario are unchanged.
- **items.yaml**: herbs `herb:emberroot|frostcap|glowmoss|duskpetal`, foods/potions `food:emberroot_skewer|frostcap_broth`, `potion:glowmoss_tonic|duskpetal_draught|dawnroot_elixir`, quest items `quest:parcel`, `quest:watch_banner` (new category `quest`, stack 10, kind material), five cook recipes, loot families `critter`, `hunt`. Random loot pools are unchanged.
- **Events 1000-1029** (new range, `contracts/events.md`): 1000 content_sync, 1001 codex_unlocked, 1002 feat_earned, 1003 tablet_read, 1004 rep_changed, 1005 player_title, 1006 content_refused, 1007 content_places (binary), 1008 forage_picked, 1009 content_say, 1010 world_event, 1011 world_event_prize, 1020 vault_state, 1021 vault_found, 1022 vault_note. 1012-1019 and 1023-1029 reserved.
- **Interact 80 `content`**: 1 sync, 2 read a tablet, 3 forage, 4 use a vault part, 5 show a title, 9 dev: start a world event (dev tickets only).
- **Quest wire (950/951)** additive fields: `kind` 2 (a townsperson's request), `items`, `rollItems`, `rep`, `repTown`, `say` (offers). Interact 60 action 1 now also accepts content offers (side quests and stories) by their id.
- **Quest objectives** (`internal/quests`): `kill` (N non-demon kills in a radius; `count` saved in the log), `give` (talk to a specific NPC holding the items; they take them), `escort`, `read`, `attune`, `dungeon`; `Objective.npc/n/family`; `Quest.count/items/rollItems/rep/giverNpc/seq/start`; at most 6 side quests held.
- **Migration 0025** `character_content` (one jsonb per character, epoch-fenced like 0023). Local profiles: `localsave.State.Content` (optional). WP16 handoff field `content`.
- Zone env: `LODESTONE_ZONE_NO_WORLD_EVENTS=1` (kill switch), `LODESTONE_ZONE_VAULT_PACKS=0` (evidence runs only). `GET /debug/content` (vault plans, live events, tablets, quest givers).

## Network budget

Everything is event driven; nothing per tick. Places (1007) go once per session per 256 m area as you walk (about 0.5-1 KB per area). Titles go only for players who have one, to players within 140 m, re-checked every 2 s. World events: on start, to newcomers in range, on 10 % progress steps and at the end. Content is off in worlds without an atlas or towns (the flat test and scale worlds), so `LODESTONE_WIRE_DIGEST=1` is unchanged: p90_e600 `831bb7f4...`, p300_e2000 `8c29d408...`.

## Ownership (WP16)

A world event or a vault belongs to the zone owning its region: only that zone schedules or wakes it, and players walking to it are handed to that zone. Ghost-band players on a neighbouring zone are not announced to until they cross. Events are not persisted (minutes long; a restart drops them); vault progress per character (found, chest timer) is.

## Known gaps

- The account upgrade (local profile → account) does not copy the content state (same as the quest log).
- World events and vaults don't cross zone borders mid-fight; the Behemoth roams within the zone's own regions (it turns back at a foreign border).
- Followers (rescued villagers) are NPC entities stepped by the zone without collision against buildings (like WP20 NPCs) and teleport to you if left 45 m behind.
- Names and texts are proposals for Nicole (one file: `contracts/content.yaml`).
