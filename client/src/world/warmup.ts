// Shader warm-up (WP19 second pass; spec 12 "shader precompile during the
// loading screen using KHR_parallel_shader_compile").
//
// three.js compiles a material's program the first time an object using it
// is drawn, synchronously: on ANGLE/D3D11 one program is 20-200 ms of main
// thread, so every material seen for the first time during play was a long
// task (WP19 traversal: 347 ms on high, 157 ms on low) and the post chain plus
// shadowed materials of the high tier made the first frames slow (first
// playable 6.7 s vs 2.8 s on low).
//
// warmShaders compiles every material in the scene (visible or not: pooled
// effects included) plus `extra` objects that only appear later, with the
// scene's lights, through renderer.compileAsync: with KHR_parallel_shader_compile
// the driver compiles them on its own threads and we poll until they are
// ready, so the main thread stays free. It compiles against a render target,
// as the world draws through the post chain (render targets give programs
// linear output and no tone mapping: a different program than the canvas).
// While a warm-up is pending the world skips drawing (WorldScene), so no draw
// call forces a synchronous compile of a half-ready program.

import * as THREE from 'three';

let target: THREE.WebGLRenderTarget | null = null;

export interface WarmResult {
  ms: number;
  /** Programs three.js holds after the warm-up. */
  programs: number;
  /** False when the time limit hit first (the rest compiles on first use). */
  done: boolean;
}

/**
 * Compiles `scene` (and `extra`, as if it were in the scene) for `camera`,
 * resolving when every program is ready or after `limitMs`.
 */
export async function warmShaders(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, extra: THREE.Object3D[] = [], limitMs = 8000): Promise<WarmResult> {
  const t0 = performance.now();
  target ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const prev = gl.getRenderTarget();
  const jobs: Promise<unknown>[] = [];
  gl.setRenderTarget(target);
  try {
    scene.updateMatrixWorld();
    jobs.push(gl.compileAsync(scene, camera));
    if (extra.length) {
      const g = new THREE.Group();
      for (const o of extra) g.add(o);
      g.updateMatrixWorld(true);
      jobs.push(gl.compileAsync(g, camera, scene).finally(() => g.clear()));
    }
  } finally {
    gl.setRenderTarget(prev);
  }
  let timer = 0;
  const done = await Promise.race([Promise.all(jobs).then(() => true), new Promise<boolean>((r) => (timer = window.setTimeout(() => r(false), limitMs)))]);
  window.clearTimeout(timer);
  return { ms: performance.now() - t0, programs: gl.info.programs?.length ?? 0, done };
}
