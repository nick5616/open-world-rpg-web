// Graphics quality: a user-facing setting ('auto' | 'low' | 'medium' | 'high')
// plus the *effective* tier the renderer runs at. In 'auto' the canvas'
// PerformanceMonitor steps the tier down when frames run long and back up when
// there is headroom; an explicit setting pins it. Everything render-side reads
// its knobs from QUALITY_PRESETS, so one table decides what each tier costs
// (spec 12: "every effect has a quality tier switch").
//
// adapted from wizard-wars client/src/stores/qualityStore.ts. Added knobs for
// an open world: shadow cascades (spec 12: none / 2 / 3), view distance (WP05
// streams chunks to it) and normal maps (skipped on low, spec 12 PBR rules).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type QualityTier = 'low' | 'medium' | 'high';
export type QualitySetting = QualityTier | 'auto';

export interface QualityPreset {
  /** Upper bound for <Canvas dpr={[1, dpr]}>: the biggest fill-rate lever on hi-dpi screens. */
  dpr: number;
  /** Pooled point lights (spell FX later). The count never changes mid-session so lit shaders don't recompile. */
  maxLights: number;
  shadows: boolean;
  /** Sun shadow cascades (0 when shadows are off). */
  shadowCascades: number;
  /** MSAA, read only at context creation. */
  antialias: boolean;
  /** Meters; camera far plane and fog end. WP05 sizes chunk streaming from it. */
  viewDistance: number;
  normalMaps: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  low: { dpr: 1, maxLights: 3, shadows: false, shadowCascades: 0, antialias: false, viewDistance: 600, normalMaps: false },
  medium: { dpr: 1.25, maxLights: 6, shadows: true, shadowCascades: 2, antialias: true, viewDistance: 1200, normalMaps: true },
  high: { dpr: 1.75, maxLights: 10, shadows: true, shadowCascades: 3, antialias: true, viewDistance: 2000, normalMaps: true },
};

export const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high'];

interface QualityState {
  setting: QualitySetting;
  /** Effective tier. Equals `setting` unless the setting is 'auto'. */
  tier: QualityTier;
  /**
   * WP19: the tier for everything that shapes shaders (shadow cascades, post
   * chain, normal maps, light pools). Equals `tier`, except that auto steps
   * leave it alone: a step that recompiles every shader froze the page for
   * ~4.7 s on ANGLE/D3D11 (the "lurch" in the two-browser runs), so auto
   * mode adapts with the cheap knobs (resolution, view distance, scatter,
   * grass, terrain detail) and only an explicit setting recompiles.
   */
  shaderTier: QualityTier;
  setSetting: (s: QualitySetting) => void;
  /** Auto mode only: move one step down/up. No-ops at the ends or when pinned. */
  stepDown: () => void;
  stepUp: () => void;
}

/** Weak machines start a tier lower; auto mode climbs from there if it can. */
export function initialAutoTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'high';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4;
  return mobile ? 'low' : weak ? 'medium' : 'high';
}

export const useQualityStore = create<QualityState>()(
  persist(
    (set, get) => ({
      setting: 'auto',
      tier: initialAutoTier(),
      shaderTier: initialAutoTier(),
      setSetting: (setting) => {
        const tier = setting === 'auto' ? initialAutoTier() : setting;
        set({ setting, tier, shaderTier: tier });
      },
      stepDown: () => {
        const { setting, tier } = get();
        if (setting !== 'auto') return;
        const i = TIER_ORDER.indexOf(tier);
        if (i > 0) set({ tier: TIER_ORDER[i - 1] });
      },
      stepUp: () => {
        const { setting, tier } = get();
        if (setting !== 'auto') return;
        const i = TIER_ORDER.indexOf(tier);
        if (i < TIER_ORDER.length - 1) set({ tier: TIER_ORDER[i + 1] });
      },
    }),
    {
      name: 'lodestone_quality_settings',
      // Only the user's choice persists; an auto tier is re-derived per session.
      partialize: (s) => ({ setting: s.setting }),
      merge: (persisted, current) => {
        const setting = (persisted as { setting?: QualitySetting } | undefined)?.setting ?? current.setting;
        const tier = setting === 'auto' ? current.tier : setting;
        return { ...current, setting, tier, shaderTier: tier };
      },
    },
  ),
);

/** Non-reactive read of the current preset, for useFrame and other non-React code. */
export function getQuality(): QualityPreset {
  return QUALITY_PRESETS[useQualityStore.getState().tier];
}
