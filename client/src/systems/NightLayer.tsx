// The 3D half of night and chemistry (WP15): fire (instanced flame cards
// that lean with the shared wind, a small pool of flickering lights),
// scorched ground, ice sheets, earth pillars, and the demons' look on top
// of WP13's enemy bodies (horns, burning eyes) plus rise/burn flashes. (Rain
// streaks moved to world/sky/rainStreaks.ts in playtest 2.) Mounted inside the world canvas by
// NetPlay. Imperative three.js in one useFrame: a big fire is 3 instanced
// draws and 4 lights, far inside the budget.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FIRE_UPDRAFT_TOP_M } from '@lodestone/contracts';
import { drawnRemotes } from '../net/netStore';
import { enemyInfo } from '../combat/events';
import { windState } from '../world/wind';
import { liveStyle } from '../world/style/styles';
import { localPlayer } from '../state/live';
import { cellCenter, cellX, cellZ } from './chem/sim';
import { nightFrame, nightFx, nightRuntime } from './night';

const MAX_FLAMES = 4000;
const MAX_SCORCH = 8000;
const tx = new THREE.Vector3();
const tz = new THREE.Vector3();
const tn = new THREE.Vector3();

/** A radial falloff for scorch blotches (white centre, transparent rim, a little noise). */
function scorchAlpha(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const n = 64;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const noise = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
      const a = Math.max(0, Math.min(1, (1 - d) * 1.6 - noise * 0.25));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(a * 255);
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
const MAX_ICE = 4000;

// Exported for camp fires (CR 025, ui/camps/CampLayer.tsx): the same instanced flame cards, animated here.
export const flameMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0, 1) } },
  vertexShader: /* glsl */ `
    uniform float uTime; uniform vec2 uWind;
    varying vec2 vUv; varying float vSeed;
    void main() {
      vUv = uv;
      vec4 wp = instanceMatrix * vec4(position, 1.0);
      vSeed = fract(sin(dot(wp.xz, vec2(12.9898, 78.233))) * 43758.5453);
      float h = uv.y;
      float flick = 0.75 + 0.35 * sin(uTime * (7.0 + 5.0 * vSeed) + vSeed * 40.0);
      wp.y = instanceMatrix[3].y + (wp.y - instanceMatrix[3].y) * flick;
      wp.xz += uWind * h * h * 0.6;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    varying vec2 vUv; varying float vSeed;
    void main() {
      vec2 c = vUv - vec2(0.5, 0.0);
      float w = 0.5 * (1.0 - vUv.y) + 0.04;
      float edge = smoothstep(w, w * 0.25, abs(c.x + 0.06 * sin(uTime * 9.0 + vUv.y * 8.0 + vSeed * 20.0)));
      float a = edge * smoothstep(1.0, 0.25, vUv.y) * smoothstep(0.0, 0.08, vUv.y);
      vec3 col = mix(vec3(1.0, 0.62, 0.18), vec3(0.9, 0.16, 0.02), vUv.y);
      gl_FragColor = vec4(col * 1.1 * a, a);
    }`,
});

export function flameGeometry(): THREE.BufferGeometry {
  // Two crossed cards, 1.6 m tall: a flame reads from every side.
  const a = new THREE.PlaneGeometry(1.7, 1.6);
  a.translate(0, 0.8, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([...(a.attributes.position.array as Float32Array), ...(b.attributes.position.array as Float32Array)]);
  const uv = new Float32Array([...(a.attributes.uv.array as Float32Array), ...(b.attributes.uv.array as Float32Array)]);
  const idx = [...(a.index!.array as Uint16Array), ...Array.from(b.index!.array as Uint16Array, (i) => i + 4)];
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function pillarGeometry(half: number, run: number, height: number): THREE.BufferGeometry {
  // A square frustum: CylinderGeometry with 4 segments, turned 45 degrees.
  const g = new THREE.CylinderGeometry(half * Math.SQRT2, (half + run) * Math.SQRT2, height, 4, 3);
  g.rotateY(Math.PI / 4);
  g.translate(0, height / 2, 0);
  return g;
}

interface DemonDecor {
  root: THREE.Group;
  eyes: THREE.MeshBasicMaterial;
}

const hornGeo = new THREE.ConeGeometry(0.08, 0.5, 6);
const eyeGeo = new THREE.SphereGeometry(0.065, 6, 5);
const hornMat = new THREE.MeshStandardMaterial({ color: '#b8a888', roughness: 0.45, emissive: '#2a1008', emissiveIntensity: 0.4 });

function makeDecor(size: number, lord: boolean): DemonDecor {
  const root = new THREE.Group();
  const eyes = new THREE.MeshBasicMaterial({ color: lord ? '#ff3020' : '#ff6a20' });
  const s = size * (lord ? 1.3 : 1);
  for (const side of [-1, 1]) {
    const h = new THREE.Mesh(hornGeo, hornMat);
    h.position.set(0.14 * side * s, 1.78 * size, 0);
    h.rotation.z = -0.5 * side;
    h.scale.setScalar(s);
    root.add(h);
    const e = new THREE.Mesh(eyeGeo, eyes);
    e.position.set(0.1 * side * size, 1.58 * size, -0.24 * size);
    e.scale.setScalar(size);
    root.add(e);
  }
  return { root, eyes };
}

export function NightLayer() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const parts = useMemo(() => {
    const root = new THREE.Group();
    root.name = 'night-layer';
    const flames = new THREE.InstancedMesh(flameGeometry(), flameMat, MAX_FLAMES);
    flames.frustumCulled = false;
    flames.count = 0;
    flames.renderOrder = 6;
    const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    // Scorch: soft round blotches a bit wider than a cell (so neighbours merge
    // into one burn) and laid on the slope (playtest: flat 2 m squares at the
    // cell centre's height floated as black rectangles on hillsides).
    const scorchQuad = new THREE.PlaneGeometry(2.8, 2.8).rotateX(-Math.PI / 2);
    const scorch = new THREE.InstancedMesh(scorchQuad, new THREE.MeshStandardMaterial({ color: '#1c1610', roughness: 1, transparent: true, opacity: 0.8, alphaMap: scorchAlpha(), depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), MAX_SCORCH);
    scorch.frustumCulled = false;
    scorch.count = 0;
    const ice = new THREE.InstancedMesh(quad, new THREE.MeshStandardMaterial({ color: '#cfe8ff', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.88, emissive: '#26405a', emissiveIntensity: 0.3 }), MAX_ICE);
    ice.frustumCulled = false;
    ice.count = 0;
    ice.receiveShadow = true;
    const lights = [0, 1, 2, 3].map(() => {
      const l = new THREE.PointLight('#ff8a3a', 0, 28, 1.6);
      root.add(l);
      return l;
    });
    const pillarMat = new THREE.MeshStandardMaterial({ color: '#7a6a55', roughness: 0.95, flatShading: true });
    root.add(flames, scorch, ice);
    return { root, flames, scorch, ice, lights, pillarMat, pillars: new Map<number, THREE.Mesh>(), decor: new Map<number, DemonDecor>(), fx: [] as { obj: THREE.Mesh; at: number; dur: number; grow: number }[], version: -1 };
  }, []);

  useEffect(() => {
    scene.add(parts.root);
    return () => {
      scene.remove(parts.root);
    };
  }, [scene, parts]);

  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const v3 = useMemo(() => new THREE.Vector3(), []);
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), []);

  useFrame((_, delta) => {
    const now = performance.now();
    nightFrame(localPlayer.pos.x, localPlayer.pos.z);
    flameMat.uniforms.uTime.value += delta;
    flameMat.uniforms.uWind.value.set(windState.dirX, windState.dirZ);
    const view = nightRuntime.view;

    // Fire, scorch and ice: rebuilt when the chemistry changed.
    if (view && view.version !== parts.version) {
      parts.version = view.version;
      let nf = 0;
      let ni = 0;
      let ns = 0;
      const clusters: { x: number; y: number; z: number; n: number }[] = [];
      view.forEachActive((id, st, y) => {
        const x = cellCenter(cellX(id));
        const z = cellCenter(cellZ(id));
        if (st === 1 && nf < MAX_FLAMES) {
          const gy = y - FIRE_UPDRAFT_TOP_M;
          const s = 0.8 + ((id * 2654435761) >>> 0) / 4294967296 * 0.6;
          q.setFromAxisAngle(v3.set(0, 1, 0), (id % 7) * 0.45);
          m4.compose(v3.set(x + ((id % 5) - 2) * 0.15, gy - 0.05, z), q, one.clone().multiplyScalar(s));
          parts.flames.setMatrixAt(nf++, m4);
          // 16 m clusters for the light pool
          let c = clusters.find((k) => Math.abs(k.x / k.n - x) < 16 && Math.abs(k.z / k.n - z) < 16);
          if (!c) clusters.push((c = { x: 0, y: 0, z: 0, n: 0 }));
          c.x += x;
          c.y += gy;
          c.z += z;
          c.n++;
        } else if (st === 3 && ni < MAX_ICE) {
          m4.compose(v3.set(x, y + 0.03, z), q.identity(), one);
          parts.ice.setMatrixAt(ni++, m4);
        }
      });
      view.forEachBurnt((id) => {
        if (ns >= MAX_SCORCH || !nightRuntime.runtime) return;
        const x = cellCenter(cellX(id));
        const z = cellCenter(cellZ(id));
        const g = nightRuntime.runtime.terrainGround;
        const h = g.heightAt(x, z);
        // Tangent basis from the terrain's slope across the cell: the quad's
        // corners follow the ground instead of hanging off the downhill side.
        const sx = (g.heightAt(x + 1, z) - g.heightAt(x - 1, z)) / 2;
        const sz = (g.heightAt(x, z + 1) - g.heightAt(x, z - 1)) / 2;
        tx.set(1, sx, 0);
        tz.set(0, sz, 1);
        tn.crossVectors(tz, tx).normalize();
        m4.makeBasis(tx, tn, tz).setPosition(x, h + 0.05, z);
        parts.scorch.setMatrixAt(ns++, m4);
      });
      parts.flames.count = nf;
      parts.ice.count = ni;
      parts.scorch.count = ns;
      parts.flames.instanceMatrix.needsUpdate = parts.ice.instanceMatrix.needsUpdate = parts.scorch.instanceMatrix.needsUpdate = true;
      clusters.sort((a, b) => b.n - a.n || Math.hypot(a.x / a.n - camera.position.x, a.z / a.n - camera.position.z) - Math.hypot(b.x / b.n - camera.position.x, b.z / b.n - camera.position.z));
      parts.lights.forEach((l, i) => {
        const c = clusters[i];
        l.userData.on = !!c;
        if (c) l.position.set(c.x / c.n, c.y / c.n + 2.5, c.z / c.n);
      });
      // Pillars.
      const live = new Set<number>();
      for (const p of view.pillars()) {
        live.add(p.id);
        if (!parts.pillars.has(p.id)) {
          const mesh = new THREE.Mesh(pillarGeometry(p.half, p.run, p.height), parts.pillarMat);
          mesh.position.set(p.x, p.baseY - 0.02, p.z);
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.userData.at = now;
          parts.root.add(mesh);
          parts.pillars.set(p.id, mesh);
        }
      }
      for (const [id, mesh] of parts.pillars) {
        if (!live.has(id)) {
          parts.root.remove(mesh);
          mesh.geometry.dispose();
          parts.pillars.delete(id);
        }
      }
    }
    for (const l of parts.lights) l.intensity = l.userData.on ? (30 + 12 * Math.sin(now / 70 + l.id) + 8 * Math.sin(now / 23 + l.id * 3)) * liveStyle.torch : 0;
    // Pillars rise out of the ground over 0.4 s.
    for (const mesh of parts.pillars.values()) mesh.scale.y = Math.min(1, (now - (mesh.userData.at as number)) / 400);

    // Demons: horns and burning eyes on WP13's enemy bodies.
    const seen = new Set<number>();
    for (const v of drawnRemotes.views) {
      if (v.kind !== 2) continue;
      const info = enemyInfo(v);
      if (info.family !== 'demon') continue;
      seen.add(v.id);
      let d = parts.decor.get(v.id);
      if (!d) {
        d = makeDecor(info.size, info.key === 'starless_sovereign');
        parts.decor.set(v.id, d);
        parts.root.add(d.root);
      }
      d.root.position.set(v.x, v.y, v.z);
      d.root.rotation.y = v.yaw;
      d.root.visible = v.healthPct > 0;
      d.eyes.color.setRGB(1, 0.25 + 0.2 * Math.sin(now / 90 + v.id), 0.05);
    }
    for (const [id, d] of parts.decor) {
      if (!seen.has(id)) {
        parts.root.remove(d.root);
        parts.decor.delete(id);
      }
    }

    // Rise and burn flashes.
    while (nightFx.length) {
      const f = nightFx.shift()!;
      const color = f.t === 'rose' ? '#3a0a3a' : f.t === 'burned' ? '#ffb040' : '#4a2a5a';
      const obj = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, blending: f.t === 'burned' ? THREE.AdditiveBlending : THREE.NormalBlending }));
      obj.position.set(f.x, f.y + 1, f.z);
      parts.root.add(obj);
      parts.fx.push({ obj, at: now, dur: 1200, grow: f.t === 'rose' ? 3 : 2.2 });
    }
    for (let i = parts.fx.length - 1; i >= 0; i--) {
      const f = parts.fx[i];
      const k = (now - f.at) / f.dur;
      if (k >= 1) {
        parts.root.remove(f.obj);
        f.obj.geometry.dispose();
        (f.obj.material as THREE.Material).dispose();
        parts.fx.splice(i, 1);
        continue;
      }
      f.obj.scale.setScalar(0.4 + f.grow * k);
      (f.obj.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
    }
  });

  return null;
}
