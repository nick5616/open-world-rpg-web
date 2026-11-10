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
| 900-949 | Playtest 1 progression and difficulty (character stats, stamped areas, tower attunement; CR 012). 904-949 reserved |
| 950-969 | Playtest 1 quests (CR 013: quest log, offers, steps, completion) |
| 970-979 | Playtest 1 building doors (CR 013; WP20 follow-up) |
| 980-989 | Playtest 2 travel to a friend (CR 017). 983-989 reserved |
| 990-999 | Playtest 2 PvP and duels (CR 019: the PvP flag, kill feed, duel challenge, state and result). 998-999 reserved |
| 1000-1029 | Playtest 2 content (CR 023: codex, feats and titles, lore tablets, renown, herb patches, world events, sealed vaults). 1012-1019 and 1023-1029 reserved |
| 1100-1119 | Playtest 2 camps (CR 025: pieces by area, placement refusals, chests, Rested, your camp and signposts). 1108-1119 reserved |

## Registered kinds

| Kind | Name | Fields |
| --- | --- | --- |
| 1 | `notice` | `data` = UTF-8 text shown in the system channel |
| 2 | `teleport` | `entityId` = who, `x/y/z` = destination (cm); clients cut interpolation |
| 100 | `drowned` | WP10. Sent reliably to the player whose movement step drowned them and respawned them at the shore (the step does both, identically on client and server, so this is only for UI: a fade, a notice). `entityId` = who, `x/y/z` = the shore point (cm), `value` = 0 |
| 200 | `damage` | WP13. An enemy took damage (to players within 64 m except the attacker, who gets HitResult): `entityId` = attacker (player), `targetId` = enemy, `value` = damage, `x/y/z` = hit point (cm), `data` = u8 HitResult flags \| u8 enemy health % |
| 201 | `enemy_died` | WP13. Within 96 m: `entityId` = enemy, `targetId` = killer, `value` = XP granted to each eligible player, `x/y/z` = where, `data` = name (elites, bosses; empty for commons) |
| 202 | `player_hurt` | WP13. To you: an enemy hit you. `entityId` = you, `targetId` = enemy, `value` = damage after shields, `x/y/z` = the enemy, `data` = u8 enemy attack id |
| 203 | `player_downed` | WP13. Within 64 m: `entityId` = the downed player, `targetId` = enemy, `value` = ms until the respawn (PLAYER_RESPAWN_S) at their respawn point (core teleport 2 follows) |
| 204 | `telegraph` | WP13. An enemy started a wind-up (to players within 70 m): `entityId` = enemy, `targetId` = attack id (combat.yaml enemyAttacks), `value` = wind-up ms (300-600), `x/y/z` = area centre (cm), `data` = u8 shape (0 cone, 1 circle, 2 ground, 3 line, 4 projectile) \| u16 yaw (turn x65536) \| u16 radius cm \| u16 reach cm \| u8 arc/2 deg \| u16 width cm \| u16 active ms |
| 205 | `enemy_projectile` | WP13. An enemy launched a projectile (within 70 m): `entityId` = enemy, `targetId` = attack id, `x/y/z` = origin (cm), `data` = i16 vx, vy, vz (cm/s / 2) \| u16 radius cm \| u16 range cm |
| 206 | `status` | WP13. A status landed on an enemy (within 64 m): `entityId` = player, `targetId` = enemy, `value` = status id (combat.yaml statuses), `data` = u8 duration in ticks |
| 207 | `evaded` | WP13. To you: an enemy strike missed. `entityId` = you, `targetId` = enemy, `value` = 1 dodge (i-frames), 2 parry, 3 outside the area |
| 208 | `boss_phase` | WP13. Within 120 m: `entityId` = boss, `targetId` = new phase index (0-based), `value` = phase count, `data` = u16 invulnerable transition ms \| UTF-8 boss name |
| 209 | `boss_engaged` | WP13. Within 70 m, once per fight: `entityId` = boss, `targetId` = enemy type id, `value` = health after party scaling, `data` = boss name |
| 210 | `boss_defeated` | WP13. Within 160 m: `entityId` = boss, `targetId` = enemy type id, `value` = fight length in seconds (engage to kill), `data` = boss name. WP14's loot hook and weekly lockout key off the same kill (combat.KillInfo) |
| 211 | `camp_cleared` | WP13. Within 120 m: `targetId` = group id, `value` = group kind (1 camp, 2 bandit, 3 guardian, 4 pack, 6 test), `x/y/z` = anchor, `data` = site name |
| 212 | `combat_sync` | WP13. To you after join and after every change: `value` = active loadout, `data` = u8 version(1) \| u8 active \| 2 x (u8 weapon id \| 4 x u16 spell id, 0 empty \| i8 gem element, -1 none) \| u16 n + n x u16 known spell ids \| u8 n + n x (u8 skill id \| u32 xp) \| u16 mana max x10 \| u8 drink charges \| u16 skill points left \| u8 character level \| 2 x u8 weapon look material code per loadout (pt/ux; see "Players" below; absent from older zones) |
| 213 | `mana` | WP13. To you, on change at most 5 Hz: `value` = mana x10, `targetId` = mana max x10 |
| 214 | `cast` | WP13. Another player's attack or cast started (within 64 m, not to the caster): `entityId` = caster, `targetId` = attack/spell/form id (\| 0x8000 = a dash variant; 0x4001 = the secondary button went down on a sword, spear or bow: parry stance, spear charge, bow draw (CR 018), once per press), `x/y/z` = origin, `data` = u16 yaw \| i16 pitch (CR 022: a charged weapon move, the bow's drawn shot or the spear's charge, appends u8 the draw 0..255 like a released charge spell) |
| 215 | `refused` | WP13. To you: an attack, cast or combat Interact was refused. `targetId` = attack/spell id (or the Interact action), `value` = reason (HitResult refusal codes below), `data` = u32 start seq |
| 216 | `skill_up` | WP13. To you: `targetId` = skill id (combat.yaml skills), `value` = new level, `data` = UTF-8 technique key unlocked at this level (empty if none) |
| 217 | `heal` | WP13. To the healed player: `entityId` = healer, `targetId` = you, `value` = amount (`data` = [1] for a heal over time) |
| 218 | `consumable` | WP13. To you: `targetId` = 1 use started / 0 effect applied, `value` = charges left, `data` = [heal] when applied |
| 219 | `shield` | WP13. To you: `targetId` = spell id (0 = absorbed a hit), `value` = shield points left. CR 022: when a hit breaks it (points reach 0) the zone also sends `value` 0, `targetId` 0, `entityId` = the owner to players within 64 m except the owner, so their shell bursts for everyone as it does for you |
| 220 | `boss_reset` | WP13. Within 120 m: nobody fought the boss for 15 s, it healed and returned to phase 1: `entityId` = boss, `data` = name |
| 221 | `respawned` | WP13. To you: back on your feet at full health (`value` = health max) |
| 222 | `strike_hit` | WP13. Within 64 m except the victim: an enemy strike landed on a player (hit flash): `entityId` = player, `targetId` = enemy, `value` = damage |
| 223 | `channel` | CR 020. A hold-to-fire stream or a hold-to-empower charge (spells with `auto` / `charge`). Start (`value` 1 stream, 2 charge gathering): to players within 64 m except the caster, `entityId` = caster, `targetId` = spell id, `x/y/z` = origin, `data` = u16 yaw | i16 pitch | u32 start seq (a stream's shots lean by the seeded pattern of `streamSeed(start seq, spell id)`, client/src/combat/spellsim.ts; observers simulate the stream from it: nothing is sent per shot). Stop (`value` 0): to everyone within 64 m and the caster (whose prediction stops on it if the zone ended the stream first, e.g. out of mana), `data` = u16 shots fired | u32 start seq. A released charge is an ordinary 214 whose `data` ends with u8 the held fraction (0-255) |
| 224 | `detonate` | CR 020. A delayed charge or a brand burst (`detonate` spells; the zone's own hits, no claims), within 64 m: `entityId` = the caster, `targetId` = the enemy it was in, `value` = spell id, `x/y/z` = centre, `data` = u16 radius cm. The damage follows as 200s (and to the caster too) |
| 226 | `held` | CR 022 (shared spell visuals). What a player holds, for everyone else's visuals: to players within 64 m except the holder. `entityId` = the player, `targetId` = what is held (a stream's, charge's or channelled beam's spell id; a held dash's variant \| 0x8000 on steps the zone paid for; 0x4001 for a guard: the secondary held on a sword, spear or bow), `value` = u16 yaw \| i16 pitch << 16 (the holder's input frame values, exact), `x/y/z` = the player (cm), `data` = u32 start seq (a stream's seed) \| u16 progress (stream: shots fired; the others: steps held). Sent while an aimed action (stream, charge, beam) is held when the aim moved >= 64 yaw / 128 pitch units, at most every 3 ticks (10 Hz), and as a keepalive every 30 ticks for every held action (a late observer learns what runs); nothing for a player who holds nothing. Its start and stop are 214 / 223 and the Activity casting bit, which the zone sets on a player while a held action runs (for a dash: while its key holds it) |
| 225 | `summon_attack` | CR 020. An ally (summon spell) attacked, within 64 m: `entityId` = the ally (EntityKind effect, typeId = summon id | (element + 1) << 8, health % = time left), `targetId` = its target (enemy or player), `value` = the spell that called it, `x/y/z` = the ally's chest, `data` = u16 summon id. A melee bite lands at once, a bolt when it would arrive (200 / 992 follow); about one a second per ally |
| 230 | `dash_slam` | Playtest 2 dash overhaul (CR 021). Within 64 m: a held flight dash (magma dash) dived into the ground and burst there (the zone already applied the damage). `entityId` = the player, `targetId` = dash variant (combat.yaml dashes id), `value` = burst radius cm, `x/y/z` = where (cm). 231-239 reserved for dashes |

| 400 | `inventory` | WP14. To you, after join and after every change: your whole inventory. `entityId` = you, `value` = gold, `data` = UTF-8 JSON `{"v":1,"gold":n,"quick":"<consumable key the drink key uses>","persist":"db"\|"local"\|"memory","items":[{h, b, q, l, r, s, n?, a?, u?, k?, t, v, p}]}`: `h` wire handle (u32, the Interact 21 targetId), `b` item key (contracts/items.yaml), `q` quantity, `l` item level, `r` rarity 0-7, `s` slot (`inv:0-39`, `gem:N`, `ore:N`, `purse`, `eq:main0` / `eq:main1` (loadout weapons), `eq:head` / `eq:body` / `eq:legs`), `n` generated name (mythic+), `a` affixes `[{k, s, v}]` (key, stat, value), `u` unique keys, `k` sockets (gem key or "" per socket), `t` tradeable, `v` verified, `p` provenance entries (hands it passed through) |
| 401 | `loot_granted` | WP14. To you: items just added to your inventory. `targetId` = source (1 kill, 2 container, 3 vein, 4 craft, 5 purchase, 6 starter, 7 a dropped item you took, 8 gem, 9 quest reward (CR 013)), `value` = entries, `data` = JSON `[{b, q, r, n?}]` |
| 402 | `bitchin` | WP14. To everyone in the zone (and the world's global chat through the social bus): a Bitchin' item was found (spec 8). `entityId` = finder, `data` = JSON `{name, item, displayName, text}` |
| 403 | `item_refused` | WP14. To you: `targetId` = Interact kind << 8 \| action, `value` = reason: 1 inventory full, 2 no such item, 3 not allowed, 4 missing ingredients, 5 blueprint required, 6 not enough gold, 7 too far, 8 already opened (this character), 9 no such socket, 10 not at a waypoint, 11 busy, 12 no station open here |
| 404 | `station` | WP14. To you: a cooking station is open (inn hearth or campfire; forges and anvils open with WP20's 805): `targetId` = 3 (CR 025: 4 = a camp workbench; a camp campfire is 3 with its piece id as the prop id), `value` = your Smithing level, `data` = u64 prop stable id LE |
| 405 | `crafted` | WP14. To you: `targetId` = recipe id (items.yaml order, 1-based), `value` = quantity, `data` = JSON of the new item (Event 400 item shape) |
| 406 | `containers` | WP14. To you, when you enter a new chunk and after opening one: loot containers within 96 m. `value` = count, `data` = `u8 version(1) \| u16 n \| n x (u64 container id LE, i32 x, i32 y, i32 z (cm), u8 kind (0 chest, 1 buried cache, 2 urn, 3 crate), u8 opened (1 = this character already opened it))` |
| 407 | `container_opened` | WP14. To you: `value` = items rolled, `data` = u64 container id LE (contents arrive as 401 + 400) |
| 408 | `dropped` | WP14. To you: you dropped an item: `entityId` = the public pickup entity (0 while a local profile's drop waits for its save), `targetId` = you, `value` = quantity, `data` = item key |
| 409 | `boss_lockout` | WP14. To you: this boss already gave you loot this week (spec 8 weekly lockout): `value` = ISO week, `data` = boss name |
| 410 | `gem_combined` | WP14. To you: three gems combined at a waypoint: `value` = 1, `data` = the new gem key |
| 411 | `item_taken` | WP14. To you: you took a dropped item: `targetId` = the pickup entity, `value` = quantity, `data` = item key |

| 500 | `world_clock` | WP15. To you after join and whenever it changes: `entityId` = you, `targetId` = tonight's night index (u32), `value` = its moon phase (0 new .. 4 full .. 7), `data` = `u8 version(1) \| f64 clock offset s \| u8 moon offset \| u16 WorldSpec windDirection \| u8 chemistry sync path (1 events, 2 bitmap) \| f32 demonIntensity \| u8 rain override (0 seeded, 1 rain, 2 dry)`. World time = server time (s) + offset; the client derives day, night, moon, rain and the chemistry wind from it and the seed (client/src/systems/clock.ts = server/pkg/weather) |
| 501 | `dusk` | WP15. To everyone: night fell. `targetId` = night index, `value` = moon phase, `data` = notice text |
| 502 | `dawn` | WP15. To everyone: sunrise. `value` = demons burned, `targetId` = demons that fled, `data` = notice text |
| 503 | `demon_burned` | WP15. Within 96 m, at dawn: `entityId` = demon, `value` = 1 burned in the open / 0 fled to a lair or cave mouth, `x/y/z` = where |
| 504 | `demon_shrugged` | WP15. To the attacker: an ordinary hit on a demon (it regenerates; only sunsteel, Light or sunrise kill demons). `entityId` = you, `targetId` = demon, `value` = the damage that will close again |
| 505 | `demons_rose` | WP15. Within 160 m: demons rose from shadowed ground. `targetId` = rank (0 lesser, 1 greater, 2 lord), `value` = how many, `x/y/z` = where |
| 506 | `lord_risen` | WP15. To everyone: a demon lord walks tonight (new moon). `entityId` = the lord, `x/y/z` = where, `data` = name |
| 510 | `defense_warning` | WP15. Within 400 m of a town: its ward falters. `targetId` = town (settlement index), `value` = seconds to the first wave, `x/z` = ward garden, `data` = town name |
| 511 | `defense_wave` | WP15. Within 400 m: a wave comes (also to joiners mid-event). `targetId` = town, `value` = wave number (1..), `x/z` = garden, `data` = `u8 waves \| u8 phase \| u16 demons` |
| 512 | `ward_health` | WP15. Within 400 m, at most 2 Hz: `targetId` = town, `value` = ward garden health (WARD_HEALTH max), `x/z` = garden, `data` = u16 demons alive |
| 513 | `defense_ended` | WP15. Within 400 m: `targetId` = town, `value` = 1 held, 2 broken (demons roam the town until dawn), 3 abandoned (nobody near for 30 s), `data` = notice text |
| 514 | `defense_reward` | WP15. To each participant when the ward held: `targetId` = town, `value` = XP granted |
| 520 | `chem_ignite` | WP15. Within CHEM_INTEREST_M: a chemistry op, scheduled CHEM_OP_LEAD_STEPS ahead. `targetId` = centre cell (iz * 2048 + ix, 2 m cells), `value` = radius in cells, `x/z` = cell centre (cm), `data` = i64 step LE. Ignites dry fuel within the radius, melts ice |
| 521 | `chem_extinguish` | WP15. Same layout: puts out burning cells within the radius |
| 522 | `chem_freeze` | WP15. Same layout: freezes water cells (a walkable sheet for FREEZE_STEPS) and puts out burning ones |
| 523 | `chem_pillar` | WP15. `targetId` = pillar id, `x/y/z` = centre and base height (cm), `value` = height cm, `data` = `i64 step \| u16 half edge cm \| u16 wall run cm`; stands PILLAR_STEPS (2 minutes) on the movement ground of both sides |
| 524 | `chem_baseline` | WP15. A chunk's full state for a client coming in range: `targetId` = chunk (cz * 64 + cx, 64 m chunks), `data` = `i64 step \| u16 n \| n x (u16 local cell \| u8 state (1 burning, 2 burnt, 3 frozen) \| i32 until - step)` |
| 525 | `chem_bitmap` | WP15, the fallback path (Interact 51 action 10 = 2, or LODESTONE_ZONE_CHEM_SYNC=bitmap): 2 Hz per active chunk in range, `targetId` = chunk, `data` = `i64 step \| 256 bytes` (2 bits per cell, LSB first: 0 none, 1 burning, 2 burnt, 3 frozen); an all-zero bitmap clears a chunk |
| 526 | `chem_refused` | WP15. To you: a chemistry/night Interact was refused. `targetId` = targetKind << 8 \| action, `value` = 1 dev only, 2 bad action/arg, 3 no such town / already running, 4 no ground to raise demons on |
| 600 | `tower_unlocked` | WP12. You stood on a tower's top (zone-validated): `entityId` = you, `targetId` = atlas site index of the tower, `value` = region index now revealed, `x/y/z` = top centre (cm), `data` = UTF-8 region name. Granted once per character. |
| 601 | `waypoint_activated` | WP12. You touched a waypoint stone for the first time: `targetId` = site index, `x/y/z` = stone (cm), `data` = name (a settlement waypoint carries its settlement's name). |
| 602 | `discovery` | WP12. You entered a POI's discovery radius for the first time: `targetId` = site index, `value` = XP granted, `x/y/z` = site (cm), `data` = name (may be empty). |
| 603 | `progress_sync` | WP12. Your whole exploration state, after join and after every change: `value` = level, `data` = `u8 version(1) \| u64 xp \| u16 level \| i32 lastWaypoint site (-1 none) \| u32 revealed-regions bitmask \| 3 x (u16 n + n bytes)` bitsets towers, waypoints, discoveries (bit i = byte i/8, bit i%8 LSB first, indexed by atlas site index). |
| 604 | `level_up` | WP12 (character level from XP; WP13 may emit it too): `value` = new level. |
| 605 | `pins` | WP12. The full list of pins to show (replaces the previous list): `data` = `u8 version(1) \| u8 count \| count x (u8 flags (bit 0 = party pin) \| u8 slot \| u8 colour \| i32 x cm \| i32 z cm \| u16 len + UTF-8 owner name)`. Personal pins are yours (slots 0-9); party pins are one per member. |
| 606 | `fast_travel_denied` | WP12. `targetId` = requested site, `value` = reason: 1 not a fast-travel point, 2 not unlocked, 3 cooldown (2 s). |
| 607 | `party` | WP12. Your party changed: `value` = the snapshot `partyId` of your party as u32 bits (0 = none). Remote entities with the same `partyId` are your party (compass, map). |
| 608 | `respawn_point` | WP12. The last waypoint you touched changed (spec 8: death respawns you there): `targetId` = site index, `data` = name. |
| 900 | `character_stats` | Playtest 1 (CR 012). To you after join, on every level-up and on every attunement: what your level and tower boons give. `entityId` = you, `targetId` = reason (0 sync, 1 level-up, 2 attuned), `value` = level, `data` = `u8 version(1) \| u8 reason \| u16 level \| u16 previous level (a level-up: the level before) \| u64 xp \| u32 xp into this level \| u32 xp the next level needs \| u16 health max \| u16 mana max \| u16 stamina max (points) \| u16 damage bonus from the level (x10 %) \| u8 skill points unspent \| u8 skill points total \| u8 towers attuned \| u16 n + n bytes attuned bitset` (bit i = atlas site i, like `progress_sync`). Level-ups also still send 604; a level-up refills health and stamina |
| 901 | `area` | Playtest 1. To you: the area (combat.yaml `difficulty.cellM`, 256 m squares) you stand in, when you enter a new one and when yours gets stamped. `entityId` = you, `targetId` = area index (`cz * 16 + cx`), `value` = area level, `x/z` = area centre (cm), `data` = `u8 version(1) \| u8 tier index (combat.yaml difficulty.tiers: 0 haven, 1 quiet, 2 wilds, 3 perilous, 4 dread, 5 deadly) \| u8 flags (1 the Haven, 2 stamped just now by you, 4 provisional: the database was unreachable) \| u16 area size m \| u16 your level when you stamped it (flag 2 only) \| UTF-8 discoverer's name (rest; empty for the Haven)` |
| 902 | `tower_attuned` | Playtest 1, the hook for a grand discovery moment. To you: you attuned to a tower's crystal for the first time (Interact 10 action 2 on its top) and got its permanent boon (combat.yaml `leveling.attune`; the new numbers follow in 900 reason 2). `entityId` = you, `targetId` = the tower's atlas site index, `value` = region index, `x/y/z` = the crystal's top centre (cm), `data` = UTF-8 region name (same as 600's). Once per character per tower |
| 903 | `attune_refused` | Playtest 1. To you: `targetId` = requested site, `value` = 1 not standing on that tower's top, 2 already attuned, 3 not a tower |
| 800 | `npc_say` | WP20. An NPC answers you (talk, or a service refused politely): `entityId` = the NPC's entity id, `targetId` = NPC role (0 villager, 1 merchant, 2 blacksmith, 3 innkeeper, 4 bounty keeper, 5 farmer, 6 guard), `value` = 1 if its service is open now (0: at home for the night, closed), `data` = UTF-8 line to show |
| 801 | `shop` | WP20. A merchant's wares, after talking to them by day: `entityId` = NPC entity, `value` = merchant kind (0 general, 1 provisions, 2 herbalist, 3 tools), `data` = `u8 version(1) \| u8 count \| count x (u16 len + UTF-8 item id, u32 price, u16 stock)`. Item ids are placeholders until WP14 defines items (`food:bread`, `tool:pickaxe`...) |
| 802 | `bounties` | WP20. A settlement's bounty board (read the board, or talk to the bounty keeper): `entityId` = keeper entity (0 when read from the board), `targetId` = settlement index (towns buffer), `data` = `u8 version(1) \| u8 count \| count x (u32 bounty id, u8 kind (0 clear a camp/structure, 1 deliver items, 2 slay a demon, 3 explore a structure), u16 target atlas site index (0xFFFF none), u16 quantity, u32 reward, u8 accepted (1 = you have it, 2 = you completed it (CR 013: held bounties are quests in your persisted log, Event 950)), u16 len + UTF-8 text)`. Bounties are seeded per settlement per in-game day |
| 803 | `bounty_accepted` | WP20. `targetId` = bounty id, `value` = reward, `data` = UTF-8 text. Completion is WP13/WP14/WP15's (kills, items, demons) through the zone `Bounties` hook |
| 804 | `rested` | WP20. You rested at an inn: `entityId` = you, `value` = health restored |
| 805 | `station_opened` | WP20 (forge interaction point for WP14). You used a forge or anvil: `entityId` = you, `targetId` = station kind (1 forge, 2 anvil), `data` = u64 prop stable id LE + u16 settlement index. WP14's `Config.Stations` records the open station and lets this event through: the client opens the smithing panel (smelting, forging; Interact 22) on it |
| 806 | `town_refused` | WP20. `value` = reason: 1 too far, 2 unknown target, 3 closed for the night, 4 no such item or bounty, 5 already accepted, 6 too many bounties (max 5), 7 nothing to rest for, 8 no cave below; `data` = u64 target id LE |
| 970 | `door_state` | Doors. A building door opens or closes (to every player within 260 m of the settlement's edge, each with its own step): `entityId` = who changed it (player or NPC entity id; 0 = the zone), `targetId` = door prop index (towns buffer PROPS), `value` = new state (1 open, 0 closed), `x/y/z` = the door (cm), `data` = `u64 door prop stable id LE \| u32 step LE`: your input seq from which the new state applies (0 = it already applies). The zone picks a step beyond everything you will have predicted when this arrives (your newest applied frame + the round trip in frames + 12) and steps your frames with the old state before it and the new one from it on; clients do the same, so prediction never disagrees. Doors start open |
| 971 | `door_baseline` | Doors. On coming within 200 m of a settlement whose doors changed since you last heard: `targetId` = settlement index, `data` = `u8 version(1) \| u16 count \| count x (u32 door prop index \| u8 open before step \| u8 open from step \| u32 step (0 = settled))`. Lists the settlement's doors that are not settled open; every unlisted door of the settlement is open |
| 972 | `door_refused` | Doors. To you: Interact 34 refused. `targetId` = door prop index (0xFFFFFFFF unknown), `value` = reason: 1 too far, 2 not a door / bad action, 3 someone is in the doorway (a player or NPC touching it, with a margin for their speed), 4 still swinging (a change is pending), 5 already in that state; `data` = u64 target id LE |
| 980 | `travel_channel` | Playtest 2 (CR 017). To you: a travel to a friend started (Interact 61/1): stand still for `value` ms. `entityId` = you, `targetId` = the friend's entity id (0 when they are on another zone), `data` = the friend's name (UTF-8). Moving more than 1 m or taking damage cancels it (981) |
| 981 | `travel_refused` | Playtest 2 (CR 017). To you: travel refused or cancelled. `value` = reason: 1 friend not online in this world, 2 not friends (checked while channelling), 3 you are in combat (hurt or fighting in the last 10 s, or downed), 4 the friend is in combat or downed, 5 cooldown (30 s after a travel), 6 you moved, 7 you were hurt, 8 you cancelled (Interact 61/2), 9 unavailable (no database to check friendships), 10 that is you. `data` = the friend's name when known |
| 982 | `travel_arrived` | Playtest 2 (CR 017). To you, after the core `teleport` Event (2) that moved you onto the friend's spot: `data` = the friend's name. On another zone's ground the WP16 handoff follows as after a walk |
| 807 | `purchase` | WP20. `value` = price, `targetId` = quantity, `data` = item id. Since WP14 the price is paid in gold (`currency:gold`, CR 010) and the item lands in the inventory (401 + 400); not enough gold or no room refuses with 403 instead (zones configured with an external `Config.Granter` keep the WP20 behaviour) |
| 950 | `quest_log` | Playtest 1 (CR 013). To you after join and after every change: your whole quest log. `entityId` = you, `targetId` = tracked quest id (0 none), `value` = active quests, `data` = UTF-8 JSON `{"v":1,"tracked":id,"quests":[{id, key, kind (0 bounty, 1 story), title, giver, step, steps:[{text, done}], text, note?, progress, need (0 = no count), markers:[{x, z, r?, label}], gold, xp, turnIn?}]}`. `markers` are the current step's places in meters (`r` > 0: an area circle of that radius, else a point); `text`/`note` the current step and its hint; `progress`/`need` a count (e.g. 2 of 4 ore) |
| 951 | `quest_offer` | Playtest 1. To you: a quest you may accept (Interact 60 action 1 with `targetId`). `entityId` = the NPC offering it (0 none), `targetId` = quest id, `data` = UTF-8 JSON: one quest of 950's shape plus `stepMarkers` (every step's markers, so the offer can preview where the quest takes place). Today: a blacksmith offers "Ward against the night" to a character who dropped it (or has not started it yet: playtest 2's first quest "Slimes in the meadows" comes before it) |
| 952 | `quest_step` | Playtest 1. To you: a step completed. `targetId` = quest id, `value` = the new current step index, `data` = JSON `{title, done (the step completed), next (the new step's text)}`. A talk step's NPC line comes as an 800 from that NPC right before |
| 953 | `quest_completed` | Playtest 1. To you: a quest completed (its gold and items arrive as 401 source 9 + 400, its XP as 603/604). `targetId` = quest id, `value` = gold, `data` = JSON `{title, gold, xp, kind}` |
| 954 | `quest_refused` | Playtest 1. To you: a quest Interact was refused. `targetId` = quest id, `value` = reason: 1 unknown quest/offer, 2 not at the hand-in place, 3 missing items, 4 quest log full, 5 already active, 6 already completed |
| 955 | `quest_started` | Playtest 1. To you: a quest joined your log without an Interact (the starter quest on a character's first login) or from an accepted offer. `targetId` = quest id, `data` = JSON `{title, text (first step), giver}` |
| 701 | `vein_hit` | WP09. To the miner: `entityId` = miner, `value` = vein hit points left, `x/y/z` = vein (cm), `data` = u64 vein id LE + u16 max hit points |
| 702 | `vein_break` | WP09. To each player who helped break it: `entityId` = player, `targetId` = their pickup's entity id, `value` = seconds until respawn, `data` = u64 vein id |
| 703 | `drop_spawned` | WP09. To the owner: `entityId` = pickup entity, `targetId` = owner, `value` = quantity, `data` = item id (UTF-8, `ore:<name>` / `gem:<name>:<cut>` until WP14 defines items) |
| 704 | `item_granted` | WP09 (grant hook for WP14). To the player: `entityId` = player, `targetId` = the pickup taken, `value` = quantity, `data` = item id |
| 706 | `mine_refused` | WP09. To the miner: `value` = 1 too far, 2 already mined, 3 unknown vein, 4 swinging too fast; `data` = u64 vein id |
| 707 | `mine_swing` | CR 018 (playtest 2 avatar animation). Within 64 m of the miner, not to the miner: another player swung a pickaxe at a vein (an accepted swing, the one that sends them 701). `entityId` = miner, `x/y/z` = the vein (cm), `targetId`/`value`/`data` unused |
| 990 | `pvp_state` | Playtest 2 (CR 019). To you, whenever your PvP flag changes (and when you arrive flagged from another zone; never to a player who has not touched the flag): `entityId` = you, `value` = bits: 1 flagged (also while turning off), 2 turning off, 4 you stand in a safe zone (only while flagged); `targetId` = ms until a waiting turn-off applies (0 none), `data` = UTF-8 safe zone name (bit 4: a settlement's name, or "the Haven") |
| 991 | `pvp_refused` | Playtest 2. To you: an Interact 70 was refused. `value` = reason: 1 you fought within `pvp.combatLockS`, 2 a flag request within `pvp.toggleCooldownS` (`targetId` = ms left), 3 already in that state, 4 no such player on this zone, 5 a duel needs the same party (flag for PvP instead), 6 farther than `pvp.duel.challengeRangeM`, 7 you or they already have a duel or a challenge, 8 nothing to answer or yield, 9 you or they are down, 10 bad action; `targetId` (reasons 4-9) = the player asked about |
| 992 | `pvp_hit` | Playtest 2. To you: a player hit you (open PvP or your duel). `entityId` = the attacker, `targetId` = you, `value` = health lost, `x/y/z` = the attacker, `data` = u8 1 if it was a duel hit. Players within 64 m (not you) get `strike_hit` (222) with `targetId` = the attacker; the attacker gets the HitResult |
| 993 | `pvp_kill` | Playtest 2. Kill feed, to the killer, the victim and players within 64 m of the victim: `entityId` = killer, `targetId` = victim, `x/y/z` = where, `data` = UTF-8 JSON `{"killer": name, "victim": name}`. The victim also gets the usual `player_downed` (203, `targetId` = the killer) and respawns as from any death (nothing dropped) |
| 994 | `duel_challenge` | Playtest 2. To the challenged: a party member challenges you. `entityId` = challenger, `targetId` = duel id, `value` = ms to answer (`pvp.duel.answerS`), `x/y/z` = the challenger, `data` = UTF-8 challenger name. Answer with Interact 70 action 3 |
| 995 | `duel_state` | Playtest 2. To each duelist (phase 1: the challenger only): `entityId` = the opponent, `targetId` = duel id, `value` = phase: 1 challenge sent, waiting for the answer, 2 accepted: countdown, 3 fight; `x/y/z` = the ring's centre (cm; phases 2-3, the midpoint of the two at the accept), `data` = u16 ring radius cm \| u32 ms until the phase ends (1: the challenge expires, 2: the fight starts, 3: the time cap) \| UTF-8 opponent name |
| 996 | `duel_ended` | Playtest 2. To both: `entityId` = winner (0 none), `targetId` = loser (0 none), `value` = reason: 1 the loser dropped to 1 health, 2 the loser stayed outside the ring longer than `pvp.duel.outsideForfeitS`, 3 the loser logged out or left the zone, 4 time is up (`pvp.duel.maxS`): a draw, 5 the loser yielded, 6 declined, 7 the challenge went unanswered, 8 called off (the challenger withdrew, or something else downed a duelist); `x/y/z` = the ring's centre, `data` = UTF-8 announcement. After reasons 1-5 both get back the health the duel took and the mana they had at the accept; the zone also posts the line to the party chat of the party members it hosts |
| 1000 | `content_sync` | CR 023. To you after join and on Interact 80/1 (the journal asks when a content tab opens): your content state. `entityId` = you, `value` = feats earned, `data` = UTF-8 JSON `{v, kills: {enemyKey: n}, tablets: [tablet id], feats: [feat key], title (feat key shown, "" none), stats: {duels, events, dungeons, forage, side, stories, bounties, demons, kills}, regions (walked in), rep: [{town, name, rep, tier}], vaults: [{site, name, x, z}] (found), progress: {featKey: value}}` |
| 1001 | `codex_unlocked` | CR 023. To you: your first kill of a creature (a new bestiary entry). `entityId` = you, `targetId` = enemy id (combat.yaml), `value` = 1, `data` = UTF-8 enemy key |
| 1002 | `feat_earned` | CR 023. To you: `targetId` = feat id (content.yaml order, 1-based), `data` = JSON `{key, name, desc, title, gold, xp}` (gold arrives as 401 source 10, XP as 603) |
| 1003 | `tablet_read` | CR 023. To you (Interact 80/2): `targetId` = atlas site, `value` = tablet id, `data` = JSON `{site, id, title, text, new, place}` |
| 1004 | `rep_changed` | CR 023. To you: your renown with a settlement rose (a side or story quest done). `targetId` = settlement (towns buffer), `value` = renown, `data` = JSON `{town, rep, gain, tier, tierName, up}` (`up`: a new tier: its merchants' extra wares, content.yaml reputation.wares) |
| 1005 | `player_title` | CR 023. A player's nameplate title (a feat's): `entityId` = the player, `data` = UTF-8 title (empty = none). To players within 140 m when it changes, and to each player who comes within 140 m of a titled player (checked every 2 s); never sent while nobody has a title |
| 1006 | `content_refused` | CR 023. To you: an Interact 80 was refused. `targetId` = its target, `value` = 1 unknown, 2 too far, 3 already picked (regrowing), 4 no room, 5 the vault is sealed, 6 not now, 7 chest already opened (cooldown), 8 title not earned; `data` = u8 action |
| 1007 | `content_places` | CR 023. To you, once per session per 256 m area as you come within one area of it: `targetId` = area (`az * 64 + ax`), `data` = `u8 version(1) \| u16 ax \| u16 az \| u16 n \| n x (u16 atlas site \| u8 tablet id \| i32 x, y, z cm \| u8 read by you) \| u16 m \| m x (u32 herb patch id \| u8 herb id (content.yaml forage order, 1-based) \| i32 x, y, z cm \| u32 ms until it regrows for you, 0 ready)` |
| 1008 | `forage_picked` | CR 023. To you (Interact 80/3): `targetId` = patch id, `value` = ms until it regrows for you, `data` = UTF-8 herb item key (the herbs arrive as 401 source 10 + 400) |
| 1009 | `content_say` | CR 023. To you: a line from a non-town speaker (a rescued villager when found). `entityId` = the speaker's entity (kind npc), `targetId` = quest id, `data` = UTF-8 line |
| 1010 | `world_event` | CR 023. A world event, to the players within `events.scheduler.announceM`: on start, to each player coming into range, on progress (10 % steps) and at the end (1.5x the range, and to everyone told before). `targetId` = event id, `value` = phase (1 active, 2 won, 3 failed or expired, 4 updated), `x/y/z` = where (cm), `data` = JSON `{id, kind (starfall, caravan, behemoth, wildhunt, glintfox), name, text, phase, endsInMs, progress (-1 unknown, else %: creatures left, the caravan's health, the behemoth's health), x, y, z, r, wave?, waves?, hp?}` |
| 1011 | `world_event_prize` | CR 023. To each participant of a won event (eligible on a kill of its creatures, or within its radius at the end): `targetId` = event id, `value` = gold, `data` = JSON `{name, gold, xp, ore?, gems?}` (items as 401 source 10) |
| 1020 | `vault_state` | CR 023. A live sealed vault, to the players within `dungeons.activeM` + 30 m on every change and to newcomers: `targetId` = atlas site, `value` = phase (0 sealed, 1 open: the keeper is awake, 2 cleared) | 0x10 if you opened its chest within the cooldown, `x/z` = the vault (cm), `data` = JSON `{site, name, phase, puzzle (levers, plates, braziers, font), title, hint (the inscription), parts: [{id, kind (lever, plate, brazier, font, door, chest), label, x, y, z, on, glyph}], keeper (% health, -1 none), x, z, r, holdS?, element?}` |
| 1021 | `vault_found` | CR 023. To you: you came within `dungeons.discoverM` of a sealed vault for the first time (it is on your map now). `targetId` = atlas site, `x/z` = cm, `data` = JSON `{site, name, x, z}` |
| 1022 | `vault_note` | CR 023. To the players near a vault: a line about it (`value` 0 a refusal or inscription, 1 the seal broke, 2 the keeper fell, 3 you opened the chest); `targetId` = atlas site, `data` = UTF-8 line |
| 1100 | `camp_area` | CR 025. To you, once per session per 256 m area as you come within one area of it (only areas with pieces): `targetId` = area (`az * 64 + ax`), `data` = `u8 version(1) \| u16 ax \| u16 az \| u16 n \| n x piece` where piece = `u64 id \| u8 kind \| u8 rot \| i32 x, y, z cm \| u8 flags (1 yours, 2 a chest shared with its owner's party, 4 its owner is in your party, 8 a campfire burning) \| u32 ms until the fire goes out \| u8 chest slots used \| u8 len + UTF-8 owner name \| u8 len + UTF-8 label` |
| 1101 | `camp_piece` | CR 025. To everyone who has the piece's area: a piece was placed (`value` 1; `entityId` = the placer) or changed (2: fuel, label, lock, chest fill, owner's party); `x/y/z` = the piece (cm), `data` = one piece record (1100) |
| 1102 | `camp_removed` | CR 025. To everyone who has the area: `value` = 1 picked up, 2 decayed (the owner stayed away `decay.days`); `x/y/z` cm, `data` = u64 piece id LE |
| 1103 | `camp_refused` | CR 025. To you: an Interact 90 was refused. `targetId` = low 32 bits of the piece id, `value` = reason (server/pkg/camps Refuse*: 1 unknown, 2 too far, 3 in a settlement, 4 too steep/uneven, 5 water, 6 in the way (a building, structure or piece), 7 too close to someone else's camp, 8 your camp is full, 9 enough of this kind, 10 outside your camp's area, 11 no kit, 12 someone stands there, 13 underground, 14 not yours, 15 chest not empty, 16 no room, 17 locked, 18 no firewood, 19 the fire is full, 20 another zone owns that ground, 21 just fought, 22 no camps in this world, 23 local profiles can't store items), `data` = u8 action |
| 1104 | `camp_chest` | CR 025. To you (on open, and to everyone with it open on every change): `value` = slots, `data` = JSON `{piece, lock, owner, mine, open (false: you may not use it), shared, label?, slots: [null \| Event 400 wire item]}` |
| 1105 | `camp_rested` | CR 025. To you: `value` = seconds of Rested left (0 = it ended), `data` = JSON `{staminaBonus, regenMult, manaRegenMult, fire}` (empty when it ended). The stamina wheel arrives in SelfState as usual |
| 1106 | `camp_mine` | CR 025. To you after join, on changes to your camp and when your party changes: `value` = your pieces, `data` = JSON `{pieces: [{id, kind, x, z}], markers: [{id, x, z, label, owner, mine}] (your and your party's signposts), spawn: [x, z] \| null (your bedroll: your respawn point), max, restedS}` |
| 1107 | `camp_note` | CR 025. To you: a line (`value` 0 info (a signpost's name), 1 the fire, 2 rest), `data` = UTF-8 |
| 997 | `duel_outside` | Playtest 2. To a duelist: `value` = ms before you forfeit for standing outside the ring (`pvp.duel.outsideForfeitS`), 0 = back inside; `targetId` = duel id |

HitResult refusal codes (HitResult.flags when `accepted` is false; also
Event 215 `value`): 1 not an enemy (a player you may not fight: one of you
is not flagged for PvP, CR 019), 2 unknown target, 3 dead, 4 unknown attack,
5 out of reach, 6 no line of sight, 7 too many hits, 8 stale, 9 illegal (too
fast, not unlocked; a heal or other zero-damage spell on a player), 10
invulnerable (boss transition), 11 required status missing, 12 cooldown, 13
mana, 14 spell not known, 15 you are down, 16 PvP: you or they stand in a
safe zone (a settlement or the Haven), 17 PvP: a party member (challenge them
to a duel instead).

Player-vs-player claims (playtest 2, CR 019): a HitClaim naming a player is
validated like one naming an enemy (the logged attack, reach plus
HIT_RANGE_SLACK_M against any sample of the victim's last HIT_HISTORY_MS,
terrain line of sight) only when the PvP rules allow it: both flagged, not in
the same party, neither in a safe zone; or the two fighters of a duel,
anywhere and whatever their flags. Damage = the same hit against a physical
enemy x `pvp.damageMult` (combat.yaml), then the victim's armor and shield;
no statuses, skill XP, kill XP or loot come from players.

Fast travel itself is the core `teleport` (2): the zone moves you and sends it
to you and to everyone who currently has you in their snapshot.

## Interact

`Interact` (protocol.yaml, id 5, c2s, reliable) is the generic "do something
to a thing" verb. `targetKind` is a registry like Event kinds; `action` and
`arg` are per kind. The zone rate-limits Interact at 10 burst / 5 per s.

| targetKind | Owner | targetId | action | arg |
| --- | --- | --- | --- | --- |
| 1-9 | reserved (core) | | | |
| 10 `site` | WP12 | atlas site index | 1 = fast travel (to an unlocked tower or activated waypoint), 2 = attune to the tower's crystal (playtest 1: stand on its top; 902 or 903 answers) | 0 |
| 11 `pin` | WP12 | `x cm \| z cm << 32` (both u32, inside the world) | 1 = set personal pin, 2 = clear personal pin, 3 = set your party pin, 4 = clear your party pin | set: `slot (0-9) \| colour << 8`; clear: slot; party set: colour |
| 20 `container` | WP14 | container stable id (worldgen chunk container record; listed by Event 406) | 1 = open (once per character, within 4.5 m of the eye) | 0 |
| 21 `item` | WP14 | item wire handle (Event 400 `h`); socket: weapon handle \| gem handle << 32 | 1 = use (consumable: becomes the drink key's choice; tome: learn; arrows: set the active loadout's arrowheads; gear: equip), 2 = drop (public pickup for 10 min, TransferItem), 3 = equip, 4 = unequip, 5 = move within its pouch, 6 = socket a gem, 7 = unsocket (gem kept at a town forge/anvil, destroyed elsewhere), 8 = combine 3 gems into the next cut (at a waypoint), 9 = set as the drink key's consumable | 2: quantity (0 = all); 3: loadout (weapons); 4: slot 0 main0, 1 main1, 2 head, 3 body, 4 legs (targetId ignored); 5: slot index; 6/7: socket index |
| 22 `craft` | WP14 | 2: the hearth/campfire prop stable id; 1: 0 | 1 = craft at the open station (forge/anvil from 805, cooking or a camp workbench from 404; within 7 m of it; CR 025: `camp` recipes (kits) need no station), 2 = open a cooking station (404) | 1: recipe id |
| 23-29 | reserved WP14 | | | |
| 30 `npc` | WP20 | the NPC's entity id (snapshot `EntityRecord.id`, kind npc) | 1 = talk (the NPC answers with 800, then its service: 801 shop, 802 bounties), 2 = buy, 3 = rest (innkeeper), 4 = accept bounty | buy: item index in the last 801 list; accept: bounty id; else 0 |
| 31 `board` | WP20 | bounty board prop stable id (towns buffer) | 1 = read (802), 2 = accept | accept: bounty id |
| 32 `station` | WP20 (WP14 hooks in) | forge or anvil prop stable id | 1 = use (805) | 0 |
| 33 `shaft` | WP20 | mineshaft structure stable id (= its atlas site id) | 1 = descend (teleport into the linked cave system's entrance chamber; core `teleport` event) | 0 |
| 34 `door` | WP20 follow-up (playtest UX) | door prop stable id (towns buffer PROPS kind 0, buildings with floors and a closed front; forges have none) | 1 = open, 2 = close, 3 = toggle (4.5 m from the eye; 970 to everyone near, or 972) | 0 |
| 35-39 | reserved WP20 (chests are WP14's 20-29) | | | |
| 40 `vein` | WP09 | vein stable id | 1 = pickaxe swing (25 damage, >= 250 ms apart, within 4.5 m of the eye) | tool tier (0 for now) |
| 41 `pickup` | WP09, WP14 | pickup entity id | 1 = take: personal pickups owner only (auto-taken on touch), public pickups (dropped items, snapshot `owner` none) anyone within 4.5 m | 0 |
| 50 `combat` | WP13 | 0 | 1 = swap loadout, 2 = equip weapon, 3 = equip spell, 4 = learn a tree node, 5 = set the socketed gem (dev builds only; WP14 sockets), 6 = set the weapon material (WP15; dev builds only; WP14's equipped item gear also carries it), 7 = learn any spell like a tome (CR 020; dev builds only: evidence runs) | 1: loadout (0/1); 2: loadout \| weapon id << 8; 3: loadout \| slot << 4 \| spell id << 8 (0 clears); 4: spell id; 5: loadout \| (element + 1) << 8; 6: loadout \| material id << 8 (combat.yaml materials; 3 = sunsteel, 0 = ordinary); 7: spell id |
| 51 `chem` | WP15 | dev actions: `x cm \| z cm << 32` (u32 each) | 1 = ignite, 2 = freeze, 3 = extinguish, 4 = raise a pillar (dev only); 10 = choose my chemistry sync path (anyone) | 1-3: radius in cells; 10: 1 events, 2 bitmap |
| 52 `night` | WP15 (dev only) | 0 | 1 = the nearest town's ward falters (a defense event now), 2 = set the world clock offset, 3 = raise demons near me | 2: offset seconds (i32 bits); 3: 0 lesser pack, 1 greater, 2 lord |
| 60 `quest` | Playtest 1 (CR 013) | quest id (Event 950/951) | 1 = accept an offer (951), 2 = abandon, 3 = hand in (a delivery's items, within 10 m of its settlement's bounty board or bounty keeper; reading that board or talking to that keeper hands in too), 4 = track (`targetId` 0 = none) | 0 |
| 61 `friend` | Playtest 2 (CR 017) | FNV-1a 64 of the friend's character id (UTF-8 bytes; the zone matches it against its players and the world presence feed) | 1 = travel to them (a 3 s channel, Event 980), 2 = cancel a channel | 0 |
| 80 `content` | Playtest 2 (CR 023) | 2: atlas site of a lore tablet; 3: herb patch id (1007); 4: `atlas site << 8 \| part id` (1020); 5: feat id (0 = no title); else 0 | 1 = send 1000, 2 = read a lore tablet (4.5 m from the eye), 3 = gather a herb patch (`forage.reachM`), 4 = use a vault part (a lever, the door, the chest; 4.5 m), 5 = show a feat's title, 9 = dev builds only: start world event `arg` near you | 9: event kind (1 starfall, 2 caravan, 3 behemoth, 4 wild hunt, 5 glintfox); else 0 |
| 90 `camp` | Playtest 2 camps (CR 025) | 1: `kind \| rot << 8 \| x cm << 16 \| z cm << 40` (kind = camps.yaml piece id, rot 0-7 in 45 degree steps, x/z cm 24 bits each); 2-4, 8: piece id (40 bits); 5: `piece id \| qty << 40` (16 bits, 0 = all); 6: `piece id \| slot << 40`; 7: `piece id \| chunk << 40`; 9, 10: 0 | 1 = place a piece from its kit (the zone checks server/pkg/camps rules; 1101 or 1103), 2 = pick up your piece (its kit back; a chest must be empty), 3 = use (campfire: light it with one firewood if cold, else open cooking (404 kind 3); bedroll: rest (1105); chest: open (1104); workbench: open it (404 kind 4); signpost: its name (1107)), 4 = add firewood, 5 = put an item in a chest, 6 = take a chest slot, 7 = a chunk of a signpost name (4 ASCII bytes in `arg`, a 0 byte ends it; chunk 0 starts over; 24 characters at most), 8 = chest lock (0 owner only, 1 the owner's party), 9 = dev builds only: every kit and materials, 10 = send 1106 again. Reach: `limits.reachM` from the feet | 4: firewood (0 = as much as fits); 5: item handle (Event 400 `h`); 7: label bytes; 8: lock; else 0 |
| 70 `pvp` | Playtest 2 (CR 019) | 1: 0; 2: the party member's entity id; 3: the challenger's entity id (0 = whoever challenged you); 4: 0 | 1 = set your PvP flag (on: at once; off: after `pvp.flagOffDelayS`, restarted by any PvP hit meanwhile; requests `pvp.toggleCooldownS` apart, refused within `pvp.combatLockS` of fighting; 990 or 991), 2 = challenge a party member within `pvp.duel.challengeRangeM` to a duel (994 to them, 995 to you, or 991), 3 = answer a challenge, 4 = yield: withdraw your challenge, decline one, or forfeit your duel (996) | 1: 1 on, 0 off; 3: 1 accept, 0 decline; else 0 |

WorldEdits for `vein_mined` (WP09) carry 16 bytes of `params` (f32 x, y, z,
carve radius 1.5) and `expiresAt` = respawn time; a delta whose `expiresAt`
is at or before the server time means the edit expired (the vein respawned
and the carve is restored). See server/zone/README.md "Caves and mining".

Players (pt/ux weapons) carry their active loadout's weapon look in
`EntityRecord.typeId`, so other clients draw it in the avatar's hand:
bits 0-3 = combat.yaml weapon id (0 none), bits 4-7 = material code (0
ordinary, else 1 + the index in items.yaml `materials`: 4 iron, 5 silver,
6 sunsteel...; the equipped item's material, else the loadout's dev
material), bits 8-11 = socketed gem element + 1 (0 none); playtest 2 (CR
017): bit 12 = flagged for PvP (also while a turn-off waits), bit 13 = in a
duel (countdown or fight). The zone sets it
only when the loadout, gear, PvP flag or duel changes (with every `combat_sync`), never per
tick; it rides the usual delta coding, ghosts and handoffs. The same
per-loadout material codes end `combat_sync` (212) for the owner's own
first-person view. See server/zone/internal/game/weaponlook.go and
client/src/combat/weapons/look.ts.

NPCs (WP20) are ordinary snapshot entities: `EntityRecord.kind` = npc (5),
`typeId` = role | appearance variant << 8, `level` = merchant kind (255
none), `name` = the NPC's generated name. Their schedules (out by day,
indoors at night) run in the zone (`server/zone/internal/npc`); a client
matches an entity to its towns-buffer record by name and position when it
needs more (home, work spot). Reach for every WP20 Interact: 4 m from the
eye. See server/zone/README.md "Towns and NPCs".

Pickups (WP09, WP14) are snapshot entities of kind pickup (4): `name` = item
key, `level` = quantity (capped 255), `typeId` = rarity (0-7). Personal
loot (kills, veins, container overflow) is sent only to its owner; dropped
items are public and despawn 10 minutes after the drop. See
server/zone/README.md "Items and loot (WP14)".

Demons (WP15) are ordinary enemies (`EntityKind` enemy, `typeId` from
combat.yaml where `family` is `demon`); the reserved `EntityKind` demon (6)
stays unused so every client and bot keeps drawing and targeting them on
the WP13 path. See docs/cr/011-wp15-night-chemistry.md.
