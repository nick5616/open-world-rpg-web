# CR 046: Towns art (playtest 3)

Branch `pt3/towns-art`. Playtest feedback: "Make the assets in the world better and higher fidelity, like it would make you want to live in this world, super immersive. Houses are just okay."

Render-side only. The towns buffer, every collision box, every door and NPC position, the zone and the contracts are untouched: **no genVersion change, no migration, no protocol or event change**. No footprint was changed, so client and server collision stay as they were (`doors.test.ts`, `kit.test.ts` and both zone integration tests still pass unchanged).

## What changed

A **detail level** (`client/src/world/buildings/detail.ts`) follows the quality tier the session starts with: low = 0 (the playtest-2 look and cost), medium = 1, high / ultra = 2. The buildings worker gets it in its `init` message and builds every settlement at that level. A tier picked later applies to settlements streamed in after it (same rule as the light pool: nothing recompiles).

| | low (0) | medium (1) | high / ultra (2) |
| --- | --- | --- | --- |
| Texture array | 256 px, richer painters | same | **512 px** (same pictures, finer grain and joints) |
| Windows | flat pane + sill | frame (jambs, head with drip ledge), board-and-batten shutters, leaded panes in the texture (warm glow per pane at night) | + inner reveal and window seat, **open shutters**, **flower boxes**, **curtains** |
| Walls | style face | stone **footing course** with a cap ledge (all styles but stilt), **lime-wash colour per building** on plaster walls | + rafter tails |
| Timber style | painted beams | **real half-timbering**: plaster panels, sill and head plates, a post in every window bay boundary, mid-floor rails, knee braces, framed gables with a king post | same |
| Roofs | one tint | **per-building tint** (brightness and warm / cool shift), terracotta / slate / shingle **ridge caps**, thicker thatch ridge, lichen and silvered shingles in the textures | + rafter tails |
| Chimneys | stone box | stepped stack with a corbelled cap, a slab and two clay pots (the smoke rises from the pots) | same |
| Doors | lintel | jambs, head board, **wall lantern** (glass glows at night: emissive, not a light), **inn hanging sign** with tankards | same |
| Yard | none | barrels, crates, sacks, wood piles, hay, forge coal heaps, benches, doorstep flower pots | + carts, wash lines with hung cloth, ladders, rain barrels, chopping blocks |
| Rooms | as before | skirting, plastered ceiling between **dark beams**, bed posts / footboard / quilt, table runner, loaf, hearth mantel + cauldron + logs | + **wainscot**, hanging herbs, an inn's **candle wheel** (flames: emissive and flickering), table candles |
| Props | | stall valance, hanging onions and a produce crate, well bucket and rope, pointed fence post caps | |

### Placement rules for the clutter (`dress.ts`)

Yard items have **no collision** (the zone knows nothing about them, like porch posts and chimneys), so a `Yard` query per settlement keeps them out of the way of everything the server collides with or walks:

- hard against a side or back wall; the only thing in front of a building is a pair of flower pots beside the doorstep (not on porches or stairs); never in the door corridor;
- outside every floor / wall / fence / furniture / town-prop / ramp / deck / railing box of the settlement, with a 15 cm margin plus the item's radius;
- outside every street, footpath and road ribbon passing within the settlement (half width + margin + 0.3 m), and outside the 13 m square;
- on nearly level ground (4 sample points within 0.45 m);
- deterministic from the building index (a settlement always dresses the same way).

`art.test.ts` checks the query (every building footprint and every street point rejects), determinism, finite and valid meshes at every level on the official world and on seed 3 (adobe), and the triangle budget.

## Cost (measured, `docs/evidence/pt3-towns-after-drawcalls.txt` and the numbers in the STATUS section)

Draw calls do not change: the shell, the interior and the door leaves are the same meshes, the new geometry is merged into them. The largest town (Draedmore, 40 buildings): shell 21k triangles at low (as before), 40k at medium, 61k at high; interior 12.8k / 22.5k / 29.6k. The texture array goes from 8.6 MB to 34 MB (before mips) at high; low and medium keep 256 px. Worker build time of a settlement ~25 ms -> ~150 ms on high (still off the main thread); the 512 px textures take ~4 s in the worker at startup (high only).

## Files

New: `client/src/world/buildings/detail.ts`, `dress.ts`, `art.test.ts`. Changed: `kit.ts` (windows, timbering, skirts, roofs, chimneys, door surrounds, fences, ceilings), `props.ts` (table, bed, hearth, stall, well), `textures.ts` (size-independent painters, plaster, stone, shingle, clay tile, planks, window, fieldstone), `meshBuilder.ts` (`skip` option on `box`), `buildings.worker.ts` / `protocol.ts` / `townsManager.ts` / `TownsLayer.tsx` (the detail level), `dev/townBench.mjs` (`--tier`, `dusk`, clear weather).

## Known gaps

- Stalls (`floors === 0`), signposts, bridges, docks and the exploration / structure meshes got no new geometry in this pass (stalls and wells got prop detail, fences post caps); structures and roads are unchanged.
- Dressing is decoration: a barrel against a wall can be walked through.
- Hip roofs still render as gables (README gap, collision boxes unchanged).
- Interiors are lit by the sky and the fixed light pool only; glass and flames are emissive, there are no new lights.
