// In-world quest markers (playtest 1): a soft beam of light rising from
// each of the tracked quest's current markers, so you can see where to go
// from a hill. One shared geometry and material, at most a few meshes (a
// draw call each); beams fade as you arrive and when far away. Mounted
// inside the world canvas by NetPlay.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { nightRuntime } from '../../systems/night';
import { trackedQuest } from './store';
import { liveMarkers } from './live';

const MAX_BEAMS = 4;
const BEAM_H = 320;

let shared: { geo: THREE.CylinderGeometry; mat: THREE.MeshBasicMaterial } | null = null;

/** Cached (never disposed: pbrMaterial rule) beam geometry and material. */
export function questBeamResources() {
  if (shared) return shared;
  // Vertical gradient: bright at the ground, fading upward.
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  const geo = new THREE.CylinderGeometry(0.9, 0.9, BEAM_H, 10, 1, true);
  geo.translate(0, BEAM_H / 2, 0);
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd166', alphaMap: tex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  shared = { geo, mat };
  return shared;
}

export function QuestLayer() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const beams = useMemo(() => {
    const r = questBeamResources();
    return Array.from({ length: MAX_BEAMS }, () => {
      const m = new THREE.Mesh(r.geo, r.mat.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 4;
      return m;
    });
  }, []);
  useEffect(() => {
    for (const b of beams) scene.add(b);
    return () => {
      for (const b of beams) {
        scene.remove(b);
        (b.material as THREE.Material).dispose();
      }
    };
  }, [scene, beams]);
  useFrame((state) => {
    const q = trackedQuest();
    const rt = nightRuntime.runtime;
    const ms = liveMarkers(q); // playtest 2: a person's beam follows them
    const t = state.clock.elapsedTime;
    beams.forEach((b, i) => {
      const m = ms[i];
      if (!m || !rt) {
        b.visible = false;
        return;
      }
      const d = Math.hypot(m.x - camera.position.x, m.z - camera.position.z);
      const r = m.r ?? 0;
      // Fade out inside the area / on arrival, and gently with distance.
      const near = Math.min(1, Math.max(0, (d - Math.max(6, r * 0.5)) / 25));
      const far = 1 - Math.min(0.6, d / 4000);
      const mat = b.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.6 * near * far * (0.85 + 0.15 * Math.sin(t * 2 + i));
      b.visible = mat.opacity > 0.01;
      b.position.set(m.x, rt.terrainGround.heightAt(m.x, m.z) - 1, m.z);
      // Wider for areas, and with distance so it stays visible.
      const w = Math.max(1, Math.min(9, d / 110)) * (r > 0 ? 1.6 : 1);
      b.scale.set(w, 1, w);
    });
  });
  return null;
}
