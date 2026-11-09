# 0021: Discovery-stamped difficulty, leveling that matters, crystal attunement

Status: accepted (playtest 1, branch `pt/progression`). Contract: `docs/cr/012-progression-difficulty.md`.

## Context

Nicole's first playtest:

> "demons are really hard early on because you dont know where to get sun
> steel or light magic. So in the night, they play as invulnerable and they
> are frequent in number. There should be an associated difficulty of
> evaluating adjacent chunks that have been generated, the user who first
> generated the new chunk's level. so, when you load in to the starting
> area, there are no demons only slimes or something. But as you level up,
> the areas you discover are free to shape into harder challenges."
>
> "also i am level 4 but idk what i can do with that, nor do i feel any stronger."
>
> "also what is the giant tower with the crystal? that should do something."

Before this change an enemy's level was `1 + round(24 x region danger)`
(region = 1024 m, danger from distance to spawn, decided by the generator),
demons hunted every player in the open at night (4 lesser demons per player
on a new moon at the default intensity), a level gave +10 health and +7
mana and nothing else visible, and towers revealed the map silently.

## Decision 1: the area is a 256 m square, stamped once, first writer wins

**Granularity.** An area is a 256 m square (4 x 4 chunks, 16 x 16 = 256
areas in the v1 world): `combat.yaml difficulty.cellM`. The zone's combat
groups already live on this grid (`combat.cellM`), so every camp, pack and
night spawn maps to one area, and a pack and its neighbours are never
split. A region (1024 m, 16 areas) is too coarse: one stamp would decide a
quarter of the world. A chunk (64 m, 4,096 areas) is too fine: a player
sprinting at 7.8 m/s would stamp a chunk every 8 s and enemies 160 m away
would sit in chunks nobody had "discovered". 256 m is about 30 s of walking
and two enemy spawn radii.

**Discovery.** A player discovers every area whose square lies within
`stampReachM` = 200 m of them (the generator checks it exceeds
ENEMY_SPAWN_M = 160 m), so a group's area is always known before the group
spawns. Atlas groups in a not-yet-stamped area wait (they spawn a second
later); undiscovered areas stay unstamped until someone comes near.

**The stamp rule** (`internal/difficulty.Propose`):

```
target  = discoverer's character level + dangerBonus x region danger   (dangerBonus = 2)
if any of the 8 neighbours is stamped (the Haven counts as level 1):
    target = (1 - w) x target + w x mean(neighbours)                   (w = neighbourWeight = 0.5)
    target = clamp(target, max(neighbours) - maxStep, min(neighbours) + maxStep)   (maxStep = 3;
             when the neighbours are farther apart than that, within maxStep of the lowest)
level = round(target), 1 .. maxLevel (30)
```

So a level-15 explorer far from everything stamps 15-17; the same explorer
right next to the Haven stamps at most 4, and difficulty ramps by at most
3 levels per 256 m outward from it, so a strong player walking out of the
start area meets a gradient (4, 7, 10, 13, 15...) instead of a cliff. A
level-1 player wandering next to a level-12 area someone else stamped is
pulled up (no hidden pockets of easy land between hard ones). The
generator's region danger survives as a small bonus, so the far edges are
still a little meaner than their discoverer.

**The Haven.** Areas whose centre lies within `havenRadiusM` = 420 m of
the world spawn (8 areas on the official world, about 1 km across, the
spawn town and its surroundings) are fixed at level 1, tier `haven`, and
never stored: beginner creatures (slimes) only, no elites, no boss arenas,
no demons, no defense events. It is a pure function of the atlas, so every
zone agrees without asking anyone.

**Persistence and consistency.** Stamps are rows in Postgres
`area_difficulty` (migration 0021), keyed `(world_id, cell_m, cell_x,
cell_z)`. A claim reads the stamped neighbours, proposes a level, `INSERT
... ON CONFLICT DO NOTHING RETURNING`, and on conflict reads the row that
won. Two zones (WP16) racing for one area at the same moment with players
of different levels both end up with the one stamp (tested in process with
two pools and over two zone processes). A stamp never changes. `cell_m` in
the key means a later granularity change starts a fresh map instead of
misreading old rows.

**Tick cost.** The zone keeps a flat `[]int16` of known levels (256
entries): every lookup on the tick (group spawn, night spawn, LevelAt,
areaTier) is an array index. The tick checks each player at 2 Hz
(staggered) for areas within 200 m that need a claim (9-16 squares, a few
comparisons) and hands claims to **one worker goroutine** over a channel
(non-blocking send; full = try again next pass); results come back over
another channel and are drained at the start of the next tick. No tick ever
touches Postgres. At start the worker loads the world's stamps. If a claim
fails (database down), the worker returns a **provisional** level computed
from what the zone knows; it is used at once (so play continues) and
claimed again 30 s later; the client is told (flag 4).

Without a database (dev, tests) a `MemStore` gives the same semantics
in-process (shared by two in-process zones in `TestTwoZonesAgreeOnAStamp`).
`LODESTONE_ZONE_NO_DIFFICULTY=1` restores the WP13 region danger curve;
zones without an atlas run without difficulty.

## Decision 2: tiers drive enemies and demons

Area level -> tier (`combat.yaml difficulty.tiers`):

| Tier | Area level | Packs/camps | Elites | Night demons (x WP15 count) | Greater demons | Demon speed | Lords | Bosses | Town defense |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haven | the spawn's 8 areas | slimes only | none | none | none | | no | no | no |
| Quiet Lands | 1-3 | half slimes, half biome beasts | none | none | none | | no | yes | no |
| The Wilds | 4-7 | biome tables | x0.5 | x0.35 (0-1 straggler) | none | x0.85 (5.6 m/s < walking 8) | no | yes | no |
| Perilous Lands | 8-12 | biome tables | x1 | x0.7 | x0.6 | x1 | no | yes | yes |
| Dreadlands | 13-19 | biome tables | x1.3 | x1 (WP15) | x1 | x1 | yes | yes | yes |
| The Deadlands | 20+ | biome tables | x1.6 | x1.25 | x1.5 | x1.05 | yes | yes | yes |

- Every atlas group (camp, bandit camp, guardian, wild pack, boss arena)
  takes its **level** and **tier** from its area when it spawns. Dev/test
  placements and cave-chamber arenas keep their explicit levels.
- Night spawns ask the tier at the player (how many hunt, greater chance)
  and at the spawn point (never rise in an area whose tier has no demons,
  e.g. the Haven next door). Demons spawned in the wilds are slower.
- **Towns stay havens for the weak:** players below level 6 are not hunted
  within 90 m beyond any ward (on top of WP15's "inside a ward = sheltered").
- Lords rise only at lairs in dread lands or worse; a town's ward falters
  (defense events) only in perilous lands or worse.
- WP15's core rule is untouched: ordinary damage never kills a demon; only
  sunsteel, Light and sunrise do. WP15's demon tests use dev raises (which
  ignore tiers) and still pass unchanged.

Moon phase and `demonIntensity` still scale everything as in WP15 (the
tier multiplies on top).

## Decision 3: levels give health, damage, stamina and skill points

`combat.yaml leveling`, applied by the zone, shown by the client:

| Per level above 1 | Before | Now |
| --- | --- | --- |
| Health | +10 | +12 |
| Damage (weapon moves, spells, forms, DOTs) | +0 % | +10 % |
| Stamina wheel | +0 | +2 (cap +60) |
| Mana | +7 | +7 |
| Spell skill points | +1 | +1 |
| Spell tree tiers (skill-point learning) | all open | tiers 1-3 at level 1, 4-5 at 3, 6-7 at 6, 8-9 at 10, 10-11 (domains) at 14, 12+ (pinnacles) at 18 |

**The curve against enemies.** Enemies keep WP13's +10 % health and +6 %
damage per level. Player damage grows exactly as fast as enemy health, so
an at-level common dies in the same 2-5 hits at level 30 as at level 1
(`TestLevelCurveKeepsFightsSnappy`: boar, wolf, cutthroat, brute,
sentinel, ember imp at levels 1/10/20/30 with the training sword: 4, 4, 4,
5, 4, 4 hits at every level), before weapon skill (+1 %/skill level) and
gear. Player health grows a little faster than enemy damage (12 % vs 6 %),
so a levelled character survives more at level. Being over-levelled is
felt: a level-12 character kills level-4 commons in 3 hits (brute: 4)
instead of 4 (5). Being under-levelled is felt the other way: a level-1
character in a level-10 area faces 1.9x health and 1.54x damage.

**A level-up is a moment.** The zone refills health and stamina, sends 604
as before and 900 `character_stats` (reason 1); the client shows a
fanfare (big "Level N", the exact gains, unlocked tiers, a short
synthesized chime) and the character panel (C) lists level, XP to next,
stats, the area you stand in, what the next levels give and unlock, the
spells a skill point can learn right now (Light first: "kills demons"),
and weapon skills with their next technique. A new character has 2 skill
points: Glint (Light, tier 1) is learnable from the first minute, which
answers "where do I get Light magic" without a quest.

**Stamina** lives in the shared movement step (WP10), so it changes the
movement state's `StaminaMax`; it rides `SelfState` and the client's
prediction now also compares it (one zero-distance replay when it
changes). Bots that never level never see a change.

**No stat-point system.** Spec 8's skills grow by use and level gives
"health and spell skill points"; a second point currency would fight that.
Skill points (and the new tier gates) are the choice a level gives.

## Decision 4: the crystal attunement

Climbing a tower still unlocks it the moment you stand on top (WP12: map
reveal, fast travel, 150 XP). The crystal there now asks to be **attuned**
(Interact 10 action 2, server-validated: you must stand on that tower's
top). The first attunement of each tower gives a permanent boon, derived
from the set of attuned towers (`character_progress.attuned`): +8 stamina
(spec 8: "stamina upgrades come from rare finds at towers"), +5 health,
+1 skill point, +100 XP. The zone sends Event 902 `tower_attuned` (tower
site, region, crystal position, region name): the documented hook the
`pt/ux` branch's location-discovery intro can listen to. The client shows
"Climb to the crystal to reveal this land" within 45 m of an unclimbed
tower, "[E] Attune to the crystal" (with the boon) on the top, and a
notice after.

## Alternatives considered

- **Scale enemies to each player** (no stamps): a shared world where a
  level-2 and a level-20 friend see different enemies breaks parties and
  loot, and contradicts "the areas you discover are free to shape into
  harder challenges".
- **Stamp in the generator** (genVersion bump): every world would need a
  re-mint and the stamp depends on who arrives, which is not a function of
  the seed. Golden hashes stay unchanged.
- **Stamp per region (1024 m)** or **per chunk (64 m)**: see Decision 1.
- **Hide demons until the player owns sunsteel/Light**: per-player rules for
  shared monsters again; the tier rule keeps nights readable for everyone.

## Gaps and follow-ups

- Container item levels (WP14 chests) still use region danger, not the
  stamp.
- Kill XP is not reduced for enemies far below the player (farming slimes
  at level 10 still pays 10 XP each; the curve makes it slow, not zero).
- A town's defense event checks the tier where the town stands; a town on
  an area border uses its centre.
- The Haven is a circle around the atlas spawn; worlds whose spawn sits on
  a border of several towns get the same 420 m regardless of town size.
- Spell slots are not level-gated (4 from the start, WP13).
- Tier names and slime names are proposals for Nicole.
