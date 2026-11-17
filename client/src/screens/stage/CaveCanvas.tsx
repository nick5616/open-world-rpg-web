// The lazy 3D half of the backdrop: an R3F Canvas around CaveWorld (and the
// character on the stage). Its own chunk, loaded after first paint.

import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { MutableRefObject } from 'react';
import { CaveWorld, type WorldQuality } from './CaveWorld';
import { StageFigure } from './StageFigure';
import type { Look } from '../../net/look';
import type { StageVariant } from './caveGen';

export interface CaveCanvasProps {
  variant: StageVariant;
  quality: WorldQuality;
  look?: Look | null;
  yawRef: MutableRefObject<number>;
  offsetY: number;
  onReady: () => void;
  onFail: () => void;
}

export default function CaveCanvas({ variant, quality, look, yawRef, offsetY, onReady, onFail }: CaveCanvasProps) {
  return (
    <Canvas
      dpr={quality.tier === 'full' ? [1, 1.75] : [1, 1]}
      gl={{ antialias: quality.tier === 'full', powerPreference: 'high-performance', preserveDrawingBuffer: false }}
      camera={{ fov: 50, near: 0.1, far: 120, position: [0, -2, 5] }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          onFail();
        });
        // two frames in, so the fade-in never shows an unlit first frame
        requestAnimationFrame(() => requestAnimationFrame(onReady));
      }}
      style={{ position: 'absolute', inset: 0, touchAction: 'pan-y' }}
    >
      <CaveWorld variant={variant} quality={quality} yawRef={yawRef} offsetY={offsetY}>
        {variant === 'stage' && look && <StageFigure look={look} yawRef={yawRef} sway={!quality.reducedMotion} />}
      </CaveWorld>
    </Canvas>
  );
}
