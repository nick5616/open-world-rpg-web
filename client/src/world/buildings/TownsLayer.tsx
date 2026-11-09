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

/** Night light pool by quality tier (fixed for the session: changing it would recompile every lit material). */
export function townLightCount(maxLights: number): number {
  return maxLights >= 10 ? 6 : maxLights >= 6 ? 4 : 0;
}

export function TownsLayer({ runtime }: { runtime: WorldRuntime }) {
  const camera = useThree((s) => s.camera);
  const manager = useMemo(() => {
    if (!runtime.towns) return null;
    try {
      return new TownsManager(runtime, townLightCount(QUALITY_PRESETS[useQualityStore.getState().shaderTier].maxLights));
    } catch (err) {
      console.warn('[towns] layer unavailable', err);
      return null;
    }
  }, [runtime]);

  useEffect(() => {
    if (!manager) return;
    const uninstall = installTownsDebug(manager);
    return () => {
      uninstall();
      manager.dispose();
    };
  }, [manager]);

  useFrame((_, delta) => manager?.update(camera, Math.min(delta, 0.1)));

  return manager ? <primitive object={manager.group} /> : null;
}
