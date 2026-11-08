# 0020: Towns, roads and structures (WP20)

Date: 2026-11-08

## Towns are a second pure function of the atlas, in the pinned wasm

Spec 5 puts towns and structures in the pinned generator ("terrain, caves,
towns, structures and placement live in the pinned wasm"), generated "at
mint as part of the atlas". The atlas buffer itself could not grow without
changing its hash (and the official world's pin), so the towns are a new
export, `towns_build(atlas)`, computed from the atlas by every host (client
worker, zone, bots), cached per wasm instance, golden-tested in Node,
Chromium, Go/wazero and native Rust. Cost: ~0.1-0.7 s native, 0.15-1.05 s in
wasm for a whole v1 world (budget 60 s); ~0.5 MB raw. Clients build it in a
worker during load rather than downloading it: the bytes are identical, and
nothing world-shaped goes over the wire (spec 4).

## Buildings collide through the WP09 level-ground hooks, not the heightfield overlay

WP12's overlay is a heightfield (`max(terrain, structures)`), which cannot
have interiors. Buildings instead are oriented boxes with a flat or
u-sloped top, queried through the two hooks WP09 added to the movement
step: the ground viewed at the player's level (a box top within one step,
0.6 m, of the feet is floor: floors, porches, door ramps, bridge decks,
roof halves) and a push-out pass (a solid box whose top is above the step
and bottom below the head, 1.9 m, pushes the 0.4 m body circle out; a
ceiling box lowers a jump). So you walk in through doors, stop at walls and
furniture, stand on roofs after a glide, and cross bridges, with no change
to the movement code.

- Walls are not climbable (they are not in the height function), like cave
  walls; mantling onto town walls happens only from above.
- Bit-identical TS (`worldgen/js/src/town.ts`) and Go (`server/pkg/towns`):
  f64 over f32 box values, same operation order, every box carries its
  cos/sin from the generator (no host trig), `float64()` around products in
  Go. 1,750 floor + 1,750 collide golden vectors replay bit for bit.
- Walkable tops higher than a step are hard edges where the known last-ulp
  `sin`/`cos` difference between V8 and Go (WP02/WP10 caveat: input yaw ->
  direction) can flip WP10's climb grab. Measured: jumping onto a walkable
  well produced 8-10 corrections of up to 6 cm. So furniture taller than a
  step and town props (well, board) are solid only; beds, chests and rubble
  stay walkable. After that change the walk-into-buildings acceptance shows
  0 corrections, max 0.83 cm (cm quantization only).
- The zone's ground wraps the cave terrain by embedding (`townCaveTerrain`
  in `server/zone/towns.go`), so the game's interface assertions on the
  ground (chunk interest, spawns, caves) keep working; the client exposes
  `WorldRuntime.caveGround` for the same reason.

## Roads are drawn, not cut (genVersion 1)

See CR 007: cutting roads into the heightfield changes chunks. Roads are
least-cost paths on the macro grid (slope, water, biome costs; reuse of
existing roads makes forks), smoothed and clipped at settlement edges where
streets continue; bridges are collision boxes. Signposts at forks point at
the nearest settlement along each road; lanterns line roads near towns.

## Layouts: required first, refined on the real terrain

Square around the waypoint stone, streets continuing the roads (topped up
to 2/3/4), a ring street in villages and towns, frontage plots both sides
of every street and around the square. Inn, forge and ward garden first
(the square first for inn and forge), then houses / farms / workshops /
storehouses to a seeded target in the spec's range; plots must be dry and
under a 1 m terrain-range tolerance that relaxes in passes, with back-lane
plots as a second row; settlements under their minimum get extra houses.
Board, stalls and well take the square's ring in priority order, clear of
street mouths and of square-facing doorways. Towns get walls with gate
towers. Every settlement on six test worlds has inn, forge, stall, garden,
board, well, merchant, blacksmith, innkeeper and bounty keeper and a
building count inside the spec's range (`worldgen/tests/towns.rs`).

## Kits and the shape grammar

Six styles by biome (cottage, timber, stone, log, adobe, stilt). The
generator decides the parameters (footprint, floors, roof kind and ridge,
pitch, door, porch, chimney, stilts, jetty, interiors from per-role
furniture sets) and the collision; renderers assemble meshes from the same
record with one shared texture atlas, so collision and visuals derive from
the same numbers and a town draws in a handful of calls.

## Jigsaw structures on a 6 m grid

Typed open/closed edge connectors, breadth-first from a kind anchor,
weighted pools per kind, budget by tier and `structureDensity`, cells must
be dry with < 3.5 m relief. Simple and deterministic; paving is drawn on
the terrain and only solid parts collide. Mineshafts link to the nearest
cave mouth (the zone's winch teleports into a chamber of that system below
the shaft: the shaft itself is not carved, which would change cave output).
Meteor craters carry starmetal clusters through WP09's `crater_veins` hook.

## NPCs: generated people, zone-side schedules

The generator fixes who lives where (stable ids, homes, work spots, names);
the zone (`server/zone/internal/npc`) runs schedules (work 07-19, farmers
06-18, innkeepers and guards always), walks them along a street graph
through doors (0 of 15,206 walk samples inside another building on the
official world), and only spawns a settlement's NPCs as snapshot entities
while a player is within 200 m of its edge (dropped beyond 260 m). Dialogue,
wares and seeded daily bounties are zone game logic (free to change). The
NPC clock is the zone clock (Unix seconds mod 3600 + an offset) until WP15
owns world time; the client's sky clock is not synced to it yet.

## Assumptions

- Every settlement gets the full required set (inn, forge, market stall,
  bounty board, ward garden, waypoint stone), hamlets included, so the
  spawn settlement always has a forge and an inn (G4).
- Stalls and ward gardens do not count toward the spec's building counts.
- Bounty acceptance lives in zone memory per character (max 5); completion
  is the hook for WP13/WP14/WP15 (`Server.AcceptedBounties`,
  `Server.CompleteBounty`). No migration.
- Purchases grant through WP09's `Granter` hook with placeholder item ids
  and no currency (WP14).
- Resting at an inn heals to full.
