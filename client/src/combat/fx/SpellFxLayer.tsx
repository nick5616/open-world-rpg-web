// Mounts the spell FX engine (engine.ts) in the world canvas and drives it
// from one useFrame. CombatLayer mounts it online; in debug builds solo play
// mounts it too, so the FX gallery and the cast-spam bench run on the real
// world and post chain (window.__lodestoneFx).
//
// Also runs the light GPU assessment (gpu.ts) once: the renderer string
// right away, a frame-time sample once frames are steady; the result only
// caps the 'auto' default (quality.ts).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useQualityStore } from '../../stores/qualityStore';
import { useGround } from '../../scene/groundContext';
import { DEBUG } from '../../config';
import { SpellFxEngine } from './engine';
import { setSpellFxEngine } from './api';
import { fxLightCount, getGpuCap, setGpuCap, minFxTier, currentFxTier, setFxSetting, getFxSetting, type FxSetting } from './quality';
import { classifyGpu, FrameSampler, gpuInfo } from './gpu';
import { installFxDebug } from './debug';

const sampler = new FrameSampler();
let gpuClass: ReturnType<typeof classifyGpu> | null = null;

export function SpellFxLayer() {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const ground = useGround();
  // The light count shapes every lit shader: fixed per shader tier (an
  // explicit setting change remounts; auto steps never do).
  const shaderTier = useQualityStore((s) => s.shaderTier);
  const engine = useMemo(() => new SpellFxEngine(fxLightCount(shaderTier)), [shaderTier]);
  const maxPoint = useMemo(() => {
    const ctx = gl.getContext();
    const r = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE) as ArrayLike<number> | null;
    return r ? Math.min(512, r[1]) : 256;
  }, [gl]);

  useEffect(() => {
    scene.add(engine.group);
    setSpellFxEngine(engine);
    if (!gpuClass) {
      gpuClass = classifyGpu(gpuInfo(gl.getContext()));
      setGpuCap(gpuClass);
    }
    const off = DEBUG ? installFxDebug(engine) : undefined;
    return () => {
      off?.();
      setSpellFxEngine(null);
      engine.clear();
      scene.remove(engine.group);
      engine.dispose();
    };
  }, [scene, engine, gl]);

  useEffect(() => {
    engine.prims.ground = ground;
  }, [engine, ground]);

  useFrame((state, delta) => {
    engine.update(state.camera, { width: state.size.width, height: state.size.height, dpr: state.viewport.dpr, maxPoint });
    // Frame-time sample (skips the first second of loading hitches): caps the auto default only.
    if (!sampler.result) {
      const cap = sampler.add(delta * 1000);
      if (cap) setGpuCap(minFxTier(gpuClass ?? 'high', cap));
    }
  });

  return null;
}

/** For the settings screen / console: the FX override and what runs now. */
export function fxSettings(): { setting: FxSetting; tier: string; gpuCap: string | null; set: (s: FxSetting) => void } {
  return { setting: getFxSetting(), tier: currentFxTier(), gpuCap: getGpuCap(), set: setFxSetting };
}
