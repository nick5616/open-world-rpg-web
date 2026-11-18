# CR 057: Graphics you can actually see (playtest 5, `pt5/graphics`)

Nicole: "I don't see the awesome graphics and trees my friend is seeing." and "Make the assets in the world better and higher fidelity, like that would make you want to live in this world, super immersive. For example, trees suck, houses are just okay."

Client-only. No protocol, Event, Interact, migration or worldgen change (scatter records, ids and positions are untouched). The persisted graphics setting moves to version 2 (see 1).

## Why Nicole saw something else

CR 045 (nine tree species, leaf cards, translucency, wind) and CR 046 (towns art) shipped, but both were **tier-gated**: Low drew the original low-poly blob trees (`WorldTier.vegetation: 0`) and the playtest-2 flat houses (`detailOfTier('low') = 0`), and the Auto tier could settle on Low for good (the first-run frame sample ran during world streaming and was persisted). On Low the forest was the first screenshot of `docs/evidence/pt5-graphics-before-forest-low.jpg`. Her friend's machine ran Medium or High.

## 1. Auto quality

`stores/gpuDetect.ts`, `stores/qualityStore.ts`, `scene/GraphicsApplier.tsx`, `ui/graphics/autoTierNotice.ts`.

- **Start optimistic.** `classifyGpu`: High on any discrete GPU, Apple silicon and *modern* integrated (Iris Xe, Arc, UHD 7xx, Ryzen "Radeon Graphics", 6x0M / 7x0M); Medium on older Intel / generic integrated; Low only for software GL and mobile; unknown renderer High unless 4 cores or fewer. Never Ultra (opt-in, as before).
- **Measure real play.** `AutoGovernor` (pure, tested): after the world is playable and the terrain tile queue is empty (or 25 s of waiting), it skips 2.5 s, then judges 5 s windows of per-frame deltas. p90 over **28 ms** in two consecutive windows steps one tier down (and forbids going up again); p90 at or under **18.5 ms** with a tier below High tries one step up (once; a failed try goes back and stays); three calm windows or 28 s settles it. Up to three stalls (frames over 500 ms: alt-tab, a load) per window are left out, a window that is mostly stall is discarded, more than three long frames is the machine and counts.
- **A step changes what is drawn.** `autoApply` sets `tier` and `shaderTier` together (shadows, vegetation art, post, town art), once, in the first seconds of play (one shader recompile; the earlier "cheap knobs only" rule made an Auto step change almost nothing visible). It applies in Auto only: an explicit tier (Low, Medium, High, Ultra) is never touched (tested, and in the real client).
- **drei's PerformanceMonitor is gone from the game canvas.** It stepped the cheap knobs on any busy second (on a loaded machine that undid the governor's verdict and left the tier shown in the notice different from the one running), so the governor now owns adaptation. Sustained stalls (stall after stall, under 1 fps) count as a bad window too.
- **Notice.** When the governor settles, once per tier the player has not been told about (`autoNoticed`, persisted): a small glass note under the Graphics button, 9 s, click to dismiss: "Graphics set to High; F10 to change".
- **Re-evaluation after this update.** The persisted quality state is version 2. Migrating from version 0/1, a player saved as `auto` loses the stored `detected` verdict (the old rules' possibly-Low result), so the optimistic guess and the governor run again; an explicit tier is kept as it was.
- Dev handle: `__lodestone.graphics()` now includes `autoTierLog` (each verdict with p50, p90).

## 2. Live tier switching (`toArray`)

Reproduced on a private stack with `LODESTONE_ANGLE=gl` (character, town, caves and vertical materials; teleport between switches) and not in a solo build: `Cannot read properties of undefined (reading 'toArray')` from `setValueV2fArray`, every frame after Medium -> High. Cause: three.js keeps one program per material per cache key and, when a material returns to a program it already has, reuses the uniform arrays of the *latest* compile. Three's `CSM` only resizes `CSM_cascades` (a `vec2[]` sized by the cascade count) in `updateUniforms`, which runs from `updateFrustums()`, not from `update()` and not when a rig is created. A material that already had the 3-cascade program kept a 2-entry array and the next draw read past it. Fix: `WorldScene` calls `sun.updateFrustums()` after the new rig has set up every material. Low -> Medium -> High -> Low -> ... (with teleports, auto, explicit) now runs with zero page errors: `tools/playtest/pt5-tier-switch-stack.mjs` (fails the run on any page error; before the fix 220 errors in one switch) and `pt5-tier-switch.mjs` (solo).

Also: the town meshes now follow the shader tier live (`TownsLayer` rebuilds the manager when it changes), so a live Low -> High switch gets the High town art instead of the first mount's.

## 3. Fidelity

**No tier draws the plain low-poly trees or the flat houses any more.**

Trees (`world/scatter`)
- Low uses the rich set (`vegetation: 0.5`, card budget 0.5 of High, one LOD0 variant pair, LOD1 and impostors as on the other tiers). Medium / High / Ultra as before (0.6 / 1 / 1.3).
- **Leaf masses**: about a fifth of the cards fill the crown core, the rest gather in clumps (about 11 cards each) on the outer tips with a shared tone, hue drift, lit top and dark underside, so the crown is separate clumps with branches and sky between them instead of a blob. Oak, birch, broadleaf and acacia.
- **Trunks**: per-tree taper exponent and slow swells, and 3-5 surface **roots** that hump over the ground and dive in (near mesh), on broadleaf, acacia, willow, dead trees and conifers; the existing flare and buttresses stay.
- **Bark**: grooves go dark and ridges catch light from the texture's own height, the foot of the trunk is damp, greener and darker.
- **Leaf shading**: subsurface term for leaves facing away from the sun (yellow-green glow, strongest on the lit, outer clumps; interior stays dark from the baked tone), on top of the existing look-toward-the-sun translucency; **per-tree colour** hashed from where the tree stands (some yellower, some bluer and darker), applied to legacy and rich materials.
- **Impostors**: 4 baked yaw views per species (atlas 9 x 4 tiles of 256 px, always baked from the full-density tree so Low's thinner trees do not bake as sparse cards); the billboard shader picks the two views nearest the viewing angle in the tree's own frame and dithers between them. A far forest turns as you walk past.

Houses (`world/buildings/kit.ts`, `detail.ts`)
- **Low shares Medium's town art** (`detailOfTier`: Low and Medium 1, High and Ultra 2): window frames and shutters, door surrounds, skirts, half-timber, roof tints. It is baked once per settlement; the cost is vertices, not per-frame work.
- **Roof courses** (detail 1+, not thatch): every shingle, tile or slate course gets a thin board proud of the roof with its own tone and the odd mossy course, so the roof reads as laid pieces with thickness and a shadow line.
- **Bevelled timber**: half-timber posts and the head plate are a broad base plus a narrower lighter chamfer cap.
- **Weathering**: rising damp and splashed mud above the stone skirt, two stepped bands of the wall's material, darker and greener, in 0.5-1.4 m runs each reaching a different height (no stripe).
- **Window depth**: a darker inner lip inside the frame (frame 6 cm, lip 5 cm, glass 1.5 cm).
- **Door**: a worn threshold stone under the door (5 cm, sunk into the ground below) on houses without a porch.

## Measured (RTX 3070, headless Chromium, solo, official seed, clear 0.42 h, 1280x720, GPU uncapped, `tools/playtest/pt5-graphics-shots.mjs`; the GPU is shared with other agents so frame times swing, read calls and triangles)

| view (tier) | draw calls before -> after | triangles before -> after | p50 ms before -> after |
|---|---|---|---|
| forest (Low) | 122 -> 145 | 0.62 M -> 0.84 M | 5.0 -> 6.1 |
| tree close (Low) | 128 -> 151 | 0.65 M -> 0.85 M | 3.9 -> 9.3 (noisy) |
| far forest (Low) | 131 -> 155 | 0.69 M -> 0.96 M | 4.6 -> 3.7 |
| house (Low) | 149 -> 160 | 0.61 M -> 0.74 M | 4.3 -> 3.6 |
| town street (Low) | 160 -> 170 | 0.65 M -> 0.81 M | (hitch) -> 4.3 |
| forest (High) | 423 -> 423 | 3.52 M -> 3.63 M | 11.7 -> 14.4 |
| tree close (High) | 426 -> 426 | 3.44 M -> 3.53 M | 12.9 -> 9.5 |
| far forest (High) | 433 -> 433 | 3.21 M -> 3.35 M | 11.0 -> 9.3 |
| house (High) | 352 -> 351 | 2.35 M -> 2.54 M | 16.1 -> 13.6 |
| town street (High) | 360 -> 362 | 2.40 M -> 2.61 M | 10.5 -> 12.6 |

Budgets (spec 12: 400 calls, 1.5 M tris, 33 ms Low / 16.6 ms Medium and High): Low is far inside them (about 150 calls, under 1 M tris). **High exceeds the 400-call and 1.5 M-triangle soft budgets exactly as it did before this change** (the forest was already 423 calls and 3.5 M tris from CR 045); this CR adds +0 to +2 calls and about +3-8 % triangles at High. Draw calls on Low rise by about 20 (the rich bins), still a third of High.

Evidence: `docs/evidence/pt5-graphics-{before,after}-{forest,tree,forest-far,house,town-street}-{low,high}.jpg`, `pt5-graphics-{before,after}-{low,high}.json`, `pt5-graphics-auto-tier.txt`, `pt5-graphics-auto-notice.jpg`.

## Verification

- `npx vitest run` over `src/stores`, `src/world/scatter`, `src/world/buildings`, `src/world/post` (GLSL audit), `tsc --noEmit`, eslint on touched files.
- Real client: `tools/playtest/pt5-tier-switch-stack.mjs` (stack, ANGLE-GL), `pt5-auto-tier.mjs` (Auto fresh, Auto on a throttled machine, explicit never touched, saved-as-Auto re-evaluated), `pt5-graphics-shots.mjs`.

## Gaps

- Trees on High are visibly better in the close and mid views but the step from CR 045 is moderate; the biggest change is Low (and Auto players who were on Low). Leaf cards are still large and stylised, bark is a tiled texture with a derivative bump, not geometry.
- Roof courses are boxes in the roof half's frame (vertical faces), not rotated to the slope; at a steep pitch the lip reads slightly taller. Thatch gets no courses. Dwarven and stilt houses get no grime / threshold.
- Houses were already richer than the first look on High; the new pieces are subtle from the street (a close-up shows them). Interiors, porches and doors' leaf were not redrawn.
- Town art is baked per settlement: an Auto verdict or a live tier switch that changes the shader tier rebuilds the towns (a brief re-stream); the governor's one verdict happens in the first seconds.
- Impostor lighting is still the flat sun/ambient mix of CR 045 (no normal bake).
- The governor measures vsync-capped deltas, so "headroom" on a 60 Hz display means p90 under 18.5 ms at the current tier, then it tries one step up and goes back if that fails. It cannot tell a 90 fps machine from a 61 fps one.
- Frame times could not be compared cleanly: other agents shared the GPU during the runs.
