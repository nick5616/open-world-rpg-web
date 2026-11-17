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
