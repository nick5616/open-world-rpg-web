# 0013: Combat, weapons, magic and enemies (WP13)

Date: 2026-11-08 · Status: accepted (spell names pending Nicole)

## Context

Spec 8 asks for quick, snappy PvE combat with measured feel targets, five
weapons with use-based skills and techniques, Wizard Wars' Fire/Ice/Dark/
Earth plus four new trees, enemies per biome/depth/element, elites, bosses
with phases in generated arenas and party scaling. Spec 9 asks for lenient
server validation of client hit claims, and spec 2 forbids any way for a
player to hurt a player.

## Decisions

1. **One content table, generated for both sides.** `contracts/combat.yaml`
   is normalized by `npm run gen` into the client's `COMBAT` object and the
   zone's embedded JSON (`server/pkg/combatdefs`). The generator enforces
   the feel limits (light startup <= 100 ms, recovery <= 250 ms, enemy
   wind-ups 300-600 ms) so a tuning change can't silently break them. All
   player-facing names come from its `names:` table (renames are one line).

2. **Client decides WHEN, the zone decides WHICH and WHETHER.** The client
   runs a step-synchronous timeline in LocalSim's 60 Hz steps (input
   buffer, combos, dodge-cancel, charge) and marks the start step with
   one-step input flags (`attack`, `cast`, `dodge`, `interact`;
   `alt_attack` held). The zone replays the same frames through the same
   rules (`internal/combat/player.go`), re-derives the move (combo index,
   sprint/air/plunge, charge level) and refuses starts faster than the
   move allows. No extra message: attacks ride the input frames that
   already arrive 30 times a second with redundancy.

3. **The dodge is movement.** It lives in the shared step (TS
   `client/src/sim/dash.ts`, Go `server/pkg/movement/dash.go`), counters in
   `SelfState.moveExt` bits 24-31, so prediction replays dodges exactly
   (cross-language golden replayed in Go). Mobility spells and the wind
   form are dash variants (`castSlot`); the zone strips a variant the
   player may not use (not equipped, cooldown, mana) before stepping, so
   cheating a dash only earns a correction.

4. **Hits are predicted and claimed (spec 9).** Melee arcs on the active
   frames, local projectiles, beams, areas and runes are tested against the
   enemies as drawn (interpolated), feedback (spark, 60 ms local hitstop)
   plays at once, the claim names the attack's start seq and id. The zone
   accepts if the target was in reach (+1 m) at ANY sample of its last
   HIT_HISTORY_MS plus the near-ring interpolation delay, with a terrain
   line-of-sight test for ranged hits. Not lag compensation: lenient on
   purpose (monsters, not people).

5. **Enemy strikes favor the player.** A strike's shape is decided when the
   telegraph starts (what you see is what hits). It settles only after the
   player's own input frames up to HIT_GRACE_MS + the interpolation delay
   (300 ms) after the strike have arrived: any of those frames with dodge
   i-frames, an open parry or the player outside the area evades it.

6. **PvE only, enforced structurally.** Claims naming a player are refused
   (code 1) before validation; `World.Claim` only knows enemies; the one
   function that lowers player health (`hurtPlayer`) takes an enemy source
   and only enemy strikes and projectiles call it (a test greps for it).
   Healing allies is allowed.

7. **Enemies are zone entities on the existing snapshot path.**
   `EntityKind enemy`, `typeId` packs enemy id, element and affix,
   `healthPct`, Activity `casting` while winding up. Groups (atlas camps,
   bandit camps, guardians, boss arenas, seeded wild packs) spawn within
   160 m of a player and despawn after 30 s alone, so a 4 km world costs
   nothing where nobody is; they think only within ENEMY_WAKE_M (96 m). No
   new message, no change to rings or the byte budget (decision 0005).

8. **Fight pacing is designed, not tuned by HP alone.** Commons have 80-94
   health (2-5 hits for every weapon), a 600 ms "noticed you" beat, hit-and-
   run repositioning after attacks, and hop out of reach after two quick
   hits; at most two enemies wind up on the same player. Measured with the
   bot brain in simulation (sword/spear/bow vs every common: 3-10 s).

9. **Bosses** run 2-3 phases with invulnerable 2.5 s transitions and adds
   whose count scales with the party; they reset after 15 s with nobody in
   the arena. v1 arenas are overworld structure sites (wizard towers ->
   Archon; sunken temples, demon lairs, tier-2 ruins -> Warden); WP09 cave
   chambers plug in through `combat.ArenaProvider` / `AddArena` /
   `CombatSetup.Arenas` with no change to the boss code.

10. **Party scaling**: health x (1 + 0.75 (n - 1)), damage x (1 + 0.1 (n - 1)),
    n = players engaged (near the group when the fight starts or joining
    it), capped at 8, never shrinking mid-fight. Measured: the Warden takes
    175 / 182 / 165 s for 1 / 2 / 4 bots (simulation) and 201 s for the networked party of two.

11. **Persistence without a migration.** `character_progress.skill_tree`
    holds `{"v":1, loadouts, active, weaponSkills}`, `spells_known` the
    learned spells, `spells_equipped` the active loadout (spec 11 columns).
    Local profiles carry the same fields in their signed save.

12. **Porting choices.** Wizard Wars' lightning branch (Lightning Strike,
    Static Charge, Chain Lightning) moved from Fire to the new Lightning
    tree. Earth = Druid + Crystalmancer. PvP-only mechanics were adapted
    and marked `ported:` in the YAML (Ice Wall / Crystal Wall become
    shields, Gem Plop taunts enemies, Death Note has a cooldown and skips
    bosses, Inferno Domain burns instead of accelerating projectiles).

## Consequences

- WP14 hooks: `World.OnKill(KillInfo{Enemy, Eligible})` for personal loot and
  boss lockouts, `Profile.Grant` for tomes, `Profile.SetGem` / `Loadout.Gem`
  for sockets, `Loadout.ArrowOre/ArrowGem` + `combat.yaml arrows` for ore
  arrows and gem tips, the healing draught is a stand-in consumable.
- WP15 hooks: `killsDemons`/`demonMult` data on Light spells, sunsteel
  arrows and forms; statuses and `burn` for grass ignition are data only.
- Passives are data with a small interpreter (tree damage, vs-status,
  low-HP, kill heal/shield, crit); a few (Phoenix, Undying, Twin Cast,
  Pole Vault) are not implemented yet (STATUS).
