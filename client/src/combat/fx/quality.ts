// Spell FX quality (playtest 2): how much each cast costs and how loud it
// looks. Four FX tiers on top of the graphics tier (stores/qualityStore.ts):
//
//   low     cheap but readable: ~1/3 of the particles, no dynamic lights, no
//           screen shake / flash / distortion, no bloom (the post chain has
//           none on low), small transient pools.
//   medium  2/3 particles, 2 pooled lights, mild shake and distortion.
//   high    every particle, 4 pooled lights, HDR cores for the bloom, screen
//           shake, flashes and shockwave distortion.
//   ultra   "go all out": 1.5x particles, hotter HDR, stronger distortion.
//
// Which tier runs (resolveFxTier, pure, tested):
//   1. The Graphics screen's "Spell effects" control wins when set: the
//      quality store's `effects` (stores/qualityStore.ts, persisted with the
//      rest of the graphics settings; setFxSetting() writes it). A value
//      under the pre-settings key `localStorage.lodestone_fx_quality` is
//      adopted once and removed.
//   2. Else an explicit graphics setting picks it: low -> low, medium ->
//      medium, high -> ultra (the player chose high graphics: go all out).
//   3. Else (graphics 'auto') the auto tier, capped by the GPU assessment
//      (gpu.ts: renderer string + a short frame-time sample). The assessment
//      only ever picks this default; it never overrides 1 or 2.
//
// The pooled light COUNT is fixed when the FX layer mounts (from the shader
// tier: low 0, medium 2, high and ultra 4) so lit materials never recompile mid-session
// (the WP19 "lurch" rule); everything else follows the live FX tier.

import { useQualityStore, type QualitySetting, type QualityTier } from '../../stores/qualityStore';

export type FxTier = 'low' | 'medium' | 'high' | 'ultra';
export type FxSetting = FxTier | 'auto';
export const FX_TIERS: FxTier[] = ['low', 'medium', 'high', 'ultra'];
export const FX_STORAGE_KEY = 'lodestone_fx_quality';

export interface FxProfile {
  /** Particle emission multiplier. */
  density: number;
  /** Particles a single frame may emit before further bursts are thinned (cast spam). */
  frameBudget: number;
  /** Bright cores are multiplied by this (bloom threshold is 1.25 on medium/high). */
  hdr: number;
  /** 0..1 camera shake, full-screen flash and shockwave distortion strength. */
  shake: number;
  flash: number;
  distortion: number;
  /** Instanced ground spikes (ice, crystal, bramble, stone) per style. */
  spikes: number;
  /** Bolt segment budget (lightning, chains). */
  boltSegments: number;
  /** Smoke and mist (normal-blended, the overdraw-heavy part) multiplier. */
  smoke: number;
  /** Status effects drawn on at most this many enemies. */
  statusTargets: number;
  /** Ground decals conform to the terrain with an N x N grid. */
  decalGrid: number;
}

export const FX_PROFILES: Record<FxTier, FxProfile> = {
  low: { density: 0.35, frameBudget: 600, hdr: 1, shake: 0, flash: 0, distortion: 0, spikes: 60, boltSegments: 400, smoke: 0.4, statusTargets: 6, decalGrid: 8 },
  medium: { density: 0.65, frameBudget: 1400, hdr: 1.4, shake: 0.5, flash: 0.5, distortion: 0.5, spikes: 140, boltSegments: 900, smoke: 0.7, statusTargets: 12, decalGrid: 14 },
  high: { density: 1, frameBudget: 2600, hdr: 1.8, shake: 1, flash: 0.8, distortion: 1, spikes: 220, boltSegments: 1600, smoke: 1, statusTargets: 20, decalGrid: 20 },
  ultra: { density: 1.5, frameBudget: 4000, hdr: 2.2, shake: 1, flash: 1, distortion: 1.3, spikes: 220, boltSegments: 2000, smoke: 1, statusTargets: 32, decalGrid: 24 },
};

/** Pooled point lights per shader tier (fixed for the session, see header). */
export function fxLightCount(shaderTier: QualityTier): number {
  return shaderTier === 'high' || shaderTier === 'ultra' ? 4 : shaderTier === 'medium' ? 2 : 0;
}

const ORDER: Record<FxTier, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
export const minFxTier = (a: FxTier, b: FxTier): FxTier => (ORDER[a] <= ORDER[b] ? a : b);

/** The graphics tier's FX tier (explicit high graphics = go all out). */
export function fxTierForGraphics(t: QualityTier): FxTier {
  return t === 'high' ? 'ultra' : t;
}

export interface FxResolveInput {
  fxSetting: FxSetting;
  qualitySetting: QualitySetting;
  /** The effective graphics tier (auto mode moves it). */
  tier: QualityTier;
  /** GPU assessment cap (gpu.ts), null until assessed. */
  gpuCap: FxTier | null;
}

/** Which FX tier runs (see header). Pure. */
export function resolveFxTier(i: FxResolveInput): FxTier {
  if (i.fxSetting !== 'auto') return i.fxSetting;
  const fromGraphics = fxTierForGraphics(i.tier);
  if (i.qualitySetting !== 'auto') return fromGraphics;
  // Auto: unassessed machines get 'high' (not ultra) until the sample is in.
  return minFxTier(fromGraphics, i.gpuCap ?? 'high');
}

// ── Live state ──────────────────────────────────────────────────────────────

let gpuCap: FxTier | null = null;

/** One-time adoption of the pre-settings override key into the quality store. */
function adoptLegacySetting(): void {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FX_STORAGE_KEY) : null;
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'ultra') {
      if (useQualityStore.getState().effects === 'auto') useQualityStore.getState().setEffects(v);
      localStorage.removeItem(FX_STORAGE_KEY);
    }
  } catch {
    /* private mode */
  }
}
adoptLegacySetting();

/** Settings hook (the Graphics screen, the console): 'auto' follows the graphics tier. Stored in the quality store. */
export function setFxSetting(s: FxSetting): void {
  useQualityStore.getState().setEffects(s);
}

export function getFxSetting(): FxSetting {
  return useQualityStore.getState().effects;
}

/** Set by the GPU assessment (gpu.ts). */
export function setGpuCap(cap: FxTier | null): void {
  gpuCap = cap;
}

export function getGpuCap(): FxTier | null {
  return gpuCap;
}

/** The FX tier right now (cheap: read per cast and per frame). */
export function currentFxTier(): FxTier {
  const q = useQualityStore.getState();
  return resolveFxTier({ fxSetting: q.effects, qualitySetting: q.setting, tier: q.tier, gpuCap });
}

export function currentFxProfile(): FxProfile {
  return FX_PROFILES[currentFxTier()];
}

/** prefers-reduced-motion: no shake, gentler distortion and flashes. */
export function reducedMotion(): boolean {
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
