# CR 020: new spell mechanics (playtest 2)

Nicole, playtest 2: "borrow from elden ring and other sources for interesting spell mechanics. like we could have spells that heat-seek towards the target, or spells that summon apparitions or whatever. anything." and "add spells with faster fire rates, full auto just hold it down spells. for example one could be sparks, or bubbles. or bullet rain."

Genre ideas, original names and visuals. Every mechanic is a generic, data-driven block on a spell in `contracts/combat.yaml` (any spell may carry it; the generator validates it), so new spells are one line each.

## Mechanics

| Block | What it does | Who decides |
| --- | --- | --- |
| `homing: {turnDegS, acquireM, coneDeg, delayMs, loseDeg}` | A projectile that flies straight for `delayMs`, then locks onto the nearest valid target within `acquireM` inside a `coneDeg` cone around its nose and turns toward it at up to `turnDegS` (speed kept); it loses the lock for good when the target falls more than `loseDeg` off its nose or dies. Volleys (`spread`) fan out first, then curve in | The client flies it in fixed 1/60 s steps with the shared step (`client/src/combat/spellsim.ts`) and claims what it hits. The zone re-flies the same steps (`spellsim.go`, a line-for-line twin pinned by golden vectors) from the logged cast (position, yaw, pitch, each orb's fan offset) against the claimed target's recorded positions at a few render lags, and accepts the claim only if a path reaches it (or the ordinary aimed-projectile check passes). Each orb hits a target once |
| `auto: {rateHz, manaPerShot, jitterDeg}` | Hold to fire: the cast starts a stream, one shot every `round(60 / rateHz)` steps (at most `AUTO_MAX_RATE_HZ` = 15/s) while the key is held and mana lasts; each shot costs `manaPerShot` and leans off the aim by a seeded pattern. `cooldownMs` is the pause after letting go | Both sides run the same schedule (timeline.ts / `stream.go`): the cast step logs ONE action; each shot is recorded where the player stood and looked; a claim names the shot by its nominal seq (`attackSeq`), so each bullet is validated, hit-limited and crit-rolled on its own. Ready again one interval after the last shot or `cooldownMs` after the release, whichever is later: no tap, re-press or hold pattern beats the rate |
| `rain: {radius, height}` (with `auto`) | Each shot falls from `height` m above a seeded point within `radius` m of the aim point | Same stream rules; the claim's burst point must be within range of where the shot was fired |
| `charge: {maxMs, damageMult, radiusMult, speedMult}` | Hold to empower: the cast pays and starts gathering; the release fires it with damage, burst radius and speed scaled linearly up to `maxMs` | The release frame (no channel bit) logs the action at its seq with the held fraction; an attack, dodge or cast while gathering cancels it (mana spent) |
| `orbit: {count, radius, periodMs, hitEveryMs, orbRadius}` (type `orbit`) | Orbs circle the caster for `durationMs`, each touch hurting, one target at most every `hitEveryMs`, `hits` in all | The client hits from the shared orb positions (`orbOffset`); the zone checks the claimed orb point sits on the ring around one of the caster's recent positions, touches the target, and the per-target rate |
| `detonate: {delayMs, radius, damage, status}` | A hit plants a charge that bursts `delayMs` later around the target | The zone's own hits (no claims): scheduled at the accepted hit, at most 3 live per target |
| `detonate: {onDeath: true, mark, radius, damage, status}` | A hit brands the target (`statuses.brand`); a branded enemy that dies bursts, and the burst can kill other branded enemies, which burst in turn (a chain reaction) | The zone's own hits |
| `summon: {key, count, max}` (type `summon`) | Calls `count` allies from the new `summons` table for `durationMs` | The zone (below) |

### Summons

`combat.yaml summons`: `{id, family, behavior (melee | ranged | turret), element, speed, size, color, aggro, keepAway, leashM, attack: {shape: melee | bolt, reach, damage, everyMs, windupMs, speed}}`. An ally is a zone-side combat body owned by its caster (`server/zone/internal/combat/summon.go`), built on the Enemy struct so it reuses the enemies' steering (`stepMove`: terrain, water, cliffs, buildings and doors) but kept out of the enemy tables: claims, enemy AI, camps, night, quests and bots never see one. It picks the nearest living enemy within its aggro range and the caster's leash, walks into reach (a ranged one keeps `keepAway`, a turret never moves), winds up briefly and strikes; a bolt lands when it would arrive. Damage = its attack x the caster's spell scaling (loadout spell power, spellcraft, gear spell power, level), elements; kills and XP are the caster's, Light allies sear demons (WP15). It attacks a player only when the game layer's PvP rules let its caster hurt that player (`World.SummonPvP`, `internal/game/summons.go`: both flagged, not one party, no safe zone, or the two duelists), at PvP damage, with the duel and kill-feed bookkeeping a player's own hit gets. Enemies ignore allies (apparitions take no damage). An ally leaves when its time is up, its caster goes down, leaves the zone or runs beyond `leashM`; past `summon.max` of a kind or `SUMMONS_PER_PLAYER` (3) in all, the oldest leaves.

## The new spells

| Spell | Element | Tier | Prereq | How it plays |
| --- | --- | --- | --- | --- |
| Cinder Spray | Fire | 1 | Ember Flick (known at start) | Hold: a spray of sparks, 12/s, 4 damage each, 2 mana a shot, 18 m |
| Pyre Brand | Fire | 4 | Fireball | A fan of three brands; a branded enemy that dies bursts for 50 (4 m) and sets the rest burning; packs chain |
| Frost Bubbles | Ice | 2 | Frost Bite (known at start) | Hold: drifting bubbles, 8/s, that pop for 5 in 1.3 m and slow; 2.5 mana a shot |
| Hungering Souls | Dark | 3 | Void Tap or Hex Bomb | Four souls fan out wide, hunt for 0.2 s later, 15 each, 30 % lifesteal |
| Wraith Hound | Dark | 4 | Hungering Souls | A spectral hound for 15 s (up to 2): bites for 13 every second |
| Boulder Heave | Earth | 3 | Spore Pod or Geode Bomb | Hold to grow a boulder for up to 1.2 s: 40 -> 110 damage, 1.6 -> 2.8 m burst, faster and farther |
| Burrowing Seed | Earth | 4 | Boulder Heave or Bramble Burst | A seed that burrows in and bursts 1.5 s later for 60 in 3 m, stunning |
| Arc Sparks | Lightning | 2 | Spark Jab | Hold: 15/s crackling sparks, 4 each, shock; 1.6 mana a shot |
| Storm Seekers | Lightning | 3 | Lightning Strike or Arc Sparks | Three orbs fan out 50 deg, then after 0.3 s curve onto targets: 22 each, shock |
| Whirling Blades | Wind | 3 | Gust | Three blades orbit you for 8 s, 9 per touch, a target every 0.4 s |
| Gale Phantom | Wind | 4 | Whirling Blades or Razor Wind | A phantom archer for 12 s: keeps 9 m away, wind bolts for 11 |
| Guiding Motes | Light | 1 | none (a root node) | Two motes that find their own target: 12 each, 0.7 s cooldown, 10 mana |
| Sunlit Sentinel | Light | 5 | Sunburst or Guiding Motes | A crystal turret where you aim for 10 s: light bolts for 9 every 0.6 s, sears demons |
| Starfall Hail | Void | 3 | Rift Shot | Hold: hail falls around your aim point, 10/s, 9 in 1.2 m each; 3 mana a shot |

Early finds (a new character has one skill point at level 1, tiers 1-3 need no level): Cinder Spray (tier 1 off the starting Ember Flick), Frost Bubbles (tier 2 off the starting Frost Bite) and Guiding Motes (a tier-1 root of the Light tree) are learnable on the first skill point. Names are proposals (`combat.yaml pending`).

Balance (damage per mana and per second, before scaling): Cinder Spray 48/s for 24 mana/s (2.0 per mana; Ember Flick 2.2, but you must re-press it); Arc Sparks 60/s for 24 mana/s; Frost Bubbles 40/s single target, more in a crowd; Starfall Hail 90/s spread over 4.5 m for 30 mana/s. Streams drain a level-1 pool (100 mana, 11/s regen) in 6-8 s of holding: bursty, not free. Homing trades damage for reliability (Guiding Motes 34/s if both land). A Wraith Hound deals ~195 over its life for 28 mana; the cooldowns keep allies from stacking past the caps.

## Contract

- `contracts/combat.yaml` v5: the blocks above on spells, types `summon` and `orbit`, the `summons` table, the `brand` status, 14 spells in the trees, their names (pending). Generated into `COMBAT` (`SpellDef.homing/auto/rain/charge/orbit/detonate/summon`, `SummonDef`) and `combatdefs.D` (`Spell.Homing...`, `Summon`, `SummonByKey`, `SummonTypeID`).
- `contracts/constants.yaml`: `SUMMONS_PER_PLAYER` (3), `AUTO_MAX_RATE_HZ` (15).
- `contracts/protocol.yaml`: `InputFlag.channel` (bit 14): HELD while a stream's or charge's key stays down after its cast step. A step without it, or with attack / dodge / cast, ends the stream or releases the charge. Held, not one-step, so `fillGap`'s repeated frames keep it. Old zones ignore the bit and old clients never set it: the protocol version stays 5 (bumping it would kick every open client of the deployed playtest; the golden protocol vectors are unchanged).
- `contracts/events.md`: Events 223 `channel` (stream / charge start with its seed, stop with the shot count), 224 `detonate`, 225 `summon_attack`; Event 214 for a released charge appends u8 the held fraction; Interact 50 action 7 (learn any spell like a tome, dev builds only, for evidence runs). Allies travel as EntityKind `effect` (7) with typeId = summon id | (element + 1) << 8 and health % = the time they have left.

## Wire cost (the 150 kbps downlink)

- A stream is two reliable Events per player within 64 m (start with a 32-bit seed, stop), however long it runs: observers simulate the shots from the seed (same jitter and rain points as the caster) and the caster's drawn aim. No event is sent per shot to anyone: a stream shot's damage sends no observer Event 200 either (the caster still gets its HitResult; health bars move through snapshots). Holding Arc Sparks for 5 s against a pack: 2 Events to each observer instead of ~75 casts + ~75 damage events.
- An ally is one ordinary entity in snapshots (like an enemy) plus Event 225 per attack (about 1/s per ally, max 3 allies per player).
- Bursts are one Event 224 each plus the usual damage events.
- Nothing new is sent to or by a player who never uses these spells: the G5 scale scenario's wire digest is unchanged (below).

## Anti-cheat

- Stream rate: the zone fires shots on its own schedule from the logged start and refuses claims for shot seqs it never fired (between shots, beyond the last shot, or when the stream ended for want of mana); `mechanics_test.go TestStreamCannotBeatItsRate` drives tap / release / re-press / spam patterns and never gets more than `steps / interval + 1` shots.
- Each shot hits each target once and one target (four for a bursting shot); a homing volley hits a target once per orb, and only orbs whose re-flown path reaches it.
- Allies and bursts are the zone's own hits; a claim on an ally is refused (it is no enemy), a summon spell cannot be claimed.

## Performance (G5)

Measured with `go test ./server/zone/internal/game -run XXX -bench BenchmarkScale -benchtime 1x` before (main b6c4553) and after: see docs/STATUS.md "Playtest 2: new spell mechanics". The scale scenario's bots never cast these spells, so its per-tick work only gains two empty-slice checks (`stepSummons`, `stepBursts`); a homing claim's re-flight is at most ~1,800 cheap steps, run only when the plain aimed check fails.

## Consumers

- Zone: `server/zone/internal/combat/stream.go` (streams, charges, shot lookup), `spellsim.go` (the shared simulation), `validate.go` (`claimable`, `judge`, `shotGeometryOK`, `orbitGeometryOK`, `homingReach`, charge scaling), `summon.go`, `detonate.go`, `actions.go` (Events 223, 214 + charge), `internal/game/summons.go` (entity names, PvP rules), `combat.go` (allies as EntityKind effect).
- Client: `client/src/combat/spellsim.ts`, `timeline.ts` (streams, charges, held keys, `InputFlag.channel`), `runtime.ts` (per-shot prediction and claims, rain, homing on the 60 Hz step, orbits, Events 223-225), `fx/engine.ts` (steered seekers, remote streams from their seed, charge gathering, orbits, bursts, ally bolts, small pops for stream bursts), `CombatLayer.tsx` (spectral allies with a time-left bar), `net/avatarAnim.ts` (`classifyChannel`: a stream or charge holds the casting pose), `audio/triggers.ts`, `ui/skills/tree.ts` (tooltip lines for each mechanic).
- Tests: `server/zone/internal/combat/spellsim_golden_test.go` (replays `client/src/combat/golden/spellsim_golden.json`), `mechanics_test.go`, `server/zone/internal/game/summons_test.go`; `client/src/combat/spellsim.test.ts`, `mechanics.test.ts`, the fx and skills suites.
- Evidence: `client/src/combat/dev/mechanics-shots.ts` -> `docs/evidence/pt2-spell-mechanics-*.jpg`.

## Not covered

- Allies do not cross zone borders (they leave with a caster who changes zone) and are not saved.
- Enemies do not attack allies (by design: apparitions); a later CR could give allies health and threat.
- A stream's observers draw it from the caster's snapshot yaw/pitch (8 bits each), so a remote stream points within ~1.4 deg of where the caster aims; the caster's own view and the zone's validation use the exact aim.
