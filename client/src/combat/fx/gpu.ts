// A light GPU assessment for the spell FX default (quality.ts): what the
// renderer says it is, plus a short frame-time sample once the world is up.
// It only picks the default for graphics 'auto'; an explicit graphics or FX
// setting always wins. The graphics-settings agent can reuse classifyGpu /
// FrameSampler for the global tier later.

import type { FxTier } from './quality';

export interface GpuInfo {
  renderer: string;
  maxTextureSize: number;
  /** ALIASED_POINT_SIZE_RANGE max (particles clamp to it). */
  maxPointSize: number;
}

/**
 * Renderer string -> the highest FX tier this GPU should get by default.
 * Software rasterizers get low, mobile and older integrated GPUs medium,
 * discrete and recent Apple GPUs ultra, everything else high. Pure.
 */
export function classifyGpu(info: GpuInfo): FxTier {
  const r = info.renderer.toLowerCase();
  let cap: FxTier = 'high';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r)) cap = 'low';
  else if (/mali|adreno|powervr|videocore|apple gpu|intel.*hd graphics|intel\(r\) hd|gma/.test(r)) cap = 'medium';
  else if (/nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|radeon\(tm\) rx|arc\(tm\) a|arc a\d|apple m\d (pro|max|ultra)/.test(r)) cap = 'ultra';
  if (info.maxTextureSize > 0 && info.maxTextureSize < 8192 && cap !== 'low') cap = 'medium';
  return cap;
}

/** Reads the renderer string (unmasked when the browser allows it). */
export function gpuInfo(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuInfo {
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    renderer = '';
  }
  const pts = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as ArrayLike<number> | null;
  return { renderer, maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0, maxPointSize: pts ? pts[1] : 64 };
}

/**
 * Frame-time sample: feed frame deltas (ms); after `frames` samples (the
 * first `skip` are dropped: loading hitches) it yields a cap from the median.
 * Pure state machine, tested.
 */
export class FrameSampler {
  private samples: number[] = [];
  private seen = 0;
  result: FxTier | null = null;
  constructor(private frames = 120, private skip = 30) {}

  add(dtMs: number): FxTier | null {
    if (this.result) return this.result;
    if (this.seen++ < this.skip) return null;
    this.samples.push(dtMs);
    if (this.samples.length < this.frames) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    this.result = med > 40 ? 'low' : med > 26 ? 'medium' : med > 18 ? 'high' : 'ultra';
    return this.result;
  }
}
