// Playtest 2 graphics settings: the first-run quality guess (qualityStore's
// 'auto' default). Two signals, both cheap:
//
//   1. What the GPU says it is (WEBGL_debug_renderer_info through a throwaway
//      WebGL2 context, read once before anything renders, so the first world
//      mount already builds at the right tier and nothing recompiles later).
//   2. A short frame-time sample once the world is up (GraphicsApplier): a
//      machine that reads as capable but runs slow is stepped down, and the
//      refined tier is what the next session starts at.
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
  /** Median frame time (ms) of the first-run sample; null until sampled. */
  frameMs: number | null;
  /** What auto mode starts at: gpuTier, refined by the frame sample. */
  tier: QualityTier;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/;
const MOBILE_GPU = /mali|adreno|powervr|videocore|tegra|sgx/;
const INTEGRATED = /intel|gma|uhd graphics|hd graphics|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics/;
const DISCRETE = /nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d|apple m\d/;

/** Renderer string (+ cores, mobile, texture limit) -> the tier auto mode should start at. Pure. */
export function classifyGpu(p: GpuProbe): QualityTier {
  const r = p.renderer.toLowerCase();
  let tier: QualityTier;
  if (SOFTWARE.test(r)) tier = 'low';
  else if (p.mobile || MOBILE_GPU.test(r)) tier = 'low';
  else if (DISCRETE.test(r)) tier = 'high';
  // Desktop Safari masks every Mac GPU as "Apple GPU"; Apple silicon is the spec's high-tier reference (M1 Air).
  else if (/apple gpu/.test(r)) tier = 'high';
  else if (INTEGRATED.test(r)) tier = 'medium';
  else tier = p.cores > 0 && p.cores <= 4 ? 'medium' : 'high';
  if (p.maxTextureSize > 0 && p.maxTextureSize < 8192 && tier === 'high') tier = 'medium';
  return tier;
}

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/**
 * The frame sample's verdict on top of the GPU guess (vsync-capped, so it
 * only ever lowers): a median over 40 ms is Low whatever the GPU said,
 * over 24 ms one step below the guess. Pure.
 */
export function refineTier(gpuTier: QualityTier, medianMs: number): QualityTier {
  if (!(medianMs > 0)) return gpuTier;
  if (medianMs > 40) return 'low';
  if (medianMs > 24) return ORDER[Math.max(0, ORDER.indexOf(gpuTier) - 1)];
  return gpuTier;
}

/**
 * Frame-time sampler: feed per-frame deltas (ms); the first `skip` are
 * dropped (streaming and warm-up hitches), then after `frames` samples it
 * returns the median. Pure state machine.
 */
export class FrameSampler {
  private samples: number[] = [];
  private seen = 0;
  median: number | null = null;
  constructor(
    private readonly frames = 120,
    private readonly skip = 90,
  ) {}

  add(dtMs: number): number | null {
    if (this.median !== null) return this.median;
    if (this.seen++ < this.skip) return null;
    this.samples.push(dtMs);
    if (this.samples.length < this.frames) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    this.median = s[Math.floor(s.length / 2)];
    return this.median;
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
