// Enemy-model objects for the WP19b shader warm-up (world/warmExtras.ts):
// one tiny instanced object per program the enemy renderer uses (the
// opaque / jelly / spectral part materials, their instance-colour variants
// for debris and the far LOD, the instanced bars and aura rings, the damage
// number glyphs), so the first camp in view never links a program mid-fight.

import * as THREE from 'three';
import { auraMaterials, barMaterials, enemyMat, type EnemyMatKind } from './material';
import { numberMaterial } from '../numbers/layer';

let kept: THREE.Object3D[] | null = null;

function partGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
  g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(3), 1));
  g.setAttribute('iFx', new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
  return g;
}

export function enemyWarmObjects(): THREE.Object3D[] {
  if (kept) return kept;
  const out: THREE.Object3D[] = [];
  const g = partGeometry();
  const kinds: EnemyMatKind[] = ['opaque', 'jelly', 'spectral'];
  for (const k of kinds) {
    const plain = new THREE.InstancedMesh(g, enemyMat(k), 1);
    plain.castShadow = k !== 'spectral';
    out.push(plain);
  }
  for (const k of ['opaque', 'jelly'] as const) {
    const tinted = new THREE.InstancedMesh(g, enemyMat(k), 1);
    tinted.setColorAt(0, new THREE.Color('#ffffff'));
    out.push(tinted);
  }
  const plane = new THREE.PlaneGeometry(1, 0.1);
  const bm = barMaterials();
  const am = auraMaterials();
  out.push(new THREE.InstancedMesh(plane, bm.back, 1));
  for (const m of [bm.fill, am.strong, am.soft]) {
    const im = new THREE.InstancedMesh(plane, m, 1);
    im.setColorAt(0, new THREE.Color('#ffffff'));
    out.push(im);
  }
  const ng = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  ng.index = quad.index;
  ng.setAttribute('position', quad.getAttribute('position'));
  for (const [name, size] of [
    ['iAnchor', 3],
    ['iRect', 4],
    ['iUv', 4],
    ['iColor', 4],
  ] as const)
    ng.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(size), size));
  ng.instanceCount = 1;
  out.push(new THREE.Mesh(ng, numberMaterial()));
  for (const o of out) {
    o.frustumCulled = false;
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).count = 1;
  }
  kept = out;
  return out;
}
