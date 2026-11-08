# CR 011: Night, demons, weather and chemistry (WP15)

Author: WP15 · Date: 2026-11-08 · Status: applied on `wp/15-night`

All changes are additive: no existing field, value, id or meaning changed.
`protocol.yaml` is **not** changed (PROTOCOL_VERSION stays as WP16 left it):
everything rides the generic `Event` (kinds 500-526) and `Interact`
(target kinds 51, 52, action 6 of 50).

## What

### `contracts/constants.yaml` (version 3 -> 4)

New `night` group (generated to TS, Go and Rust; worldgen does not read
it, so no world output changes):

- Clock: `DUSK_HOUR` 18.5 (demons rise), `DAWN_HOUR` 6 (sunrise burns them).
  `DAY_LENGTH_S` and `MOON_CYCLE_NIGHTS` already existed and are now used.
- Demons: `DEMON_STAGGER_COOLDOWN_S`, `DEMON_SPAWN_EVERY_S`,
  `DEMON_PER_PLAYER` (lesser demons per player in the open at new moon and
  demonIntensity 0.5), `DEMON_SPAWN_MIN_M`/`MAX_M`, `DEMON_HUNT_LEASH_M`.
- Wards and defense: `WARD_MARGIN_M`, `LANTERN_WARD_M`, `DEFENSE_CHANCE`,
  `DEFENSE_JOIN_M`, `DEFENSE_WAVES`, `DEFENSE_WARNING_S`, `DEFENSE_BREAK_S`,
  `WARD_HEALTH`, `WARD_DAMAGE_PER_S`.
- Chemistry: `CHEM_STEP_HZ` 5, `CHEM_OP_LEAD_STEPS` 3,
  `CHEM_CLIENT_DELAY_STEPS` 2, `CHEM_CHUNK_CELLS` 32, `CHEM_INTEREST_M` 256,
  `CHEM_BITMAP_HZ` 2, `CHEM_WIND_WINDOW_S` 120, the fire numbers
  (`FIRE_*_SPREAD_PERMILLE`, `FIRE_*_BURN_STEPS`, `FIRE_BURN_JITTER_STEPS`,
  `FIRE_REGROW_STEPS` = one in-game day, `FIRE_RAIN_OUT_PERMILLE`,
  `FIRE_MAX_BURNING`, `FIRE_UPDRAFT_LIFT` 7 m/s, `FIRE_UPDRAFT_TOP_M` 40),
  `FREEZE_STEPS` (60 s), `PILLAR_STEPS` (2 min), `PILLAR_HEIGHT_M`,
  `PILLAR_HALF_M`, `PILLAR_WALL_RUN_M` (80 degree walls).
- `MATERIAL_GRID_M` (2, WP00) is the chemistry grid.

`WEATHER_STUB_WINDOW_S` / `WEATHER_STUB_RAIN_PCT` keep their values and
meaning: WP15 keeps WP10's rain function (same vectors) and evaluates it
on the world clock (wall clock + the world's offset) on both sides.

### `contracts/combat.yaml` (version 1 -> 2)

- **`materials`** (new): `iron` (1), `silver` (2, `demonStagger`),
  `sunsteel` (3, **`killsDemons: true`**). A loadout carries its main-hand
  weapon's material key (`Loadout.material` in the zone's
  `character_progress.skill_tree` JSON, omitted when empty; no migration).
- **`trees.light.killsDemons: true`**: normalized onto every Light spell
  (`SpellDef.killsDemons`); `forms.light.killsDemons: true` (the Dawn Arc
  form already had `demonMult: 2`, now applied against demons).
- **Demons**: enemies of `family: demon` with `demon: {rank}` (rank lesser
  | greater | lord; `regen` filled from `demons.regen`): `gloamling` (60,
  lesser), seven greater demons each with one element ability
  (`cinder_fiend` fire 61, `rime_wraith` ice 62, `storm_ghoul` lightning
  63, `grave_brute` earth 64, `gale_reaver` wind 65, `umbral_stalker` dark
  66, `void_maw` void 67) and the lord `starless_sovereign` (110); 12 new
  enemy attacks (ids 60-71, wind-ups inside 300-600 ms as the generator
  enforces); names in `enemyNames` (proposals, below).
- **`demons`** (new): per-rank regen, the lesser list, greater by element
  (`light` regions get `void_maw`) and the lord. The generator checks every
  demon has a rank and every table entry is a demon of that rank.

Codegen (`contracts/codegen/lib/combat.mjs`): `materials`, `demons`,
`killsDemons` on trees/spells/forms, `demon` on enemies, TS types.
`server/pkg/combatdefs`: the same fields plus `MaterialByKey`/`ByID`.

### The sunsteel contract (for WP14)

"Is sunsteel" is one key: **the material key `sunsteel`** in
`combat.yaml materials` (`killsDemons: true`). The zone's demon rule
(`combat.KillsDemons`, server/zone/internal/combat/demon.go) depends only
on it:

- a weapon hit kills demons iff the active loadout's `Material` names a
  material with `killsDemons` (sunsteel);
- a bow hit iff the loadout's `ArrowOre` arrowhead has `killsDemons`
  (`weapons.bow.arrows.sunsteel`, WP13 data);
- a spell iff its tree has `killsDemons` (Light); the Light form likewise.

WP14 equips a forged sunsteel blade by calling
`Profile.SetMaterial(loadout, "sunsteel")` (or whatever material its item
record names; an unknown key is refused). Until then dev builds set it with
`Interact{targetKind 50, action 6, arg = loadout | materialId << 8}`
(`LODESTONE_ZONE_DEV_COMBAT`, on with the dev ticket key); the acceptance
uses exactly this.

### `contracts/events.md`

Event kinds 500-506 (clock, dusk, dawn, demons), 510-514 (town defense),
520-526 (chemistry ops, baselines, bitmaps, refusals); Interact target
kinds 51 `chem` and 52 `night`; Interact 50 action 6. Demons are
`EntityKind` enemy (the reserved `demon` kind stays unused).

## Why

Spec 8 "Night and demons" and "Systems (the chemistry engine)", spec 9
"sync events, not results ... keep both paths behind one interface". Every
number the client and zone must evaluate identically (clock, wind, fire)
has to be a contract, and the demon rule has to be a stable key WP14 can
target without either package waiting for the other.

## Consumers affected

- Zone: `server/zone/internal/{combat (demon.go + small hooks), chem, night, game/night.go}`, `server/zone/night.go`, main.go (2 lines).
- Client: `client/src/systems/*` (clock, chemistry twin, night runtime, layer, HUD); `contracts/ts` regenerated.
- Go shared: `server/pkg/weather` (clock.go), `server/pkg/combatdefs`.
- Worldgen: `worldgen/src/gen/constants.rs` regenerated (unused constants; no output change, the golden table is unchanged).
- WP14: `Profile.SetMaterial` / the `sunsteel` key (above).
- WP16: the world clock is wall time + the world's configured offset, so every zone of a world agrees as long as they share `LODESTONE_ZONE_TIME_OFFSET_S` (dev's runtime "set time" Interact is per zone).

## Proposed names (pending Nicole's approval, like WP13's)

Demons: Gloamling (lesser); Cinder Fiend, Rime Wraith, Storm Ghoul, Grave
Brute, Gale Reaver, Umbral Stalker, Void Maw (greater); Starless Sovereign
(lord). Original names; nothing from Demon Slayer (no ranks, techniques or
designs).
