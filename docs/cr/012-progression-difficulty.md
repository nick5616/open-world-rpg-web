# CR 012: Progression and discovery-stamped difficulty (playtest 1)

Author: playtest-1 progression agent · Date: 2026-11-09 · Status: applied on `pt/progression`

Nicole's first playtest: demons were unbeatable early (no sunsteel or Light
yet, many of them, every night), level 4 meant nothing, and the crystal
towers did nothing visible. Decisions: `docs/decisions/0021-discovery-difficulty.md`.

All changes are additive. `protocol.yaml` and `constants.yaml` are **not**
changed (PROTOCOL_VERSION unchanged): everything rides the generic `Event`
(kinds 900-903, new range 900-949) and `Interact` (target kind 10, new
action 2). Worldgen is untouched: the area stamp is server state, not
generator output, and every golden hash is unchanged.

## What

### `contracts/combat.yaml` (version 2 -> 3)

- **Slimes**, the beginner family: enemies `slime` (Dewdrop Slime, id 50)
  and `moss_slime` (Mossback Slime, id 51), family `slime`, slow (3.2-3.6
  m/s, slower than walking), short aggro (12 m), soft hits; attacks
  `slime_bump` (id 30) and `slime_hop` (id 31), wind-ups 500/600 ms. Names
  are proposals (one-line renames in `enemyNames`).
- `tables.beginner: [slime, slime, moss_slime]`: what the Haven holds and
  quiet lands mix in. The generator refuses demons and bosses there.
- `leveling` (new): health `100 + 12/level`, damage `+10 %/level` on every
  player attack, spell and DOT, stamina `+2/level` (cap +60), skill points
  `1 + level` (unchanged), spell tree tiers gated by level for skill-point
  learning (`spellTierLevels {4: 3, 6: 6, 8: 10, 10: 14, 12: 18}`; tomes
  still teach anything), and the tower attunement boon (`attune`: +8
  stamina, +5 health, +1 skill point, +100 XP).
- `difficulty` (new): area size `cellM` 256 m, `havenRadiusM` 420,
  `maxStep` 3, `neighbourWeight` 0.5, `dangerBonus` 2, `maxLevel` 30,
  `stampReachM` 200 (the generator checks it exceeds ENEMY_SPAWN_M), the
  low-level town safety (`demonSafeBelow` 6, `demonSafeMarginM` 90) and six
  tiers (haven, quiet, wilds, perilous, dread, deadly) with per-tier knobs:
  beginner share, elite multiplier, demon/greater-demon multipliers, demon
  speed, lords, bosses, defense events. The generator validates all of it.

Changed meaning (gameplay numbers, not wire): character health per level
10 -> 12; player damage now grows with level (was flat); enemy level comes
from the stamped area (was region danger only) when the zone runs with
difficulty (production default).

### `contracts/items.yaml`

`loot.families.slime` (item 0.06, consumable 0.12, food 0.15).

### `contracts/events.md`

New range **900-949** (playtest 1), kinds:

- 900 `character_stats` (to you: level, XP into/for the level, health,
  mana, stamina, damage bonus, skill points, towers attuned + bitset;
  reason sync / level-up / attuned),
- 901 `area` (the 256 m area you stand in: level, tier, Haven / stamped by
  you / provisional, discoverer's name),
- 902 `tower_attuned` (**the hook for the `pt/ux` location-discovery
  intro**: tower site, region index, crystal position, region name),
- 903 `attune_refused`.

Interact 10 (`site`) gains action **2 = attune** (stand on the tower's top).

### Migration `0021_progression_difficulty.sql` (additive)

- `area_difficulty (world_id, cell_m, cell_x, cell_z, level, stamped_by,
  stamped_by_name, stamped_by_level, stamped_at)`, primary key
  `(world_id, cell_m, cell_x, cell_z)`; zones insert with `ON CONFLICT DO
  NOTHING` and read back (first writer wins across zones). No foreign key on
  `world_id` (dev worlds without a `worlds` row).
- `character_progress.attuned bytea NOT NULL DEFAULT '\x'` (tower crystals
  attuned, by atlas site index). The zone's progress load/save reads and
  writes it, so **run `npm run migrate` before deploying the zone**.

### Local saves (`server/pkg/localsave`)

`Progress.attuned` (optional, base64 bytes); the account upgrade path copies
it into `character_progress.attuned`.

## Why

Spec 8 already says experience comes from discovery, levels give health and
skill points, stamina upgrades come from towers, and demons are the night's
threat. Playtest 1 showed the numbers did not reach the player: enemy
levels followed distance from spawn regardless of who arrived, demons
appeared everywhere a player stood in the open, and leveling changed
almost nothing visible. The stamp makes the world grow with the people
who explore it (Nicole: "as you level up, the areas you discover are free
to shape into harder challenges"), while keeping it shared and consistent.

## Compatibility

- Old clients ignore Events 900-903 (unknown kinds) and never send
  Interact 10/2. The client drops `KeyC` from the movement keys (crouch
  stays on Ctrl) to open the character panel.
- Zones without difficulty (`LODESTONE_ZONE_NO_DIFFICULTY=1`, tests that
  leave `Config.Difficulty` nil, zones without an atlas) keep the WP13
  region danger curve exactly.
- The client's prediction now also compares the stamina wheel
  (`SelfState.staminaMax`); a level-up or attunement changes it once,
  causing one zero-distance replay.
- Generated: `contracts/ts/src/gen/{combat,items}.ts`,
  `server/pkg/combatdefs/combat_gen.json`, `server/pkg/itemdefs/items_gen.json`.
  No golden vector changes (no protocol or constants change).
