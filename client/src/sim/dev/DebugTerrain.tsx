// Debug visual for `?ground=worldgen` (WP10): a 192 m heightfield patch
// around the camera sampled from the GroundQuery at 2 m, colored by slope
// (green walkable, tan between walkable and climbable, grey near-vertical),
// plus a translucent water surface from waterAt. Rebuilt when the camera
// moves 32 m. Crude on purpose: WP05 owns real terrain rendering; this only
// makes climb/glide/swim visible in dev and in headless captures.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { WALKABLE_TAN_SQ } from '@lodestone/contracts';
import type { GroundQuery } from '../ground';
import { slopeAt } from '../movement';

const SIZE = 192;
const STEP = 2;
const N = SIZE / STEP + 1;
const MOVE_REBUILD = 32;

export function DebugTerrain({ ground }: { ground: GroundQuery }) {
  const camera = useThree((s) => s.camera);
  const center = useRef({ x: Number.NaN, z: Number.NaN });
  const { land, water } = useMemo(() => {
    const mk = () => {
      const g = new THREE.PlaneGeometry(SIZE, SIZE, N - 1, N - 1);
      g.rotateX(-Math.PI / 2);
      return g;
    };
    const land = mk();
    land.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
    return { land, water: mk() };
  }, []);
  useEffect(
    () => () => {
      land.dispose();
      water.dispose();
    },
    [land, water],
  );
  const landRef = useRef<THREE.Mesh>(null);
  const waterRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const cx = Math.round(camera.position.x / STEP) * STEP;
    const cz = Math.round(camera.position.z / STEP) * STEP;
    if (Math.abs(cx - center.current.x) < MOVE_REBUILD && Math.abs(cz - center.current.z) < MOVE_REBUILD) return;
    center.current = { x: cx, z: cz };
    const lp = land.attributes.position as THREE.BufferAttribute;
    const wp = water.attributes.position as THREE.BufferAttribute;
    const col = land.attributes.color as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < lp.count; i++) {
      // Local vertex x/z are exact multiples of STEP; the mesh sits at (cx, 0, cz).
      const x = cx + lp.getX(i);
      const z = cz + lp.getZ(i);
      const h = ground.heightAt(x, z);
      lp.setY(i, h);
      const w = ground.waterAt ? ground.waterAt(x, z) : -1e9;
      wp.setY(i, w > h ? w : h - 0.5);
      const t2 = slopeAt(ground, x, z).t2;
      if (t2 <= WALKABLE_TAN_SQ) c.setRGB(0.32, 0.52, 0.25);
      else if (t2 < 30) c.setRGB(0.62, 0.55, 0.42);
      else c.setRGB(0.5, 0.5, 0.52);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    lp.needsUpdate = true;
    wp.needsUpdate = true;
    col.needsUpdate = true;
    land.computeVertexNormals();
    land.computeBoundingSphere();
    water.computeBoundingSphere();
    landRef.current?.position.set(cx, 0, cz);
    waterRef.current?.position.set(cx, 0, cz);
  });

  return (
    <>
      <mesh ref={landRef} geometry={land} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} flatShading />
      </mesh>
      <mesh ref={waterRef} geometry={water}>
        <meshStandardMaterial color="#2d6fa3" transparent opacity={0.6} roughness={0.2} />
      </mesh>
    </>
  );
}
