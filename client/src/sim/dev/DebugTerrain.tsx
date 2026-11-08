// Debug visual for `?ground=worldgen` (WP10): heightfield patches around the
// camera sampled from the GroundQuery (a 192 m patch at 2 m, plus a 1.5 km
// patch at 24 m pushed back with polygon offset so the fine one wins where
// they overlap), colored by slope (green walkable, tan between walkable and
// climbable, grey near-vertical), and a translucent water surface from
// waterAt. Rebuilt when the camera moves a quarter of a patch. Crude on
// purpose: WP05 owns real terrain rendering; this only makes climb, glide and
// swim visible in dev and in headless captures.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { WALKABLE_TAN_SQ } from '@lodestone/contracts';
import type { GroundQuery } from '../ground';
import { slopeAt } from '../movement';

function Patch({ ground, size, step, back }: { ground: GroundQuery; size: number; step: number; back: boolean }) {
  const camera = useThree((s) => s.camera);
  const n = size / step + 1;
  const center = useRef({ x: Number.NaN, z: Number.NaN });
  const { land, water } = useMemo(() => {
    const mk = () => {
      const g = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
      g.rotateX(-Math.PI / 2);
      return g;
    };
    const l = mk();
    l.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    return { land: l, water: mk() };
  }, [size, n]);
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
    const cx = Math.round(camera.position.x / step) * step;
    const cz = Math.round(camera.position.z / step) * step;
    if (Math.abs(cx - center.current.x) < size / 6 && Math.abs(cz - center.current.z) < size / 6) return;
    center.current = { x: cx, z: cz };
    const lp = land.attributes.position as THREE.BufferAttribute;
    const wp = water.attributes.position as THREE.BufferAttribute;
    const col = land.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      // Local vertex x/z are exact multiples of step; the mesh sits at (cx, 0, cz).
      const x = cx + lp.getX(i);
      const z = cz + lp.getZ(i);
      const h = ground.heightAt(x, z);
      lp.setY(i, h);
      const w = ground.waterAt ? ground.waterAt(x, z) : -1e9;
      // Dry: sink the water sheet well below the land (depth precision at distance).
      wp.setY(i, w > h ? w : h - (back ? 40 : 3));
      const t2 = slopeAt(ground, x, z).t2;
      if (t2 <= WALKABLE_TAN_SQ) col.setXYZ(i, 0.32, 0.52, 0.25);
      else if (t2 < 30) col.setXYZ(i, 0.62, 0.55, 0.42);
      else col.setXYZ(i, 0.5, 0.5, 0.52);
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
      <mesh ref={landRef} geometry={land} receiveShadow={!back}>
        <meshStandardMaterial vertexColors roughness={0.95} flatShading polygonOffset={back} polygonOffsetFactor={back ? 4 : 0} polygonOffsetUnits={back ? 4 : 0} />
      </mesh>
      <mesh ref={waterRef} geometry={water}>
        <meshStandardMaterial color="#2d6fa3" transparent opacity={0.6} roughness={0.2} polygonOffset={back} polygonOffsetFactor={back ? 4 : 0} polygonOffsetUnits={back ? 4 : 0} />
      </mesh>
    </>
  );
}

export function DebugTerrain({ ground }: { ground: GroundQuery }) {
  return (
    <>
      <Patch ground={ground} size={192} step={2} back={false} />
      <Patch ground={ground} size={1536} step={24} back />
    </>
  );
}
