# CR 056: Line of sight for monsters (playtest 5, `pt5/mob-walls`)

Nicole: "mobs can attack you through walls and that shouldn't be: that they can
see you, or that they can get damage through the wall, or the projectile
makes it."

Server-authoritative (`server/zone/internal/combat/sight.go`, used by `ai.go`
and `validate.go`) plus one client Event handler. One new Event (1990, range
1990-1999). No Interact, protocol, migration or worldgen change.

## Cause

Enemy AI knew three things about a target: distance (`acquire`: aggro range),
the nav grid (it paths round a wall when its straight step is refused) and the
heightfield (an enemy shot ended when it dipped under the ground). Nothing
asked "is there a wall between us":

- `acquire` and `chase` used distance only, so a wolf 12 m away behind a house
  noticed the player, woke, chased and (a melee bite has 2-3 m reach) bit
  through a thin wall.
- `strikeArea` queued a strike on every player inside the area shape.
- `stepShots` only tested the heightfield, so arrows and bolts flew through
  town walls, base pieces and cave rock.
- The players' own ranged claims (`validate.go` `clear`) only tested the
  surface heightfield (and, underground, that test read the surface above you
  as a wall).

## The query

`World.rayClear(a, b)` steps along the segment every 0.35 m (with a 0.15 m body
radius, so a 10 cm wall cannot be stepped over) and asks, per sample (`solidAt`):

| geometry | how it is known |
|---|---|
| terrain, the CR 040 edits overlay, structures | `ground.HeightAt` above the sample (0.3 m slack for sight, none for shots) where the point is on the open surface |
| cave rock, the Underground and Depths floors and ceilings, island bodies | `CaveTerrain.Sight` (`server/pkg/worldhost/caves.go`): `caves.Rock` in caves, `LayerHeight` floors and ceilings in the vertical layers; there the surface heightfield does not apply |
| town building walls and furniture, dwarven halls, sky palace walls | `World.Obstacles` (town boxes: `towns.Blocker`) |
| closed doors | `World.Obstacles` (open doors are no wall) |
| a player's base pieces (CR 041 collision twins) and solid camp pieces | `World.Obstacles` (`camps.Set.Blocked`) |

A box blocks when it rises above the sample and starts below it, so a counter
or a chest is seen over, a wall is not. A look from an enemy goes from its eye
to the player's chest, then (if blocked) to the head: either clear is a yes.
Endpoints are not tested (a body against a wall is pushed out of it).

## Where it is used

1. **Perception and aggro.** `acquire` only picks a player the enemy
   *notices*: sees, or hears (within 7 m, same floor). `chase` keeps
   `lastSeen`; a target not noticed for 6 s is dropped (another target, else
   Return). While the enemy has asked for a nav path (its straight way was
   refused) the memory is 25 s, so it still walks the path round the house. A
   chaser that cannot see its target no longer winds up (`!sees`): it
   `moveToward`s on the nav path instead of standing at the wall swinging.
2. **Melee and area attacks.** `strikeArea` queues no strike on a player a wall
   hides from the strike's centre (the enemy for a swing and a charge, the
   aimed spot for a ground blast). Bosses, packs and demons use the same code.
3. **Enemy projectiles.** Each half-tick step of a shot is a segment tested with
   `rayHit` (no slack); the shot ends where it enters a wall, rock or ground and
   sends **Event 1990** `shot_wall` (shooter, attack id, impact) to players within
   70 m. The client (`runtime.ts` -> `fx/engine.ts enemyShotWall`) ends the
   drawn shot nearest the impact there with its impact puff (`fx/shotWall.ts`).
4. **Players' ranged claims.** `validate.go clear` is the same query, so a bow
   or a bolt claimed through a wall is `RefuseLOS`. Melee claims keep reach as
   the check (`needsLOS`: no check within 6 m), so the shared basic attacks are
   unchanged.

## Cost

An enemy memoises its look at one player (two players) for 6 ticks (0.2 s),
per enemy so the AI workers (par.go) share nothing. Strikes and shots are rare
and unmemoised. A world with no wall near answers each sample with a heightfield
read and a bitmask read (`towns.Blocker.Near`). `World.NoSight` turns the rules
off (tests that force a target across a wall, an operator A/B switch).
`BenchmarkSight*` in `sight_test.go`: a 20 m ray costs 0.2-1 us; 500 chasing
wolves in the open, a whole `Step`: about 100-130 us with or without it.

## Tests

`internal/combat/sight_test.go` runs every rule against four geometries (town
wall, base wall, cave rock via a `Sight` ground, open field): the query, a
terrain ridge and a 10 cm wall, noticing, hearing, losing a target, melee, the
strike area, a ground blast, projectiles (and the event), the players' claims
and the memo's throttle. `internal/game/sight_test.go` on the official world:
a real house of the spawn town with its door shut, a `wall_wood` base piece
(removed: clear again) and the deepest chamber of cave system 0 against the
surface above it. The pathfinding tests set `NoSight` (they force a target
across a wall; they test the path, not the perception).
Real client: `client/src/combat/dev/mobwalls-shots.ts`.

## Not done

- A shot's wall check uses the half-tick segment; a shot faster than ~120 m/s
  would still be tested (samples every 0.35 m) but not at sub-sample thickness.
- Windows and arrow slits are not modelled: a building's box is solid.
- Pet and ally bolts (CR 020, `bolts`) and summon attacks use their own paths
  and are not stopped by walls here; PvP hits are unchanged.
- Hearing is a flat 7 m (no fog or storm scaling, no stealth).
