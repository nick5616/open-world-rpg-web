# CR 044: Sky and Depths content (playtest 3)

Branch `pt3/sky-depths`. Playtest feedback: "Continue with the sky and underground content." This CR builds on the vertical world (CR 038). Sections below are added by the pieces of the branch.

## Creatures and shrines

**Creatures.** The layer enemy tables no longer lean on the surface families. Four new enemies in `contracts/combat.yaml` (ids 120-123, additive; codex lines in `content.yaml`), each with its own procedural model in `client/src/combat/enemies/models.ts`:

- `sky_wyvern` (sky, wind flyer): long neck, spread leathery wings on finger bones, barbed tail, hind talons. In the sky table beside the harpies, wisps and moths, which already had their own models.
- `ember_demon` (Depths, lesser demon, fire): a crown of flame, smouldering shoulders, glowing cracks.
- `magma_hound` (Depths, cave family, fire): basalt hide with glowing seams, a mane of flame, ember paws and tail tip.
- `obsidian_golem` (Depths, cave family, fire): glass shards with lava-edged plates.

`combat.LayerTables` for the Depths now draws ember demons, magma hounds and obsidian golems alongside the gloamlings and greater demons of the Starless host; the sky table adds the wyvern. Evidence: `docs/evidence/pt3-depths-creature.jpg`.

**Demon shrines.** Every Depths hall has a demon shrine (vertical decoration kind 24, `aux` = chamber). E at the shrine (Interact 153, target = the chamber; within the shrine's size + 9 m, 8 m vertically, in the Depths) starts a cleansing (`server/zone/internal/game/shrine.go`): three waves wake at the shrine one after another (ember demons and a hound; hounds and demons; an obsidian golem, a cinder fiend and a hound, shielded), each as the previous falls. The last wave's fall cleanses the shrine and pays everyone who fought within 60 m: gold (the vault chest's, x1.5) and two rolled pieces from the vault chest table with the Depths' luck (x2.5), granted by item marker so each character is paid once per shrine per 6 hour window (no new state, no migration). A second player pressing E joins the live fight. Nobody within 60 m for 90 s retires the wave.

Events (`contracts/events.md`, 1890-1899): 1890 `shrine_state` (value 0 already cleansed this window, 1 a wave woke, 2 a wave fell and the next woke, 3 cleansed, 4 abandoned; data = wave and wave count), 1891 `shrine_reward` (value = gold, data = item bases). The client shows each stage as a notice and the E prompt as "Cleanse the demon shrine". `systems/night.ts` routes 1880-1899 to the vertical events handler.

Cost: nothing while no shrine is live (one map length check per tick); a live shrine works once a second. Zone tick stays flat.

## Sky palaces (interior, trial, boss)

A sky palace (CR 038's structure kind 9 and PALACE decoration) is now a real building. `contracts/palace.yaml` plus `contracts/codegen/lib/palace.mjs` expand, at `npm run gen`, into one explicit list of ~110 collision boxes in the palace's local frame (walls with doorways and lintels, floors, ceilings, columns, the plinth and its steps) and the gameplay table (wards, packs by room, arena, chest, shaft). `server/pkg/palace` (Go) and `client/src/world/palace/palaceSites.ts` (TS) append those boxes to the towns' box list before the collision is indexed, so movement, the enemy blocker, shelter audio and prediction all use the existing town collision with no new code; the palace turns by quarter turns only, so cos/sin are exact and both twins agree to the bit (`server/pkg/palace/testdata/golden.json`, `palace.test.ts`). **No worldgen change** (the descriptor's decoration is read, genVersion stays 3).

The layout: a front portico and gate, a vestibule with annexes, a colonnade, the sun and moon galleries, an atrium with a **wind shaft** (an updraft column, 15 m/s, in the zone's and the client's wind field: `palace.Wind` / `VerticalWind`) rising to an upper gallery, the wings, and above the atrium's north wall a **throne hall** at the gallery's height (reached only from the gallery). Falling from the gallery is 14 m (no fall damage).

**Trial** (`server/zone/internal/game/palace.go`): a player within 150 m (3D) wakes the palace (or knocks at the doors: Interact 150, Event 1702); guard packs (sentinels, wisps, harpies, moths, spark wisps; elite affixes in some halls) take nine rooms. Strike the **Ward of the Sun** (west gallery), the **Ward of the Moon** (east gallery) and the **Ward of the Wind** (upper gallery, reached by riding the shaft): Interact 152, within 5 m. The third wakes the **Sky Guardian** (`combat.yaml`: enemy `sky_guardian`, boss `sky_guardian`, attacks `guardian_*` ids 130-134; three phases: sweep and lance, sunfall under every player plus two adds, gale and dive) in the throne hall. Its fall opens the chest: gold 220-380 and two relic-or-better items with luck 3.5, once per character per 20 h (the vault chest's persisted cooldown, keyed by the palace's site index: no migration). Works in co-op: state is per palace, rewards go to everyone who fought or stood inside. Nobody near for 600 s puts it back to sleep. Cost: one scan of the (one or two) palaces every 30 ticks; an awake palace sends a state per character on change.

**Client**: `PalaceViews.ts` with three levels of detail (full inside 230 m, hull to 1.5 km, a silhouette beyond), floating rings, banners that sway, doors that swing open as you come, the shaft's wind, ward emblems and a chest that follow Event 1704, interior lamps through the pooled cave lights (no lights added at runtime), and a light column and halo so the palace can be found from far below (no flashing: static, normal-blended).

## Sky activity: the Glide Ring Race

Every sky town's challenge stand (towns prop kind 31, Interact 151) now starts the **Glide Ring Race** (`activity.go`, Event 1706). E arms a course of twelve rings spiralling down round the island (34 m apart, 5 m lower each: a glider's loss), generated as a pure function of the stand and the descriptor's islands and checked clear of every island. The clock starts at the first ring, so the walk to the rim is free; the zone checks the racer's real position every tick only while a race is live (nothing otherwise). Landing, falling out of the course or the 110 s limit ends the run. Medals by time against the ideal glide time (gold <= 1.25x, silver 1.6x, bronze 2.1x) pay gold and XP once per half hour per stand per character; a gold medal rolls a relic once per 20 hours. Best times are kept per stand and character (migration 0034 `sky_race_times`; `game.RaceStore`, PG and in-memory, restored before the zone ticks, written in the background) and the stand's top five rides along with every arming.

## Polish

Deeper blue, violet and turquoise crystal tints and a dimmer crystal glow (they read pastel at distance before), a grander tunnel portal (obelisks, braziers, a runelight column), **baked ambient occlusion** in the cavern and Depths meshes (a ring of lattice samples per vertex: free, no post-process), birds over the archipelagos and wind chimes on the sky towns' and palaces' islands (instanced, hidden on the low tier). Not done: sky-town NPC variety and a bounty-board quest (the quest tables are content-heavy); the cloud-harvest activity.
