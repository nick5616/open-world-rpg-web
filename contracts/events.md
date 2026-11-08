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
