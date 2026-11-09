// Resolved graphics (playtest 2 graphics settings): the quality store's
// preset + tier + overrides + visual style -> every number the renderer
// reads. Pure, so the settings logic is tested without a GPU; the hook
// memoizes it for React.
//
// Cheap knobs (resolution, view distance, foliage, frame cap) follow the
// effective `tier`, which auto mode steps. Shader-shaping knobs (shadows,
// post chain, anti-aliasing, normal maps, light pools) follow `shaderTier`,
// which only an explicit choice changes (WP19: no recompile on an auto step).
// The player's overrides apply to both. A style can cap knobs (Retro removes
// work) without touching what is stored, so switching back restores them.

import { useMemo } from 'react';
import { CONTROL_PRESETS, QUALITY_PRESETS, TIER_ORDER, useQualityStore, type EffectsSetting, type GraphicsControls, type Overrides, type QualityTier, type VisualStyle } from './qualityStore';
import { WORLD_TIERS, type WorldTier } from '../world/config';
import { STYLES, type RetroProfile } from '../world/style/styles';

export interface ResolvedGraphics {
  tier: QualityTier;
  shaderTier: QualityTier;
  style: VisualStyle;
  /** Effective controls (what the Graphics screen shows, after style caps). */
  controls: GraphicsControls;
  /** True when any override is set (the preset reads "Custom"). */
  custom: boolean;
  /** World streaming/scatter knobs for the effective tier, with the controls applied. */
  world: WorldTier;
  // Shader-shaping (shaderTier + overrides).
  shadowCascades: number;
  shadowMapSize: number;
  shadowDistance: number;
  bloom: boolean;
  godRays: boolean;
  /** MSAA samples of the post chain's scene buffer. */
  msaa: number;
  fxaa: boolean;
  normalMaps: boolean;
  maxLights: number;
  /** Terrain texture anisotropy. */
  anisotropy: number;
  retro: RetroProfile | null;
}

/** Grass from the foliage control: 0 off, 0.5 = medium (28 m, 1.2/m2), 1 = high (36 m, 2.4/m2). */
export function grassFor(foliage: number): { grassDistance: number; grassDensity: number } {
  if (!(foliage > 0.02)) return { grassDistance: 0, grassDensity: 0 };
  return { grassDistance: Math.round(20 + 16 * foliage), grassDensity: +(2.4 * foliage).toFixed(2) };
}

export function resolveGraphics(tier: QualityTier, shaderTier: QualityTier, overrides: Overrides, style: VisualStyle): ResolvedGraphics {
  const retro = STYLES[style]?.retro ?? null;
  const cheap: GraphicsControls = { ...CONTROL_PRESETS[tier], ...overrides };
  const shader: GraphicsControls = { ...CONTROL_PRESETS[shaderTier], ...overrides };
  const controls: GraphicsControls = {
    renderScale: cheap.renderScale,
    dprCap: cheap.dprCap,
    viewDistance: cheap.viewDistance,
    foliage: cheap.foliage,
    maxFps: cheap.maxFps,
    shadows: shader.shadows,
    shadowDistance: shader.shadowDistance,
    post: shader.post,
    antialias: shader.antialias,
  };
  if (retro) {
    // Retro is meant to be cheap: low internal resolution (applied as the
    // pixel ratio), close fog so less terrain, short grass, no MSAA/FXAA
    // (it would smear the pixels), no bloom or light shafts, small shadows.
    controls.viewDistance = Math.min(controls.viewDistance, retro.maxView);
    controls.foliage = Math.min(controls.foliage, 0.5);
    controls.antialias = 'off';
    controls.post = false;
    if (controls.shadows === 'high') controls.shadows = 'low';
    controls.shadowDistance = Math.min(controls.shadowDistance, 140);
  }
  const base = WORLD_TIERS[tier];
  const world: WorldTier = {
    ...base,
    ...grassFor(controls.foliage),
    scatterDistance: Math.min(base.scatterDistance, Math.max(300, controls.viewDistance * 0.6)),
    shadowDistance: controls.shadows === 'off' ? 0 : controls.shadowDistance,
    shadowMapSize: controls.shadows === 'high' ? 2048 : 1024,
    bloom: controls.post,
    godRays: controls.post && WORLD_TIERS[shaderTier].godRays,
  };
  const sp = QUALITY_PRESETS[shaderTier];
  return {
    tier,
    shaderTier,
    style,
    controls,
    custom: Object.keys(overrides).length > 0,
    world,
    shadowCascades: controls.shadows === 'off' ? 0 : controls.shadows === 'low' ? 2 : 3,
    shadowMapSize: controls.shadows === 'high' ? 2048 : 1024,
    shadowDistance: controls.shadows === 'off' ? 0 : controls.shadowDistance,
    bloom: controls.post && WORLD_TIERS[shaderTier].bloom,
    godRays: controls.post && WORLD_TIERS[shaderTier].godRays,
    msaa: controls.antialias === 'msaa4' ? 4 : controls.antialias === 'msaa2' ? 2 : 0,
    fxaa: controls.antialias === 'fxaa' && controls.post,
    normalMaps: sp.normalMaps,
    maxLights: sp.maxLights,
    anisotropy: TIER_ORDER.indexOf(shaderTier) >= TIER_ORDER.indexOf('high') ? 8 : 4,
    retro,
  };
}

/**
 * Backing-store pixel ratio for the canvas: Retro renders `lines` rows and
 * lets the browser upscale with nearest-neighbour; otherwise the device ratio
 * capped by the DPR control, times the render scale.
 */
export function pixelRatioFor(g: ResolvedGraphics, devicePixelRatio: number, cssHeight: number): number {
  if (g.retro) return Math.min(1, g.retro.lines / Math.max(1, cssHeight));
  return Math.max(0.25, Math.min(devicePixelRatio || 1, g.controls.dprCap) * g.controls.renderScale);
}

/** Spell FX tier: an explicit effects setting, else the graphics tier (see combat/fx/quality.ts). */
export function effectsTierFor(effects: EffectsSetting, tier: QualityTier): Exclude<EffectsSetting, 'auto'> {
  return effects === 'auto' ? tier : effects;
}

/** Non-reactive read (useFrame and other non-React code). */
export function getGraphics(): ResolvedGraphics {
  const s = useQualityStore.getState();
  return resolveGraphics(s.tier, s.shaderTier, s.overrides, s.style);
}

/** React: the resolved graphics, recomputed only when an input changes. */
export function useGraphics(): ResolvedGraphics {
  const tier = useQualityStore((s) => s.tier);
  const shaderTier = useQualityStore((s) => s.shaderTier);
  const overrides = useQualityStore((s) => s.overrides);
  const style = useQualityStore((s) => s.style);
  return useMemo(() => resolveGraphics(tier, shaderTier, overrides, style), [tier, shaderTier, overrides, style]);
}
