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
| `ai.go` | Enemy AI state machines, steering on the heightfield and around `World.Obstacles` (the zone's town buildings and closed doors), telegraphed attacks (300-600 ms), strikes that settle after the player's grace frames, enemy projectiles, player upkeep (mana, regen, drinks, respawns), `hurtPlayer` (the ONLY way a player loses health; only enemies call it) |
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

## Scale (WP19)

- `windupsOn` (at most two wind-ups on one player) walks an index of
  enemies that entered Windup instead of every enemy: it was O(enemies) per
  chasing enemy, 22 % of a 300-player / 2,000-enemy tick.
- A player grid (32 m cells), valid only inside `Step` (positions do not
  move there), answers `acquire`, `playersNear` and the wake rule; outside
  `Step` (claims with input frames) they fall back to the full scan.
- `scale_test.go` proves both against the old full scans.

### Second pass (WP19b): partitioned enemy AI (`par.go`)

"No goroutines" above now has one exception, owned by the host: with
`World.SetParallel` (the zone passes its tick pool) the enemy loop in `Step`
runs simple groups on workers. Each group's awake members think in spawn
order on one worker's private copy of the World (maps and pointers shared,
only read during the pass); events, strikes and enemy shots land in the
worker's slices and are merged back in spawn order, exactly where the old
single loop appended them. Bosses, demons, enemies with a damage-over-time
status and enemies without a group keep the old path (their think can kill,
spawn or touch other groups), run in place during the merge.

The only rule that couples groups, at most `maxWindupsOnOne` wind-ups on one
player, is kept exact: during the parallel pass an enemy counts other
groups' wind-ups as they were at the start of the tick (plus its own
group's, live) and records a request; the merge admits requests in spawn
order against the live count, and a refused enemy stands still that tick.
That rule (other groups seen as of the tick's start) is the one behavioural
difference from the old loop, and it is fixed: the outcome does not depend
on the number of workers or how groups are handed out
(`TestPartitionedAIMatchesAcrossWorkers`; without a pool everything runs
the same passes on the caller). `playerUpkeep` now walks players in id
order (`playerList`), so respawns and upkeep events no longer come out in
map order.

G4: a leashed `combatbot` (a `Goal` + `Leash`, e.g. the night bots at a ward garden) no longer picks enemies beyond leash + reach; it used to lock onto an older pack it could never reach and stand at the leash edge with 0 attacks through a whole defense (`combatbot/brain_test.go`).

### G5: 4 vCPU (2 cores + SMT)

`spawnTick` (once a second) marks a group "a player is within ENEMY_SPAWN_M" with a pass number on the group instead of a map rebuilt every pass, and skips the distance test for a group already marked this pass (no other player can change its marks). With 300 players among 500 camps it was ~150,000 `Hypot` calls and ~40,000 map writes in one tick: a +1.2 ms spike every 30th tick on two cores with SMT, i.e. inside the tick p99. Same marks, same spawns and despawns (all combat tests unchanged).

## Spell mechanics (playtest 2, CR 020)

| File | What |
| --- | --- |
| `spellsim.go` | The shared spell simulation, twin of `client/src/combat/spellsim.ts`: the 1/60 s homing step (acquire in a cone, turn-rate-limited steering, lose lock), the seeded stream jitter and rain points, orbit positions, charge fractions. `spellsim_golden_test.go` replays the client's golden vectors |
| `stream.go` | Hold-to-fire streams (one Action per stream, each shot recorded where it was fired; claims name a shot by its nominal seq) and hold-to-empower charges (the release logs the Action with the held fraction); `InputFlag.channel` |
| `validate.go` | `claimable` (per-shot and per-orb hit limits, orbit touch rate), `judge` (shot geometry from where it was fired with its jitter, rain, orbit ring, the homing re-flight `homingReach`), charge scaling of damage, radius and range |
| `summon.go` | Allies: zone-side bodies on the Enemy struct (the enemies' steering), never in `enemies`; target, follow, wind up, bite or bolt; caps; the PvP hook `SummonPvP` |
| `detonate.go` | Delayed charges and brands that burst on death (chain reactions): the zone's own hits |

Tests: `mechanics_test.go` (stream rate, mana drain and anti-cheat patterns, per-shot claims, charges, homing re-flights, orbit geometry and rate, delayed charges, brand chains, ally lifecycle, caps, targets and the PvP rule).
