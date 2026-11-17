// The gem cavern as an R3F scene (title backdrop and character stage). Every
// light is fixed for the scene's life (never added/removed at runtime), glow is
// emissive or additive, and nothing strobes: shimmer is a slow sine of a few
// percent, off under Reduce flashing; the camera drift stops under
// prefers-reduced-motion.

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GEMS, floorY, layoutClusters, layoutStalactites, rng, type StageVariant } from './caveGen';
import { caveGeometry, caveRockMaterial, caveUniforms, crystalGeometry, flameMaterial, gemMaterial, glowPointsMaterial, poolMaterial, shaftMaterial } from './caveMaterials';

export interface WorldQuality {
  /** 'full' desktop, 'lite' weak GPU / phone. */
  tier: 'full' | 'lite';
  /** prefers-reduced-motion: camera and motes hold still. */
  reducedMotion: boolean;
  /** Reduce flashing: shimmer off. */
  calm: boolean;
}

const FIRE_POS: [number, number] = [-1.45, 0.75];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function Rock({ q }: { q: WorldQuality }) {
  const geo = useMemo(() => (q.tier === 'full' ? caveGeometry(176, 100) : caveGeometry(96, 56)), [q.tier]);
  const mat = useMemo(() => caveRockMaterial(), []);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  return <mesh geometry={geo} material={mat} />;
}

function Stalactites({ seed }: { seed: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const data = useMemo(() => layoutStalactites(seed), [seed]);
  const geo = useMemo(() => {
    const g = new THREE.ConeGeometry(1, 1, 7, 1, true);
    g.rotateX(Math.PI);
    g.translate(0, -0.5, 0);
    return g;
  }, []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x1b1c2b, roughness: 0.85, flatShading: true }), []);
  useEffect(() => {
    const im = ref.current!;
    data.forEach(([x, y, z, h, r], i) => {
      _m.compose(_p.set(x, y, z), _q.identity(), _s.set(r, h, r));
      im.setMatrixAt(i, _m);
    });
    im.instanceMatrix.needsUpdate = true;
  }, [data]);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  return <instancedMesh ref={ref} args={[geo, mat, data.length]} frustumCulled={false} />;
}

/** Crystal clusters (one InstancedMesh per gem), halos, floor light pools; returns the brightest sites for the lights. */
function Crystals({ variant, q, seed }: { variant: StageVariant; q: WorldQuality; seed: number }) {
  const clusters = useMemo(() => layoutClusters(variant, seed, q.tier === 'full' ? 1 : 0.55), [variant, seed, q.tier]);
  const geo = useMemo(() => crystalGeometry(), []);
  const mats = useMemo(() => GEMS.map((_, i) => gemMaterial(i)), []);
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const poolRef = useRef<THREE.InstancedMesh>(null);
  const halo = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    const phase: number[] = [];
    const rand = rng(seed + 3);
    for (const c of clusters) {
      const g = new THREE.Color(GEMS[c.gem].glow);
      pos.push(c.x + c.nx * c.size * 0.5, c.y + c.ny * c.size * 0.5, c.z + c.nz * c.size * 0.5);
      col.push(g.r * 0.5, g.g * 0.5, g.b * 0.5);
      size.push(c.size * 2.4);
      phase.push(rand());
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gg.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    gg.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    gg.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
    return gg;
  }, [clusters, seed]);
  const haloMat = useMemo(() => glowPointsMaterial(), []);
  const poolMat = useMemo(() => poolMaterial(), []);
  const poolGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  const floorClusters = useMemo(() => clusters.filter((c) => c.floor), [clusters]);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => {
    haloMat.uniforms.uScale.value = (size.height * dpr) / 2.2;
    haloMat.uniforms.uTwinkle.value = q.calm ? 0 : 0.18;
  }, [haloMat, size.height, dpr, q.calm]);

  useEffect(() => {
    const per: number[] = GEMS.map(() => 0);
    const counts = GEMS.map((_, g) => clusters.reduce((n, c) => n + c.crystals.filter((k) => k.gem === g).length, 0));
    const idx: number[] = GEMS.map(() => 0);
    for (const c of clusters) {
      _n.set(c.nx, c.ny, c.nz).normalize();
      const qn = _q.setFromUnitVectors(UP, _n).clone();
      for (const k of c.crystals) {
        const im = refs.current[k.gem];
        if (!im) continue;
        _q2.setFromEuler(_e.set(k.tilt, k.heading, 0, 'YXZ'));
        const qq = qn.clone().multiply(_q2);
        // tangent offset
        const tx = new THREE.Vector3(1, 0, 0).applyQuaternion(qn);
        const tz = new THREE.Vector3(0, 0, 1).applyQuaternion(qn);
        _p.set(c.x, c.y, c.z).addScaledVector(tx, k.ox).addScaledVector(tz, k.oz).addScaledVector(_n, -0.12);
        if (c.floor) _p.y = Math.max(_p.y, floorY(_p.x, _p.z) - 0.1);
        _m.compose(_p, qq, _s.set(k.width * 2, k.height, k.width * 2));
        im.setMatrixAt(idx[k.gem]++, _m);
        per[k.gem]++;
      }
    }
    for (let g = 0; g < GEMS.length; g++) {
      const im = refs.current[g];
      if (!im) continue;
      im.count = counts[g];
      im.instanceMatrix.needsUpdate = true;
    }
    const pm = poolRef.current;
    if (pm) {
      const col = new THREE.Color();
      floorClusters.forEach((c, i) => {
        const r = 1.5 + c.size * 1.15;
        _m.compose(_p.set(c.x, floorY(c.x, c.z) + 0.04, c.z), _q.identity(), _s.set(r * 2, 1, r * 2));
        pm.setMatrixAt(i, _m);
        col.set(GEMS[c.gem].glow).multiplyScalar(0.12 + c.size * 0.03);
        pm.setColorAt(i, col);
      });
      pm.count = floorClusters.length;
      pm.instanceMatrix.needsUpdate = true;
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    }
  }, [clusters, floorClusters]);

  useEffect(() => () => { geo.dispose(); mats.forEach((m) => m.dispose()); halo.dispose(); haloMat.dispose(); poolMat.dispose(); poolGeo.dispose(); }, [geo, mats, halo, haloMat, poolMat, poolGeo]);

  const perGem = GEMS.map((_, g) => clusters.reduce((n, c) => n + c.crystals.filter((k) => k.gem === g).length, 0));
  return (
    <>
      {GEMS.map((_, g) => (
        <instancedMesh key={g} ref={(r) => { refs.current[g] = r; }} args={[geo, mats[g], Math.max(1, perGem[g])]} frustumCulled={false} />
      ))}
      <instancedMesh ref={poolRef} args={[poolGeo, poolMat, Math.max(1, floorClusters.length)]} frustumCulled={false} renderOrder={2} />
      <points geometry={halo} material={haloMat} frustumCulled={false} renderOrder={3} />
    </>
  );
}

/** Drifting dust and spores in gem tints, rising slowly. */
function Motes({ q, variant }: { q: WorldQuality; variant: StageVariant }) {
  const count = q.tier === 'full' ? 220 : 90;
  const { geo, home } = useMemo(() => {
    const rand = rng(77);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rand() - 0.5) * 30;
      pos[i * 3 + 1] = -5 + rand() * 14;
      pos[i * 3 + 2] = -22 + rand() * 28;
      c.set(GEMS[Math.floor(rand() * GEMS.length)].glow).lerp(new THREE.Color(0xdde6ff), 0.35);
      col.set([c.r * 0.7, c.g * 0.7, c.b * 0.7], i * 3);
      size[i] = 0.05 + rand() * 0.09;
      phase[i] = rand();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    return { geo: g, home: pos.slice() };
  }, [count]);
  const mat = useMemo(() => glowPointsMaterial(), []);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => {
    mat.uniforms.uScale.value = (size.height * dpr) / 2.2;
    mat.uniforms.uTwinkle.value = q.calm ? 0 : 0.35;
  }, [mat, size.height, dpr, q.calm]);
  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  useFrame((_, dtRaw) => {
    if (q.reducedMotion) return;
    const dt = Math.min(dtRaw, 0.1);
    const t = caveUniforms.uTime.value;
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      let y = p.getY(i) + dt * (0.08 + (i % 7) * 0.012);
      if (y > 9) y = -5;
      p.setXYZ(i, home[i * 3] + Math.sin(t * 0.13 + i) * 0.7, y, home[i * 3 + 2] + Math.cos(t * 0.11 + i * 1.7) * 0.6);
    }
    p.needsUpdate = true;
  });
  void variant;
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={4} />;
}

function Shafts({ variant }: { variant: StageVariant }) {
  const defs = useMemo(
    () => (variant === 'title'
      ? [[-4, -14, 0.5, 0x8fb6ff, 0.075], [7, -20, -0.35, 0xb9a4ff, 0.06], [-13, -8, 0.22, 0x8fb6ff, 0.05]]
      : [[-2.5, -10, 0.4, 0x8fb6ff, 0.07], [5, -13, -0.3, 0xb9a4ff, 0.055]]) as [number, number, number, number, number][],
    [variant],
  );
  const mats = useMemo(() => defs.map((d) => { const m = shaftMaterial(d[3]); m.uniforms.uAmp.value = d[4]; return m; }), [defs]);
  const geo = useMemo(() => new THREE.CylinderGeometry(0.5, 3.4, 20, 18, 1, true), []);
  useEffect(() => () => { geo.dispose(); mats.forEach((m) => m.dispose()); }, [geo, mats]);
  return (
    <>
      {defs.map((d, i) => (
        <mesh key={i} geometry={geo} material={mats[i]} position={[d[0], 4.5, d[1]]} rotation={[0, 0, d[2] * 0.25]} renderOrder={1} />
      ))}
    </>
  );
}

/** Four fixed gem lights (and a fire light on the stage), all breathing a few percent. */
function Lights({ variant, q }: { variant: StageVariant; q: WorldQuality }) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const fire = useRef<THREE.PointLight>(null);
  const spots = useMemo(() => {
    const c = layoutClusters(variant, 1337).slice(0, 4);
    return c.map((k) => ({ pos: [k.x + k.nx * k.size * 0.9, k.y + k.ny * k.size * 0.9 + 0.8, k.z + k.nz * k.size * 0.9] as [number, number, number], color: GEMS[k.gem].glow, base: 26 + k.size * 11 }));
  }, [variant]);
  useFrame(() => {
    const t = caveUniforms.uTime.value;
    const amp = q.calm ? 0 : 0.07;
    spots.forEach((s, i) => {
      const l = lights.current[i];
      if (l) l.intensity = s.base * (1 + amp * Math.sin(t * 0.4 + i * 1.9));
    });
    if (fire.current) fire.current.intensity = 10 * (1 + (q.calm ? 0.03 : 0.1) * Math.sin(t * 2.1) * Math.sin(t * 0.7 + 1));
  });
  return (
    <>
      <ambientLight color={0x232b55} intensity={0.7} />
      {variant === 'stage' && <directionalLight color={0xaebcff} intensity={1.5} position={[2.5, 4, 8]} />}
      <hemisphereLight args={[0x2a3a78, 0x0b0713, 0.55]} />
      {spots.map((s, i) => (
        <pointLight key={i} ref={(r) => { lights.current[i] = r; }} position={s.pos} color={s.color} intensity={s.base} distance={42} decay={1.7} />
      ))}
      {variant === 'stage' ? (
        <pointLight ref={fire} position={[FIRE_POS[0], floorY(FIRE_POS[0], FIRE_POS[1]) + 0.9, FIRE_POS[1]]} color={0xff9a45} intensity={10} distance={10} decay={1.6} />
      ) : (
        // keeps the light count equal between variants is not needed (separate scenes); the title adds a cool fill from above
        <pointLight position={[0, 6, -4]} color={0x6a7fe0} intensity={30} distance={40} decay={1.7} />
      )}
    </>
  );
}

/** Campfire for the stage: logs, layered flames, rising embers. */
function Campfire({ q }: { q: WorldQuality }) {
  const y = floorY(FIRE_POS[0], FIRE_POS[1]);
  const flames = useRef<THREE.Group>(null);
  const mats = useMemo(() => [flameMaterial(0xff6a1f), flameMaterial(0xffb347), flameMaterial(0xfff0b0)], []);
  const logMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.9 }), []);
  const emberGeo = useMemo(() => {
    const n = 36;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col.set([1, 0.55, 0.2], i * 3);
      size[i] = 0.05 + (i % 5) * 0.012;
      ph[i] = (i * 0.37) % 1;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    return g;
  }, []);
  const emberMat = useMemo(() => glowPointsMaterial(), []);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  useEffect(() => {
    emberMat.uniforms.uScale.value = (size.height * dpr) / 2.2;
    emberMat.uniforms.uTwinkle.value = 0;
  }, [emberMat, size.height, dpr]);
  useEffect(() => () => { mats.forEach((m) => m.dispose()); logMat.dispose(); emberGeo.dispose(); emberMat.dispose(); }, [mats, logMat, emberGeo, emberMat]);
  useFrame(() => {
    const t = caveUniforms.uTime.value;
    const amp = q.calm || q.reducedMotion ? 0.03 : 0.1;
    flames.current?.children.forEach((c, i) => {
      const s = 1 + amp * Math.sin(t * (2.2 + i * 0.7) + i * 2) * Math.sin(t * 0.9 + i);
      c.scale.set(1 + (s - 1) * 0.5, s, 1 + (s - 1) * 0.5);
    });
    if (!q.reducedMotion) {
      const p = emberGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const k = ((t * (0.12 + (i % 4) * 0.03) + i * 0.173) % 1);
        p.setXYZ(i, Math.sin(i * 12.9 + t * 0.4) * 0.35 * k, 0.4 + k * 2.4, Math.cos(i * 7.3 + t * 0.3) * 0.35 * k);
      }
      p.needsUpdate = true;
    }
  });
  return (
    <group position={[FIRE_POS[0], y, FIRE_POS[1]]}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} material={logMat} position={[0, 0.1, 0]} rotation={[Math.PI / 2 - 0.35, (i * Math.PI * 2) / 3, 0]}>
          <cylinderGeometry args={[0.07, 0.085, 0.95, 7]} />
        </mesh>
      ))}
      <group ref={flames} position={[0, 0.12, 0]}>
        <mesh material={mats[0]}><coneGeometry args={[0.34, 1.05, 10, 1, true]} /></mesh>
        <mesh material={mats[1]} position={[0, -0.02, 0]}><coneGeometry args={[0.24, 0.8, 10, 1, true]} /></mesh>
        <mesh material={mats[2]} position={[0, -0.05, 0]}><coneGeometry args={[0.13, 0.5, 8, 1, true]} /></mesh>
      </group>
      <points geometry={emberGeo} material={emberMat} frustumCulled={false} renderOrder={5} />
      {/* ring of stones */}
      {Array.from({ length: 9 }, (_, i) => (
        <mesh key={i} position={[Math.cos((i / 9) * Math.PI * 2) * 0.62, 0.07, Math.sin((i / 9) * Math.PI * 2) * 0.62]} scale={[1, 0.7, 1]}>
          <icosahedronGeometry args={[0.13 + (i % 3) * 0.02, 0]} />
          <meshStandardMaterial color={0x2a2a36} roughness={0.9} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/** Camera: title drifts slowly through the cavern; the stage frames the figure. */
function CameraRig({ variant, q, yawRef, offsetY }: { variant: StageVariant; q: WorldQuality; yawRef?: MutableRefObject<number>; offsetY: number }) {
  const { camera, size, pointer } = useThree();
  const look = useRef(new THREE.Vector3());
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    if (!q.reducedMotion) caveUniforms.uTime.value += dt;
    const t = caveUniforms.uTime.value;
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    const mv = q.reducedMotion ? 0 : 1;
    if (variant === 'title') {
      const fy = floorY(0, 0);
      cam.position.set(Math.sin(t * 0.045) * 2.6 + pointer.x * 0.5 * mv, fy + 2.4 + Math.sin(t * 0.06) * 0.45 + pointer.y * 0.25 * mv, 5 + Math.sin(t * 0.031) * 1.8);
      look.current.set(Math.sin(t * 0.03) * 2 - 1, fy + 3.6 + Math.sin(t * 0.05) * 0.5, -14);
      cam.fov = aspect < 0.8 ? 62 : 50;
    } else {
      const fy = floorY(0, 0);
      const dist = Math.min(11, 6.2 / Math.min(1, aspect * 1.05));
      cam.position.set(Math.sin(t * 0.08) * 0.25 * mv + pointer.x * 0.25 * mv, fy + 1.5 + pointer.y * 0.1 * mv, dist);
      look.current.set(0, fy + 1.0, 0);
      cam.fov = 32;
      void yawRef;
    }
    cam.lookAt(look.current);
    // phones: the figure/title sits in the top part of the screen above the bottom sheet
    if (offsetY !== 0) cam.setViewOffset(size.width, size.height, 0, size.height * offsetY, size.width, size.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  });
  return null;
}

export interface CaveWorldProps {
  variant: StageVariant;
  quality: WorldQuality;
  yawRef?: MutableRefObject<number>;
  /** Fraction of the screen height to shift the picture up by (phones: bottom sheet). */
  offsetY?: number;
  children?: React.ReactNode;
}

export function CaveWorld({ variant, quality: q, yawRef, offsetY = 0, children }: CaveWorldProps) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new THREE.Color(0x05060f);
    scene.fog = new THREE.FogExp2(0x070a1c, variant === 'title' ? 0.022 : 0.03);
    caveUniforms.uShim.value = q.calm || q.reducedMotion ? 0 : 1;
  }, [scene, variant, q.calm, q.reducedMotion]);
  const seed = 4242;
  return (
    <>
      <Lights variant={variant} q={q} />
      <Rock q={q} />
      <Stalactites seed={seed} />
      <Crystals variant={variant} q={q} seed={seed} />
      {q.tier === 'full' && <Shafts variant={variant} />}
      <Motes q={q} variant={variant} />
      {variant === 'stage' && <Campfire q={q} />}
      <CameraRig variant={variant} q={q} yawRef={yawRef} offsetY={offsetY} />
      {children}
    </>
  );
}
