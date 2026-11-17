# CR 043: Caves with stuff, dwarven camps and strongholds (playtest 3)

Branch `pt3/dwarves`. Playtest feedback: "Continue with the underground content. Caves should have stuff and monsters and lead to secret underground dwarven civilization camps, and larger strongholds too."

Builds on CR 038 (the vertical world: the Underground is layer 2). This CR is the only playtest 3 change that alters worldgen output: **genVersion 3 -> 4**.

## Summary

- **Cave dressing** (Underground tunnels, passages, vast chambers): timber supports, rails and abandoned mine carts, bones, glowworm ceilings, ore piles, collapses, **chests** (loot, interactive) and **lore tablets** (interactive), scaled by place; packs of cave creatures along every tunnel and in the chambers (existing families, new `*_cave` variants in `combat.yaml`).
- **Dwarven camps** (3-5 per world): a small walled hamlet carved into a chamber of its own, 130-230 m off a tunnel or a vast chamber, reached by a narrow **secret passage** (`rk::SECRET`) whose first 14 m end in a rune-carved **secret door** half hidden in the wall. Forge, inn, stalls, bounty board, braziers, ore carts, townsfolk (dwarves), a waypoint stone. Friendly: no packs inside, safe at night.
- **Dwarven strongholds** (1-2 per world): a carved hall city in a great chamber (rx 150-190, 80-100 m high): market floor, smiths' terrace and top terrace (two gentle risers), a walled town (41-45 buildings, ~20 people, guards), a **great door** (17 m) at the rim where the Deep Road arrives, a processional of braziers and banners, forge glow in the smiths' quarter, a **throne terrace** opposite the door with a colonnade. A steep **mines' stair** leads to the **lower halls**: a deeper chamber of old workings (carts, rails, collapses, rich ore) with a rune circle and a boss.

## Generator (genVersion 4)

`worldgen/src/vertical/dwarf.rs` (plan + decoration), `field.rs` (floors), `town/` (dwarven style, settlements). Everything is **appended** after the genVersion 3 plan:

- Chambers 6 `dwarf_camp`, 7 `stronghold`, 8 `lower_halls` (after every v3 chamber); corridor kind 4 `secret`; level floors (noise 0.35 m instead of 1.6) and the stronghold's two risers (`field::chamber_at`, `TERRACE_TOP` 11 m). No new field maths for hosts: layer tiles carry everything.
- Sites (appended after every v3 site, layer 2): per hall a settlement (hamlet 45 m / town 130 m), its waypoint (linked), a **door** POI (kind 11 `dwarf_door`, size 0 secret / 1 great) and, per stronghold, the **lower halls** POI (kind 12 `lower_halls`). Every v3 site keeps its index and id (`docs/evidence/pt3-dwarves-golden-review.txt`: 0 sites moved, 0 chunks changed height).
- Towns buffer: dwarven settlements after the sky towns (`layout::build_under_settlements`), building style 6 `dwarf` (flat roofs, thick walls), prop kinds 32 `minecart`, 33 `ore_pile` (31 `activity` is the sky towns'), a great brazier (prop 27) instead of the well, merchants 4 `miner` and 5 `broker` (stock indices), dwarf names. NPC role mix as any town; the stable-id layers are unchanged.
- Decorations (appended; descriptor format unchanged, flag `df::INTERACT` = 4): kinds 28 `minecart`, 29 `rails` (size = length, yaw along), 30 `support`, 31 `bones`, 32 `glowworms` (hang), 33 `chest` (interact; tint = tier 1 cave, 2 camp road, 3 hall), 34 `tablet` (interact; aux = lore id), 35 `brazier`, 36 `dwarf_door` (size = height; tint 6 gate, 5 iron stair gate), 37 `dwarf_pillar`, 38 `ore_pile`, 39 `runes` (circle), 40 `statue`, 41 `banner`, 42 `secret_door`, 43 `throne`, 44 `forgeglow`, 45 `collapse`. Columns of the stronghold's colonnade and the lower halls are in the columns table (collision). Veins (band 3) in every dwarven chamber (richer in the lower halls).
- genVersion 3 is archived (`worldgen/archive/worldgen-7fbe0614976d388d.wasm`, `golden-v3.json`); the golden table is regenerated.

## Contract changes

- Atlas POI kinds 11 `dwarf_door`, 12 `lower_halls` (`worldgen/README.md`, `format.ts`); chamber kinds 6-8; towns `BUILDING_STYLES` +`dwarf`, `PROP_KINDS` +`activity`, `minecart`, `orePile`, `MERCHANT_KINDS` +`miner`, `broker`.
- Events 1860-1879 and Interact 160-163 (see below). No protocol message, no snapshot format change.
- Migration 0033 is **not used** (the dwarves need no schema: chest cooldowns and quest state use existing tables / memory).

## Renewal and saves

`mintdb.RenewOfficial` 3 -> 4 keeps every site and id (the dwarven ones are appended; `TestRenewOfficialToDwarves`). Terrain holes are unchanged from 3 to 4, so no saved position moves.

## Server

(filled in by the server slice)

## Client

(filled in by the client slice)
