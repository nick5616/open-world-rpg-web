# client/src/audio: sound design and music

The game's sound: Nicole's music as the identity of the world, sound
effects cut and layered from the Novation Anniversary packs, and a few
synthesized textures. One AudioContext for everything, voice chat
included.

## How it fits together

| File | What |
| --- | --- |
| `context.ts` | The one AudioContext and its buses: master (with a safety limiter) and music, sfx, ambience, ui, voice, each a duck stage plus a volume stage; sfx and ambience also carry an environment low-pass (interior damping). In the main bundle: the first click or key (the title screen's Play) creates and resumes it, as autoplay rules require. |
| `settings.ts` | Volume per bus + mute, in localStorage `lodestone.audio.v1` (validated like the voice prefs). |
| `bridge.ts` | What game code calls: `emitSound(name, payload)` and the `audioWorld` state (underground, chamber radius, distance to the cave mouth, in town, fighting). Tiny, never pulls the engine in. |
| `ui/AudioRoot.tsx` | Mounted by PlayScreen. Boots the engine (lazy chunk) after the first playable frame, on idle. K or the "Sound" button opens the settings panel; every HUD button clicks. |
| `engine.ts` | The engine (lazy chunk, 88 KB / 28 KB gzip with the QoL pass): listener follows the camera and movement sounds every frame; the environment pass 10x a second (shelter, cave leak, surface underfoot, weather, interior reverb, positional loops, far voices re-placed, smiths); music director and ducking 4x a second; hidden-tab fade; zone Events through the trigger map; the `window.__lodestoneAudio` debug handle. |
| `triggers.ts` | **The trigger map**: zone Event kind -> cue (`ZONE_EVENTS`) and named client moments -> cue (`TRIGGERS`). |
| `cues.ts` | Every cue: files (variants, random pick), bus, volume, pitch spread, 3D or not, voice limits, cooldown, music ducking. |
| `sfx.ts` | One-shot player: buffer cache, voice pool and caps, admission through `voiceLimit.ts`, variant/pitch/gain variation, equal-power panning (direction only) with `spatial.ts` distance, air and occlusion per voice (re-evaluated at 10 Hz for long ones), distance culling, the reverb bus (IR sized by the chamber or room radius, ported from WP09's cave audio). WP19b: the IR is synthesized in 32 k-sample slices with a yield between them (a newer radius supersedes one in progress), so it is never a main-thread long task. |
| `spatial.ts` | Pure: the distance curve (inverse distance easing to silence at the range), air absorption, occlusion between spaces (outdoors, a closed building, a cave), the loop categories (torch ... forge, wildfire, river, shore) with their ranges. |
| `acoustics.ts` | Pure: listener surroundings -> mix: cave leak, weather through the shelter (gain, low-pass, rain on the roof), interior reverb and damping, rain intensity ramp, ducking levels, thunder. |
| `shelter.ts` | Pure over the towns buffer: roof over the head (5-point probe of the town collision boxes), inside a closed building, its room size, the acoustic space of a point, the town box underfoot. |
| `surface.ts` | Pure: footstep surface (soft, hard, wood, water, snow) from depth, the box underfoot, water depth, biome, town. |
| `voiceLimit.ts` | Pure: which one-shots may start (cooldown, duplicates, stacks), never the same variant twice, pitch/gain spread. |
| `loopPool.ts` | Pure: which positional loops get a voice (top 8 by audible gain, a bias for the playing ones), burning cells clustered into fires. |
| `emitters.ts` | Pure: fire props and camp campfires -> loop emitters, forges -> smiths, a point grid, the smith's rhythm. |
| `loops.ts` | The positional loop voices (fade in, glide, fade out and stop). |
| `synth.ts` | Noise buffers and the loop textures rendered once through an OfflineAudioContext: fire, river flow, shore lapping, rain on a roof. |
| `bells.ts` | Playtest 2 immersion pass: the Heartfall's bells, synthesized (inharmonic bell partials, each a beating pair, high ones dying first, a metallic strike, a long fade) and rendered once through an OfflineAudioContext; `synth:<bell>` files in a cue are rendered by `sfx.ts` instead of fetched. |
| `worldProbe.ts` | The engine's view of the loaded world (towns, terrain, water, atlas biome, chemistry fire) feeding the pure modules. |
| `music/director.ts` | Pure state machine: which musical state the world asks for (unit-tested). |
| `music/player.ts`, `music/tracks.ts` | Crossfading playback: long tracks streamed through media elements, short loops (combat, time crunch) decoded and looped sample-exact. |
| `ambience.ts` | Synthesized beds: wind, rain, rain on the roof, thunder, night insects, underwater hush, cave drips; wind, open-air rain, thunder and insects through one shelter-controlled "weather" submix. WP19b: the noise buffers (~1 M samples) are synthesized in slices and each bed joins its chain when ready: in one go it was a 67-86 ms long task when the engine booted (traversal benchmark). |
| `movement.ts` | Footsteps (on the sampled surface), jumps, landings, splashes, glider, climbing from `localPlayer` state (unit-tested). |
| `assets/` | Built files (Ogg Opus + AAC each), imported through Vite: content-hashed `/assets/` names, immutable cache, never inlined. |
| `cueFiles.gen.ts` | Generated by `tools/audio/build-audio.mjs`: cue -> files. |

Budgets (spec 12): nothing audio is in the first-frame download. The
main bundle gains the context and settings (+1.4 KB gzip of JS in all);
the engine and every asset load after the first playable frame. One
codec per browser is fetched: 6.8 MB of Opus music for all 8 tracks
(streamed, only the tracks heard) and 1.0 MB of SFX: the instant set
(UI, steps, swings, hits, first spells) is decoded at once (about 8 MB
of PCM); everything else downloads in the background but stays
compressed and decodes on first play (all 161 files decoded would be
46 MB). Committed:
17.6 MB (both codecs). 40 one-shot voices at most at
once; per-cue caps, cooldowns, duplicate and stack limits collapse crowds;
3D sounds past their range never start; 8 positional loop voices at most;
panning is equal-power (HRTF stays for voices). The loop textures are
rendered once at 32 kHz mono, 6-9 s each (about 3.4 MB of PCM for all four).

## Space and distance (audio QoL pass)

Everything placed in the world is heard from where you stand, through what
stands between you and it. The pure parts are unit-tested; the engine runs
them at 10 Hz (never per frame per source) and glides gains and filters to
the results, so nothing clicks or zippers.

- **Distance** (`spatial.ts`): full volume inside a cue's `refDistance`,
  inverse distance beyond (the physical 6 dB per doubling), easing to
  exactly silent at `maxDistance` over the last 35 % (the Web Audio models
  stop attenuating at their max, so a sound used to vanish at -23 dB).
  Far sounds also lose their top end (air: ~16 kHz at 10 m, ~5 kHz at
  60 m). The panner only pans. Sounds that last (demon rises, boss roars,
  domains) are re-placed as you move.
- **Walls and rock**: the space of a point is a closed building (towns
  buffer; an open-fronted forge counts as outdoors), a cave (more than 3 m
  under the terrain) or outdoors. One wall between you and a source: x0.42
  and 1.1 kHz low-pass; two: x0.22, 700 Hz. From a cave, the surface comes
  through as much as leaks in (below); a cave is barely heard from above.
- **Positional loops** (`loops.ts`, `loopPool.ts`, `emitters.ts`): every
  torch (heard to 12 m), brazier (18 m), hearth (16 m, muffled from the
  street), campfire (26 m), forge (30 m, deeper) and camp campfire piece,
  burning grass (cells clustered on a 12 m grid, louder and carrying
  further the more burn), rivers (55 m, flowing) and lake/sea shores (34 m,
  lapping; a ring probe of the water surface twice a second) is an emitter;
  only the 8 loudest at the listener get a voice, a playing one keeps its
  slot unless a newcomer is 1.6x louder, and voices fade in (0.3 s) and
  out (0.25 s, then stop and disconnect). By day a smith hammers at every
  forge within 36 m (bursts of 2-4 strikes ~0.45 s apart, then 2.5-6 s),
  scheduled sample-exact.
- **Rain and weather** (`acoustics.ts`): rain builds over ~15 s from a
  drizzle and dies away over ~10 s (the weather is on/off), breathing a
  little while it falls; above 0.6 a thunder rumble from a strike 0.6-5 km
  away every 25-80 s, arriving at the speed of sound, quieter and darker
  the further. Wind, open-air rain, thunder and insects go through one
  weather submix: under a porch or bridge (roof over your head, a 5-point
  probe) it is a little quieter and duller, inside walls x0.22 and
  low-passed to ~650 Hz while a "rain on the roof" drumming layer rises in
  its place. Walking through a doorway crossfades over ~0.3 s. In a cave,
  surface weather fades with the distance to the nearest opening and the
  depth (`caveLeak`: ~0.6 at the mouth, ~0.25 ten metres in, under 0.05 by
  thirty) and is low-passed down to ~300 Hz; no roof drumming underground.
- **Interiors and caves**: indoors a small-room reverb (send 0.32, sized
  by the room) and a gentle 11 kHz low-pass on the sfx and ambience buses;
  underground the chamber reverb (as before) and a 7.5 kHz low-pass. UI,
  music and voice stay dry.
- **One-shot hygiene** (`voiceLimit.ts`): per-cue cooldowns as before; the
  same cue at the same place (1.2 m) within 70 ms is one sound; at most 3
  starts of one cue in 45 ms (an area hit on eight enemies); never the same
  variant twice in a row; +/-10 % gain on top of each cue's pitch spread; a
  4 ms ramp when a file starts mid-way.
- **Footsteps by surface**: grass/dirt (`step_soft`), stone in towns, caves
  and on stone town boxes (`step_hard`), planks on floors, decks, bridges
  and ramps (`step_wood`: the stone knocks a fifth lower), wading in
  shallow water (`step_water`), snow in the snowpeak biome (`step_snow`).
- **Mix**: music ducks to 35 % while anyone in voice speaks (ambience 60 %,
  sfx 80 %) and to 50 % under big stings (ambience 72 %); a hidden tab
  fades music, ambience and effects out in ~0.5 s (voice chat stays) and
  back in when you return.

## Music

| State | When (priority, highest first) | Plays |
| --- | --- | --- |
| timed | Town defense: warning countdown, waves; a boss's last phase (enrage) | **time crunch**: *intro* at the warning, then *loop*; *5 sec left* when 5 s remain before the first wave, when the ward is under 30 %, or a boss under 15 %. Intro, loop and final run phase-locked, so switches are seamless |
| void | A Void domain (6 s) | **void realm**, open |
| cave | Underground (latched in at 0.55, out at 0.35) | **void realm**, low-passed at 6 kHz |
| combat | Hit or hurt in the last seconds, a telegraph within 18 m, a boss bar | **combat**: 16 bars of the Novation Analog Synthwave pack (134 bpm), gapless |
| silence | The Hush's entrance (CR 035: it is the silence; its toll and the lord's sting carry the moment) | nothing |
| void (the Heartfall) | The Hush's fight and its choir (finale phases 2 and 4) | **void realm**; the endless night's countdown is a timed objective (the time crunch, "5 sec left" before it falls); the dawn after the victory switches to the day at once |
| night | 18:30-06:00 (in towns too) | **night**: see "Gaps"; plays the nocturne cut of future land 2 for now |
| town | Inside a settlement by day | **future land**, warmer (3.2 kHz low-pass) and softer |
| day | Otherwise | **future land 1** and **future land 2**, alternating each time day music comes back and at every track end |

Rising priority switches at once; falling back waits 4 s (no flapping at
a cave mouth or a town wall). Changes crossfade (1-5 s by state); a
track crossfades into the next 6 s before it ends. Music ducks to 35 %
while anyone in voice is speaking (voice keeps priority), and to 50 %
under big stings (level-up, boss, discovery).

## Sound effects: cue sheet

Sources: **Nicole** = `Documents/ableton/rpg`; D1/D2/D3 = Novation
Anniversary Soundpack 1st Drop / Pack 2nd Drop / 3rd Drop (`C:\Samples`).
Variants are picked at random with a small pitch spread. "spatial" cues
take a world position.

| Cue | Variants | Made from | Plays when |
| --- | --- | --- | --- |
| `ui_click` | 3 | D1 Hyperpop: FX_Gm_150bpm_4; D3 Indie Hip Hop: One Shot 3; D3 Indie Hip Hop: One Shot 4 | Any HUD button click (AudioRoot listener) |
| `ui_confirm` | 1 | D2 Japanese LoFi: FX 12; D1 Hyperpop: FX_Gm_150bpm_4 | trigger `ui_confirm` |
| `ui_open` | 1 | D3 Indie Hip Hop: One Shot 1 | Inventory (I), crafting panel, sound panel open |
| `ui_close` | 1 | D3 Indie Hip Hop: One Shot 1 | Same panels closing |
| `ui_error` | 1 | D2 East Coast Hip Hop: One-Shot 2; D3 Indie Hip Hop: One Shot 5 | Event 403 item_refused |
| `map_open` | 1 | D1 Old School Hip-Hop: FX_Em_107bpm_4; D1 FX: Noise Sweep FX | Map (M) opens (exploration store) |
| `map_close` | 1 | D1 Old School Hip-Hop: FX_Em_107bpm_4 | Map closes |
| `notify` | 1 | D2 Japanese LoFi: FX 12 | spare UI notification |
| `whisper` | 1 | D2 Japanese LoFi: FX 12 | A whisper arrives while the chat is closed (social store unread, spec 9) |
| `quest_accept` | 1 | D2 East Coast Hip Hop: One-Shot 6; D1 Hyperpop: FX_Gm_150bpm_4 | Event 803 bounty_accepted; trigger `quest_accept` |
| `quest_complete` | 1 | **Nicole: level up sound 2**; D2 East Coast Hip Hop: One-Shot 6 | trigger `quest_complete`  |
| `step_soft` | 4 | D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums12; D1 Acoustic Drums: Acoustic Drums13; D1 Acoustic Drums: Acoustic Drums10; D1 Acoustic Drums: Acoustic Drums2 | Footsteps on grass/dirt (movement.ts, per stride) |
| `step_hard` | 4 | D1 Acoustic Drums: Acoustic Drums16; D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums12; D1 Acoustic Drums: Acoustic Drums14; D1 Acoustic Drums: Acoustic Drums13; D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums10 | Footsteps on stone: town streets, stone town boxes, caves |
| `step_snow` | 3 | D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums12; D1 Acoustic Drums: Acoustic Drums13 | Footsteps in the snowpeak biome |
| `step_wood` | (4) | `step_hard`'s files at 0.8x | Footsteps on building floors, decks, bridges, ramps |
| `step_water` | (2) | `swim_stroke`'s files at 1.35x, quiet | Wading in shallow water |
| `jump` | 2 | D1 FX: Fast FX | Leaving the ground / double jump |
| `land` | 2 | D1 Acoustic Drums: Acoustic Drums13; D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums16; D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums2; D1 Acoustic Drums: Acoustic Drums14 | Landing from a fall over 3 m/s (louder with speed) |
| `dash` | 2 | D1 FX: Fast FX | Dodge/dash (trigger `dodge`) |
| `dodge` | 1 | D1 FX: Fast FX | Event 207 evaded (dodge) |
| `splash` | 1 | D3 EBM Energy: FX 0001; D1 Acoustic Drums: Acoustic Drums12 | Entering water; Event 100 drowned |
| `swim_stroke` | 2 | D1 FX: Water FX | Swimming strokes (every 1.1 s while moving) |
| `glide_open` | 1 | D1 FX: Swipe FX; D1 Old School Hip-Hop: FX_Em_107bpm_8 | Glider opens |
| `climb_grab` | 3 | D1 Acoustic Drums: Acoustic Drums15; D1 Old School Hip-Hop: FX_Em_107bpm_4; D1 Acoustic Drums: Acoustic Drums14; D1 Acoustic Drums: Acoustic Drums5 | Climbing, a grab per 0.55 m |
| `swing_sword` | 3 | D1 FX: Swipe FX; D3 Indie Hip Hop: One Shot 10; D1 Analog Synthwave: FX_Bbm_134bpm_7 | Sword light/sprint/air attacks (local prediction; Event 214 for others, spatial) |
| `swing_heavy` | 1 | D1 FX: Swipe FX; D1 Hyperpop: FX_Gm_150bpm_10 | Sword heavy, plunge, riposte; spear heavy |
| `thrust_spear` | 2 | D1 FX: Fast FX; D1 Hyperpop: FX_Gm_150bpm_13; D1 Old School Hip-Hop: FX_Em_107bpm_3 | Spear attacks |
| `swing_staff` | 1 | D1 FX: Swipe FX | Staff bonk |
| `wand_flick` | 1 | D2 Japanese LoFi: FX 10; D1 FX: Fast FX | Wand jab |
| `bow_draw` | 1 | D3 Indie Hip Hop: One Shot 11; synthesized | Right mouse held with a bow |
| `bow_release` | 1 | D1 Hyperpop: FX_Gm_150bpm_4; D1 FX: Fast FX | Bow quick shot / charged release |
| `bolt` | 2 | D2 Japanese LoFi: FX 10 | Staff and wand bolts |
| `hit` | 4 | D1 Acoustic Drums: Acoustic Drums4; D1 Acoustic Drums: Acoustic Drums12; D1 Hyperpop: FX_Gm_150bpm_13; D1 Acoustic Drums: Acoustic Drums2; D1 Acoustic Drums: Acoustic Drums13; D1 Hyperpop: FX_Gm_150bpm_7; D1 Acoustic Drums: Acoustic Drums10; D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums15 | Predicted melee/projectile hit on an enemy; Event 200 (others' hits), 222 |
| `hit_crit` | 2 | D1 Acoustic Drums: Acoustic Drums4; D1 Acoustic Drums: Acoustic Drums15; D1 FX: Metallic FX; D1 FX: Hit FX; D1 Acoustic Drums: Acoustic Drums2; D1 Acoustic Drums: Acoustic Drums12 | Event 200 with the crit flag |
| `hit_resist` | 1 | D1 FX: Metallic FX; D1 Acoustic Drums: Acoustic Drums2 | spare (resisted hit) |
| `arrow_hit` | 2 | D3 Horror Trap: Lantern Short; D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums5; D1 Acoustic Drums: Acoustic Drums12 | Arrow hits |
| `parry` | 1 | D1 FX: Metallic FX; D3 Acid Techno: STAB B 3 | Event 207 evaded, parry |
| `cast_fire` | 2 | D3 Horror Trap: Carve SFX | Fire spell cast (local, and Event 214 for others) |
| `impact_fire` | 1 | D2 Retro Disco: FX 9; D1 Acoustic Drums: Acoustic Drums15 | Fire spell hit / explosion |
| `cast_ice` | 1 | D1 FX: Metallic FX; D1 FX: Airy FX | Ice spell cast |
| `impact_ice` | 1 | D2 East Coast Hip Hop: One-Shot 5; D1 FX: Metallic FX | Ice spell hit |
| `cast_lightning` | 1 | D2 East Coast Hip Hop: One-Shot 7; D1 FX: Glitch FX | Lightning spell cast |
| `impact_lightning` | 1 | D1 FX: Glitch FX; D1 FX: Cymbal Hit FX | Lightning spell hit |
| `cast_earth` | 1 | D2 Japanese LoFi: FX 4; D1 Old School Hip-Hop: FX_Em_107bpm_4 | Earth spell cast |
| `impact_earth` | 1 | D2 Japanese LoFi: FX 4; D1 Old School Hip-Hop: FX_Em_107bpm_4; D1 Acoustic Drums: Acoustic Drums13 | Earth spell hit (and untyped AoE) |
| `cast_wind` | 1 | D1 FX: Noise Sweep FX | Wind spell cast |
| `impact_wind` | 1 | D3 EBM Energy: FX 0015 | Wind spell hit |
| `cast_light` | 1 | D3 Acid Techno: FX STAB A 5; D2 Japanese LoFi: FX 12 | Light spell cast (also forms) |
| `impact_light` | 1 | D2 East Coast Hip Hop: One-Shot 6; D1 Hyperpop: FX_Gm_150bpm_4 | Light spell hit |
| `cast_dark` | 1 | D1 FX: Deep FX; D2 Phonk Hip Hop: Vocals 3 | Dark spell cast |
| `impact_dark` | 1 | D1 FX: Short Delay FX | Dark spell hit |
| `cast_void` | 1 | D1 FX: Control FX; D1 FX: Abyss FX | Void spell cast |
| `impact_void` | 1 | D1 FX: Robot Scream FX; D1 FX: Hit FX | Void spell hit |
| `domain` | 1 | D1 FX: Long Tail FX; D1 FX: Deep FX | Domain spells (any element); a Void domain also starts the void music |
| `spell_refused` | 1 | D3 Indie Hip Hop: One Shot 5; D3 Indie Hip Hop: One Shot 2 | Event 215 refused (cooldown, mana) |
| `player_hurt` | 2 | D1 Acoustic Drums: Acoustic Drums13; D1 Acoustic Drums: Acoustic Drums2; D3 Indie Hip Hop: One Shot 4; D1 Acoustic Drums: Acoustic Drums10 | Event 202 player_hurt (you) |
| `player_downed` | 1 | D2 East Coast Hip Hop: One-Shot 2; D1 FX: Hit FX | Event 203 player_downed (you) |
| `respawn` | 1 | D1 FX: Soft Riser FX; D2 Japanese LoFi: FX 12 | Event 221 respawned |
| `enemy_die` | 2 | D1 FX: Hit FX; D1 Old School Hip-Hop: FX_Em_107bpm_4 | Event 201 enemy_died (spatial) |
| `heal` | 1 | D1 Hyperpop: FX_Gm_150bpm_8; D2 Japanese LoFi: FX 12 | Event 217 heal (you) |
| `shield` | 1 | D1 FX: Metallic FX; D1 FX: Abyss FX | Event 219 shield |
| `drink` | 1 | D1 FX: Water FX | Event 218 consumable (drink starts) |
| `telegraph` | 1 | D3 Indie Hip Hop: One Shot 11; D3 Horror Trap: Danger Harsh | Event 204 telegraph: an enemy winds up (spatial; near you = combat music) |
| `enemy_shot` | 1 | D2 Japanese LoFi: FX 10 | Event 205 enemy_projectile (spatial) |
| `beast_growl` | 2 | D1 FX: Robot Scream FX; D3 Horror Trap: Danger Harsh | spare (beast aggro; not wired: no aggro event) |
| `demon_growl` | 3 | D2 Phonk Hip Hop: Vocals 3; D1 FX: Robot Scream FX; D3 Horror Trap: Danger Harsh; D2 Phonk Hip Hop: Vocals 5 | Event 505 demons_rose (with demons_rise); 503 demon fled at dawn |
| `demons_rise` | 1 | D1 FX: Long Tail FX; D1 FX: Deep FX; D1 FX: Hit FX | Event 505 demons_rose (spatial, 120 m) |
| `demon_shrug` | 1 | D3 Horror Trap: Steel SFX | Event 504 demon_shrugged |
| `demon_burn` | 2 | D3 Horror Trap: Carve Effects; D3 EBM Energy: FX 0001 | Event 503 demon_burned at dawn (spatial) |
| `lord_risen` | 1 | D1 FX: Eerie FX; D1 FX: Robot Scream FX; D1 FX: Long Tail FX | Event 506 lord_risen |
| `boss_engaged` | 1 | D1 FX: Long Tail FX; D1 FX: Hit FX; D3 Horror Trap: Danger Harsh | Event 209 boss_engaged |
| `boss_phase` | 1 | D1 FX: Robot Scream FX; D1 FX: Hit FX | Event 208 boss_phase (spatial) |
| `boss_defeated` | 1 | **Nicole: level up sound 3**; D1 FX: Cymbal Hit FX | Event 210 boss_defeated |
| `mine_stone` | 3 | D3 Horror Trap: Lantern Short; D1 Acoustic Drums: Acoustic Drums4; D1 FX: Metallic FX; D1 Acoustic Drums: Acoustic Drums2; D1 Acoustic Drums: Acoustic Drums13 | Pickaxe on an ore vein (CaveAudio.hit, solo and online) |
| `mine_gem` | 2 | D1 FX: Metallic FX; D2 Japanese LoFi: FX 12 | Pickaxe on a gem cluster |
| `vein_break` | 1 | D1 Old School Hip-Hop: FX_Em_107bpm_4; D2 Japanese LoFi: FX 4 | Vein breaks (local break, Event 702) |
| `loot_common` | 1 | D2 Japanese LoFi: FX 12 | Loot r0 (Event 401); pickups (CaveAudio.chime, Event 411) |
| `loot_uncommon` | 1 | D2 Japanese LoFi: FX 12 | Loot r1 |
| `loot_rare` | 1 | D2 East Coast Hip Hop: One-Shot 6; D2 Japanese LoFi: FX 12 | Loot r2; Event 410 gem_combined |
| `loot_epic` | 1 | D1 Hyperpop: FX_Gm_150bpm_11; D2 East Coast Hip Hop: One-Shot 6 | Loot r3-4 (relic, legendary) |
| `loot_mythic` | 1 | D1 FX: Ripple Riser FX; D2 East Coast Hip Hop: One-Shot 6; D1 FX: Cymbal Hit FX | Loot r5-6 (mythic, primordial) |
| `loot_bitchin` | 1 | D1 FX: Ripple Riser FX; **Nicole: level up sound 3**; D1 FX: Cymbal Hit FX; D1 Hyperpop: FX_Gm_150bpm_11; D1 FX: Glitch FX | Bitchin' (r7, Event 401) and Event 402 (full for the finder, softer for everyone else in the zone) |
| `coins` | 2 | D2 Japanese LoFi: FX 12 | Gold only loot (Event 401 currency); Event 807 purchase |
| `chest_open` | 1 | synthesized; D1 Acoustic Drums: Acoustic Drums13; D2 Japanese LoFi: FX 12 | Event 407 container_opened; trigger `chest_open` |
| `item_drop` | 1 | D3 Indie Hip Hop: One Shot 5; D1 Acoustic Drums: Acoustic Drums10 | Event 408 dropped |
| `forge_hammer` | 3 | D1 FX: Metallic FX; D1 Acoustic Drums: Acoustic Drums15; D1 Acoustic Drums: Acoustic Drums4; D1 Acoustic Drums: Acoustic Drums12; D1 Acoustic Drums: Acoustic Drums2; D1 Acoustic Drums: Acoustic Drums13 | Event 405 crafted (with craft_done); a smith at every forge within 36 m by day (07:00-19:00) |
| `smelt` | 1 | D3 Horror Trap: Carve SFX; D3 EBM Energy: FX 0001 | Event 805 station_opened, forge |
| `craft_done` | 1 | D2 Japanese LoFi: FX 12; D2 East Coast Hip Hop: One-Shot 6 | Event 405 crafted |
| `station_open` | 1 | synthesized; D1 Acoustic Drums: Acoustic Drums12 | Event 404 station (cooking), 805 anvil |
| `npc_talk` | 3 | D3 Indie Hip Hop: One Shot 2; D3 Indie Hip Hop: One Shot 3; D3 Indie Hip Hop: One Shot 4 | Event 800 npc_say |
| `door_open` | 2 | synthesized; D1 Acoustic Drums: Acoustic Drums10; D1 Acoustic Drums: Acoustic Drums12 | trigger `door_open`  |
| `door_close` | 1 | D1 Acoustic Drums: Acoustic Drums13; D1 Acoustic Drums: Acoustic Drums16; D2 East Coast Hip Hop: One-Shot 3 | trigger `door_close`  |
| `rest` | 1 | D1 FX: Chimes FX | Event 804 rested |
| `dusk` | 1 | D1 FX: Eerie FX | Event 501 dusk |
| `dawn` | 1 | D1 FX: Airy FX; D2 East Coast Hip Hop: One-Shot 6 | Event 502 dawn |
| `ignite` | 2 | D3 Horror Trap: Carve SFX; D3 EBM Energy: FX 0001 | Event 520 chem_ignite (spatial, 60 m) |
| `extinguish` | 1 | D3 EBM Energy: FX 0001 | Event 521 chem_extinguish |
| `freeze` | 1 | D2 East Coast Hip Hop: One-Shot 5; D1 FX: Metallic FX | Event 522 chem_freeze |
| `pillar` | 1 | D2 Japanese LoFi: FX 4; D1 Old School Hip-Hop: FX_Em_107bpm_4 | Event 523 chem_pillar |
| `ward_falter` | 1 | D1 FX: Decay Riser FX_Gm; D3 Indie Hip Hop: One Shot 8 | Event 510 defense_warning (and the time-crunch music starts) |
| `ward_hit` | 1 | D1 FX: Short Delay FX; D1 FX: Metallic FX | Event 512 ward_health when it drops |
| `wave_horn` | 1 | synthesized; D2 Modern Hip Hop: FX 9 | Event 511 defense_wave |
| `defense_held` | 1 | **Nicole: level up sound 3**; D1 FX: Cymbal Hit FX | Event 513 defense_ended, held |
| `defense_broken` | 1 | D2 East Coast Hip Hop: One-Shot 2; D1 FX: Long Tail FX; D3 Horror Trap: Danger Harsh | Event 513 defense_ended, broken |
| `discovery` | 1 | D1 FX: Textured Riser FX; D2 East Coast Hip Hop: One-Shot 6; D2 Japanese LoFi: FX 12 | Event 602 discovery; trigger `discovery_intro` |
| `tower_riser` | 1 | D1 FX: Shade Riser FX | trigger `tower_attuning`  |
| `tower_attune` | 1 | D1 FX: Ripple Riser FX; D1 FX: Tower FX; **Nicole: level up sound 2** | Event 600 tower_unlocked; trigger `tower_attuned` |
| `waypoint` | 1 | D2 World Flute Trap: Fx1 0020; D2 Japanese LoFi: FX 12 | Event 601 waypoint_activated |
| `level_up_small` | 1 | **Nicole: level up sound 1** | Event 604 level_up (ordinary level) / trigger `level_up` |
| `level_up` | 1 | **Nicole: level up sound 2** | Level-up on a multiple of 5, or 2 levels at once |
| `level_up_big` | 1 | **Nicole: level up sound 3** | Level-up on a multiple of 10, or 3+ levels at once |
| `skill_up` | 1 | D1 Hyperpop: FX_Gm_150bpm_11 | Event 216 skill_up |
| `camp_cleared` | 1 | D1 FX: Cymbal Hit FX; D2 East Coast Hip Hop: One-Shot 6 | Event 211 camp_cleared |
| `bell_toll` | 1 | synthesized (`bells.ts`, a cracked bronze bell about G3, flat) | Event 204 for `bell_toll` (a Hollow Bell), on the strike (delayed by the wind-up); the choir starting (1603 phase 4: three bells) |
| `hush_toll` | 1 | synthesized (an octave and a fourth lower, longer) | Event 204 for `hush_toll`; the Hush rising (1604) |

Story moments (playtest 2 immersion pass; Events 1600-1612 were silent):
an act's title card (1602) plays `discovery`; the Hush rising (1604) its
toll then `lord_risen`; the finale's phases (1603) the choir's bells
(`bell_toll` x3), the endless night (`ward_falter`), the dawn (`dawn`); the
ending (1605) `defense_held`; a friend down near you (1610) `notify`, a
revive's hold (1612) `heal`, a revived player (1611) `respawn`.

Ambience (synthesized, `ambience.ts`): wind (louder up high, in rain and
with speed while gliding or falling), rain (seeded weather or the zone's
override, at the rain intensity), rain on the roof (under cover), thunder
(heavy rain), night insects (dry nights outside towns), underwater hush
(swimming), cave drips (underground, through the cave reverb). Playtest 2
immersion pass, wildlife by the biome under you (`wildlife.ts`, pure and
tested; voices synthesized per call in `ambience.ts`, through the weather
submix so walls muffle them): songbirds by day (five phrase shapes: a
warble, a falling trill, two whistles, chip-chip-cheee, a dove's coo; the
dawn chorus loudest, a quieter midday, an evening song) in meadows, woods
and wetlands, a hawk's descending cry over the highlands and badlands, a
chorus of frogs on wetland nights (rain does not stop them), an owl's
"hoo ... hoo-hoo" in the woods at night; rain, snow and gales hush the
birds, towns halve them, caves silence them all. Fires and
water are positional loops (`loops.ts`, rendered by `synth.ts`), not beds:
see "Space and distance".

## Not-yet-wired hooks (for the merge)

Defined and tested in `triggers.ts`; each is one line at its call site:

| Trigger | Call it from | Plays |
| --- | --- | --- |
| `emitSound('level_up', { level, gained })` | pt/progression level-up toast (Event 604 already plays it, so call only for client-side level-ups) | Nicole's level up sound 1/2/3 by size |
| `emitSound('tower_attuned')` | pt/progression tower attunement event (Event 600 already plays it) | riser into "Tower" + level up sound 2 (`tower_attune`) |
| `emitSound('quest_accept')` / `emitSound('quest_complete')` | pt/ux quests (Event 803 bounty_accepted already plays accept) | shimmer / level up sound 2 up a tone |
| `emitSound('door_open', { at })` / `emitSound('door_close', { at })` | pt/ux doors (spatial) | synthesized wooden creak / thud |
| `emitSound('discovery_intro')` | pt/ux discovery intros | riser + shimmer |
| `emitSound('chest_open', { at })` | a client-side chest lid animation (Event 407 already plays it) | creak + lid + sparkle |
| `emitSound('tower_attuning')` | the start of an attunement build-up, if pt/progression adds one | riser (`tower_riser`) |
| `beast_growl` cue | an enemy aggro event, if the zone ever sends one | growl |

Events that exist on main but are deliberately silent: 212 combat_sync,
213 mana, 206 status, 400 inventory, 406 containers, 500 world_clock,
514 defense_reward, 524/525 chemistry baselines, 603/605/607/608, 701
vein_hit (the local swing already sounded; 702 and 704 play through CaveManager's CaveAudio).

## Rebuilding the assets

```
node tools/audio/build-audio.mjs               # all (about 2 minutes)
node tools/audio/build-audio.mjs --only hit,ui_click
```

The design is data in `tools/audio/cues.config.mjs` (layers, slices,
filters, gains); the builder needs ffmpeg with libopus and the source
folders (`LODESTONE_AUDIO_RPG`, `LODESTONE_AUDIO_SAMPLES`), and rewrites
`assets/`, `cueFiles.gen.ts`, `tools/audio/manifest.json` and the audio
block of `CREDITS.md`. Drop-in fixes: when the night theme is re-exported,
change the `night` entry in `MUSIC` to `{ id: 'night', src: RPG('night overworld theme'), lufs: -18 }`
and rebuild with `--only night`.

## Gaps

- **"night overworld theme" is silent**: both the .aif and the .mp3 are
  2.4 s of near-silence (-90 dBFS), an export problem. Night plays a
  nocturne cut of future land 2 (its quiet middle, two semitones down,
  darker and roomier) until it is re-exported; see above for the one-line swap.
- Remote players' footsteps are not voiced (crowds); remote attacks and
  casts are (Event 214, spatial).
- Smiths hammer at every forge by day whether or not the blacksmith NPC is
  standing at it (online NPCs wander); doors do not change occlusion (an
  open doorway muffles like a wall); occlusion is by space (building,
  cave, outdoors), not ray-cast; the water probe hears a river or a shore,
  not waterfalls (worldgen has no waterfall feature to find).
- The Gentleman Library (Kontakt piano, encrypted .nkx/.nkc) cannot be
  used as raw audio and was skipped.

## Testing

- `npx vitest run src/audio`: director state machine, trigger map (every
  cue built, every element and rarity distinct, zone events, footsteps by
  surface), movement sounds, settings validation; audio QoL: distance,
  air and occlusion curves (`spatial.test.ts`), cave leak, weather through
  the shelter, interiors, rain intensity, ducking, thunder
  (`acoustics.test.ts`), roofs/indoors/underfoot on synthetic buildings and
  on the official world's 400 first closed buildings (`shelter.test.ts`,
  needs worldgen.wasm), voice limiting and variation (`voiceLimit.test.ts`),
  loop selection and fire clustering (`loopPool.test.ts`), world emitters,
  smith rhythm, footstep surfaces (`emitters.test.ts`).
- `node client/src/audio/dev/audio-browser.mjs`: headless Chromium, solo,
  no servers (random port). Checks the context is created inside the Play
  gesture and runs, no audio request before the first playable frame,
  day -> night -> town-night -> cave -> combat -> timed (intro, 5 s left)
  music audible on the master analyser, footsteps and jumps from real
  input, SFX for triggers and zone events, the environment pass, rain
  outside vs inside a house (quiet, muffled, roof drumming, room reverb,
  wooden floor), town fires as capped loop voices, a burst of hits
  limited, thunder, the hidden-tab fade, settings persistence and mute.
  Writes `docs/evidence/audio-headless.txt` and `audio-settings.png`.
- Console: `__lodestoneAudio.state()`, `.env()` (shelter, leak, rain,
  surface, loop voices), `.forceRain(true)`, `.thunder(1500)`, `.play('loot_bitchin')`,
  `.trigger('level_up', {level: 10})`, `.zoneEvent(501)`,
  `.force({hour: 22})` / `.force({underground: 1})` / `.force(null)`.
