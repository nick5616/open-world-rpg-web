# CR 016: fire spread tuned down (constants v5)

Playtest 2: "fire spreads like crazy". With the WP15 values (grass 45 per mille per step per burning neighbour, ~100-step burns) a burning neighbour lit a grass cell ~99 % of the time, so any fire was a front that ran until `FIRE_MAX_BURNING` (6,000 cells).

| Constant | v4 | v5 |
| --- | --- | --- |
| FIRE_GRASS_SPREAD_PERMILLE | 45 | 2 |
| FIRE_BRUSH_SPREAD_PERMILLE | 30 | 2 |
| FIRE_DAMP_SPREAD_PERMILLE | 12 | 1 |
| FIRE_MAX_BURNING | 6000 | 1200 |

Measured (60 seeds, a 3 x 3 fire-spell ignition on open grass, no rain): v5 burns a patch of 12-83 cells (median 18, ~70 m2), out in 1-3.5 min; wind still pushes it downwind. Both chemistry twins read the generated constants; `server/zone/internal/chem/testdata/sim_vectors.json` regenerated (TS twin checks the same file). Clients and zone must run the same version (a deploy ships both).

Also (client only): scorched cells are drawn as soft round blotches laid on the slope instead of flat 2 m squares at the cell centre's height, which floated as black rectangles on hillsides.
