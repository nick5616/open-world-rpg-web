// The duel ring on the ground (playtest 2, CR 019): a glowing band and a
// low, fading curtain around the ring's centre, laid on the terrain (each
// vertex at the ground height under it), gold while the duel counts down
// and fights, red while you stand outside it. Built once per duel (two
// meshes, two draw calls). Mounted inside the world canvas by NetPlay.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGround } from '../../scene/groundContext';
import { DUEL_PHASE } from './events';
import { usePvp } from './store';

const SEGMENTS = 160;
const BAND_W = 0.35;
const CURTAIN_H = 1.6;

/** Ring geometry: a flat band (y on the ground) and a vertical curtain. */
export function ringGeometry(cx: number, cz: number, radius: number, heightAt: (x: number, z: number) => number): { band: THREE.BufferGeometry; curtain: THREE.BufferGeometry } {
  const band: number[] = [];
  const curtain: number[] = [];
  const uv: number[] = [];
  const idxB: number[] = [];
  const idxC: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const xo = cx + cs * (radius + BAND_W / 2);
    const zo = cz + sn * (radius + BAND_W / 2);
    const xi = cx + cs * (radius - BAND_W / 2);
    const zi = cz + sn * (radius - BAND_W / 2);
    const x = cx + cs * radius;
    const z = cz + sn * radius;
    const g = heightAt(x, z);
    band.push(xi, heightAt(xi, zi) + 0.06, zi, xo, heightAt(xo, zo) + 0.06, zo);
    curtain.push(x, g, z, x, g + CURTAIN_H, z);
    uv.push(i / SEGMENTS, 0, i / SEGMENTS, 1);
    if (i < SEGMENTS) {
      const k = i * 2;
      idxB.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      idxC.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const b = new THREE.BufferGeometry();
  b.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
  b.setIndex(idxB);
  const c = new THREE.BufferGeometry();
  c.setAttribute('position', new THREE.Float32BufferAttribute(curtain, 3));
  c.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  c.setIndex(idxC);
  return { band: b, curtain: c };
}

let fade: THREE.CanvasTexture | null = null;
function fadeTexture(): THREE.Texture | null {
  if (fade || typeof document === 'undefined') return fade;
  const cv = document.createElement('canvas');
  cv.width = 2;
  cv.height = 32;
  const g = cv.getContext('2d');
  if (!g) return null;
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 32);
  fade = new THREE.CanvasTexture(cv);
  return fade;
}

const GOLD = new THREE.Color('#ffd166');
const RED = new THREE.Color('#ff4d4d');

export function DuelRing() {
  const scene = useThree((s) => s.scene);
  const ground = useGround();
  const duel = usePvp((s) => s.duel);
  const show = !!duel && duel.phase >= DUEL_PHASE.countdown;
  const key = show ? `${duel.id}:${duel.center.x}:${duel.center.z}:${duel.radius}` : '';
  const mats = useMemo(
    () => ({
      band: new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      curtain: new THREE.MeshBasicMaterial({ color: GOLD, alphaMap: fadeTexture(), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    }),
    [],
  );
  const meshes = useMemo(() => {
    if (!show || !duel) return null;
    const g = ringGeometry(duel.center.x, duel.center.z, duel.radius, (x, z) => ground.heightAt(x, z));
    const band = new THREE.Mesh(g.band, mats.band);
    const curtain = new THREE.Mesh(g.curtain, mats.curtain);
    for (const m of [band, curtain]) {
      m.frustumCulled = false;
      m.renderOrder = 5;
    }
    band.name = 'duel-ring';
    return { band, curtain };
  }, [key, ground, mats]); // key names the duel and its ring; the rest of `duel` changes every event
  useEffect(() => {
    if (!meshes) return;
    scene.add(meshes.band, meshes.curtain);
    return () => {
      scene.remove(meshes.band, meshes.curtain);
      meshes.band.geometry.dispose();
      meshes.curtain.geometry.dispose();
    };
  }, [meshes, scene]);
  useEffect(
    () => () => {
      mats.band.dispose();
      mats.curtain.dispose();
    },
    [mats],
  );
  useFrame(() => {
    if (!meshes) return;
    const d = usePvp.getState().duel;
    const out = !!d && d.forfeitAt > 0;
    const t = performance.now() / 1000;
    const c = out ? RED : GOLD;
    mats.band.color.copy(c);
    mats.curtain.color.copy(c);
    mats.band.opacity = 0.65 + 0.25 * Math.sin(t * (out ? 9 : 3));
    mats.curtain.opacity = (d?.phase === DUEL_PHASE.countdown ? 0.5 : 0.3) + (out ? 0.2 : 0);
  });
  return null;
}
