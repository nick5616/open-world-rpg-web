// Visual styles (playtest 2: "add graphics options for different kinds of rpg
// styles"): art-direction presets, independent of the quality tier. A style
// is a table of numbers; nothing here allocates per frame or recompiles a
// shader when the player switches (styleShader.ts feeds the lit materials
// through shared uniforms, post/styleEffect.ts the screen pass, WorldScene
// the fog, grade, sky, water and light multipliers). The one exception is
// Retro, which also *removes* work (bloom, god rays, MSAA, view distance) so
// that it is genuinely cheap; that changes the post chain, so it rebuilds it
// once (with the WP19b shader warm-up) like an explicit quality change.
//
//   lodestone  the default. Valheim and Breath of the Wild in spirit, on our
//              own low-poly art: soft two-tone cel light with a gentle rim,
//              brighter painterly skies, strong aerial perspective, moody
//              valley fog at dusk and night, warm torchlight, wind-swept grass.
//   painterly  stronger toon bands, ink outlines, flatter posterized colour.
//   grim       desaturated and cold, heavy fog, darker nights, vignette.
//   retro      a late-90s console look: low internal resolution upscaled with
//              nearest-neighbour, vertex snapping, affine texture wobble on
//              the town atlas, ordered dithering, 15-bit colour, short fog.
//              Lodestone's palette, not any particular game's.
//
// See docs/decisions/0023-art-direction.md.

import type { VisualStyle } from '../../stores/qualityStore';

export interface StyleProfile {
  label: string;
  blurb: string;
  // Lit materials (styleShader.ts).
  /** 0..1 blend from smooth Lambert to banded light. */
  toon: number;
  /** Light bands across the lit side (2 = lit/shadow). */
  toonBands: number;
  /** Band edge softness (0 hard .. 0.5 smooth). */
  toonSoft: number;
  /** Rim light strength on upright surfaces (characters, trunks, walls). */
  rim: number;
  // Screen pass (styleEffect.ts).
  /** Ink outline strength 0..1 (depth edges). */
  outline: number;
  /** Luminance posterize levels (0 = off). */
  posterize: number;
  vignette: number;
  /** Colour quantization levels per channel with ordered dithering (0 = off). */
  quantize: number;
  // Grade (WorldScene, on top of time-of-day and biome).
  saturation: number;
  contrast: number;
  /** Gain tint multiplier. */
  tint: [number, number, number];
  // Atmosphere.
  /** Valley fog density multiplier (on the time-of-day fog). */
  fog: number;
  /** Constant extra height-fog density (pools in the low ground all day). */
  fogFloor: number;
  /** Extra valley fog at dusk and through the night (density units). */
  nightFog: number;
  /** Aerial-perspective haze multiplier. */
  haze: number;
  /** Linear distance fog [start, end] in m (retro); null = none. */
  fogRange: [number, number] | null;
  /** Night exposure lift multiplier (lower = darker nights). */
  nightExposure: number;
  /** Sky: saturation, brightness, painterly banding 0..1. */
  skySat: number;
  skyBright: number;
  skyBands: number;
  // Lights and post.
  bloomIntensity: number;
  bloomThreshold: number;
  /** God-ray weight multiplier. */
  rays: number;
  /** Warm point lights (torches, fires, lanterns) intensity multiplier. */
  torch: number;
  // Nature.
  /** Grass and foliage sway multiplier; gust sheen on grass. */
  windSweep: number;
  windSheen: number;
  /** Water: shallow turquoise boost and shore foam. */
  waterTurquoise: number;
  waterFoam: number;
  // Retro.
  retro: RetroProfile | null;
}

export interface RetroProfile {
  /** Internal render height in pixels (nearest-neighbour upscale to the window). */
  lines: number;
  /** Vertex snap grid (clip-space cells across the half screen). */
  snap: [number, number];
  /** Affine texture interpolation on the town atlas (0..1). */
  affine: number;
  /** Caps: view distance (m). */
  maxView: number;
}

export const STYLES: Record<VisualStyle, StyleProfile> = {
  lodestone: {
    label: 'Lodestone',
    blurb: 'Soft cel light, bright painterly skies, deep haze, moody fog and warm firelight.',
    toon: 0.6,
    toonBands: 2,
    toonSoft: 0.16,
    rim: 0.32,
    outline: 0,
    posterize: 0,
    vignette: 0.12,
    quantize: 0,
    saturation: 0.1,
    contrast: 1.0,
    tint: [1.01, 1.0, 0.98],
    fog: 1.15,
    fogFloor: 0.0005,
    nightFog: 0.0035,
    haze: 1.6,
    fogRange: null,
    nightExposure: 0.8,
    skySat: 1.18,
    skyBright: 1.08,
    skyBands: 0,
    bloomIntensity: 0.6,
    bloomThreshold: 1.05,
    rays: 1.15,
    torch: 1.6,
    windSweep: 1.4,
    windSheen: 0.22,
    waterTurquoise: 1,
    waterFoam: 1,
    retro: null,
  },
  painterly: {
    label: 'Painterly',
    blurb: 'Bold toon bands, ink outlines and flat, saturated colour.',
    toon: 0.95,
    toonBands: 3,
    toonSoft: 0.05,
    rim: 0.4,
    outline: 0.85,
    posterize: 7,
    vignette: 0.08,
    quantize: 0,
    saturation: 0.22,
    contrast: 1.02,
    tint: [1.02, 1.0, 0.97],
    fog: 1.0,
    fogFloor: 0.0003,
    nightFog: 0.002,
    haze: 1.3,
    fogRange: null,
    nightExposure: 1.1,
    skySat: 1.25,
    skyBright: 1.06,
    skyBands: 0.7,
    bloomIntensity: 0.45,
    bloomThreshold: 1.15,
    rays: 1.0,
    torch: 1.5,
    windSweep: 1.3,
    windSheen: 0.18,
    waterTurquoise: 1.2,
    waterFoam: 1.3,
    retro: null,
  },
  grim: {
    label: 'Grim',
    blurb: 'Cold, desaturated and fog-bound, with dark nights and a heavy vignette.',
    toon: 0.15,
    toonBands: 2,
    toonSoft: 0.3,
    rim: 0.08,
    outline: 0,
    posterize: 0,
    vignette: 0.5,
    quantize: 0,
    saturation: -0.38,
    contrast: 1.12,
    tint: [0.95, 0.99, 1.06],
    fog: 2.4,
    fogFloor: 0.0035,
    nightFog: 0.006,
    haze: 2.6,
    fogRange: null,
    nightExposure: 0.45,
    skySat: 0.7,
    skyBright: 0.85,
    skyBands: 0,
    bloomIntensity: 0.35,
    bloomThreshold: 1.35,
    rays: 0.8,
    torch: 1.25,
    windSweep: 1.1,
    windSheen: 0,
    waterTurquoise: 0,
    waterFoam: 0.6,
    retro: null,
  },
  retro: {
    label: 'Retro 32-bit',
    blurb: 'Chunky low-res pixels, wobbling vertices, dithered 15-bit colour and close fog.',
    toon: 0,
    toonBands: 2,
    toonSoft: 0.5,
    rim: 0,
    outline: 0,
    posterize: 0,
    vignette: 0.15,
    quantize: 24,
    saturation: 0.05,
    contrast: 1.06,
    tint: [1.03, 0.99, 0.95],
    fog: 1.0,
    fogFloor: 0,
    nightFog: 0.002,
    haze: 1.0,
    fogRange: [45, 230],
    nightExposure: 0.9,
    skySat: 1.0,
    skyBright: 1.0,
    skyBands: 0.35,
    bloomIntensity: 0,
    bloomThreshold: 10,
    rays: 0,
    torch: 1.4,
    windSweep: 1.0,
    windSheen: 0,
    waterTurquoise: 0.4,
    waterFoam: 0.5,
    retro: { lines: 240, snap: [160, 120], affine: 1, maxView: 520 },
  },
};

export const STYLE_ORDER: VisualStyle[] = ['lodestone', 'painterly', 'grim', 'retro'];

export function isVisualStyle(v: unknown): v is VisualStyle {
  return typeof v === 'string' && v in STYLES;
}

/**
 * Per-frame style values for code outside the world scene (WorldScene writes
 * them): warm point lights (town lanterns, fires) multiply their intensity
 * by `torch`.
 */
export const liveStyle = { torch: 1 };
