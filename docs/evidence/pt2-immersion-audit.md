# Playtest 2: immersion audit

Nicole: "make the game really good and immersive ... really analyze the
assets you make for immersion". Measured against the art direction
(`docs/decisions/0023-art-direction.md`: Valheim and Breath of the Wild in
spirit, low-poly, light first, readable silhouettes, our own designs).

**How it was looked at.** A private dev stack (`tools/playtest/stack.mjs`,
`LODESTONE_ZONE_DEV=1`), one new character driven by the dev console, the
default Lodestone style on High (a Low sheet too), headless Chromium on the
RTX 3070 (ANGLE D3D11), 1280x720 tiles composed into contact sheets by
`tools/playtest/immersion-shots.mjs`:

| Sheet | What |
| --- | --- |
| `pt2-immersion-biomes-{day,dusk,night,rain,snow}-before.jpg` | the six biomes (meadow, forest, highlands, snowpeak, badlands, wetland) at 11:00, 19:06, 23:00, in rain at 14:00 and in snow at 13:00, third person |
| `pt2-immersion-towns-before.jpg` | Draedmore: approach, the square at noon (townsfolk), a farmer close, the square at 20:30 and 23:00, a street lamp at night, an inn interior, the skyline (chimneys) |
| `pt2-immersion-caves-towers-before.jpg` | the cave pick (the teleport is the zone's: it put us in a pond), the Forgotten Spire from 30 m, at its base, at night |
| `pt2-immersion-enemies-before.jpg` | packs spawned in the meadow (wolves, boars, slimes, cutthroats, a sentinel, shades) and demons at night; the close-ups are the enemy gallery's (`pt2-enemy-models-*.jpg`) |
| `pt2-immersion-heartfall-before.jpg` | the Hush's entrance (with the HUD), the Hush from 16 m and close, the choir of Hollow Bells, the endless night, the ending and credits |
| `pt2-immersion-avatars-before.jpg` | the bare avatar and in iron armor (front, photo-mode camera), from behind, emotes (wave, dance), a pet wolf, playing the lute, riding the steed and galloping |
| `pt2-immersion-firstperson-before.jpg` | first person with each weapon kind and casting |
| `pt2-immersion-spells-before.jpg` | three casts and a dodge dash, third person |
| `pt2-immersion-camp-fishing-before.jpg` | a camp at night, the campfire close, a fishing spot, a line out |
| `pt2-immersion-hud-before.jpg` | the HUD calm and in combat, inventory, map, journal, skills, character |
| `pt2-immersion-low-before.jpg` | Low: meadow and forest by day, forest night, town night, wetland dusk, highland rain |
| `pt2-immersion-life-before.jpg` | the places where life should be: a meadow sky at 10:00, the meadow grass, a forest, a wetland at 22:30, a town's chimneys at 09:00 |

Audio was audited from the code and the trigger map (`client/src/audio`:
`triggers.ts`, `cues.ts`, `ambience.ts`, `movement.ts`, `music/director.ts`)
against every player action and Event kind, since a headless capture cannot
listen.

(The "before" sheets also show a few things that are artefacts of the
capture, not the game: the What's new welcome card sits on many HUD tiles
because the script never dismissed it on a brand-new character, and the
enemy packs spawned behind the third-person camera.)

## Critique by asset class

### Terrain, vegetation, sky (biomes)

- **Silhouette / readability**: strong. Low-poly blob trees, conifers in the
  highlands and snowpeaks, boulders and the bright yellow-green grass tufts
  read at once. The meadow and forest are the most "BotW" frames in the game.
- **Scale**: consistent: a 1.8 m avatar against 6-10 m trees, 1-2 m
  boulders, the tower ~25 m.
- **Colour harmony**: good by day; the grass is a touch acid (yellow-green
  against brown ground) but it is the style. Badlands and snow are plausible.
  **Snow does not touch the grass**: under `/weather snow` the snow cover
  whitens the ground but every tuft stays summer green (breaker, medium).
- **Light and atmosphere**: skies with drifting clouds, aerial haze and
  valley fog are lovely by day. **Dusk is gone by 19:00**: at 19:06 every
  biome is already full night (stars, blue); the golden hour lives around
  17:00-18:30. **Under rain and snow the sun's shadows stay hard and dark**
  (forest rain: a crisp black tree shadow under an overcast sky; breaker,
  trivial to fix). Night is moody and readable, never black.
- **Motion**: grass sways with the gust sheen; trees do not (blob canopies are
  static); nothing else moves.
- **World life**: **none**. No birds in the sky, no insects over the
  meadow, no fireflies at night, no leaves falling in the woods, no pollen
  in the light. The world reads as a beautiful diorama: the single biggest
  "not alive" signal outside towns.
- **Water**: turquoise shallows and the shore foam are good; rain does not
  ripple the water; the wetland's largest patch is a lake.

### Towns, NPCs, interiors

- **Buildings**: cottages with plaster, timber, thatch and tiled roofs,
  fences, a market stall, a walled town; the strongest asset class after the
  terrain. Scale of doors to players is right.
- **Chimneys never smoke**, not at breakfast, not at night: towns look
  uninhabited from a distance (breaker, medium).
- **Fires are pictures**: hearths, braziers, campfires, torches and street
  lanterns in towns are crossed quads with a fire texture that never moves;
  the light pool sways gently but the flame itself is frozen (breaker,
  low effort).
- **Townsfolk** walk their routines (out by day, about at 20:30, fewer at
  23:00) and applaud songs, but they are **box people with box heads and no
  faces**, a Minecraft-like look that clashes with the rounded low-poly
  enemies and buildings (breaker, medium).
- **Interiors**: furnished (tables, benches, shelves, a bar), wooden floors;
  **windows are black voids at noon from inside**, and the room is lit only
  by the hemisphere light (medium; not fixed here).
- **Nameplates** over townsfolk within 15 m are fine.

### Caves, towers, vaults

- The tower (the Forgotten Spire) is a clean stone cone; its base and the
  crystal are inside the 3 m teleport offset of the capture (the camera ended
  up inside the wall: a capture miss). Caves from the WP09 evidence
  (`pt2-graphics-lodestone-cave-high.png`) read well: dark rock, gem glow,
  mushrooms. No vault on this world's first rings (`kinds` in the capture
  log has none).

### Enemies

- The playtest 2 models (`pt2-enemy-models-*.jpg`) are characterful and
  readable; packs read as packs; telegraph decals are very saturated red
  (readability over immersion; kept).
- **Demons wear two sets of horns**: WP15's NightLayer still adds its
  generic white cone horns and orange ball eyes over every demon, at fixed
  heights that ignore the new hunched models and their poses (floating
  horns beside the gloamling, eyes in front of its chest: `biomes-night`,
  forest). It would also put horns on the Hollow Bells (family demon).
  Breaker, trivial.

### The Heartfall: the Hush and the Hollow Bells

- **The final boss has no face of its own**: the Hush is the Archon's purple
  robed floater with a halo and three orbs, scaled 3.2x; its Hollow Bells
  are the hooded Shade. Neither reads as "the silence at the heart of
  everything" or "a bell with no clapper that tolls anyway" (content.yaml's
  own lore). Breaker, high impact.
- **The entrance is buried in HUD**: the region card, the quest tracker, the
  boss bar, tips, the hotbar and (on a fresh session) the welcome card sit on
  top of the letterboxed title card and the Hush's lines; the welcome card
  even sits over the ending and the credits. Breaker, low effort.
- The arena's purple ribbons and the beacon read well at night.

### Player avatars, emotes, pets, mount, instruments

- **The bare avatar is a mannequin**: a bald skin-coloured sphere head with a
  glossy black visor band (it reads as sunglasses), a navy tube body, no hair,
  nose or eyes. In iron armor the helm frames the same "sunglasses".
  Everyone sees it all the time in third person and on every other player.
  Breaker, high impact, low effort. At 25-80 m (mid LOD) the head is painted
  in the shirt's navy.
- Armor, emotes (wave, dance), the lute pose, the pet wolf and the spirit
  steed are good; the steed's spectral pale blue reads as magic.

### First person, spells, dashes

- View models (sword, bow, staff, spear, wand) are crisp; the iron sleeve is
  blocky but fine. Spell and dash effects are the most polished VFX in the
  game (playtest 2 spell VFX). The level-up card crossing a dash is noisy but
  rare.

### Camps, fishing

- The campfire lights its circle warmly; no smoke or embers rise from it. The
  fishing shore reads well (bright morning water).

### HUD and menus

- Consistent serif titles, dark translucent panels, gold accents: coherent.
  The bottom hint lines (two rows of key help) are dense for a calm walk;
  tips pop up mid-fight in the centre. Menus are readable and consistent.
  (UI clutter outside the story moments left to the UX owners.)

### Audio (from the code)

- **Every core action has a sound** (steps by surface, jumps, landings,
  swims, climbs, gliding, swings, casts and impacts per element, hits, crits,
  parries, loot by rarity, crafting, doors, towers, level-ups; Nicole's
  music by day/night/town/cave/combat/timed).
- **Story moments are silent or generic**: Events 1600-1612 (act title
  cards, the Hush's entrance, the choir, the endless night, the ending,
  revives) have no cue at all; the Hush fight plays the generic combat loop;
  a Hollow Bell's toll plays the generic telegraph sting. Breaker, high
  impact, low effort.
- **Daytime ambience is noise**: wind, rain and night insects are
  synthesized beds, but there is no birdsong by day, no frogs on wetland
  nights, no owl in the woods (the audio README lists this as a gap).
  Breaker, medium.
- **Riding sounds like walking** (the rider's human footsteps at a gallop;
  `movement.ts` knows nothing of the steed) and **fishing is silent** (no
  cast, plop, bite or catch). Medium, low effort.
- Mix: music ducks under voice and stings; loops capped at 8; no gaps found.

### Performance and pops

- No LOD pops caught in the stills; the far trees use impostors at
  distance. Turn and enemy benches: see "Performance" at the end.

## Top 15 immersion breakers (ranked by impact / effort)

| # | Breaker | Impact | Effort | Fixed |
| --- | --- | --- | --- | --- |
| 1 | The player avatar is a faceless mannequin with a "sunglasses" visor; navy head at mid LOD | high | low | yes |
| 2 | The Hush wears the Archon's model | high | medium | yes (with 3) |
| 3 | The Hollow Bells are hooded Shades | high | medium | yes (with 2) |
| 4 | The story's cinematic and ending are buried under HUD cards | high | low | yes |
| 5 | Story moments are silent; the finale has no music of its own; bells toll with a generic sting | high | low | yes |
| 6 | No wildlife: no birds, butterflies, fireflies, falling leaves, pollen | high | medium | yes |
| 7 | Floating legacy horns and eyes over every demon | medium | trivial | yes |
| 8 | Town fires, torches and lanterns are frozen pictures | medium | low | yes |
| 9 | Chimneys never smoke | medium | medium | yes |
| 10 | No birdsong by day, no frogs or owls at night | medium | medium | yes |
| 11 | Hard sun shadows under an overcast rain or snow sky | medium | trivial | yes |
| 12 | Riding plays human footsteps; fishing is silent | medium | low | yes |
| 13 | Townsfolk are faceless box people | medium | medium | yes |
| 14 | Grass stays summer green under snow cover | medium | low | no (next) |
| 15 | Interior windows are black at noon | medium | medium | no (next) |

Also noted, not ranked: dusk is over by 19:00 (the golden hour is short);
rain does not ripple water; tips pop up in the middle of a fight; the
telegraph decals are loud.

## What was fixed (before / after)

Each fix is its own commit on `pt2/immersion`. The "after" sheets were
taken with the same script on the same stack after all of them
(`--tag after`; the capture now also dismisses the welcome card on HUD
tiles and turns toward spawned packs, so compare the scenes, not the
cards).

| Fix | Commit | Before | After |
| --- | --- | --- | --- |
| The Hush and its Hollow Bells: own models and animation | `7151849` | `pt2-enemy-models-story-before.jpg`, `pt2-immersion-heartfall-before.jpg` | `pt2-enemy-models-story.jpg`, `pt2-immersion-heartfall-after.jpg` |
| No floating horns and eyes over demons | `1c16671` | `pt2-immersion-biomes-night-before.jpg` (forest), `pt2-immersion-enemies-before.jpg` (demons) | `pt2-immersion-enemies-after.jpg` (demons at night, one close) |
| The entrance and the ending play without the HUD | `0eaf365` | `pt2-immersion-heartfall-before.jpg` (tiles 1, 2, 7, 8) | `pt2-immersion-heartfall-after.jpg` |
| World life: birds, butterflies, fireflies, leaves, motes | `288aef4` | `pt2-immersion-life-before.jpg`, `-biomes-day-before.jpg` | `pt2-immersion-life-after.jpg`, `-biomes-day-after.jpg` (flocks, butterflies) |
| Chimney smoke | `76a29fc` | `pt2-immersion-life-before.jpg` (town at 09:00), `-towns-before.jpg` (skyline) | `pt2-immersion-life-after.jpg`, `-towns-after.jpg` |
| Town flames lick and sway | `405da7c` | a still flame picture | motion does not show in a still; the patched town program compiles and draws in every run (no shader error), the sway is only on the always-on fire layer |
| Players get a face and hair | `3d9b958` | `pt2-immersion-avatars-before.jpg` | `pt2-immersion-avatars-after.jpg`, `pt2-immersion-avatar-face-after.jpg` |
| Townsfolk get faces | `b1beeb5` | `pt2-immersion-towns-before.jpg` | `pt2-immersion-npc-faces-after.jpg`, `-towns-after.jpg` |
| Clouds soften the shadows | `e4de444` | `pt2-immersion-biomes-rain-before.jpg` (forest: a crisp black shadow) | `pt2-immersion-overcast-shadows-after.jpg` (left: a shower clearing, soft; middle: clear, crisp; right: rain, soft), `-biomes-rain-after.jpg` |
| The story is heard (bells, cues, music) | `11c81de` | silent Events 1600-1612; the telegraph sting for a bell | `triggers.test.ts`, `director.test.ts`; the bells rendered in the browser: hollow bell 7 s, hush toll 10 s, peak 0.54, silent last 10 ms (no click), ~100-150 ms on the audio thread |
| Birdsong, a hawk, frogs, owls | `7a9069d` | wind noise only | `wildlife.test.ts`; the engine runs them in the browser with no error |
| Hoofbeats in the saddle; fishing is heard | `b986691` | human steps on a steed; silent fishing | `movement.test.ts`, `triggers.test.ts`, `fishing.test.ts` |

Notes on the after sheets: the plumes are faint at 15:00 by design (lazy
hearths at mid-afternoon; breakfast and supper smoke most); the choir
tile shows the Hollow Bells small at 5 m of boom (the gallery sheet shows
them close); a capture of a town flame in motion needs video, not a still.

## Performance

`pt2-immersion-bench.json` (RTX 3070, ANGLE D3D11, headless Chromium,
uncapped; before = main `390d60c`, after = `pt2/immersion` with the
ambient life live in the meadow):

| | before p50 / p99 / max (ms) | after |
| --- | --- | --- |
| Turn, High, pan | 5.8 / 10.0 / 16.1 | 5.6 / 9.5 / 12.0 |
| Turn, High, flick | 5.6 / 10.6 / 12.7 | 5.3 / 8.6 / 10.7 |
| Turn, Low, pan | 3.6 / 7.1 / 11.2 | 3.3 / 5.7 / 7.9 |
| Turn, Low, flick | 3.3 / 5.7 / 11.7 | 3.3 / 5.6 / 14.1 |
| Enemy crowd 200 | 7.6 / 11.2 / 13.1 (662 draws) | 7.2 / 11.5 / 13.8 (665 draws) |
| Enemy crowd 2,000 | 6.5 / 10.9 / 13.8 (622 draws) | 6.2 / 10.1 / 11.4 (622 draws) |

0 frames over 33 ms and 0 long tasks in every turn run. Within noise.
