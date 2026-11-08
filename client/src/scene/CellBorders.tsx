// Debug overlay (spec 14 "show chunk and cell borders"): AOI cells (32 m,
// cyan), chunks (64 m, orange) and regions (1024 m, red) drawn on the ground
// around the player, with corner posts so borders read at a distance. The
// line geometry is rebuilt only when the player crosses into another AOI
// cell, not per frame.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AOI_CELL_M, CHUNK_SIZE_M, REGION_CHUNKS } from '@lodestone/contracts';
import { localPlayer } from '../state/live';
import { useGround } from './groundContext';

const RADIUS_CELLS = 4;
const POST_H = 6;
const REGION_M = CHUNK_SIZE_M * REGION_CHUNKS;

/** Classify a grid line coordinate: region > chunk > cell. */
export function lineKind(coord: number): 'region' | 'chunk' | 'cell' {
  const m = (v: number) => ((v % REGION_M) + REGION_M) % REGION_M;
  if (m(coord) === 0) return 'region';
  if (((coord % CHUNK_SIZE_M) + CHUNK_SIZE_M) % CHUNK_SIZE_M === 0) return 'chunk';
  return 'cell';
}

const COLORS = { cell: new THREE.Color('#38d9f5'), chunk: new THREE.Color('#ff922b'), region: new THREE.Color('#ff3b3b') };

export function CellBorders() {
  const ground = useGround();
  const lines = useRef<THREE.LineSegments>(null);
  const lastCell = useRef('');
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => () => geom.dispose(), [geom]);

  useFrame(() => {
    const p = localPlayer.pos;
    const cx = Math.floor(p.x / AOI_CELL_M);
    const cz = Math.floor(p.z / AOI_CELL_M);
    const key = `${cx},${cz}`;
    if (key === lastCell.current) return;
    lastCell.current = key;

    const pos: number[] = [];
    const col: number[] = [];
    const push = (x: number, z: number, x2: number, z2: number, y1: number, y2: number, c: THREE.Color) => {
      pos.push(x, y1, z, x2, y2, z2);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const x0 = (cx - RADIUS_CELLS) * AOI_CELL_M;
    const x1 = (cx + RADIUS_CELLS + 1) * AOI_CELL_M;
    const z0 = (cz - RADIUS_CELLS) * AOI_CELL_M;
    const z1 = (cz + RADIUS_CELLS + 1) * AOI_CELL_M;
    // Ground lines in 4 m segments so they follow non-flat ground (WP05) too.
    const SEG = 4;
    for (let gx = x0; gx <= x1; gx += AOI_CELL_M) {
      const c = COLORS[lineKind(gx)];
      for (let z = z0; z < z1; z += SEG) push(gx, z, gx, z + SEG, ground.heightAt(gx, z) + 0.05, ground.heightAt(gx, z + SEG) + 0.05, c);
    }
    for (let gz = z0; gz <= z1; gz += AOI_CELL_M) {
      const c = COLORS[lineKind(gz)];
      for (let x = x0; x < x1; x += SEG) push(x, gz, x + SEG, gz, ground.heightAt(x, gz) + 0.05, ground.heightAt(x + SEG, gz) + 0.05, c);
    }
    // Posts at chunk corners (taller at region corners).
    for (let gx = Math.ceil(x0 / CHUNK_SIZE_M) * CHUNK_SIZE_M; gx <= x1; gx += CHUNK_SIZE_M) {
      for (let gz = Math.ceil(z0 / CHUNK_SIZE_M) * CHUNK_SIZE_M; gz <= z1; gz += CHUNK_SIZE_M) {
        const region = lineKind(gx) === 'region' || lineKind(gz) === 'region';
        const h = ground.heightAt(gx, gz);
        push(gx, gz, gx, gz, h, h + (region ? POST_H * 3 : POST_H), region ? COLORS.region : COLORS.chunk);
      }
    }
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geom.computeBoundingSphere();
  });

  return (
    // renderOrder 2: after the (transparent) ground grid, whose 64 m section
    // lines sit exactly under the chunk borders and would otherwise cover them.
    <lineSegments ref={lines} geometry={geom} frustumCulled={false} renderOrder={2}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} />
    </lineSegments>
  );
}
