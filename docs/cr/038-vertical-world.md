# CR 038: The vertical world (playtest 2)

Branch `pt2/vertical-world`. Nicole: "ok new pivot for the game: make it vertical. there are tunnels you can take to underground vast, lit-by-crystal cave networks that are huge and breathtaking with glowing blue waters like a cave in south america or something, and also hellish areas in the depths too, and also you can fly up and go to sky islands, and sky towns, and specifically put in the legend of zelda skyward sword bamboo island minigame in here. lots of stuff like that in the sky. sky palaces too, which rightfully are their own domain when youre inside. they are large and have elaborate twists and turns and ambience."

This CR is the **foundation**: the three new layers, generated from the seed, walkable on both sides of the wire, drawn, heard and mapped. Sky palaces (instanced interiors) and sky activities (an original bamboo-slicing challenge and the like) are separate follow-ups that build on the hooks listed at the end.

## Summary

- **Sky** (layer 1): 3-5 archipelagos per world, islands at 330-800 m (each clear of the ground under it by 120 m+), lobed outlines, a rolling grassy top, an inverted-mountain underside (layered earth and stone, hanging rocks), waterfalls pouring off the rims into a bank of clouds under the archipelago. Anchor islands carry a **sky town** (2-3 per world: hamlet or village, inn, forge, stall, board, well, ward garden, townsfolk, a waypoint) or a **sky palace** site (1-2 per world, a huge white-and-gold palace visible from far below); smaller islands are groves, meadows, crags and **sky ruins**. **Wind**: a **sky lift** crystal at the edge of the surface town nearest an archipelago (an 18 m/s column up past the islands), wind columns and geysers rising from the ground under each archipelago, and currents beside every island carrying you to the next higher one. You ride them gliding (the movement step's updraft hook).
- **The Underground** (layer 2): 4-8 **tunnel entrances** on hillsides (a portal of standing stones with glowing runes over a hole in the terrain, on the map), each a long tunnel (300-1100 m) winding down into a **vast cavern** (100-420 m across, domed roofs 70-150 m up) and coming out on a **balcony high on the wall**, then a ledge ramp down to the floor. Caverns: **crystal halls** (blue, teal and violet crystal clusters and spires that cast real light), **cenotes** (a glowing turquoise lake under daylight shafts from the surface: holes in the land you can jump into), **river halls** (underground rivers, waterfalls), **fungal halls** (giant glowing mushrooms, ferns). Stalactites, stalagmites, great columns, ore and gem veins, **safe camps** (a waypoint, a campfire, tents, lanterns) in every other cavern. Caverns are joined by passages and rivers.
- **The Depths** (layer 3): under the deepest caverns a **gate** in the floor (a ring of black spikes and embers) opens on a steep descent to halls of basalt and ash around **lava lakes** joined by **lava rivers**, lava falls, sulphur vents, obsidian, drifting embers and a demon shrine in each hall.

## Generator (genVersion 3)

`worldgen/src/vertical/` (README "Vertical world"): every layer is a pair of heightfields over the terrain's 1 m lattice (sky: island top over island bottom; Underground/Depths: floor under ceiling) plus a water/lava lattice, so collision is the terrain's triangle rule on f32 lattice values (`ground::tri_interp`), bit-identical in every host. The plan (islands, archipelagos, updrafts, chambers, corridors, openings, shafts, columns, decorations, veins) is a pure function of the base atlas; the atlas pass builds it once to append its sites. New exports: `vertical_build` (descriptor `LDVT`), `layer_tile` (`LDLT`, 65 x 65 lattices at LOD 0-6), `layer_height` (one surface at a point). Openings cut holes into the layer above with the cave mouths' triangle-centroid rule. Every genVersion 2 site keeps its index and id; the vertical sites (tunnel, cavern, sky_lift, depths, archipelago, depths_gate POIs; sky_palace and sky_ruin structures; sky town settlements and their waypoints; underground camp waypoints) are appended, with a layer byte (site record byte 37). The terrain's heights are unchanged everywhere (golden review: 0 chunks changed height); scatter is cleared at tunnel mouths; sky towns are appended to the towns buffer (laid out on their island by the same layout code; every surface settlement, structure and prop keeps its index). The genVersion 2 build is archived (`worldgen/archive/worldgen-1dcd2ffc09618d97.wasm`, table `golden-v2.json`).

## Contract changes

- Atlas: site byte 37 = layer; new POI kinds 5-10, structure kinds 9-10 (worldgen/README.md, `format.ts`).
- Towns buffer: prop kind 31 `activity` (sky-town squares).
- Exports `vertical_build`, `layer_tile`, `layer_height` (ABI version unchanged: additive).

- Constants v8 (`contracts/constants.yaml`): `UPDRAFT_MAX_LIFT` 10 -> 20 (sky lifts are 18 m/s), new `TERMINAL_FALL_SPEED` 54, new `UPDRAFT_FREE_LIFT` 8 (gliding costs no stamina in an updraft at least this strong, and anywhere in the sky band over an archipelago: `movement.FreeGlider` / `UpdraftField.freeGlideAt`). Movement goldens regenerated; the vertical ground has its own movement golden set (`client/src/sim/golden/vertical.ts`, `server/pkg/movement/vertical_golden_test.go`).
- Events 1700 `fall_damage`, 1701 `lava`, 1702 `palace_door` (hook), 1703 `activity_spot` (hook); 1704-1719 reserved (`contracts/events.md`). Interact 150 `palace`, 151 `activity` (hooks). Event 901 (area level) `y` = the layer. Mount whistle refusal reasons 4 (underground) and 11 (sky).
- Difficulty store: layered areas reuse the existing table (`cell_z = layer * 16 + z`): no migration.
- No protocol or snapshot format change; no database migration.

## Server

`server/zone/README.md` "Vertical world (playtest 2, CR 038)" has the details. In short:

- **Ground**: `server/pkg/vertical.Ground` is the line-for-line Go twin of the TS `VerticalGroundCore` (golden vectors from `worldgen/golden/golden.json`); `worldhost.CaveTerrain.WithVertical` wraps the cave ground with it (pure Go collision from cached LOD 0 layer tiles, a wasm `layer_height` on a cache miss, background tile builds fed by interest). `CaveTerrain.LayerAt` gives each entity's layer.
- **Wind**: the descriptor's columns and the free sky glide join the step's updraft field in the zone (`night.go`) and in the client's prediction (`sim/stepEnv.setVerticalUpdrafts`, `sim/verticalWind.ts`).
- **3D interest**: entities on different layers more than 80 m apart vertically are not in each other's snapshots (party exempt). Atlas-less worlds (the scale gate) have no vertical world: `LODESTONE_WIRE_DIGEST` unchanged (`docs/evidence/pt2-vertical-bench.txt`).
- **Fall damage** (server-authoritative, none into swimmable water, gliding, climbing, dashing or riding: (v - 18) x 3.2 % of max health), **lava** (35 %/s).
- **Difficulty per layer**: own 256 m areas per layer with floors sky 10, Underground 6, Depths 20 (top tier). **Enemies** per layer (`combat.LayerTables`: cavern crawlers, gloom bats, crystal golems, shades, void mites; the Depths' gloamlings and greater demons of the Starless host from CR 035; sky harpies, wisps, moths), Depths kills pay like elites with 2.5x luck. **Veins** of bands 3/4 mine like cave veins.
- **Sky towns**: townsfolk on their island, woken by 3D distance; shops, inns, boards, forges as anywhere; story, quests and content keep to base sites and surface towns, so every existing sequence stays where it was. Steeds can't be summoned underground or in the sky.
- **Vibe explorer**: landmark filters for every new site kind and a layer filter (also in the client's Vibe tab).

## Renewal and saves

- `mintdb.RenewOfficial` 2 -> 3 keeps every base site and id (the vertical ones are appended), so discoveries, waypoints, quests and story progress stay valid. Characters saved within an opening's radius + 8 m (a tunnel mouth or a cenote shaft cut into the terrain) are moved to the spawn marker (`TestRenewOfficialToVertical`).
- On login, `safeSaved` also catches a character saved where the ground is now a hole (put on the opening's rim), inside an island's rock (put on its top) or in rock with nothing under it (the spawn).
- Local-profile save blobs carry only positions and progress keyed by stable ids: no blob migration.

## Hooks for the follow-ups

- **Sky palaces**: each palace is an atlas structure site (category 2, kind 9 `sky_palace`, layer 1) on a big island; the descriptor's `palace` decoration (kind 16) sits at the island top with the site in `aux` and the gate facing local +z of its yaw. The palace exterior is drawn by `client/src/world/vertical/decoMeshes.ts palaceGeometry` (a unit-radius model scaled by the decoration's size). The entrance (Interact and Events below) is a stub that answers "the doors are sealed".
- **Sky activities**: every sky-town square has an `activity` prop (towns buffer prop kind 31, interactable, a stable prop id like any town prop) at the square's edge. The Interact for it is a stub.
