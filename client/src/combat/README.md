# client/src/combat

The client side of combat (WP13). Online only: NetPlay attaches it to the
zone session (`link.ts`), offline play has no enemies.

| File | What |
| --- | --- |
| `timeline.ts` | The step-synchronous timeline (runs inside LocalSim's 60 Hz steps): input buffer (150 ms), attack starts and combos, dodge-cancel, bow draw / spear charge, sword parry, spell slots with cooldown + mana prediction, mobility spells as dash variants, elemental form (Q), technique (V; the middle mouse button toggles the camera view), drink (R). Mirrors `server/zone/internal/combat/player.go` |
| `runtime.ts` | Input listeners, predicted hits (melee arcs on the active frames, local projectiles, beams, chains, area and lingering spells, runes), spark + hitstop at once, HitClaims, numbers on HitResult, combat Events -> HUD/FX; every spell visual (yours, other players' via Event 214, statuses 206, shields 219, enemy projectiles 205) goes to the spell FX engine (`fx/`, below) |
| `probe.ts` | The input-to-hit timing probe (press -> first hit frame, feedback, recovery, dodge-cancel, i-frames, buffer, hitstop, drink, wind-ups, confirmation) |
| `events.ts` | Event kinds 200-222, Interact 50, `combat_sync` / telegraph decoders, typeId unpacking |
| `store.ts` | HUD state (zustand, event-rate) and the FX queue (numbers, telegraphs, swings, the enemy hit flash) |
| `CombatLayer.tsx` | Enemies, telegraph decals, the hit flash, floating numbers; mounts the first-person weapon (`weapons/`) and the spell FX layer (`fx/SpellFxLayer.tsx`) |
| `weapons/` | Procedural weapon models, the first-person weapon and the weapon look other players see (pt/ux, below) |
| `CombatHud.tsx` | Health, mana, weapon (the equipped item's name, else the type) + four spell slots with cooldowns, draughts, boss bar, toasts, downed overlay |
| `link.ts` | Session attach, PlayerDriver hooks, `window.__lodestoneCombat` (probe, HUD) |
| `dev/feel-browser.ts` | Headless Chromium feel run against the real zone (`npm run combat:browser -w client`) |

Controls (playtest 1, `spellSelect.ts`): LMB attack; **mouse wheel** selects
what the right button uses: the weapon's secondary (parry for the sword,
draw for the bow, charge for the spear, heavy/bonk for the staff and wand;
the default, so RMB behaves as in WP13 until you scroll) or one of the four
spell slots (empty slots are skipped; the selected box is raised with a
gold "RMB" badge); **RMB** uses the selection (casts the spell); **hold Z**
for the weapon's secondary at any time (parry or draw with a spell
selected); **1-4** still cast directly (and select their slot); F or Left
Alt dodge, Q elemental form, V weapon technique (middle mouse: first / third person), R draught,
X swap loadout (a slot that is empty in the new loadout falls back to the
weapon). The hint line under the bars says the same (`COMBAT_HINT`).
Selection is client-side only: the zone sees the same cast / alt_attack
input bits as before, so WP13's feel numbers and the timeline tests are
unchanged (`spellSelect.test.ts` drives the runtime through the wheel).

Overhead health bars (playtest 1): each enemy's bar (and an elite's or
boss's name label) sits in a plate that `faceCamera` turns to the camera
every frame, double-sided, so it reads from any side (it used to turn with
the body and vanished from behind; `billboard.test.ts`, screenshots
`docs/evidence/pt-ux-healthbars-{before,after}-{north,south,east,west}.png`).
Player nameplates (`net/avatar.ts`) and NPC labels were already sprites /
screen-space labels.

Tests: `npx vitest run src/combat` (feel limits in the tables, timeline
rules, wire decoders). The real-time numbers come from the probe run
(docs/evidence/wp13-feel.*).

## Weapons (pt/ux: "weapons don't look like weapons")

Sword, spear, bow, staff and wand are procedural models (no assets, nothing
in CREDITS.md), built once per look and cached for the session (never
disposed):

| File | What |
| --- | --- |
| `weapons/builder.ts` | Loft/lathe/sweep mesh builder: one indexed BufferGeometry per weapon with vertex colour and a `surf` attribute (metalness, roughness, glow) |
| `weapons/material.ts` | The ONE material every weapon, fist and forearm shares (a patched MeshStandardMaterial: per-vertex PBR terms, a sky/ground reflection for metal since the scene has no environment map, glow with a slow shimmer and rim); one program, compiled when the first weapon is drawn at zone join |
| `weapons/models.ts` | The five weapons at three detail levels, hands, the bow's dynamic string and nocked arrow |
| `weapons/look.ts` | Weapon look (type, material, gem) and its typeId packing |
| `weapons/FirstPersonWeapon.tsx` | The first-person rig: poses, fists and forearms, swing (hitstop-frozen, probe-measured exactly as before), bow draw, cast flicks, walk bob |
| `weapons/dev/preview.html` | Art preview on the Vite dev server (`/src/combat/weapons/dev/preview.html?sunsteel=1&gem=5`, `?d=1`, `?zoom=sword`); `dev/preview-shot.ts` screenshots it, `dev/tris.ts` prints triangle counts |
| `dev/weapon-shots.ts` | `npm run weapons:shots -w client [-- before]`: real client + real zone screenshots, docs/evidence/pt-ux-weapon-*.png |

What they look like: an arming sword (tapered, bevelled, fullered blade,
curved crossguard with finials and a langet carrying the gem on both faces,
leather-strapped grip, wheel pommel); a spear (ash shaft, strapped grip,
cord binding, socketed leaf head with a midrib and the gem at its base, butt
spike); a recurve bow (laminated limbs, leather grip, riser fittings, the gem
in the riser, a string that pulls back with the draw and an arrow nocked
while drawing); a staff (gnarled shaft, metal collar, four tines cradling a
large gem, plain quartz when none is socketed); a wand (ebony with carved
beads and spiral, metal ferrule, three claws holding the gem tip).

Materials colour the metal: steel by default, items.yaml copper, iron,
silver, sunsteel, starmetal, voidglass (oak = wooden). **Sunsteel** is a
warm gold-white with glowing edges and a shimmer running up the blade (it
reads at night too). Gems take their element colour (`ELEMENT_COLORS`) and
glow.

Budgets (triangles, one draw call each; fist 566, forearm 80):

| | first person | third person (< 25 m) | far (25-90 m) |
| --- | --- | --- | --- |
| sword | 1588 | 552 | 124 |
| spear | 1184 | 432 | 112 |
| bow | 964 | 448 | 76 |
| staff | 1252 | 354 | 68 |
| wand | 1068 | 222 | 68 |

The first-person view is 3 draw calls (weapon, right fist, right forearm),
5 with the off hand (spear shaft, bow grip); each remote player adds 1.

Where the look comes from: your own weapon and gem from the active loadout
(`combat_sync`), its material from the per-loadout material codes that now
end `combat_sync`; other players' from their entity's snapshot `typeId`
(weapon id | material code << 4 | (gem element + 1) << 8, contracts/
events.md "Players"), which the zone sets only when the loadout or gear
changes. Remote avatars hold it in the right hand (the bow in the left) on
the high LOD and at the side on the mid LOD.

Tests: `src/combat/weapons/weapons.test.ts` (budgets, bounds, determinism,
cache, gem and sunsteel glow, bow draw, typeId packing, combat_sync tail),
`src/net/avatar.test.ts` (a remote avatar holds and swaps the weapon);
zone: `server/zone/internal/game/weaponlook_test.go`.

## Spell VFX (playtest 2: "spells show nothing or are underwhelming")

Every spell visual is one imperative engine (`fx/`), ported and adapted from
Nicole's Wizard Wars spell FX library (`client/src/components/spells/fx`,
commit "spell vfx overhaul": GPU particles, pooled transients, shader
warm-up). `CombatLayer` mounts it online; debug solo builds mount it too
(for the gallery and the bench; `?nofx` leaves it out).

| File | What |
| --- | --- |
| `fx/api.ts` | `spellFx.*`: what gameplay calls (no three.js import; a no-op until the layer mounts; a throwing visual never breaks combat) |
| `fx/engine.ts` | `SpellFxEngine`: flying projectiles (looks, trails, hand origin, visual collision for remote/enemy shots), beams and chains, areas (circle / cone / line, lingering zones that follow their caster), domains, runes (arm, idle, trigger per enemy that steps in), direct-target spells and their windup marks, dashes, shields, elemental forms, statuses on enemies (particles + a tinted shell), Event 214 casts of other players (simulated, visual only), enemy projectiles (205); the off-hand flourish; the draw warm-up |
| `fx/recipes.ts` | What each family looks like: trails, impacts, explosions, area bursts, lightning strikes, zone / domain emission, runes, target spells, dashes, shields, statuses |
| `fx/spellVisual.ts` | Pure: spell -> family (fire, ice, lightning, nature / stone / crystal for earth, wind, light, dark / blood / void), palette, projectile look, spike style, sigil, weight, set piece |
| `fx/particles.ts` | GPU particles: two pools (additive 12k, smoke 3k), closed-form motion in the vertex shader, ring buffer, only the written slice uploaded: 2 draw calls for every particle |
| `fx/transients.ts` | Fixed pools: rings, flashes, scorch / sigil / zone decals (grids laid on the terrain when placed), domes, beams, shells, instanced spikes (6 styles), pooled point lights, bolts |
| `fx/bolts.ts` | Lightning as camera-facing ribbons, all bolts in one preallocated buffer (one draw call), re-crackled in place |
| `fx/materials.ts` | Beam, magic circle, ground zone, dome, shockwave ring, shell, ribbon shaders (unlit, light-count independent) |
| `fx/screen.ts` | One post `Effect` (medium/high) merged into the world's EffectPass: shockwave distortion, shake (a UV offset: the camera rig is untouched), capped flashes, the shield edge tint |
| `fx/quality.ts`, `fx/gpu.ts` | FX tiers and the settings hook; the GPU assessment |
| `fx/warm.ts` | One object per FX program for the WP19b shader warm-up (`world/warmExtras.ts`) |
| `fx/SpellFxLayer.tsx`, `fx/debug.ts` | The R3F mount (one useFrame), GPU sample, draw warm-up trigger; `window.__lodestoneFx` (debug builds: `cast(key)`, `spam(n, ms)`, `stats()`, `setFx(tier)`) |
| `fx/dev/gallery.html` | The FX gallery: the real engine and post chain over test ground with dummies (`/src/combat/fx/dev/gallery.html?tier=high`, `__gallery.cast('fireball')`, `.local(key)` first person, `.status('burn')`) |
| `fx/dev/fx-shots.ts` | `npx vite-node src/combat/fx/dev/fx-shots.ts [high low]`: the evidence sheets `docs/evidence/pt2-spell-vfx-*.png` |
| `fx/dev/fx-zone-shots.ts` | Real client x2 on a real zone: your casts and what another player sees (`pt2-spell-vfx-zone.jpg`) |
| `fx/dev/fx-bench.mjs` | Cast-spam bench in the real world (10 virtual casters, every spell); `LODESTONE_BENCH_UNCAPPED=1` (no vsync), `LODESTONE_BENCH_QUERY=solo&nofx` (A/B) |

**Before / after, per spell type** (before = what `CombatLayer` drew until
this pass):

| Type | Before | After |
| --- | --- | --- |
| projectile / arc (yours) | an unlit sphere that flew through terrain and bodies for its whole range; a 0.12 m octahedron on hit | a look per family (orb, needle, shard, void core, boulder, seed, wind crescent, light lance, ball lightning) with a glow halo and a family trail, leaving your off hand; impact bursts, flashes, rings, scorch; explosions with shockwaves, debris spikes and lights where it really ends (ground, body, range) |
| hitscan / beam | a 1 px `THREE.Line` (WebGL clamps line width) | volumetric beam shader with a hot core, impact and muzzle bursts; channelled beams stay up and re-aim; ultimates get set pieces (God Ray / Divine Judgement pillar from the sky, Monolith / Verdant Lance spikes, Null Gaze smoulder, Heaven's Exhale gale) |
| chain | 1 px lines | forked lightning ribbons per hop, re-crackled |
| aoe (circle / cone / line) | a flat translucent disc (floating or clipping on slopes, invisible for dark colours) | per family bursts; cones sprayed from the caster, lines erupt spikes racing outward; lingering zones as animated terrain-hugging floors with emission (blizzard snow, immolate flames, singularity spiral, cyclone funnel); windup sigils that fill where it will land; set pieces (Eruption, Lightning Strike, Act of God, Frost Nova, Sunburst, Let There Be Light, Collapse, Blood Nova, Thunderclap, Downburst) |
| domain | the same disc | dome (revealed from the ground up, faint from inside), floor and per-family weather (fire rain, blizzard, strikes, crystal / bramble growth, gale, sun rays, void spiral) |
| rune | a disc for its duration | a magic circle that arms (sweep), idles (motes) and detonates per family on each enemy that enters |
| direct | a disc on the target if one was found | per spell (Shatter, Petrify, Root Snare, Amaterasu, Unmake, Death Note / Unwritten with their long windup marks under the target) |
| mobility | nothing | a dash trail per family behind you (and others), bursts at both ends |
| defensive | nothing | a shield shell others see (from inside it is invisible), an edge tint for you, a break burst on Event 219 = 0; Halo: a ring over the head and rising motes |
| elemental form (Q) | a gold disc for 0.3 s | the form's shape burst in its element and a short aura |
| other players' casts (214) | nothing at all | the full cast, simulated from the event (windup, projectiles with visual collision, beams, areas, runes, dashes, shields, forms) |
| statuses (206) | nothing | per status particles (burn flames, freeze ice and frost, shock arcs, stun stars, slow motes, pull spiral, curse, black flame) and a tinted shell on the nearest enemies (medium and up) |
| enemy projectiles (205) | a red sphere through terrain | the attack's element look and trail, impact on the ground or you |

**Quality** (`fx/quality.ts`): FX tiers low / medium / high / ultra. Which
runs: `localStorage.lodestone_fx_quality` (an explicit FX override:
`setFxSetting`, or `__lodestoneFx.setFx('ultra')`) wins; else an explicit
graphics setting (`lodestone_quality_settings`) picks it (low -> low, medium
-> medium, **high -> ultra: "go all out"**); else (graphics auto) the auto
tier capped by the GPU assessment (`fx/gpu.ts`: the unmasked renderer string,
software -> low, mobile / old Intel HD -> medium, discrete / Apple Pro ->
ultra, then a 120-frame median: > 40 ms low, > 26 medium, > 18 high). The
assessment only ever picks that default. Low: a third of the particles, no
lights, no shake / flash / distortion, no status shells, no bloom (the post
chain has none on low). Ultra: 1.5x particles, hotter HDR cores (the bloom
threshold is 1.25), full shake and distortion. The point-light pool size is
fixed per shader tier when the layer mounts (low 0, medium 2, high 4) so lit
materials never recompile; an explicit setting change remounts it.
`prefers-reduced-motion` turns shake off and halves flashes.

**Settings hook** for the graphics-settings screen: `fxSettings()` in
`fx/SpellFxLayer.tsx` (current setting, tier, GPU cap,
`set('auto' | 'low' | 'medium' | 'high' | 'ultra')`).

**Performance**: nothing allocated per frame in the steady state (particle
writes, pools, bolts, decals; per-frame emitters use hoisted options; a cast
allocates a handful of small objects). Caps: 64 projectiles, 48 ongoing
effects, the transient pools (`POOL`), spikes and bolt segments per tier,
statuses on the nearest N enemies, a per-frame particle budget past which
bursts thin; far effects emit less and nothing past 90 m. Warm-up: every FX
program is in the WP19b compile (`warmExtras`), and once it is done the
engine draws every pooled object invisibly for a few frames (`prewarm`):
ANGLE builds each draw's D3D variant on its first real draw, which cost
60-110 ms hitches at the first casts until this. Numbers: docs/STATUS.md
"Playtest 2: spell VFX".

**Readability**: particles fade within ~2 m of the camera; your own
projectile's halo shrinks near the lens; beams fade near the camera; big
flashes are dimmer per pixel and capped near you; no spike grows within
1.5 m of the camera; sigils under your own feet stay faint; domes are a
faint tint from inside; floors are deep tones (never white) and enemy
telegraphs draw over them (renderOrder 6 vs 2-4); status shells are rims;
full-screen flashes are capped at 18 %; the crosshair is an HTML overlay
(the screen shake is a couple of pixels of UV offset).

**Third person**: your casts leave your avatar's hand (`view.third`);
`engine.handAnchor` can override it with the rig's real hand.

Tests: `src/combat/fx/fx.test.ts` (tier resolution and profiles, fxCount
scaling and the frame budget, GPU classification and the frame sample,
recipe selection for every spell in combat.yaml, pools and caps, the light
pool, spikes near the camera, bolts and the ribbon cap, the projectile cap,
the runtime's routing of casts and Events 214/206/219/205).
