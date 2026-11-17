// Building pieces in the world (CR 041): the instanced renderer (renderer.ts)
// fed from the camp store, plus the build ghost. Per frame it only moves the
// ghost and the light pool; instances are rebuilt when the pieces change or
// you walk 24 m.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, worldClock } from '../../state/live';
import { useAccessibility } from '../../stores/accessibility';
import { useCamps } from '../camps/store';
import { ghostOk, updateBuildGhost } from './ghost';
import { BuildRenderer, ghostMesh } from './renderer';

const MOVE_RESYNC_M = 24;

/** 0 by day, 1 at night, ramping through dusk and dawn. */
export function darkness(timeOfDayS: number): number {
  const h = ((timeOfDayS / 3600) * 24) % 24;
  if (h >= 19 || h < 5.5) return 1;
  if (h >= 17 && h < 19) return (h - 17) / 2;
  if (h >= 5.5 && h < 7.5) return 1 - (h - 5.5) / 2;
  return 0;
}

export function BuildLayer() {
  const scene = useThree((s) => s.scene);
  const calm = useAccessibility((s) => s.reduceFlashing);
  const parts = useMemo(() => {
    const r = new BuildRenderer(true);
    const ghostRoot = new THREE.Group();
    ghostRoot.visible = false;
    r.root.add(ghostRoot);
    return { r, ghostRoot, ghostKey: '', pieces: null as unknown, sx: 1e9, sz: 1e9 };
  }, []);

  useEffect(() => {
    scene.add(parts.r.root);
    return () => {
      scene.remove(parts.r.root);
      parts.r.dispose();
    };
  }, [scene, parts]);

  useFrame((state) => {
    const s = useCamps.getState();
    const px = localPlayer.pos.x;
    const pz = localPlayer.pos.z;
    if (s.pieces !== parts.pieces || Math.hypot(px - parts.sx, pz - parts.sz) > MOVE_RESYNC_M) {
      parts.pieces = s.pieces;
      parts.sx = px;
      parts.sz = pz;
      parts.r.sync(Object.values(s.pieces), px, pz);
    }
    parts.r.frame(state.clock.elapsedTime, px, localPlayer.pos.y, pz, darkness(worldClock.timeOfDayS), calm);
    // The ghost.
    const g = updateBuildGhost();
    parts.ghostRoot.visible = g.active;
    if (!g.active) {
      if (parts.ghostKey) {
        parts.ghostRoot.clear();
        parts.ghostKey = '';
      }
      return;
    }
    const ok = ghostOk(g);
    const key = `${g.kind}:${ok}`;
    if (key !== parts.ghostKey) {
      parts.ghostRoot.clear();
      parts.ghostRoot.add(ghostMesh(g.kind, ok));
      parts.ghostKey = key;
    }
    parts.ghostRoot.position.set(g.x / 100, g.y / 100, g.z / 100);
    parts.ghostRoot.rotation.y = -g.rot * (Math.PI / 4);
  });
  return null;
}
