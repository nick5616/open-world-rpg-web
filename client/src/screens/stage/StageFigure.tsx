// The character on the stage: the game's own procedural Avatar (net/avatar.ts,
// full rig, idle animation) restyled with a creation look, turned by the
// player's drag (yawRef) and gently by itself while untouched.

import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Avatar } from '../../net/avatar';
import type { RemoteView } from '../../net/interpolation';
import type { Look } from '../../net/look';
import { floorY } from './caveGen';

export interface StageFigureProps {
  look: Look;
  yawRef: MutableRefObject<number>;
  /** Slow self-turn while nobody is dragging (off under prefers-reduced-motion). */
  sway: boolean;
}

export function StageFigure({ look, yawRef, sway }: StageFigureProps) {
  const camera = useThree((s) => s.camera);
  const avatar = useMemo(() => new Avatar(7, { nameplate: false, look }), []);
  const view = useMemo(
    () => ({ id: 7, x: 0, y: floorY(0, 0), z: 0, yaw: Math.PI, pitch: 0, speed: 0, kind: 0, name: '', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: 0, appearance: 0, ring: 0, delayMs: 0, mode: 'interp' }) as unknown as RemoteView,
    [],
  );
  const blob = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.65)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);
  useEffect(() => {
    avatar.setLook(look);
  }, [avatar, look]);
  useEffect(() => () => avatar.dispose(), [avatar]);
  useFrame((st, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    if (sway) yawRef.current += dt * 0.04 * Math.sin(st.clock.elapsedTime * 0.3);
    // the avatar faces -Z at yaw 0; the camera is on +Z, so the resting yaw is a half turn
    view.yaw = Math.PI + yawRef.current;
    avatar.update(view, camera, dt);
  });
  return (
    <>
      <primitive object={avatar.root} />
      <mesh position={[0, floorY(0, 0) + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <circleGeometry args={[0.9, 24]} />
        <meshBasicMaterial map={blob} transparent depthWrite={false} />
      </mesh>
    </>
  );
}
