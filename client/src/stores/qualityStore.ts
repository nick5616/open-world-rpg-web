// Graphics settings: the one source of truth for quality (spec 12: "every
// effect has a quality tier switch") and, since playtest 2, for the visual
// style and the spell effects quality too. Persisted in localStorage under
// `lodestone_quality_settings` (zustand persist, version 1).
//
//   setting    the preset the player picked: 'auto' | low | medium | high | ultra
//   tier       the *effective* tier. Equals `setting` unless it is 'auto', in
//              which case the canvas' PerformanceMonitor steps it down when
//              frames run long and back up (never above High) when there is room.
//   shaderTier WP19: the tier for everything that shapes shaders (shadow
//              cascades, post chain, normal maps, light pools). Auto steps
//              leave it alone: a step that recompiles every shader froze the
//              page for ~4.7 s on ANGLE/D3D11, so auto mode adapts with the
//              cheap knobs and only an explicit choice recompiles.
//   overrides  the individual controls of the Graphics screen (render scale,
//              shadows, view distance, ...) on top of the preset. Picking a
//              preset clears them; any override makes the preset read "Custom".
//   style      the art direction (world/style/styles.ts), independent of quality.
//   effects    spell FX quality ('auto' follows the graphics tier).
//   detected   the first-run guess (gpuDetect.ts): GPU class, then the tier the
//              frame-time governor settled on. Only 'auto' uses it; the
//              player's choice wins (autoApply never touches an explicit one).
//   autoNoticed the tier the player was last told Auto had picked (the
//              one-time "Graphics set to High" notice).
//
// resolveGraphics() turns all of that into the numbers the renderer reads
// (one function, tested), so nothing else re-derives a knob from a tier name.
//
// adapted from wizard-wars client/src/stores/qualityStore.ts.

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { classifyGpu, probeGpu, type DetectedGpu } from './gpuDetect';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type QualitySetting = QualityTier | 'auto';
export type ShadowMode = 'off' | 'low' | 'high';
export type AntiAlias = 'off' | 'fxaa' | 'msaa2' | 'msaa4';
export type EffectsSetting = 'auto' | 'low' | 'medium' | 'high' | 'ultra';
export type VisualStyle = 'lodestone' | 'painterly' | 'grim' | 'retro';

export const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
/** Auto mode never climbs above this (Ultra is opt-in; spec 12's budgets are written for High). */
export const AUTO_MAX_TIER: QualityTier = 'high';
export const QUALITY_SETTINGS: QualitySetting[] = ['auto', ...TIER_ORDER];
export const STYLE_IDS: VisualStyle[] = ['lodestone', 'painterly', 'grim', 'retro'];
export const DEFAULT_STYLE: VisualStyle = 'lodestone';

/** What each tier costs (shader-shaping and cheap knobs). The world's own table is world/config.ts. */
export interface QualityPreset {
  /** Device-pixel-ratio cap: the biggest fill-rate lever on hi-dpi screens. */
  dpr: number;
  /** Pooled point lights. The count never changes mid-session so lit shaders don't recompile. */
  maxLights: number;
  shadows: boolean;
  /** Sun shadow cascades (0 when shadows are off). */
  shadowCascades: number;
  /** Canvas MSAA for screens without the world's post chain. */
  antialias: boolean;
  /** Meters; terrain streams to it (WP05). */
  viewDistance: number;
  normalMaps: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  low: { dpr: 1, maxLights: 3, shadows: false, shadowCascades: 0, antialias: false, viewDistance: 600, normalMaps: false },
  medium: { dpr: 1.25, maxLights: 6, shadows: true, shadowCascades: 2, antialias: true, viewDistance: 1200, normalMaps: true },
  high: { dpr: 1.75, maxLights: 10, shadows: true, shadowCascades: 3, antialias: true, viewDistance: 2000, normalMaps: true },
  ultra: { dpr: 2, maxLights: 10, shadows: true, shadowCascades: 3, antialias: true, viewDistance: 2400, normalMaps: true },
};

/** The player-facing controls of the Graphics screen. */
export interface GraphicsControls {
  /** Fraction of the native resolution rendered (0.5..1). */
  renderScale: number;
  /** Device-pixel-ratio cap (1..2.5). */
  dprCap: number;
  shadows: ShadowMode;
  /** Meters of sun shadow (cascades span this). */
  shadowDistance: number;
  /** Meters of terrain (64 m chunks: viewDistance / 64 rings). */
  viewDistance: number;
  /** Grass and small foliage: 0 off .. 1.5 lush. */
  foliage: number;
  /** Bloom, light shafts, outlines and FXAA (fog, tone mapping and grading always run). */
  post: boolean;
  antialias: AntiAlias;
  /** Frame-rate cap (0 = unlimited / display rate). */
  maxFps: number;
}

export const CONTROL_PRESETS: Record<QualityTier, GraphicsControls> = {
  low: { renderScale: 1, dprCap: 1, shadows: 'off', shadowDistance: 120, viewDistance: 600, foliage: 0, post: false, antialias: 'off', maxFps: 0 },
  medium: { renderScale: 1, dprCap: 1.25, shadows: 'low', shadowDistance: 180, viewDistance: 1200, foliage: 0.5, post: true, antialias: 'msaa2', maxFps: 0 },
  high: { renderScale: 1, dprCap: 1.75, shadows: 'high', shadowDistance: 320, viewDistance: 2000, foliage: 1, post: true, antialias: 'msaa4', maxFps: 0 },
  ultra: { renderScale: 1, dprCap: 2, shadows: 'high', shadowDistance: 450, viewDistance: 2400, foliage: 1.3, post: true, antialias: 'msaa4', maxFps: 0 },
};

/** Valid ranges (UI sliders and the persisted-value sanitizer share them). */
export const CONTROL_RANGES = {
  renderScale: [0.5, 1],
  dprCap: [1, 2.5],
  shadowDistance: [60, 600],
  viewDistance: [400, 3000],
  foliage: [0, 1.5],
  maxFps: [0, 240],
} as const;
export const SHADOW_MODES: ShadowMode[] = ['off', 'low', 'high'];
export const AA_MODES: AntiAlias[] = ['off', 'fxaa', 'msaa2', 'msaa4'];
export const EFFECTS_SETTINGS: EffectsSetting[] = ['auto', 'low', 'medium', 'high', 'ultra'];

export type Overrides = Partial<GraphicsControls>;

interface QualityState {
  setting: QualitySetting;
  tier: QualityTier;
  shaderTier: QualityTier;
  overrides: Overrides;
  style: VisualStyle;
  effects: EffectsSetting;
  detected: DetectedGpu | null;
  autoNoticed: QualityTier | null;
  /** Pick a preset (clears the individual overrides). */
  setSetting: (s: QualitySetting) => void;
  setControl: <K extends keyof GraphicsControls>(k: K, v: GraphicsControls[K]) => void;
  resetControls: () => void;
  setStyle: (s: VisualStyle) => void;
  setEffects: (e: EffectsSetting) => void;
  /** First-run detection result (and the frame-sample refinement). */
  setDetected: (d: DetectedGpu) => void;
  /**
   * Playtest 5: the governor's verdict. Auto only (an explicit tier is never touched):
   * sets the effective tier AND the shader tier (shadows, vegetation art, post), because
   * a measured step has to change what is drawn; the one-off recompile is paid in the
   * first seconds of play. Returns whether anything changed.
   */
  autoApply: (tier: QualityTier, frameMs: number | null) => boolean;
  setAutoNoticed: (t: QualityTier) => void;
  /** Auto mode only: move one step down/up (cheap knobs only). No-ops at the ends or when pinned. */
  stepDown: () => void;
  stepUp: () => void;
}

const isTier = (v: unknown): v is QualityTier => typeof v === 'string' && (TIER_ORDER as string[]).includes(v);
const isSetting = (v: unknown): v is QualitySetting => v === 'auto' || isTier(v);
const isStyle = (v: unknown): v is VisualStyle => typeof v === 'string' && (STYLE_IDS as string[]).includes(v);
const isEffects = (v: unknown): v is EffectsSetting => typeof v === 'string' && (EFFECTS_SETTINGS as string[]).includes(v);
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** Keep only well-formed overrides (persisted data is untrusted: old builds, hand edits). */
export function sanitizeOverrides(o: unknown): Overrides {
  const out: Overrides = {};
  if (!o || typeof o !== 'object') return out;
  const r = o as Record<string, unknown>;
  for (const k of ['renderScale', 'dprCap', 'shadowDistance', 'viewDistance', 'foliage', 'maxFps'] as const) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(v, CONTROL_RANGES[k]);
  }
  if (typeof r.shadows === 'string' && (SHADOW_MODES as string[]).includes(r.shadows)) out.shadows = r.shadows as ShadowMode;
  if (typeof r.antialias === 'string' && (AA_MODES as string[]).includes(r.antialias)) out.antialias = r.antialias as AntiAlias;
  if (typeof r.post === 'boolean') out.post = r.post;
  return out;
}

function sanitizeDetected(d: unknown): DetectedGpu | null {
  if (!d || typeof d !== 'object') return null;
  const r = d as Record<string, unknown>;
  if (!isTier(r.tier) || !isTier(r.gpuTier)) return null;
  return { renderer: String(r.renderer ?? ''), gpuTier: r.gpuTier, tier: r.tier, frameMs: typeof r.frameMs === 'number' ? r.frameMs : null };
}

export interface PersistedQuality {
  setting: QualitySetting;
  overrides: Overrides;
  style: VisualStyle;
  effects: EffectsSetting;
  detected: DetectedGpu | null;
  autoNoticed: QualityTier | null;
}

export const QUALITY_STORAGE_KEY = 'lodestone_quality_settings';
export const QUALITY_STORAGE_VERSION = 2;

/**
 * Persisted state of any earlier version -> the current shape. Version 0 (WP02
 * to playtest 1) stored only `{ setting: 'auto'|'low'|'medium'|'high' }`; a
 * bare string (hand-written by older scripts) is read as that setting.
 * Version 2 (playtest 5): a player saved as Auto has their stored detection
 * thrown away, so the optimistic GPU guess and the governor run again (the old
 * rules could have left them on Low for good); an explicit tier is kept.
 * Anything unreadable falls back to the defaults. Pure.
 */
export function migrateQuality(persisted: unknown, version: number): PersistedQuality {
  let p: unknown = persisted;
  if (typeof p === 'string') p = { setting: p };
  const r = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const setting = isSetting(r.setting) ? r.setting : 'auto';
  if (version < 1) return { setting, overrides: {}, style: DEFAULT_STYLE, effects: 'auto', detected: null, autoNoticed: null };
  return {
    setting,
    overrides: sanitizeOverrides(r.overrides),
    style: isStyle(r.style) ? r.style : DEFAULT_STYLE,
    effects: isEffects(r.effects) ? r.effects : 'auto',
    detected: version < 2 ? null : sanitizeDetected(r.detected),
    autoNoticed: isTier(r.autoNoticed) && version >= 2 ? r.autoNoticed : null,
  };
}

/** Weak machines start a tier lower; auto mode climbs from there if it can. Used when nothing was detected. */
export function initialAutoTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'high';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4;
  return mobile ? 'low' : weak ? 'medium' : 'high';
}

/** The tier a setting runs at: the setting itself, or for 'auto' the detected (else heuristic) tier, capped at High. */
export function tierForSetting(setting: QualitySetting, detected: DetectedGpu | null): QualityTier {
  if (setting !== 'auto') return setting;
  const t = detected?.tier ?? initialAutoTier();
  return TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(AUTO_MAX_TIER) ? AUTO_MAX_TIER : t;
}

/** Storage that also reads a legacy raw value (a bare tier string) instead of dropping it. */
const storage: StateStorage = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name);
      if (raw === null) return null;
      try {
        JSON.parse(raw);
        return raw;
      } catch {
        return JSON.stringify({ state: { setting: raw.trim() }, version: 0 });
      }
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* private mode / quota: in-memory only */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const useQualityStore = create<QualityState>()(
  persist(
    (set, get) => ({
      setting: 'auto',
      tier: initialAutoTier(),
      shaderTier: initialAutoTier(),
      overrides: {},
      style: DEFAULT_STYLE,
      effects: 'auto',
      detected: null,
      autoNoticed: null,
      setSetting: (setting) => {
        if (setting === 'auto' && !get().detected) detectGpu();
        const tier = tierForSetting(setting, get().detected);
        set({ setting, tier, shaderTier: tier, overrides: {} });
      },
      setControl: (k, v) => set({ overrides: sanitizeOverrides({ ...get().overrides, [k]: v }) }),
      resetControls: () => set({ overrides: {} }),
      setStyle: (style) => set({ style }),
      setEffects: (effects) => set({ effects }),
      setDetected: (detected) => set({ detected }),
      autoApply: (tier, frameMs) => {
        const { setting, tier: cur, shaderTier, detected } = get();
        if (setting !== 'auto') return false;
        const t = TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(AUTO_MAX_TIER) ? AUTO_MAX_TIER : tier;
        const d = detected ? { ...detected, tier: t, frameMs: frameMs ?? detected.frameMs } : null;
        if (t === cur && t === shaderTier) {
          if (d) set({ detected: d });
          return false;
        }
        set({ tier: t, shaderTier: t, ...(d ? { detected: d } : {}) });
        return true;
      },
      setAutoNoticed: (autoNoticed) => set({ autoNoticed }),
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
        if (i < TIER_ORDER.indexOf(AUTO_MAX_TIER)) set({ tier: TIER_ORDER[i + 1] });
      },
    }),
    {
      name: QUALITY_STORAGE_KEY,
      version: QUALITY_STORAGE_VERSION,
      storage: createJSONStorage(() => storage),
      // The player's choices persist; an auto tier is re-derived per session.
      partialize: (s): PersistedQuality => ({ setting: s.setting, overrides: s.overrides, style: s.style, effects: s.effects, detected: s.detected, autoNoticed: s.autoNoticed }),
      migrate: (persisted, version) => migrateQuality(persisted, version),
      merge: (persisted, current) => {
        const p = migrateQuality(persisted, QUALITY_STORAGE_VERSION);
        const tier = tierForSetting(p.setting, p.detected);
        return { ...current, ...p, tier, shaderTier: tier };
      },
    },
  ),
);

/**
 * First run: read the GPU before anything renders, so the first world mount
 * builds at the detected tier (no recompile later). Skipped when the player
 * already chose, or a detection is stored. The frame-time refinement runs
 * once the world is up (scene/GraphicsApplier.tsx).
 */
export function detectOnFirstRun(): void {
  const s = useQualityStore.getState();
  if (s.detected || s.setting !== 'auto') return;
  detectGpu();
  const tier = tierForSetting('auto', useQualityStore.getState().detected);
  useQualityStore.setState({ tier, shaderTier: tier });
}

function detectGpu(): void {
  const probe = probeGpu();
  if (!probe) return;
  const gpuTier = classifyGpu(probe);
  useQualityStore.getState().setDetected({ renderer: probe.renderer, gpuTier, frameMs: null, tier: gpuTier });
}
detectOnFirstRun();

/** Non-reactive read of the current preset, for useFrame and other non-React code. */
export function getQuality(): QualityPreset {
  return QUALITY_PRESETS[useQualityStore.getState().tier];
}
