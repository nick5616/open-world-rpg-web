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
| 30-39 | suggested: WP20 towns (doors, NPCs, boards) | | | |
