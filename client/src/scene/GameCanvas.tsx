// R3F scene root for play. Owns the Canvas, quality-driven renderer options,
// the adaptive quality monitor, sky/light, the ground visual, the player
// controller and the first-person arms. The ground (collision) and its visual
// are props so WP05 can swap in streamed terrain without editing this file.

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { useQualityStore, QUALITY_PRESETS } from '../stores/qualityStore';
// Playtest 2 graphics settings: resolved knobs and the style hooks in every
// lit material (the chunk patch must run before the first program compiles).
import { pixelRatioFor, useGraphics } from '../stores/graphics';
import '../world/style/styleShader';
import { GraphicsApplier } from './GraphicsApplier';
import { useDebugStore } from '../stores/debugStore';
import { DEBUG } from '../config';
import type { GroundQuery } from '../sim/ground';
import type { StepRecord } from '../sim/localSim';
import type { PlayerDriver } from './PlayerController';
import { DEFAULT_GROUND, GroundContext } from './groundContext';
import { PlayerController } from './PlayerController';
import { FirstPersonArms } from './FirstPersonArms';
import { LocalAvatar } from './LocalAvatar';
// Playtest 2: photo mode's free camera, first-person emote feedback, fishing lines (after PlayerController: they adjust its camera).
import { PhotoRig } from '../ui/photo/PhotoRig';
import { FirstPersonEmote } from '../ui/emotes/FirstPersonEmote';
import { FirstPersonPet } from './FirstPersonPet';
import { FishingLayer } from '../ui/fishing/FishingLayer';
import { FirstPersonInstrument } from '../ui/music/FirstPersonInstrument';
import { SkyAndSun } from './SkyAndSun';
import { FlatTerrain } from './FlatTerrain';
import { CellBorders } from './CellBorders';

interface Props {
  ground?: GroundQuery;
  /** Visual for the ground; defaults to the flat placeholder. */
  terrain?: ReactNode;
  onStep?: (r: StepRecord) => void;
  /** Online play (WP06): feeds steps to the zone and applies corrections. */
  driver?: PlayerDriver;
  /** Extra scene content (remote players). */
  children?: ReactNode;
  /** Replaces the placeholder sky and sun (WP05 brings its own; pass false for none). */
  environment?: ReactNode;
  /** The world renders through its own post chain with its own MSAA, so the canvas skips MSAA. */
  ownComposer?: boolean;
}

/** The view model is parented to the camera, so the camera must be in the scene graph. */
function CameraInScene() {
  const camera = useThree((s) => s.camera);
  return <primitive object={camera} />;
}

/** Window height in CSS pixels, live (Retro's internal resolution is a fixed number of rows). */
function useWindowHeight(): number {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 1080 : window.innerHeight));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

export function GameCanvas({ ground = DEFAULT_GROUND, terrain, onStep, driver, children, environment, ownComposer }: Props) {
  const tier = useQualityStore((s) => s.tier);
  const preset = QUALITY_PRESETS[tier];
  const g = useGraphics(); // WP19: shadows follow the shader tier, never an auto step
  const showCells = useDebugStore((s) => s.showCells);
  const height = useWindowHeight();
  const dpr = pixelRatioFor(g, typeof window === 'undefined' ? 1 : window.devicePixelRatio, height);

  return (
    <Canvas
      style={{ position: 'fixed', inset: 0 }}
      // near 0.05 so the arms (0.3 m from the eye) never clip; far follows the tier.
      camera={{ fov: 75, near: 0.05, far: preset.viewDistance }}
      // MSAA is fixed at context creation (the tier at first mount decides);
      // 'high-performance' asks hybrid-GPU laptops for the discrete GPU.
      gl={{ antialias: ownComposer ? false : preset.antialias, powerPreference: 'high-performance' }}
      // Cap the backing-store scale: a 2-3x hi-dpi display otherwise renders
      // 4-9x the pixels. The monitor lowers it further (via the tier) when
      // frames run long; the Graphics screen's render scale and DPR cap, and
      // Retro's fixed row count, set it too (stores/graphics.ts).
      dpr={dpr}
      shadows={g.shadowCascades > 0}
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
      <GraphicsApplier />
      <GroundContext.Provider value={ground}>
        <CameraInScene />
        <Suspense fallback={null}>
          {environment === undefined ? <SkyAndSun /> : environment}
          {terrain ?? <FlatTerrain height={ground.heightAt(0, 0)} />}
          {DEBUG && showCells && <CellBorders />}
        </Suspense>
        <PlayerController onStep={onStep} driver={driver} />
        {children}
        <FirstPersonArms />
        {/* playtest 2: your own body in third person */}
        <LocalAvatar />
        <FirstPersonEmote />
        <FirstPersonPet />
        <FishingLayer />
        <FirstPersonInstrument />
        <PhotoRig />
      </GroundContext.Provider>
    </Canvas>
  );
}
