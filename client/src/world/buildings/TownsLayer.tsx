// Scene mount of the towns layer (WP20), next to WP12's StructuresLayer in
// WorldCanvas: React owns only the lifetime of the TownsManager; the
// manager updates itself from one useFrame (default priority, so before
// WorldScene renders the frame at priority 1).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { WorldRuntime } from '../core/runtime';
import { QUALITY_PRESETS, useQualityStore } from '../../stores/qualityStore';
import { TownsManager } from './townsManager';
import { installTownsDebug } from './townsDebug';
import { detailOfTier } from './detail';
import { worldDebug } from '../debug/worldDebug';

/** Night light pool by quality tier (fixed for the session: changing it would recompile every lit material). */
export function townLightCount(maxLights: number): number {
  return maxLights >= 10 ? 6 : maxLights >= 6 ? 4 : 0;
}

export function TownsLayer({ runtime }: { runtime: WorldRuntime }) {
  const camera = useThree((s) => s.camera);
  // Playtest 5: the art level (and the light pool) follow the shader tier, so a live Low -> High switch rebuilds the
  // town meshes at the new detail instead of keeping the first mount's. Auto's governor sets the shader tier once, in
  // the first seconds of play (stores/qualityStore.ts autoApply), so that is at most one rebuild.
  const shaderTier = useQualityStore((s) => s.shaderTier);
  const manager = useMemo(() => {
    if (!runtime.towns) return null;
    try {
      return new TownsManager(runtime, townLightCount(QUALITY_PRESETS[shaderTier].maxLights), detailOfTier(shaderTier));
    } catch (err) {
      console.warn('[towns] layer unavailable', err);
      return null;
    }
  }, [runtime, shaderTier]);

  useEffect(() => {
    if (!manager) return;
    const uninstall = installTownsDebug(manager);
    worldDebug.townsIdle = () => manager.idle();
    return () => {
      if (worldDebug.townsIdle) worldDebug.townsIdle = null;
      uninstall();
      manager.dispose();
    };
  }, [manager]);

  useFrame((_, delta) => manager?.update(camera, Math.min(delta, 0.1)));

  return manager ? <primitive object={manager.group} /> : null;
}
