// Level up, in the world (CR 052): a soft golden glow rises around your
// character (a spiral of motes lifting from your feet to above your head and
// fading), with the level-up sound the audio system already plays. The
// banner shrinks to one small line (ui/progression, Immersive HUD). One
// Points object of GLOW_N vertices on the wisp's shader; no lights. Under
// Reduce flashing the motes ease in slower and never pulse.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer } from '../../state/live';
import { useProgression } from '../../ui/progression/store';
import { useAccessibility } from '../../stores/accessibility';
import { makeGlowMaterial } from '../guide/WispLayer';

let glowMat: THREE.ShaderMaterial | null = null;
const levelGlowMaterial = () => (glowMat ??= makeGlowMaterial(new THREE.Color(1.0, 0.78, 0.3)));

export const GLOW_N = 28;
/** Seconds the glow lasts. */
export const GLOW_S = 3.4;

export interface Mote {
  x: number;
  y: number;
  z: number;
  size: number;
  alpha: number;
}

/** Mote `i` at age t (s) around the feet: a rising spiral, widest at the waist, fading toward the top and the end. Pure. */
export function moteAt(i: number, t: number, out: Mote, calm = false): Mote {
  const k = i / GLOW_N;
  const delay = k * 0.9;
  const a = Math.max(0, t - delay);
  const life = Math.min(1, a / (GLOW_S - 0.9));
  const ang = k * Math.PI * 2 * 3 + a * 1.9;
  const r = 0.55 + 0.35 * Math.sin(life * Math.PI) + 0.1 * Math.sin(k * 17);
  out.x = Math.cos(ang) * r;
  out.z = Math.sin(ang) * r;
  out.y = 0.1 + life * 2.6;
  const fadeIn = Math.min(1, a / (calm ? 0.7 : 0.35));
  out.alpha = t < delay ? 0 : fadeIn * Math.pow(1 - life, 0.8) * 0.9;
  out.size = 0.16 + 0.1 * Math.sin(k * 11 + a * 2) ** 2;
  return out;
}

export function LevelGlow() {
  const scene = useThree((s) => s.scene);
  const reduce = useAccessibility((s) => s.reduceFlashing);
  const obj = useMemo(() => {
    const pos = new Float32Array(GLOW_N * 3);
    const size = new Float32Array(GLOW_N);
    const alpha = new Float32Array(GLOW_N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(g, levelGlowMaterial());
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    pts.visible = false;
    pts.name = 'level-glow';
    return { pts, pos, size, alpha, g, at: -1, lastId: useProgression.getState().fanfare?.id ?? 0 };
  }, []);
  const mote = useMemo<Mote>(() => ({ x: 0, y: 0, z: 0, size: 0, alpha: 0 }), []);

  useEffect(() => {
    scene.add(obj.pts);
    return () => {
      scene.remove(obj.pts);
      obj.g.dispose();
    };
  }, [scene, obj]);

  useFrame((state) => {
    const f = useProgression.getState().fanfare;
    if (f && f.id !== obj.lastId) {
      obj.lastId = f.id;
      obj.at = state.clock.elapsedTime;
    }
    if (obj.at < 0) return;
    const t = state.clock.elapsedTime - obj.at;
    if (t > GLOW_S) {
      obj.at = -1;
      obj.pts.visible = false;
      return;
    }
    const feet = localPlayer.pos;
    for (let i = 0; i < GLOW_N; i++) {
      moteAt(i, t, mote, reduce);
      obj.pos[i * 3] = feet.x + mote.x;
      obj.pos[i * 3 + 1] = feet.y + mote.y;
      obj.pos[i * 3 + 2] = feet.z + mote.z;
      obj.size[i] = mote.size;
      obj.alpha[i] = mote.alpha;
    }
    for (const k of ['position', 'aSize', 'aAlpha']) (obj.g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    const cam = state.camera as THREE.PerspectiveCamera;
    levelGlowMaterial().uniforms.uScale.value = (state.size.height * 0.5) / Math.tan(((cam.fov ?? 70) * Math.PI) / 360);
    obj.pts.visible = true;
  });

  return null;
}
