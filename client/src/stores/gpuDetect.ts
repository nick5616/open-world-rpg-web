// Auto quality (playtest 2, reworked in playtest 5 / CR 057). Two signals:
//
//   1. What the GPU says it is (WEBGL_debug_renderer_info through a throwaway
//      WebGL2 context, read once before anything renders, so the first world
//      mount already builds at the right tier). Optimistic: High on any
//      discrete or modern integrated GPU.
//   2. Real play: AutoGovernor (below) measures frame times in the first
//      ~28 s after the world is playable and steps down when p90 is over
//      budget, or tries one step up when there is plenty of headroom. The
//      tier it settles on is where the next session starts (and is measured
//      again).
//
// Auto never picks Ultra (opt-in: spec 12's budgets are written for High),
// and an explicit setting from the player always wins over both signals.
//
// The spell FX layer (combat/fx/gpu.ts, playtest 2) has its own renderer
// classifier for its FX cap; it reads the same renderer string.

import type { QualityTier } from './qualityStore';

export interface GpuProbe {
  renderer: string;
  /** navigator.hardwareConcurrency (0 = unknown). */
  cores: number;
  mobile: boolean;
  /** MAX_TEXTURE_SIZE (0 = unknown). */
  maxTextureSize: number;
}

export interface DetectedGpu {
  renderer: string;
  /** Tier from the renderer string alone. */
  gpuTier: QualityTier;
  /** Median frame time (ms) of the governor's last window; null until measured. */
  frameMs: number | null;
  /** What auto mode starts at: gpuTier, then what the governor settled on. */
  tier: QualityTier;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/;
const MOBILE_GPU = /mali|adreno|powervr|videocore|tegra|sgx/;
const INTEGRATED = /intel|gma|uhd graphics|hd graphics|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/;
/** Integrated GPUs of the last few years that run High: Iris Xe, Arc, UHD 7xx, Ryzen APUs (Radeon Graphics, 6x0M / 7x0M), Apple. The governor steps down if one is not. */
const MODERN_INTEGRATED = /iris\(r\) xe|iris xe|iris\(r\) plus|intel\(r\) arc|arc\(tm\)|uhd graphics 7\d\d|radeon\(tm\) graphics|radeon graphics|radeon\(tm\) [67]\d0m|radeon [67]\d0m|apple/;
const DISCRETE = /nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d|apple m\d/;

/**
 * Renderer string (+ cores, mobile, texture limit) -> the tier auto mode starts at.
 * Optimistic by design (playtest 5): High on any discrete or modern integrated GPU, since
 * the frame-time governor (AutoGovernor) steps down within seconds if the guess is wrong,
 * and a wrongly low start was what kept players on the plain Low art. Pure.
 */
export function classifyGpu(p: GpuProbe): QualityTier {
  const r = p.renderer.toLowerCase();
  let tier: QualityTier;
  if (SOFTWARE.test(r)) tier = 'low';
  else if (p.mobile || MOBILE_GPU.test(r)) tier = 'low';
  else if (DISCRETE.test(r)) tier = 'high';
  // Desktop Safari masks every Mac GPU as "Apple GPU"; Apple silicon is the spec's high-tier reference (M1 Air).
  else if (/apple gpu/.test(r)) tier = 'high';
  else if (MODERN_INTEGRATED.test(r)) tier = 'high';
  else if (INTEGRATED.test(r)) tier = 'medium';
  else tier = p.cores > 0 && p.cores <= 4 ? 'medium' : 'high';
  if (p.maxTextureSize > 0 && p.maxTextureSize < 8192 && tier === 'high') tier = 'medium';
  return tier;
}

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/** Frame-time budgets of the governor (ms). p90 over the down budget = steps down; p90 at or under the up budget = tries one tier up. */
export const AUTO_BUDGET = { downP90Ms: 25, upP90Ms: 18.5, hitchMs: 250 } as const;

export interface GovernorStep {
  kind: 'down' | 'up' | 'settled';
  /** The tier to run at after this verdict. */
  tier: QualityTier;
  p50: number;
  p90: number;
}

const pctile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/**
 * Auto mode's frame-time governor (playtest 5, CR 057). Feed per-frame deltas (ms) from real
 * play; it skips the first `skipMs` (streaming and shader warm-up), then judges windows of
 * `windowMs`: p90 over the down budget steps one tier down (and forbids going up again), p90
 * at or under the up budget with the tier below `maxTier` tries one tier up, a calm window
 * counts toward settling. It settles after `totalMs` or three calm windows. Long hitches
 * (alt-tab, a load) are left out of the numbers; a window that is mostly hitches is discarded.
 * Pure state machine: the caller applies the returned tier.
 */
export class AutoGovernor {
  private elapsed = 0;
  private win: number[] = [];
  private winMs = 0;
  private hitchMs = 0;
  private calm = 0;
  private noUp = false;
  done = false;
  constructor(
    public tier: QualityTier,
    private readonly maxTier: QualityTier = 'high',
    private readonly opt: { skipMs: number; windowMs: number; totalMs: number } = { skipMs: 2500, windowMs: 5000, totalMs: 28000 },
  ) {}

  add(dtMs: number): GovernorStep | null {
    if (this.done) return null;
    this.elapsed += dtMs;
    if (this.elapsed < this.opt.skipMs) return null;
    this.winMs += dtMs;
    if (dtMs > AUTO_BUDGET.hitchMs) this.hitchMs += dtMs;
    else this.win.push(dtMs);
    if (this.winMs < this.opt.windowMs) return null;
    const hitchy = this.hitchMs > this.winMs * 0.4 || this.win.length < 20;
    const s = [...this.win].sort((a, b) => a - b);
    const p50 = s.length ? pctile(s, 50) : 0;
    const p90 = s.length ? pctile(s, 90) : 0;
    this.win = [];
    this.winMs = 0;
    this.hitchMs = 0;
    if (hitchy) return this.elapsed >= this.opt.totalMs ? this.finish(p50, p90) : null;
    const i = ORDER.indexOf(this.tier);
    if (p90 > AUTO_BUDGET.downP90Ms && i > 0) {
      this.tier = ORDER[i - 1];
      this.noUp = true;
      this.calm = 0;
      return this.verdict('down', p50, p90);
    }
    if (p90 <= AUTO_BUDGET.upP90Ms && !this.noUp && i < ORDER.indexOf(this.maxTier) && this.elapsed < this.opt.totalMs - this.opt.windowMs) {
      this.tier = ORDER[i + 1];
      this.calm = 0;
      return this.verdict('up', p50, p90);
    }
    this.calm++;
    if (this.calm >= 3 || this.elapsed >= this.opt.totalMs) return this.finish(p50, p90);
    return null;
  }

  private verdict(kind: GovernorStep['kind'], p50: number, p90: number): GovernorStep {
    return { kind, tier: this.tier, p50: +p50.toFixed(1), p90: +p90.toFixed(1) };
  }

  private finish(p50: number, p90: number): GovernorStep {
    this.done = true;
    return { kind: 'settled', tier: this.tier, p50: +p50.toFixed(1), p90: +p90.toFixed(1) };
  }
}

/** Browser probe: renderer string from a throwaway WebGL2 context (released right away). Null outside a browser. */
export function probeGpu(): GpuProbe | null {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return null;
  if (/jsdom|happy-dom/i.test(navigator.userAgent)) return null;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 0;
  let renderer = '';
  let maxTextureSize = 0;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } else {
      renderer = 'no webgl2';
    }
  } catch {
    renderer = '';
  }
  return { renderer, cores, mobile, maxTextureSize };
}
