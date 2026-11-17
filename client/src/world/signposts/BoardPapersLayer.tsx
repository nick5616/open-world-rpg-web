// Papers pinned on the bounty boards (CR 052): the nearest few boards within
// PAPER_RANGE_M of the camera each carry one paper per available bounty (both
// faces), one small dynamic mesh for all of them (one draw call). The count
// is boardPapers.ts' (what the zone last said, else the default).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldRuntime } from '../core/runtime';
import { PK } from '../buildings/props';
import { paperLayout, papersFor, useBoardPapers, MAX_PAPERS } from './boardPapers';

export const PAPER_RANGE_M = 55;
const MAX_BOARDS_NEAR = 3;
const QUADS = MAX_BOARDS_NEAR * MAX_PAPERS * 2 * 2; // papers + pins, two faces
/** The towns buffer's board panel: faces at v = +-0.05, from 0.9 to 2.0 above the base. */
const FACE_V = 0.062;

interface BoardRef {
  index: number;
  settlement: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export function BoardPapersLayer({ runtime }: { runtime: WorldRuntime }) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const boards = useMemo<BoardRef[]>(() => (runtime.towns ? runtime.towns.props.filter((p) => p.kind === PK.board).map((p) => ({ index: p.index, settlement: p.settlement, x: p.x, y: p.y, z: p.z, yaw: p.yaw })) : []), [runtime]);
  const mesh = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(QUADS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(QUADS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(QUADS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let q = 0; q < QUADS; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    m.name = 'board-papers';
    return { m, key: '', acc: 9 };
  }, []);

  useEffect(() => {
    scene.add(mesh.m);
    return () => {
      scene.remove(mesh.m);
      mesh.m.geometry.dispose();
      (mesh.m.material as THREE.Material).dispose();
    };
  }, [scene, mesh]);

  useFrame((_, dt) => {
    if (!boards.length) return;
    mesh.acc += dt;
    if (mesh.acc < 0.5) return;
    mesh.acc = 0;
    const near = boards
      .map((b) => ({ b, d: Math.hypot(b.x - camera.position.x, b.z - camera.position.z) }))
      .filter((n) => n.d <= PAPER_RANGE_M)
      .sort((a, b) => a.d - b.d || a.b.index - b.b.index)
      .slice(0, MAX_BOARDS_NEAR);
    const counts = useBoardPapers.getState().counts;
    const key = near.map((n) => `${n.b.index}:${papersFor(n.b.settlement, counts)}`).join('|');
    if (key === mesh.key) return;
    mesh.key = key;
    const geo = mesh.m.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    let q = 0;
    const quad = (cx: number, cy: number, cz: number, nx: number, nz: number, hw: number, hh: number, rot: number, r: number, g: number, b: number) => {
      // The viewer's right on this face is (nz, -nx); rotate the quad in its own plane.
      const rx = nz;
      const rz = -nx;
      const cs = Math.cos(rot);
      const sn = Math.sin(rot);
      const corner = (sx: number, sy: number): [number, number, number] => {
        const a = sx * hw * cs - sy * hh * sn;
        const up = sx * hw * sn + sy * hh * cs;
        return [cx + rx * a, cy + up, cz + rz * a];
      };
      const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      for (let k = 0; k < 4; k++) {
        const i = q * 4 + k;
        pos.setXYZ(i, pts[k][0], pts[k][1], pts[k][2]);
        nor.setXYZ(i, nx, 0, nz);
        col.setXYZ(i, r, g, b);
      }
      q++;
    };
    for (const { b } of near) {
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      const papers = paperLayout(b.index, papersFor(b.settlement, counts));
      for (const sv of [-1, 1]) {
        const nx = -s * sv;
        const nz = c * sv;
        for (const p of papers) {
          // at(f, u, y, v): x = cx + u c - v s, z = cz + u s + v c
          const px = b.x + p.u * c - sv * FACE_V * s;
          const pz = b.z + p.u * s + sv * FACE_V * c;
          if (q + 2 > QUADS) break;
          const t = 0.88 + 0.1 * p.tint;
          quad(px, b.y + p.y, pz, nx, nz, p.w / 2, p.h / 2, p.rot, t, t * 0.96, t * 0.84);
          // a red pin near the top
          quad(px + nx * 0.006, b.y + p.y + p.h * 0.36, pz + nz * 0.006, nx, nz, 0.022, 0.022, 0, 0.75, 0.18, 0.14);
        }
      }
    }
    geo.setDrawRange(0, q * 6);
    pos.needsUpdate = nor.needsUpdate = col.needsUpdate = true;
    mesh.m.visible = q > 0;
  });

  return null;
}
