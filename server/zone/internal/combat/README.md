# server/zone/internal/combat

The zone's PvE combat (WP13, spec 8 and 9). Pure and tick-owned: no I/O, no
clocks (time = zone tick and input frame seq), no goroutines. The glue to
sessions, entities, the wire and persistence is `internal/game/combat.go`;
the numbers come from `contracts/combat.yaml` via `server/pkg/combatdefs`.

| File | What |
| --- | --- |
| `profile.go` | Loadouts (two), known spells, weapon skill XP; learn/equip/swap rules; `skill_tree` JSON (decision 0013) |
| `player.go` | Per-player runtime: frames -> attack/cast/form log (the record a HitClaim must match), start legality (no faster than the move, dodge cancels recovery), mobility dash checks (mana, cooldown, equipped), parry windows, drinks, frame history for the strike grace window |
| `validate.go` | HitClaim validation (lenient: any sample of the target's last HIT_HISTORY_MS + interpolation delay, reach + HIT_RANGE_SLACK_M, terrain LOS for ranged), damage (skills, spell power, passives, elements, statuses, crits), kills, XP, the WP14 loot hook |
| `enemy.go` | Enemies: level/affix/party scaling, statuses, shields, position history |
| `ai.go` | Enemy AI state machines, steering on the heightfield, telegraphed attacks (300-600 ms), strikes that settle after the player's grace frames, enemy projectiles, player upkeep (mana, regen, drinks, respawns), `hurtPlayer` (the ONLY way a player loses health; only enemies call it) |
| `boss.go` | Boss phases, invulnerable transitions, party-scaled adds, resets, arenas (`Arena`, `ArenaProvider` hook for WP09 cave chambers) |
| `world.go` | Groups (camps, bandit camps, guardians, wild packs, boss arenas) from the atlas, seeded compositions, spawn/despawn by player distance, wake/sleep at ENEMY_WAKE_M |
| `atlas.go` | Site biome/element and region element/danger from the raw atlas |
| `events.go`, `actions.go` | Event kinds 200-222, payload encoders, cast FX, shields/heals on cast |
| `combatbot/` | A headless fighter (the real weapon timelines and claims) used by the simulations here and by `cmd/combatbots` |

PvE only: claims name enemies; a claim naming a player is refused by the
glue before it reaches `World.Claim`; `TestOnlyEnemiesCallHurtPlayer`
checks structurally that nothing else lowers player health.

## Tests

```
go -C server/zone test ./internal/combat/...
```

- `combat_test.go`: every attack and spell claimed at a player is refused,
  `hurtPlayer` only from enemies, validation (reach, history leniency,
  pending/unknown/too-fast/hits), cooldowns and mana, unequipped dashes
  stripped, a telegraphed strike lands when you stand still and misses when
  you dodge, party scaling, profile learn/equip/round trip.
- `sim_test.go`, `boss_test.go`: in-process fights at simulated time with
  the bot brain (spec 8 measurements): every common enemy x sword/spear/bow
  dies in 2-5 hits and the fight lasts 3-10 s; elites of each affix 10-30 s;
  Warden and Archon fights with 1, 2 and 4 players last 2-5 minutes through
  3 phases; a party of two clears a camp and then a boss.
