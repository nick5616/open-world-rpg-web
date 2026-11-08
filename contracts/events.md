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
| 701 | `vein_hit` | WP09. To the miner: `entityId` = miner, `value` = vein hit points left, `x/y/z` = vein (cm), `data` = u64 vein id LE + u16 max hit points |
| 702 | `vein_break` | WP09. To each player who helped break it: `entityId` = player, `targetId` = their pickup's entity id, `value` = seconds until respawn, `data` = u64 vein id |
| 703 | `drop_spawned` | WP09. To the owner: `entityId` = pickup entity, `targetId` = owner, `value` = quantity, `data` = item id (UTF-8, `ore:<name>` / `gem:<name>:<cut>` until WP14 defines items) |
| 704 | `item_granted` | WP09 (grant hook for WP14). To the player: `entityId` = player, `targetId` = the pickup taken, `value` = quantity, `data` = item id |
| 706 | `mine_refused` | WP09. To the miner: `value` = 1 too far, 2 already mined, 3 unknown vein, 4 swinging too fast; `data` = u64 vein id |

Mining uses the existing `Interact` message (WP09): `targetKind` 1 = vein
(`targetId` = vein stable id, `action` 1 = pickaxe swing, `arg` = tool tier,
0 for now), `targetKind` 2 = pickup (`targetId` = pickup entity id, `action`
1 = take). `WorldEdits` for `vein_mined` carry 16 bytes of `params` (f32 x,
y, z, carve radius 1.5) and `expiresAt` = respawn time; a delta with
`expiresAt` at or before the server time means the edit expired (the vein
respawned and the carve is restored). See server/zone/README.md "Caves and
mining".
