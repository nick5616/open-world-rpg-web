// Which backdrop this browser gets: the live 3D cavern, a lighter 3D cavern
// (phones, integrated GPUs), or the static CSS cavern (no WebGL, software
// rendering, or `?cave=0`). Decided once, before anything renders, from the
// same cheap GPU probe the graphics auto-tier uses; `?cave=1` forces 3D
// (screenshots on a software renderer), `?cave=lite` forces the light tier.

import { classifyGpu, probeGpu } from '../../stores/gpuDetect';
import { prefersReducedMotion } from '../../combat/flashSafety';
import { useAccessibility } from '../../stores/accessibility';

export type SceneMode = 'full' | 'lite' | 'css';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

let cached: SceneMode | null = null;

export function sceneMode(): SceneMode {
  if (cached) return cached;
  const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  const force = q.get('cave');
  if (force === '0') return (cached = 'css');
  if (force === '1') return (cached = 'full');
  if (force === 'lite') return (cached = 'lite');
  const p = probeGpu();
  if (!p) return (cached = 'css'); // no DOM / jsdom
  if (!p.renderer || p.renderer === 'no webgl2') return (cached = 'css');
  if (SOFTWARE.test(p.renderer)) return (cached = 'css');
  const tier = classifyGpu(p);
  return (cached = tier === 'low' || p.mobile ? 'lite' : 'full');
}

/** Test hook. */
export function resetSceneMode(): void {
  cached = null;
}

export function calmNow(): { reducedMotion: boolean; calm: boolean } {
  const reducedMotion = prefersReducedMotion();
  return { reducedMotion, calm: reducedMotion || useAccessibility.getState().reduceFlashing };
}
