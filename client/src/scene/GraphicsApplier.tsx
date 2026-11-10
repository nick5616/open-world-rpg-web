// Inside the Canvas (playtest 2 graphics settings): the bits of the graphics
// settings that belong to the canvas rather than the world scene.
//
//  - Retro style: nearest-neighbour upscale of the low internal resolution
//    (CSS image-rendering on the canvas; the pixel ratio itself is GameCanvas'
//    dpr prop, from stores/graphics.ts pixelRatioFor).
//  - First-run auto-detect, second half: once the world is playable, sample
//    frame times; a slow machine steps down now (cheap knobs only, no
//    recompile) and starts at the refined tier next session.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useQualityStore } from '../stores/qualityStore';
import { FrameSampler, refineTier } from '../stores/gpuDetect';
import { useGraphics } from '../stores/graphics';
import { worldDebug } from '../world/debug/worldDebug';

export function GraphicsApplier() {
  const gl = useThree((s) => s.gl);
  const retro = useGraphics().retro !== null;
  useEffect(() => {
    const el = gl.domElement;
    el.style.imageRendering = retro ? 'pixelated' : '';
    return () => {
      el.style.imageRendering = '';
    };
  }, [gl, retro]);

  const sampler = useRef<FrameSampler | null>(null);
  useFrame((_, delta) => {
    const q = useQualityStore.getState();
    const d = q.detected;
    if (q.setting !== 'auto' || !d || d.frameMs !== null) return;
    if (worldDebug.firstPlayableMs === null || document.hidden) return;
    sampler.current ??= new FrameSampler();
    const med = sampler.current.add(delta * 1000);
    if (med === null) return;
    const tier = refineTier(d.gpuTier, med);
    q.setDetected({ ...d, frameMs: +med.toFixed(1), tier });
    // This session: auto steps down to it (the cheap knobs, like the monitor would).
    const now = useQualityStore.getState;
    for (let i = 0; i < 3 && TIER_INDEX[now().tier] > TIER_INDEX[tier]; i++) now().stepDown();
  });
  return null;
}

const TIER_INDEX = { low: 0, medium: 1, high: 2, ultra: 3 } as const;
