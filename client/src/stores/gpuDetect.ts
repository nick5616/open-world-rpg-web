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
export const AUTO_BUDGET = { downP90Ms: 28, upP90Ms: 18.5, stallMs: 500 } as const;

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
 * counts toward settling. It settles after `totalMs` or three calm windows. Up to three
 * stalls (frames over 500 ms: alt-tab, a load) in a window are left out of its numbers, and a
 * window that is mostly stall is discarded; more than that is the machine, and counts.
 * Pure state machine: the caller applies the returned tier.
 */
export class AutoGovernor {
  private elapsed = 0;
  private win: number[] = [];
  private winMs = 0;
  private calm = 0;
  private bad = 0;
  private stallRun = 0;
  private win0: number[] = [];
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
    this.win.push(dtMs);
    if (this.winMs < this.opt.windowMs) return null;
    // A few huge frames are stalls (alt-tab, a load, a GC pause), not the machine: leave them out. Many are the machine.
    const stalls = this.win.filter((d) => d > AUTO_BUDGET.stallMs);
    const few = stalls.length <= 3;
    const frames = few ? this.win.filter((d) => d <= AUTO_BUDGET.stallMs) : this.win;
    const stallMs = few ? stalls.reduce((x, y) => x + y, 0) : 0;
    const hitchy = frames.length < 6 || stallMs > this.winMs * 0.5;
    const sorted = [...frames].sort((x, y) => x - y);
    let p50 = sorted.length ? pctile(sorted, 50) : 0;
    let p90 = sorted.length ? pctile(sorted, 90) : 0;
    this.win0 = this.win;
    this.win = [];
    this.winMs = 0;
    // A window lost to load hitches is not a verdict: keep measuring for up to twice the time before settling blind.
    // But windows made only of stalls, one after another, are a machine at under 2 fps: that counts as bad (twice = down).
    if (hitchy) {
      this.stallRun = stalls.length > 0 || frames.length === 0 ? this.stallRun + 1 : 0;
      if (this.stallRun < 2) return this.elapsed >= this.opt.totalMs * 2 ? this.finish(p50, p90) : null;
      const all = [...this.win0].sort((x, y) => x - y);
      p50 = p90 = all.length ? pctile(all, 50) : AUTO_BUDGET.stallMs;
    } else this.stallRun = 0;
    const i = ORDER.indexOf(this.tier);
    if (p90 > AUTO_BUDGET.downP90Ms && i > 0) {
      // Two bad windows in a row: one window of a fast machine can be 10 % missed vsyncs from a chunk upload or a shader compile.
      if (++this.bad < 2) return null;
      this.bad = 0;
      this.tier = ORDER[i - 1];
      this.noUp = true;
      this.calm = 0;
      return this.verdict('down', p50, p90);
    }
    this.bad = 0;
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
