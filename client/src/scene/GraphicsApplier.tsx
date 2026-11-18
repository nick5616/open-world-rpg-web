// Inside the Canvas (playtest 2 graphics settings): the bits of the graphics
// settings that belong to the canvas rather than the world scene.
//
//  - Retro style: nearest-neighbour upscale of the low internal resolution
//    (CSS image-rendering on the canvas; the pixel ratio itself is GameCanvas'
//    dpr prop, from stores/graphics.ts pixelRatioFor).
//  - Auto quality's governor (playtest 5, CR 057): once the world is playable,
//    measure real frame times for ~28 s (stores/gpuDetect.ts AutoGovernor) and
//    apply its verdicts (down when p90 is over budget, one try up when there is
//    headroom). Auto only: an explicit tier is never touched, and the governor
//    stops the moment the player picks one. A tier the player was not yet told
//    about shows the one-time "Graphics set to ..." notice
//    (ui/graphics/autoTierNotice.ts).

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useQualityStore } from '../stores/qualityStore';
import { AutoGovernor } from '../stores/gpuDetect';
import { useGraphics } from '../stores/graphics';
import { worldDebug } from '../world/debug/worldDebug';
import { announceAutoTier } from '../ui/graphics/autoTierNotice';

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

  const gov = useRef<AutoGovernor | null>(null);
  const waited = useRef(0);
  useFrame((_, delta) => {
    const q = useQualityStore.getState();
    if (q.setting !== 'auto') {
      gov.current = null; // an explicit choice ends the measurement; picking Auto again starts a fresh one
      return;
    }
    if (worldDebug.firstPlayableMs === null || document.hidden) return;
    if (gov.current?.done) return;
    // The first seconds of a fresh world are terrain streaming, town building and shader compiles: not what this machine
    // sustains. Measure once the tile queue is empty (or after 25 s of waiting, whatever it is doing).
    const t = worldDebug.terrain?.stats;
    waited.current += delta * 1000;
    if (t && (t.queued + t.inFlight > 0 || t.missingWanted > 0) && waited.current < 25000) return;
    gov.current ??= new AutoGovernor(q.tier);
    const step = gov.current.add(delta * 1000);
    if (!step) return;
    const changed = q.autoApply(step.tier, step.p50);
    if (changed || step.kind === 'settled') worldDebug.autoTierLog.push({ atMs: Math.round(performance.now()), kind: step.kind, tier: step.tier, p50: step.p50, p90: step.p90, changed });
    if (step.kind === 'settled') announceAutoTier(step.tier);
  });
  return null;
}
