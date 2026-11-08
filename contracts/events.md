# Event kinds

`Event` (protocol.yaml, id 67) is the generic reliable gameplay event. Its
`kind` field is a registry kept here so packages don't collide. Claim a range
for your package; document each kind's use of `entityId`, `targetId`, `value`,
`x/y/z` (cm) and `data`.

| Range | Owner |
| --- | --- |
| 1-99 | WP03 / WP06 core (spawn, despawn, teleport, notices) |
| 100-199 | WP10 movement (landing, stamina, drown) |
| 200-399 | WP13 combat (damage numbers, deaths, status, telegraphs) |
| 400-499 | WP14 loot (drops, pickups, grants, Bitchin' announcement) |
| 500-599 | WP15 night and chemistry (ignite, freeze, pillar, dawn burn, defense events) |
| 600-699 | WP12 exploration (tower reveal, waypoint, discovery XP) |
| 700-799 | WP09 mining (vein hit, vein break) |
| 800-899 | WP20 towns and NPCs (dialogue, shop, bounty) |

## Registered kinds

| Kind | Name | Fields |
| --- | --- | --- |
| 1 | `notice` | `data` = UTF-8 text shown in the system channel |
| 2 | `teleport` | `entityId` = who, `x/y/z` = destination (cm); clients cut interpolation |
| 100 | `drowned` | WP10. Sent reliably to the player whose movement step drowned them and respawned them at the shore (the step does both, identically on client and server, so this is only for UI: a fade, a notice). `entityId` = who, `x/y/z` = the shore point (cm), `value` = 0 |
| 600 | `tower_unlocked` | WP12. You stood on a tower's top (zone-validated): `entityId` = you, `targetId` = atlas site index of the tower, `value` = region index now revealed, `x/y/z` = top centre (cm), `data` = UTF-8 region name. Granted once per character. |
| 601 | `waypoint_activated` | WP12. You touched a waypoint stone for the first time: `targetId` = site index, `x/y/z` = stone (cm), `data` = name (a settlement waypoint carries its settlement's name). |
| 602 | `discovery` | WP12. You entered a POI's discovery radius for the first time: `targetId` = site index, `value` = XP granted, `x/y/z` = site (cm), `data` = name (may be empty). |
| 603 | `progress_sync` | WP12. Your whole exploration state, after join and after every change: `value` = level, `data` = `u8 version(1) \| u64 xp \| u16 level \| i32 lastWaypoint site (-1 none) \| u32 revealed-regions bitmask \| 3 x (u16 n + n bytes)` bitsets towers, waypoints, discoveries (bit i = byte i/8, bit i%8 LSB first, indexed by atlas site index). |
| 604 | `level_up` | WP12 (character level from XP; WP13 may emit it too): `value` = new level. |
| 605 | `pins` | WP12. The full list of pins to show (replaces the previous list): `data` = `u8 version(1) \| u8 count \| count x (u8 flags (bit 0 = party pin) \| u8 slot \| u8 colour \| i32 x cm \| i32 z cm \| u16 len + UTF-8 owner name)`. Personal pins are yours (slots 0-9); party pins are one per member. |
| 606 | `fast_travel_denied` | WP12. `targetId` = requested site, `value` = reason: 1 not a fast-travel point, 2 not unlocked, 3 cooldown (2 s). |
| 607 | `party` | WP12. Your party changed: `value` = the snapshot `partyId` of your party as u32 bits (0 = none). Remote entities with the same `partyId` are your party (compass, map). |
| 608 | `respawn_point` | WP12. The last waypoint you touched changed (spec 8: death respawns you there): `targetId` = site index, `data` = name. |
| 800 | `npc_say` | WP20. An NPC answers you (talk, or a service refused politely): `entityId` = the NPC's entity id, `targetId` = NPC role (0 villager, 1 merchant, 2 blacksmith, 3 innkeeper, 4 bounty keeper, 5 farmer, 6 guard), `value` = 1 if its service is open now (0: at home for the night, closed), `data` = UTF-8 line to show |
| 801 | `shop` | WP20. A merchant's wares, after talking to them by day: `entityId` = NPC entity, `value` = merchant kind (0 general, 1 provisions, 2 herbalist, 3 tools), `data` = `u8 version(1) \| u8 count \| count x (u16 len + UTF-8 item id, u32 price, u16 stock)`. Item ids are placeholders until WP14 defines items (`food:bread`, `tool:pickaxe`...) |
| 802 | `bounties` | WP20. A settlement's bounty board (read the board, or talk to the bounty keeper): `entityId` = keeper entity (0 when read from the board), `targetId` = settlement index (towns buffer), `data` = `u8 version(1) \| u8 count \| count x (u32 bounty id, u8 kind (0 clear a camp/structure, 1 deliver items, 2 slay a demon, 3 explore a structure), u16 target atlas site index (0xFFFF none), u16 quantity, u32 reward, u8 accepted (1 = you have it), u16 len + UTF-8 text)`. Bounties are seeded per settlement per in-game day |
| 803 | `bounty_accepted` | WP20. `targetId` = bounty id, `value` = reward, `data` = UTF-8 text. Completion is WP13/WP14/WP15's (kills, items, demons) through the zone `Bounties` hook |
| 804 | `rested` | WP20. You rested at an inn: `entityId` = you, `value` = health restored |
| 805 | `station_opened` | WP20 (forge interaction point for WP14). You used a forge or anvil: `entityId` = you, `targetId` = station kind (1 forge, 2 anvil), `data` = u64 prop stable id LE + u16 settlement index. WP14 replaces the default handler (`game.Config.Stations`) with smelting/forging/socketing |
| 806 | `town_refused` | WP20. `value` = reason: 1 too far, 2 unknown target, 3 closed for the night, 4 no such item or bounty, 5 already accepted, 6 too many bounties (max 5), 7 nothing to rest for, 8 no cave below; `data` = u64 target id LE |
| 807 | `purchase` | WP20. `value` = price, `targetId` = quantity, `data` = item id (granted through `Config.Granter`; no currency until WP14, so the price is informational) |
| 701 | `vein_hit` | WP09. To the miner: `entityId` = miner, `value` = vein hit points left, `x/y/z` = vein (cm), `data` = u64 vein id LE + u16 max hit points |
| 702 | `vein_break` | WP09. To each player who helped break it: `entityId` = player, `targetId` = their pickup's entity id, `value` = seconds until respawn, `data` = u64 vein id |
| 703 | `drop_spawned` | WP09. To the owner: `entityId` = pickup entity, `targetId` = owner, `value` = quantity, `data` = item id (UTF-8, `ore:<name>` / `gem:<name>:<cut>` until WP14 defines items) |
| 704 | `item_granted` | WP09 (grant hook for WP14). To the player: `entityId` = player, `targetId` = the pickup taken, `value` = quantity, `data` = item id |
| 706 | `mine_refused` | WP09. To the miner: `value` = 1 too far, 2 already mined, 3 unknown vein, 4 swinging too fast; `data` = u64 vein id |

Fast travel itself is the core `teleport` (2): the zone moves you and sends it
to you and to everyone who currently has you in their snapshot.

## Interact

`Interact` (protocol.yaml, id 5, c2s, reliable) is the generic "do something
to a thing" verb. `targetKind` is a registry like Event kinds; `action` and
`arg` are per kind. The zone rate-limits Interact at 10 burst / 5 per s.

| targetKind | Owner | targetId | action | arg |
| --- | --- | --- | --- | --- |
| 1-9 | reserved (core) | | | |
| 10 `site` | WP12 | atlas site index | 1 = fast travel (to an unlocked tower or activated waypoint) | 0 |
| 11 `pin` | WP12 | `x cm \| z cm << 32` (both u32, inside the world) | 1 = set personal pin, 2 = clear personal pin, 3 = set your party pin, 4 = clear your party pin | set: `slot (0-9) \| colour << 8`; clear: slot; party set: colour |
| 20-29 | suggested: WP14 loot (chests, pickups) | | | |
| 30 `npc` | WP20 | the NPC's entity id (snapshot `EntityRecord.id`, kind npc) | 1 = talk (the NPC answers with 800, then its service: 801 shop, 802 bounties), 2 = buy, 3 = rest (innkeeper), 4 = accept bounty | buy: item index in the last 801 list; accept: bounty id; else 0 |
| 31 `board` | WP20 | bounty board prop stable id (towns buffer) | 1 = read (802), 2 = accept | accept: bounty id |
| 32 `station` | WP20 (WP14 hooks in) | forge or anvil prop stable id | 1 = use (805) | 0 |
| 33 `shaft` | WP20 | mineshaft structure stable id (= its atlas site id) | 1 = descend (teleport into the linked cave system's entrance chamber; core `teleport` event) | 0 |
| 34-39 | reserved WP20 (doors, chests are WP14's 20-29) | | | |
| 40 `vein` | WP09 | vein stable id | 1 = pickaxe swing (25 damage, >= 250 ms apart, within 4.5 m of the eye) | tool tier (0 for now) |
| 41 `pickup` | WP09 (WP14 may move pickups to 20-29) | pickup entity id | 1 = take (owner only, within reach) | 0 |

WorldEdits for `vein_mined` (WP09) carry 16 bytes of `params` (f32 x, y, z,
carve radius 1.5) and `expiresAt` = respawn time; a delta whose `expiresAt`
is at or before the server time means the edit expired (the vein respawned
and the carve is restored). See server/zone/README.md "Caves and mining".

NPCs (WP20) are ordinary snapshot entities: `EntityRecord.kind` = npc (5),
`typeId` = role | appearance variant << 8, `level` = merchant kind (255
none), `name` = the NPC's generated name. Their schedules (out by day,
indoors at night) run in the zone (`server/zone/internal/npc`); a client
matches an entity to its towns-buffer record by name and position when it
needs more (home, work spot). Reach for every WP20 Interact: 4 m from the
eye. See server/zone/README.md "Towns and NPCs".
