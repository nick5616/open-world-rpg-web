# 0023: Art direction and graphics settings (playtest 2)

Date: 2026-11-09 · Branch `pt2/graphics`

Nicole: "add graphics options for different kinds of rpg styles and graphics
quality too"; "take inspiration in general from queen's domain";
"do not make the graphics exactly look like queen"; "dont make it copy queens
domain but make it so you can get there in the graphics settings. the main
graphics inspirations are valheim and breath of the wild".

## The default look: Valheim and Breath of the Wild in spirit, our own art

The geometry and textures stay ours (low-poly, CC0 PBR terrain). What moved
is light, shading and atmosphere, which is where both games get their
character and what a browser can afford (spec 12, "light first"):

- **Soft cel light** (BotW): the sun's N.L goes through a banded ramp with
  soft edges, blended 60 % with plain Lambert, so faces read as lit/shade
  without the hard comic look. The ramp is sqrt-shaped so the terminator sits
  low: a broad lit side, a narrow shade band.
- **Rim light** on upright surfaces only (characters, trunks, walls); never
  the ground, which at eye height is all grazing angles and would wash out.
- **Brighter, saturated, gradient skies** (BotW), shared with the fog colour so
  the horizon still matches; **strong aerial perspective** (1.6x haze).
- **Moody valley fog** (Valheim): height fog that thickens toward dusk and
  stays through the night, moonlit faintly blue; **warm firelight** (town
  lanterns and fires at 1.6x); darker nights than before (0.8x the night
  exposure lift).
- **Wind made visible**: grass leans 1.4x further and a bright sheen rolls
  through it with the gust fronts of the one wind field.
- **Water**: clearer turquoise shallows, a stronger fresnel and a broken
  second foam band lapping at the shore.
- **Soft bloom** on bright sources (lower threshold, more intensity); god rays
  where they already ran (High and Ultra).
- **Rain** now changes the world, not only the sky particles: wet darker
  ground (the terrain's `uWet` existed but was never driven), overcast clouds,
  dimmer sun, thicker air; the streaks moved into the world scene so solo
  play sees them too.

## Styles, not filters

Four art-direction presets, independent of quality: **Lodestone** (default),
**Painterly** (bold bands, ink outlines from depth edges, posterized flat
colour, banded sky), **Grim** (cold, desaturated, fog-bound, dark nights,
vignette) and **Retro 32-bit**. Retro is the knob that gets you close to a
late-90s console dungeon crawler (the look Nicole referenced) without copying
one: a fixed 240 internal rows upscaled nearest-neighbour, vertex snapping,
affine texture wobble and texel-snapped sampling on the town atlas, 15-bit
colour with a 4x4 ordered dither, and close fog (45-230 m) that also climbs
the sky at the horizon. It keeps Lodestone's palette and names nothing after
another game (a test checks the style names and blurbs).

## How a style costs nothing to switch

Every lit material in the game (terrain, scatter, towns, caves, avatars,
weapons, other packages' meshes) is a three.js built-in material or a patched
one. `world/style/styleShader.ts` patches four ShaderChunks once at start-up
(the RE_Direct functions for toon + rim, `logdepthbuf_vertex` for the snap,
`common` for two uniforms) and registers the uniforms on every ShaderLib
entry with a `Float32Array` value: `UniformsUtils.clone` passes typed arrays
through by reference, so all programs share one array and a style switch is a
write, not a recompile. The screen-side half is one more Effect merged into
the existing single EffectPass (`post/styleEffect.ts`), all uniforms. Only
Retro changes the chain (it removes bloom, god rays and MSAA and caps the
view distance so it is genuinely cheap), which rebuilds the post chain once
with the WP19b shader warm-up, like an explicit quality change.

## Quality: one store, one resolver

`stores/qualityStore.ts` stays the single source of truth (key
`lodestone_quality_settings`, now version 1; version 0 and bare legacy
strings migrate). Presets Low / Medium / High / Ultra (Ultra opt-in: auto
never picks it, spec 12's budgets are for High) plus per-control overrides
(render scale, DPR cap, shadows off/low/high and distance, view distance,
foliage, post effects, anti-aliasing incl. FXAA, max FPS, spell effects
quality). `stores/graphics.ts` `resolveGraphics()` turns preset + tier +
overrides + style into every number the renderer reads; cheap knobs follow
the auto-stepped tier, shader-shaping ones the shader tier (the WP19 rule).
Low and High resolve to exactly the pre-settings numbers.

First run with 'auto' reads the GPU from a throwaway WebGL2 context before
anything renders (so the world builds at the right tier, no recompile), then
samples frame times once the world is up and only ever lowers; the refined
tier is where auto starts next session. An explicit choice always wins.

The spell FX branch (`pt2/spell-vfx`) has its own FX tier and GPU classifier;
its FX setting should read `effects` from this store (one source of truth)
when it merges.

## A bug this exposed

Rebuilding the CSM shadow rig with the same cascade count (now common: a
style or shadow-distance change) crashed the frame: `CSM.dispose()` deletes
the cascade uniforms from the live shader objects, and a material whose
program key did not change keeps that program, so `WebGLUniforms.upload`
threw. `sky/sunShadows.ts` now restores the materials itself and hands the
next rig the live shader objects.
