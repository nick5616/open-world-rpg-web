# CR 048: Playtest 3 balance (levelling, magma dash tiers, demon immunity)

Four independent playtest-3 fixes (branch `pt3/balance`). No wire change, no
protocol, event or migration change. Contract data change in
`contracts/combat.yaml` (dashes, demons); `npm run gen` regenerates
`contracts/ts/src/gen/combat.ts` and `server/pkg/combatdefs/combat_gen.json`.

## 1. Levelling: level 2 is a first-session chunk

"You immediately level up to level 2": the curve was 60 + 40 x level (100 XP
to level 2) and the spawn town's discovery alone paid 100.

`explore.XPForNextLevel(level)` is now 60 + 40 x level plus an early surcharge
of +260 / +160 / +80 / +20 for levels 1-4: **360, 300, 260, 240**, then the
unchanged curve from level 5 (260, 300, ...). Per-level costs from level 5 on
are exactly what they were (total XP to a level is 520 higher). Level 2 is the
spawn town (100), the Meadows quest (60) and a handful of kills (18-30 each),
about 10-15 minutes. Twins: `client/src/ui/progression/gains.ts xpForLevel`
(`EARLY_XP_EXTRA`). The `level` column is recomputed from XP on load, so
saved characters re-level consistently (a character saved at level 2-4 can
read one level lower after this change; XP is kept).

Consumers: `LevelForXP`, `levelProgress` (Event 900's xp-into / xp-next),
the dev console XP setter, the progression HUD, the wire vectors in
`progression_test.go` / `progression.test.ts`.

## 2. Magma dash tiers

"You can magma dash too well too soon." The dash flies (a jet hold that
cancels gravity) from level 1. Now the spell's dash depends on the character
level:

| tier | levels | dash row | feel |
|---|---|---|---|
| Lesser | 1-7 | `magma_dash_lesser` (id 10) | 22 m/s x 8 steps along the look, hold = a steered run at 16 m/s that falls (no thrust), hold drain 40 mana/s |
| Honed | 8-14 | `magma_dash_honed` (id 11) | 27 m/s x 10 steps, jet thrust at 22 m/s (steer 0.05), 32 mana/s |
| Full | 15+ | `magma_dash` (id 1), unchanged | 30 m/s x 12 steps, jet at 36 m/s, 24 mana/s |

Tiers are ordinary dash variants, so the shared movement step (Go
`server/pkg/movement/dash.go`, TS `client/src/sim/dash.ts`) is **unchanged and
stays bit-identical**; only the variant id in `castSlot` differs. The level
is an input both sides already know: the zone's `Player.Level` and the
client's `combat_sync` level (`CombatTimeline.charLevel`).

- `combat.yaml dashes`: `minLevel`, `tierName` on the base dash and each tier;
  `tierOf: <base key>` on a lesser row. Codegen validates and emits
  `DashDef.minLevel/tierName/tierOf`.
- Resolution (twins): Go `combatdefs.Defs.ResolveDash(baseID, level)`,
  TS `combat/dashes.ts resolveDash`. The client names the resolved variant;
  `Player.allowDash` accepts only the variant its level resolves to (a client
  that names a higher tier is refused and corrected, never given the better
  dash). A mid-dash level-up keeps the running variant.
- The spell card / tooltip shows the Tier row ("Lesser (Honed at level 8)"),
  the dash numbers of the tier you have, and the hold drain.
- Achievements: the distance stat counts any tier as the magma dash; "take
  flight" still needs a jet hold high above the ground (Honed or Full).
- `client/src/sim/golden/movement_wp13_dash_*.json` regenerated (the golden
  scenarios iterate every dash row; the Go twin tests read the same files).

## 3. Spell bank hides equipped spells

`ui/spellcards/card.ts bankCards(known, equipped)`; the character panel's
grid ("Spell bank") lists castable spells not in the loadout being edited.
Clearing a slot (x, Delete, or dropping the slot card on the bank) puts the
card back. Dragging a bank card onto an occupied slot swaps (the old spell
returns to the bank). The other loadout's spells stay in the bank while one
is edited.

## 4. Only high-level demons are immune

"Only high level demons should not take damage to non-sunsteel or light
magic." `combat.yaml demons.ordinary: {halfFrom: 8, immuneFrom: 15, halfMult: 0.5}`
by the demon's level (the area level when it rose; `Enemy.Level`):

- below 8 (Wilds-level night lessers): ordinary damage hurts like any enemy
  and **lasts** (counts as seared);
- 8-14 (Perilous): ordinary damage does 50 %, also lasting;
- 15+ (Dreadlands and up), lords at any level and story demons with a Guard
  (the Hollow Bells): the WP15 behaviour, ordinary hits only wound and
  regenerate.

Sunsteel and Light always do full lasting damage. Hits that are reduced or
shrugged off carry `FlagResisted` (the grey "resist" number); Event 504
("shrugged") is sent only for the immune tier, and the HUD hint reads "too
strong for ordinary weapons". `combat.KillsDemons` is unchanged; the new
`Enemy.OrdinaryTier()` / `demonDamage` apply the tiers to every damage source
(weapons, spells, dashes, DOTs, summons).

Docs updated: CR 011 (sunsteel contract section), decision 0015 (#4),
`client/src/ui/tips/tips.ts`, `ui/skills/build.ts` loadout lines. Not
re-run: the 11-minute browser acceptance `tools/acceptance/g4.mjs` and
`server/zone/cmd/nightbots` assert a level-1 demon shrugs off the starting
sword; with this change that holds only for demons of level 15+, so their
phase-1 expectation needs a high-level spawn (known gap, see STATUS).
