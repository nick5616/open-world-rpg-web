// Landmarks that call you from afar (CR 052): smoke over bandit camps, a faint
// light pillar over towers you have not attuned (dusk and night), lanterns at
// dwarven hall doors, a glow at cave mouths, birds circling a vault or an
// active world event, glints on sky palaces. Three small Points objects (an
// additive glow set, a soft smoke set, a dark birds set: three draw calls)
// plus up to four pillar beams (the quest beam's geometry, a cheap draw
// each). Everything is emissive sprites: no lights are added or removed.
// Only the nearest few of each kind within its range are alive, refreshed
// twice a second; the per-frame work is a few dozen particles. Quality: Low
// drops the birds and glints and halves the plumes.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldRuntime } from '../core/runtime';
import { makeSkyLighting, skyLighting } from '../sky/atmosphere';
import { windState } from '../wind';
import { worldClock } from '../../state/live';
import { useContent } from '../../ui/content/store';
import { isAttuned } from '../../ui/progression/store';
import { questBeamResources } from '../../ui/quests/QuestLayer';
import { useQualityStore } from '../../stores/qualityStore';
import { birdAt, BIRDS_PER_SITE, duskK, glint, LANDMARK_RANGE, nearestSites, partitionLandmarks, PLUME_PUFFS, puffAt, type BirdPos, type LSite, type Puff } from './landmarks';

const GLOW_CAP = 64;
const SMOKE_CAP = 6 * PLUME_PUFFS;
const BIRD_CAP = 3 * BIRDS_PER_SITE;

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vA;
varying vec3 vC;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), aAlpha > 0.0005 ? 1.5 : 0.0, 260.0);
  vA = aAlpha;
  vC = aColor;
}`;
const FRAG_GLOW = /* glsl */ `
varying float vA; varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float c = pow(1.0 - d, 2.4);
  gl_FragColor = vec4(vC * c * 1.8, c * vA);
}`;
const FRAG_SOFT = /* glsl */ `
varying float vA; varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float c = smoothstep(1.0, 0.15, d);
  gl_FragColor = vec4(vC, c * vA);
}`;
const FRAG_BIRD = /* glsl */ `
varying float vA; varying vec3 vC;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  // a small dark "v": two short wings
  float body = step(abs(p.y + abs(p.x) * 0.5 - 0.05), 0.07) * step(abs(p.x), 0.5);
  if (body < 0.5) discard;
  gl_FragColor = vec4(vC, vA);
}`;

const mats: Record<string, THREE.ShaderMaterial> = {};
function material(kind: 'glow' | 'smoke' | 'birds'): THREE.ShaderMaterial {
  mats[kind] ??= new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: kind === 'glow' ? FRAG_GLOW : kind === 'smoke' ? FRAG_SOFT : FRAG_BIRD,
    uniforms: { uScale: { value: 700 } },
    transparent: true,
    depthWrite: false,
    blending: kind === 'glow' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  return mats[kind];
}

interface Set {
  pts: THREE.Points;
  pos: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
  col: Float32Array;
  n: number;
}

function makeSet(kind: 'glow' | 'smoke' | 'birds', cap: number): Set {
  const pos = new Float32Array(cap * 3);
  const size = new Float32Array(cap);
  const alpha = new Float32Array(cap);
  const col = new Float32Array(cap * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const pts = new THREE.Points(g, material(kind));
  pts.frustumCulled = false;
  pts.renderOrder = kind === 'smoke' ? 3 : 5;
  pts.name = `landmarks-${kind}`;
  return { pts, pos, size, alpha, col, n: 0 };
}

function put(s: Set, x: number, y: number, z: number, size: number, alpha: number, r: number, g: number, b: number): void {
  if (s.n >= s.alpha.length) return;
  const i = s.n++;
  s.pos[i * 3] = x;
  s.pos[i * 3 + 1] = y;
  s.pos[i * 3 + 2] = z;
  s.size[i] = size;
  s.alpha[i] = alpha;
  s.col[i * 3] = r;
  s.col[i * 3 + 1] = g;
  s.col[i * 3 + 2] = b;
}

function flush(s: Set): void {
  for (let i = s.n; i < s.alpha.length; i++) {
    s.alpha[i] = 0;
    s.size[i] = 0;
  }
  const g = s.pts.geometry;
  for (const k of ['position', 'aSize', 'aAlpha', 'aColor']) (g.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
  s.n = 0;
}

/** Fade by distance: full inside 60% of the range, gone at the range. */
const rangeFade = (d: number, range: number) => Math.max(0, Math.min(1, (range - d) / (range * 0.4)));

export function LandmarkLayer({ runtime }: { runtime: WorldRuntime }) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const lm = useMemo(() => {
    const sites: LSite[] = runtime.data.sites.map((s) => ({ index: s.index, category: s.category, kind: s.kind, x: s.x, y: s.y, z: s.z, yaw: s.yaw, layer: s.layer }));
    return partitionLandmarks(sites);
  }, [runtime]);
  const world = useMemo(() => {
    const root = new THREE.Group();
    root.name = 'landmarks';
    const glow = makeSet('glow', GLOW_CAP);
    const smoke = makeSet('smoke', SMOKE_CAP);
    const birds = makeSet('birds', BIRD_CAP);
    const r = questBeamResources();
    const beams = Array.from({ length: LANDMARK_RANGE.pillar.max }, () => {
      const m = new THREE.Mesh(r.geo, r.mat.clone());
      (m.material as THREE.MeshBasicMaterial).color.set('#a8ecff');
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 3;
      return m;
    });
    root.add(smoke.pts, glow.pts, birds.pts, ...beams);
    return {
      root, glow, smoke, birds, beams,
      acc: 9,
      near: { smoke: [] as LSite[], pillar: [] as LSite[], lantern: [] as LSite[], glow: [] as LSite[], glint: [] as LSite[] },
      day: 1,
      birdSpots: [] as { x: number; z: number }[],
      sky: makeSkyLighting(),
    };
  }, []);

  useEffect(() => {
    scene.add(world.root);
    return () => {
      scene.remove(world.root);
      for (const s of [world.glow, world.smoke, world.birds]) s.pts.geometry.dispose();
      for (const b of world.beams) (b.material as THREE.Material).dispose();
    };
  }, [scene, world]);

  const puff = useMemo<Puff>(() => ({ x: 0, h: 0, z: 0, size: 0, alpha: 0 }), []);
  const bird = useMemo<BirdPos>(() => ({ x: 0, y: 0, z: 0 }), []);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const cam = camera.position;
    const tier = useQualityStore.getState().tier;
    const low = tier === 'low';
    world.acc += dt;
    if (world.acc > 0.5) {
      world.acc = 0;
      skyLighting(worldClock.timeOfDayS, world.sky);
      world.day = world.sky.day;
      const R = LANDMARK_RANGE;
      world.near.smoke = nearestSites(lm.smoke, cam.x, cam.z, R.smoke.range, low ? 3 : R.smoke.max);
      world.near.pillar = nearestSites(lm.pillar.filter((s) => !isAttuned(s.index)), cam.x, cam.z, R.pillar.range, R.pillar.max);
      world.near.lantern = nearestSites(lm.lantern, cam.x, cam.z, R.lantern.range, R.lantern.max);
      world.near.glow = nearestSites(lm.glow, cam.x, cam.z, R.glow.range, R.glow.max);
      world.near.glint = low ? [] : nearestSites(lm.glint, cam.x, cam.z, R.glint.range, R.glint.max);
      // Birds: a vault you know of, or a world event in progress, whichever is within range.
      const c = useContent.getState();
      const spots: { x: number; z: number; d: number }[] = [];
      for (const v of Object.values(c.vaults)) if (!v.opened) spots.push({ x: v.x, z: v.z, d: Math.hypot(v.x - cam.x, v.z - cam.z) });
      for (const e of Object.values(c.events)) if (e.phase === 1) spots.push({ x: e.x, z: e.z, d: Math.hypot(e.x - cam.x, e.z - cam.z) });
      spots.sort((a, b) => a.d - b.d);
      world.birdSpots = low ? [] : spots.filter((s) => s.d < R.birds.range).slice(0, R.birds.max);
    }
    const day = world.day;
    const night = 1 - day;
    const ground = runtime.terrainGround;
    const wl = Math.hypot(windState.dirX, windState.dirZ) || 1;
    const wx = windState.dirX / wl;
    const wz = windState.dirZ / wl;

    // Smoke.
    const sr = LANDMARK_RANGE.smoke.range;
    const sc = [0.5 * day + 0.1 * night, 0.48 * day + 0.1 * night, 0.46 * day + 0.12 * night] as const;
    world.near.smoke.forEach((s, k) => {
      const d = Math.hypot(s.x - cam.x, s.z - cam.z);
      const f = rangeFade(d, sr);
      const gy = ground.heightAt(s.x, s.z);
      for (let i = 0; i < PLUME_PUFFS; i++) {
        puffAt(s.index % 17, i, t, wx, wz, puff);
        put(world.smoke, s.x + puff.x, gy + puff.h, s.z + puff.z, puff.size, puff.alpha * f, sc[0], sc[1], sc[2]);
      }
      void k;
    });
    flush(world.smoke);

    // Glow: lanterns, cave mouths, palace glints.
    const lr = LANDMARK_RANGE.lantern.range;
    for (const s of world.near.lantern) {
      const f = rangeFade(Math.hypot(s.x - cam.x, s.z - cam.z), lr);
      const px = -Math.sin(s.yaw);
      const pz = Math.cos(s.yaw);
      const gy = ground.heightAt(s.x, s.z);
      for (const side of [-1, 1]) {
        const flick = 0.92 + 0.08 * Math.sin(t * 1.3 + side * 2 + s.index);
        put(world.glow, s.x + px * 1.8 * side, Math.max(gy, s.y) + 2.3, s.z + pz * 1.8 * side, 1.5 + 0.6 * night, (0.5 + 0.5 * night) * f * flick, 1.0, 0.62, 0.26);
      }
    }
    const gr = LANDMARK_RANGE.glow.range;
    for (const s of world.near.glow) {
      const f = rangeFade(Math.hypot(s.x - cam.x, s.z - cam.z), gr);
      put(world.glow, s.x, s.y + 1.6, s.z, 3.2 + 2.2 * night, (0.22 + 0.5 * night) * f, 1.0, 0.72, 0.42);
    }
    if (!low) {
      for (const s of world.near.glint) {
        const f = rangeFade(Math.hypot(s.x - cam.x, s.z - cam.z), LANDMARK_RANGE.glint.range);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + s.index;
          const g = glint(s.index % 11, i, t);
          put(world.glow, s.x + Math.cos(a) * 22, s.y + 8 + i * 4, s.z + Math.sin(a) * 22, 5 + 4 * g, g * (0.35 + 0.6 * day) * f, 1.0, 0.97, 0.85);
        }
      }
    }
    flush(world.glow);

    // Birds (daylight only).
    if (day > 0.3) {
      world.birdSpots.forEach((sp, k) => {
        const gy = ground.heightAt(sp.x, sp.z);
        const f = rangeFade(Math.hypot(sp.x - cam.x, sp.z - cam.z), LANDMARK_RANGE.birds.range);
        for (let i = 0; i < BIRDS_PER_SITE; i++) {
          birdAt(k * 1.7, i, t, bird);
          put(world.birds, sp.x + bird.x, gy + bird.y, sp.z + bird.z, 1.5, 0.8 * f * Math.min(1, (day - 0.3) * 4), 0.07, 0.07, 0.08);
        }
      });
    }
    flush(world.birds);

    // Pillars.
    const dk = duskK(day);
    world.beams.forEach((b, i) => {
      const s = world.near.pillar[i];
      if (!s || dk < 0.02) {
        b.visible = false;
        return;
      }
      const d = Math.hypot(s.x - cam.x, s.z - cam.z);
      const mat = b.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.34 * dk * rangeFade(d, LANDMARK_RANGE.pillar.range) * Math.min(1, Math.max(0, (d - 30) / 60)) * (0.88 + 0.12 * Math.sin(t * 0.8 + i));
      b.visible = mat.opacity > 0.01;
      b.position.set(s.x, ground.heightAt(s.x, s.z) - 1, s.z);
      const w = Math.max(1.6, Math.min(14, d / 140));
      b.scale.set(w, 1, w);
    });

    const cam3 = camera as THREE.PerspectiveCamera;
    const scale = (state.size.height * 0.5) / Math.tan(((cam3.fov ?? 70) * Math.PI) / 360);
    for (const m of Object.values(mats)) m.uniforms.uScale.value = scale;
  });

  return null;
}
