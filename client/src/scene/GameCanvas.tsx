// R3F scene root for play. Owns the Canvas, quality-driven renderer options,
// the adaptive quality monitor, sky/light, the ground visual, the player
// controller and the first-person arms. The ground (collision) and its visual
// are props so WP05 can swap in streamed terrain without editing this file.

import { Suspense, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { useQualityStore, QUALITY_PRESETS } from '../stores/qualityStore';
import { useDebugStore } from '../stores/debugStore';
import { DEBUG } from '../config';
import type { GroundQuery } from '../sim/ground';
import type { StepRecord } from '../sim/localSim';
import { DEFAULT_GROUND, GroundContext } from './groundContext';
import { PlayerController } from './PlayerController';
import { FirstPersonArms } from './FirstPersonArms';
import { SkyAndSun } from './SkyAndSun';
import { FlatTerrain } from './FlatTerrain';
import { CellBorders } from './CellBorders';

interface Props {
  ground?: GroundQuery;
  /** Visual for the ground; defaults to the flat placeholder. */
  terrain?: ReactNode;
  onStep?: (r: StepRecord) => void;
}

/** The view model is parented to the camera, so the camera must be in the scene graph. */
function CameraInScene() {
  const camera = useThree((s) => s.camera);
  return <primitive object={camera} />;
}

export function GameCanvas({ ground = DEFAULT_GROUND, terrain, onStep }: Props) {
  const tier = useQualityStore((s) => s.tier);
  const preset = QUALITY_PRESETS[tier];
  const showCells = useDebugStore((s) => s.showCells);

  return (
    <Canvas
      style={{ position: 'fixed', inset: 0 }}
      // near 0.05 so the arms (0.3 m from the eye) never clip; far follows the tier.
      camera={{ fov: 75, near: 0.05, far: preset.viewDistance }}
      // MSAA is fixed at context creation (the tier at first mount decides);
      // 'high-performance' asks hybrid-GPU laptops for the discrete GPU.
      gl={{ antialias: preset.antialias, powerPreference: 'high-performance' }}
      // Cap the backing-store scale: a 2-3x hi-dpi display otherwise renders
      // 4-9x the pixels. The monitor lowers it further (via the tier) when frames run long.
      dpr={[1, preset.dpr]}
      shadows={preset.shadows}
      onCreated={(state) => {
        // Dev-only handle for perf tooling (renderer.info, draw calls).
        if (DEBUG) (window as unknown as { __r3f?: unknown }).__r3f = state;
      }}
    >
      <PerformanceMonitor
        flipflops={3}
        onDecline={() => useQualityStore.getState().stepDown()}
        onIncline={() => useQualityStore.getState().stepUp()}
        // Sustained misses only: a lone hitch must not drop the whole tier.
        onFallback={() => useQualityStore.getState().stepDown()}
      />
      <GroundContext.Provider value={ground}>
        <CameraInScene />
        <Suspense fallback={null}>
          <SkyAndSun />
          {terrain ?? <FlatTerrain height={ground.heightAt(0, 0)} />}
          {DEBUG && showCells && <CellBorders />}
        </Suspense>
        <PlayerController onStep={onStep} />
        <FirstPersonArms />
      </GroundContext.Provider>
    </Canvas>
  );
}
