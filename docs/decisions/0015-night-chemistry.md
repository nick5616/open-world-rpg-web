# 0015: Night, demons, weather and chemistry

Status: accepted (WP15) · Date: 2026-11-08 · Contract: docs/cr/011-wp15-night-chemistry.md

## Context

Spec 8 wants day and night with a seeded moon, demons that regenerate and
die only to sunsteel, Light or sunrise, ward gardens and town defense
events, and a chemistry engine whose fire spreads on the shared wind
field, makes updrafts, and is synced as events with a bitmap fallback
"behind one interface". Spec 9 wants all of it inside the bandwidth and
tick budgets; WP16 wants it identical across zones.

## Decisions

1. **One world clock: wall clock + the world's offset.** World time =
   `serverTimeMs / 1000 + offset`; the offset is world configuration
   (`LODESTONE_ZONE_TIME_OFFSET_S`, the same env on every zone of a world),
   announced to clients in Event 500. Day, night, moon phase (seeded 8-night
   cycle: `(night + hash(seed)) mod 8`, 0 = new moon), rain (WP10's seeded
   windows, unchanged) and the chemistry wind are pure functions of world
   time and the seed: `server/pkg/weather/clock.go` and
   `client/src/systems/clock.ts`, pinned by shared vectors. The zone's NPC
   schedules (WP20), demons and rain, and the client's sky, rain and wind
   all read it. No per-process state, so zones agree (WP16). The dev
   "set time" Interact is per zone and dev-only.
2. **Night window**: demons rise at 18:30 (the sky's sun crosses the
   horizon at 18:00) and burn at 06:00. Night n runs from dusk of day n to
   dawn of day n + 1, so a night has one index and one moon.
3. **Demons are WP13 enemies** (`family: demon`), not a new entity kind:
   AI, telegraphs, strikes, lenient validation, snapshots, the client's
   enemy drawing and the bots' targeting all work unchanged. The protocol's
   reserved `EntityKind demon` stays unused.
4. **Regeneration model** (since CR 048 this is the high-level demons' model:
   level 15+, lords and story demons; weaker demons take lasting damage from
   ordinary hits, 50 % from level 8): health = max − seared − wounds. Ordinary damage
   adds wounds, which close at the rank's regen rate (35 % / 25 % / 15 % of
   max per second) and can never take the last point; killing damage
   (sunsteel, sunsteel arrows, Light spells and form) adds seared health,
   which never heals; death only when seared reaches max. So softening a
   demon with steel does not help the sunsteel (tested). Ordinary hits
   stagger (interrupt the wind-up, knock back) at most every 1.2 s; lords
   don't stagger. Sunrise kills without credit (no XP, no loot); demons
   within 25 m of a lair or cave mouth flee instead.
5. **The demon rule is one key** (`combat.KillsDemons`): the loadout's
   weapon material `sunsteel` (`killsDemons` in `combat.yaml materials`),
   a sunsteel arrowhead, or a `killsDemons` tree/form (Light). WP14 sets the
   material from the forged item; dev builds set it by Interact.
6. **Spawning**: every 5 s at night, each player in the open (not in a
   ward, not in a cave, not downed) is topped up to
   `round(4 × moon × intensity / 0.5)` lesser demons within 80 m, rising
   34-58 m away on dry walkable ground outside wards and lanterns, in a
   seeded direction; a greater demon by the region's element now and then
   (12 % × scale per top-up, at most one within 140 m); on new-moon nights a
   lord at each demon lair when a player comes within 220 m (announced to
   everyone). Night groups are tracked separately from camps and removed
   when cleared or despawned, so they never respawn as camps.
7. **Wards**: a settlement's ward is its radius + 10 m. Demons can't step
   into an active ward (the `Blocked` hook in the enemy step) and ignore
   players inside one (`Sheltered`); lesser demons won't step within 5 m of
   a road lantern (WP20's lantern props). Players in a ward get no hunters.
8. **Town defense events**: per town per night a seeded roll
   (`0.18 × moon × intensity / 0.5`) starts one 1-4 in-game hours after dusk,
   if a player is within the town radius + 160 m (else it is skipped). 15 s
   warning, 3 waves (3 + 2w lesser, +2 per extra defender, a greater demon
   on the last), from 2-3 seeded gates on the ward's edge, walking for the
   ward garden (WP20's garden building); 12 s lulls. During the event the
   ward is weak (demons may enter). Demons at the garden damage it (12 /s
   each, 1000 health). Ends **held** (all waves dead, or dawn with the
   garden alive: XP 100 × waves to every participant), **broken** (garden at
   0: the ward stays down and demons roam the town until dawn), or
   **abandoned** (nobody near for 30 s). Plans are seeded per (seed, town,
   night), so zones agree.
9. **Chemistry grid**: 2 m cells (2048² over the world), materials derived,
   never sent: water where `water_height > collision_height + 0.05`,
   nothing in settlements (atlas node flag), else a seeded mix by biome that
   stands in for the biome's scatter density (meadow 72 % grass, forest 40 %
   brush + 40 % grass, highlands 50 %, badlands 38 % scrub, wetland 55 %
   damp, snow none). Using the actual scatter records would need the
   client's main thread to hold every chunk's scatter; the biome mix keeps
   the material function a pure lookup that both sides compute bit for bit
   (heights are already bit-identical, WP07/WP10). Recorded as a gap.
10. **Deterministic fire**: 5 Hz steps; per step, ops due, timers (burn
    out ~16-24 s, ice thaws at 60 s, scorched ground regrows after an
    in-game day), fire next to ice melts it, rain douses (4 % per step) and
    cuts spread by 5×, then each burning cell rolls for each fresh flammable
    neighbor: `hash(seed, step, from, to) % 1000 < base × windMult / 100`
    (×0.7 diagonally), `windMult = clamp(100 + (offset · windDir) × {35, 65,
    95}[strength], 15, 400)`. The wind is the WorldSpec prevailing
    direction veering ±1 sector every 120 s with a seeded strength; the
    client also drives the grass shader's wind from it (one wind field).
    Everything is u32 hashing and integer maths on cells and steps, so the
    result is a set independent of iteration order and language.
11. **Sync events, not results**: the zone schedules every op 3 steps
    (600 ms) ahead and broadcasts it to clients within 256 m; clients run 2
    steps behind their clock estimate, so ops arrive before they apply even
    at 1 s of RTT. Late ops apply at the next step and are counted. A client
    coming in range of a chunk with fire, ice or scorch gets that chunk's
    full state (Event 524) and applies it exactly at its step. The fallback
    is 2 Hz 2-bit bitmaps per active chunk (Event 525), chosen per client
    (`?chem=bitmap` → Interact 51/10) or for everyone
    (`LODESTONE_ZONE_CHEM_SYNC=bitmap`). Both paths implement the client's
    `ChemView` (renderers, ground, updrafts never know which one feeds them);
    the zone side is `chemInterest` vs `chemBitmaps`.
12. **Movement coupling without touching the step**: fire feeds WP10's
    `UpdraftField` (7 m/s up to 40 m over any burning cell of the 3×3 block
    under you); ice sheets (walkable at the water surface) and pillars
    (3 m top, 6 m high, 80° walls: climbable by WP10's rules, like towers)
    are a ground overlay on both sides (`chem.Ground` / `ChemGround`) that
    is a pass-through when there is nothing to add, so every movement golden
    is unchanged. The client applies them 2 steps after the zone (decision
    11): a player standing exactly where a pillar rises or ice forms may see
    one correction.
13. **Server authority**: burning cells set enemies alight (burn status,
    no credit), burns landing on enemies ignite the grass under them, Fire
    spells/forms ignite where they land (the zone marches the aim ray or the
    ballistic arc itself; no client message), Ice freezes water and puts
    fires out, Bramble Burst / Crystal Spire raise pillars; lightning on an
    enemy standing in water in the rain arcs at half damage to others in the
    same water. Fire never damages players (no PvP, and no environmental
    player damage in v1).

## Consequences

- No protocol change; ~0-3 KB/s of extra reliable traffic near a big fire on
  the event path, ~25 kbps per client per 6 active chunks on the bitmap path.
- Fire state is not persisted (minutes long; regrowth one in-game day); a
  zone restart forgets fires.
- See docs/STATUS.md "WP15" for gaps.
