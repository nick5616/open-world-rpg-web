# CR 009: Combat, weapons, magic and enemies (WP13)

Author: WP13 · Date: 2026-11-08 · Status: applied on `wp/13-combat`

All changes are additive: no existing field, value or meaning changed. Bits
that were reserved or flags that had no defined meaning now have one.

## What

### New contract: `contracts/combat.yaml` (version 1)

The combat content every side reads: elements and the effectiveness table,
statuses, the six skills with their technique unlocks, five weapons with
their moves (timings in ms, generated as 60 Hz steps), elemental forms,
mobility dash variants, mana, every spell of the eight trees (Fire, Ice,
Dark, Earth ported from wizard-wars; Lightning, Wind, Light, Void new), the
start kit, enemy attacks, enemies, boss phase scripts, elite affixes and the
spawn tables (biome, element, site, depth band). Names live in one table
(`names:`), proposals awaiting Nicole under `pending:`
(docs/proposals/spell-names.md).

`npm run gen` normalizes it (codegen `contracts/codegen/lib/combat.mjs`)
into `contracts/ts/src/gen/combat.ts` (exported from `@lodestone/contracts`
as `COMBAT`) and `server/pkg/combatdefs/combat_gen.json` (embedded by the new
Go package `server/pkg/combatdefs`). The generator fails the build when a
light move starts slower than LIGHT_STARTUP_MAX_MS or recovers slower than
LIGHT_RECOVERY_MAX_MS, or an enemy wind-up leaves 300-600 ms.

### `contracts/constants.yaml` (version 2 -> 3)

New `combat` group: the spec 8 feel limits (LIGHT_STARTUP_MAX_MS 100,
LIGHT_RECOVERY_MAX_MS 250, INPUT_BUFFER_MS 150, HITSTOP_MS 60,
CONSUMABLE_USE_MS 350, ENEMY_WINDUP_MIN/MAX_MS 300/600), the dodge (9 i-frame
steps = 150 ms, 12 dash steps at 12 m/s, 12 stamina, DASH_EXIT_SPEED 6),
lenient validation (HIT_RANGE_SLACK_M 1, HIT_GRACE_MS 200), party scaling
(PARTY_SCALE_MAX 8, +75 % health and +10 % damage per extra player),
respawn/regen and spawn/despawn/respawn distances and times.

### `contracts/protocol.yaml` (version 3 -> 4)

- `InputFlag` semantics defined (bits already existed, unused until now):
  `attack` = one step per primary attack start; `alt_attack` = held while
  the secondary button is held; `dodge` = one step per dodge or mobility
  dash, with `castSlot` = the dash variant; `cast` = one step per spell
  cast (`castSlot` 0..3; 4 = elemental form, 5 = weapon technique);
  `interact` = one step per consumable use.
- `SelfState.moveExt` bits 24-27 = dash steps remaining, 28-31 = dodge
  i-frame steps remaining (were reserved 0). Clients replay dodges from
  snapshots bit-exactly.
- `HitClaim` / `HitResult` documented: claims name enemies; the zone answers
  each with HitResult (flags = crit/killed/weak/resisted/shielded when
  accepted, the refusal code when not).

PROTOCOL_VERSION 4: the zone kicks older clients with `version_mismatch`
(a v3 client would mispredict every dodge).

### `contracts/events.md`

Event kinds 200-222 (WP13 range 200-399), the HitResult refusal codes, and
Interact `targetKind` 50 `combat` (loadout swap, equip, learn, dev gem).
Interact 40/41 belong to WP09 mining.

### No migration

Combat profiles use the spec 11 columns that already exist in
`character_progress` (migration 0001): `skill_tree` (loadouts, active
loadout, weapon skill XP as `{"v":1,...}`), `spells_known`,
`spells_equipped` (the active loadout). Local profiles use the same fields
of their signed save (`localsave.Progress`).

## Why

Spec 8 combat and spec 9 combat validation. One table on both sides means
the client's predicted timelines, hit tests and HUD and the zone's
validation and damage can never disagree. The dodge must move the player,
so it lives in the shared movement step (TS and Go) and its counters ride
in SelfState for reconciliation.

## Consumers affected (all fixed in this change)

| Consumer | Change |
| --- | --- |
| Generated code | `npm run gen`: constants (TS/Go/Rust), protocol (TS/Go + golden vectors), new combat outputs |
| `client/src/sim` (WP02/WP10) | `dash.ts` + `stepMovement` dash phase; `moveWire.ts` packs/unpacks bits 24-31; `MoveInput.castSlot`; new dash goldens (`golden/wp13.ts`, `movement_wp13_dash_*.json`); WP02/WP10 goldens unchanged |
| `server/pkg/movement` (WP03/WP10) | `dash.go` + `stepFull`; `wire.go`; `MaxHorizontalSpeed` includes dashes; Go replays the dash goldens |
| `server/zone` (WP03/WP06/WP10/WP12) | combat glue (`internal/game/combat.go`), `verticalOK` allows a launch dash, one-step flags never synthesized/extrapolated, combat Interact routing, HitClaim handling after the tick's frames |
| `client/src/net` (WP06) | `zoneSession` sends `castSlot`, `sendHitClaim`, `onHitResult`; `RemoteView.typeId` |
| `client/src/sim/localSim.ts`, `scene/PlayerController.tsx` | per-step combat hook, input block while downed |
| `tools/bots` (WP03) | none: bots never set the combat flags |
| `localsave` (WP04) | none: the existing optional fields carry the profile |
