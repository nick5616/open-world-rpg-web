# 0022: Towns on natural terrain, footpaths and density (playtest 1, genVersion 2)

Date: 2026-11-09 · Branch `pt/towns-density` · Contract notes: `docs/cr/014-towns-terrain-density.md`

Nicole: "terrain in non-castle-towns shouldnt be flat. it should be more
disheveled and houses built on foundations and paths to get everywhere.
also the game feels a little too spread out and spacious, even in the
towns".

## A new generator major version, not a patch to genVersion 1

Un-levelling hamlets and villages changes chunk heights, which spec 5 rule 4
says is a new `genVersion`. WP09 and WP20 avoided that by adding exports;
here the change *is* the terrain. So `GEN_VERSION` is 2, the genVersion 1
build is archived (`worldgen/archive/`, its table `golden-v1.json`), and
`npm run test:golden` checks both. The golden diff was reviewed before
`golden:update` with `worldgen/golden/review.ts`: across the 5 golden
worlds every genVersion 1 site is kept at the same index with the same id,
and **0 golden chunks away from hamlets and villages (or at walled towns)
changed height** (`docs/evidence/pt-towns-golden-review.txt`).

## Keep every old site where it was

The density pass runs **after** the coverage pass and only appends sites.
Placing more settlements earlier (a smaller spacing in step 1) would have
moved every tower, cave and structure and renumbered every site; appending
keeps the official world recognisable (same towers, caves, roads between
the old towns, same spawn) and keeps per-character progress valid, since
towers, waypoints, discoveries and attunements are bitsets by site index.
That is what makes an in-place world renewal possible (below).

## Foundations, not terraces

Two ways to build on a slope: cut and fill the terrain under each lot, or
stand the building on the slope. Cutting would put town geometry into the
height function (chunk generation reading the towns layer, or the towns
layer becoming part of the atlas) and leave every lot as a flat shelf, the
look Nicole asked to get rid of. Standing on the slope only needs what WP20
already had: a floor box from below the lowest ground to the floor on the
highest lattice point. genVersion 2 classifies the foundation by the
relief under the lot (plinth < 0.9 m <= stepped < 2.2 m <= posts) for the
renderer, adds a porch deck for doors high above the ground and turns the
door ramp into steps above a 0.55 m rise.

- The porch deck became `walk | solid`: on a slope it stands 1-3 m above
  the ground and, walkable only, you walked through its side. Its top is
  flat, so standing on it never reads as a wall (the push-out tests a box's
  highest top against the feet).
- The steps stay a walkable-only ramp: a sloped solid box is a wall to
  someone on its lower end (same rule). They are drawn as treads whose
  nosings sit on the walkable slope.
- Stilt houses may stand in up to 1.8 m of water (wetland hamlets on
  natural ground are wetter).
- Lots reserve room in front for their porch and steps; on a street the
  steps may run over the lot's 0.5 m front gap and a quarter of the street,
  a back-lane lot keeps the whole flight plus room for the path.
- Agreement: WP20's walk-into-a-building and pt/ux's door walk-through on
  the six most demanding sloped buildings of the official world (posts,
  stepped plinths with porches, the tallest steps: up to 3 m): **0
  corrections, max divergence 0.84 cm** (cm quantization), every door
  blocks on both sides (`docs/evidence/pt-towns-sloped-walk.txt`).

## Footpaths are drawn, not levelled

Paths follow the ground like WP20's roads and streets: a ribbon on the
collision surface, no chunk change, no collision change, so prediction and
the zone agree by construction. Levelling them ("gently levelled only
along the path if needed") would again need town geometry in the height
function; at walking scale a path over natural ground reads as worn earth,
which is the disheveled look asked for. Routing is a multi-source Dijkstra
per settlement on a 1 m grid with integer costs and index tie-breaks
(deterministic, golden-hashed with the towns buffer); traces join earlier
paths so paths branch rather than run side by side. NPCs (zone) walk the
footpath of a back-lane building instead of cutting through its neighbour.
Most front-row doors open straight onto their street (a short flight of
steps), so in-town paths are few and short (official world: 76 doors, gates
and stalls); "paths to get everywhere" is also read outward: a footpath
runs from the nearest street end to every landmark, shrine, ruin and
watchtower within 320 m of a settlement (75 paths, ~16 km on the official
world), dropped where it would wade or climb steeper than 1 in 2.

## Denser: build what the map already listed, then fill gaps

Measured first (`worldgen/examples/poi_density.rs`): genVersion 1 already
had ~19 sites/km2, but 14 landmarks and 11 enemy camps per world were map
markers with nothing in the world, and towns were wide (squares up to 18 m,
5 m streets, 1.6 m between lots). genVersion 2 builds landmarks (8
variants) and enemy camps as structures, adds 6 + 10 x `settlementDensity`
hamlets (>= 270 m apart), and fills farthest-first with landmarks, small
ruins, shrines, ruined watchtowers and camps until every candidate is
within 120 m of a site edge. Official world: 194 -> 290 sites, 30 -> 42
settlements; a walker on dry land is a median 63 m (was 95 m) and at worst
227 m (was 326 m) from the nearest built thing; 99.3 % of land is within
150 m of one (was 80.3 %).

- New ruins are tier 0-1 (no new boss arenas); camps keep 750 m from the
  spawn so the Haven (server difficulty: areas within 420 m of the spawn)
  gets no new camp. New sites get guardian/camp groups through the existing
  combat placement (more fights between towns, at the area's level).
- Trees now grow up to the tighter layout radius; the client hides scatter
  on lots, streets and footpaths by stable id, as before.

## World renewal for the official world

The deployed official world is pinned to genVersion 1 (atlas
`50ae4562cfd25265`). With the archive, nothing breaks when this ships: the
zone and clients keep generating it with the genVersion 1 build. To give it
the new towns it must be renewed (spec 5 rule 5). `mintdb.RenewOfficial`
(`mintworld -official -renew`) does it in place: same row id, seed and
spec, new `gen_version`/`atlas_hash`; refused unless every old site keeps
its index and id in the new atlas (so progress carries over by stable id);
saved positions within 40 m of a hamlet or village (whose ground and
buildings changed) are reset to WP04's never-checkpointed marker, so those
characters start at the spawn; one transaction with a compare-and-set on
the old pin. Outside production the account service renews the dev
official world on startup (`LODESTONE_WORLD_RENEW=0` turns it off);
production never renews by itself.

Alternatives: minting a second official world (characters stranded in the
old one, a new row for everything), or keeping genVersion 1 and adding the
changes as a new export (impossible: the terrain itself changes).

## Assumptions

- Local profiles (signed blobs in IndexedDB) keep their saved positions; a
  local character standing in a village at renewal is lifted onto the
  ground or pushed out of a building on its next step.
- Items lying in the world and discovery-difficulty stamps are kept (areas
  are the same 256 m squares).
- The numbers (relief thresholds, layout scales, density gap) are
  proposals for Nicole's next playtest.
