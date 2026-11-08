// Procedural scatter meshes: trees (broadleaf, conifer, dead; two mesh LODs
// each), rocks, bushes and grass clumps, built once at load from three.js
// primitives with vertex colours. No model files: nothing to download, and
// the low-poly, painterly silhouettes suit the art direction (spec 16: PBR
// ground, stylised grade). Real tree and rock models can replace these later
// without touching the scatter manager (same attributes).
//
// Every geometry has: position, normal, color (vertex colour), aFoliage
// (1 where the per-instance tint and leaf flutter apply, 0 on trunks).
// Units: meters, origin at the base, height ~1 unit for trees (instance
// scale sets the real size) so wind sway can use position.y directly.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Deterministic pseudo-random for shape noise (archetypes are identical on every load). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

function paint(g: THREE.BufferGeometry, color: THREE.Color, foliage: number, shade?: (y: number) => number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const pos = ng.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const fol = new Float32Array(pos.count).fill(foliage);
  for (let i = 0; i < pos.count; i++) {
    const k = shade ? shade(pos.getY(i)) : 1;
    col[i * 3] = color.r * k;
    col[i * 3 + 1] = color.g * k;
    col[i * 3 + 2] = color.b * k;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aFoliage', new THREE.BufferAttribute(fol, 1));
  return ng;
}

/** Push vertices along their direction from `c` by smooth noise, for lumpy blobs. */
function lumpy(g: THREE.BufferGeometry, amount: number, seed: number, c = new THREE.Vector3()): THREE.BufferGeometry {
  const r = rng(seed);
  const ph = [r() * 10, r() * 10, r() * 10];
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(c);
    const n = Math.sin(v.x * 3.1 + ph[0]) * Math.sin(v.y * 2.7 + ph[1]) * Math.sin(v.z * 3.3 + ph[2]);
    v.multiplyScalar(1 + n * amount).add(c);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const BARK = new THREE.Color(0.14, 0.095, 0.06);
const LEAF = new THREE.Color(0.16, 0.3, 0.09);
const NEEDLE = new THREE.Color(0.09, 0.2, 0.1);

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

/** Leaves darker underneath and inside: cheap stand-in for canopy self-occlusion. */
const canopyShade = (y0: number, y1: number) => (y: number) => 0.55 + 0.45 * THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1);

export function broadleafTree(lod: 0 | 1): THREE.BufferGeometry {
  if (lod === 1) {
    const trunk = paint(new THREE.CylinderGeometry(0.025, 0.04, 0.6, 4, 1, true).translate(0, 0.3, 0), BARK, 0);
    const crown = paint(lumpy(new THREE.IcosahedronGeometry(0.34, 0).scale(1, 0.85, 1).translate(0, 0.68, 0), 0.08, 7, new THREE.Vector3(0, 0.68, 0)), LEAF, 1, canopyShade(0.45, 0.95));
    return merged([trunk, crown]);
  }
  const trunk = paint(new THREE.CylinderGeometry(0.022, 0.045, 0.62, 7, 2, true).translate(0, 0.31, 0), BARK, 0);
  const r = rng(11);
  const blobs: THREE.BufferGeometry[] = [];
  const centers: [number, number, number, number][] = [
    [0, 0.72, 0, 0.27],
    [0.17, 0.62, 0.06, 0.2],
    [-0.15, 0.64, -0.08, 0.21],
    [0.04, 0.6, -0.18, 0.19],
    [-0.06, 0.86, 0.1, 0.18],
  ];
  for (const [x, y, z, s] of centers) {
    const c = new THREE.Vector3(x, y, z);
    blobs.push(paint(lumpy(new THREE.IcosahedronGeometry(s, 1).translate(x, y, z), 0.12, Math.floor(r() * 1e6), c), LEAF, 1, canopyShade(0.42, 1.0)));
  }
  // A couple of limbs reaching into the crown.
  const limb = (ax: number, az: number) => paint(new THREE.CylinderGeometry(0.008, 0.016, 0.3, 4, 1, true).rotateZ(ax).rotateX(az).translate(0, 0.52, 0), BARK, 0);
  return merged([trunk, limb(0.7, 0.2), limb(-0.6, -0.3), ...blobs]);
}

export function coniferTree(lod: 0 | 1): THREE.BufferGeometry {
  if (lod === 1) {
    const trunk = paint(new THREE.CylinderGeometry(0.02, 0.035, 0.3, 3, 1, true).translate(0, 0.15, 0), BARK, 0);
    const cone = paint(new THREE.ConeGeometry(0.26, 0.85, 6, 1, true).translate(0, 0.58, 0), NEEDLE, 1, canopyShade(0.15, 1.0));
    return merged([trunk, cone]);
  }
  const trunk = paint(new THREE.CylinderGeometry(0.018, 0.04, 0.5, 6, 1, true).translate(0, 0.25, 0), BARK, 0);
  const tiers: THREE.BufferGeometry[] = [];
  const levels = [
    [0.3, 0.3, 0.32],
    [0.47, 0.25, 0.27],
    [0.63, 0.2, 0.22],
    [0.78, 0.14, 0.17],
    [0.9, 0.08, 0.12],
  ];
  levels.forEach(([y, rad, h], i) => {
    const cone = new THREE.ConeGeometry(rad, h, 9, 1, true).rotateY(i * 0.7).translate(0, y + h / 2 - 0.03, 0);
    lumpy(cone, 0.06, 100 + i, new THREE.Vector3(0, y, 0));
    tiers.push(paint(cone, NEEDLE, 1, canopyShade(0.2, 1.0)));
  });
  return merged([trunk, ...tiers]);
}

export function deadTree(lod: 0 | 1): THREE.BufferGeometry {
  const grey = new THREE.Color(0.3, 0.27, 0.24);
  const trunk = paint(new THREE.CylinderGeometry(0.018, 0.045, 0.8, lod ? 4 : 6, 1, true).translate(0, 0.4, 0), grey, 0);
  if (lod === 1) return merged([trunk, paint(new THREE.CylinderGeometry(0.006, 0.014, 0.35, 3, 1, true).rotateZ(0.8).translate(0.1, 0.6, 0), grey, 0)]);
  const branches = [
    [0.8, 0.0, 0.55, 0.32],
    [-0.9, 0.5, 0.62, 0.28],
    [0.6, -1.2, 0.7, 0.22],
    [-0.5, 2.0, 0.45, 0.25],
  ].map(([rz, ry, y, len]) => paint(new THREE.CylinderGeometry(0.005, 0.014, len, 4, 1, true).translate(0, len / 2, 0).rotateZ(rz).rotateY(ry).translate(0, y, 0), grey, 0));
  return merged([trunk, ...branches]);
}

export function rock(): THREE.BufferGeometry {
  const g = lumpy(new THREE.IcosahedronGeometry(0.5, 1).scale(1, 0.7, 1).translate(0, 0.22, 0), 0.22, 77, new THREE.Vector3(0, 0.22, 0));
  // Faceted: per-face normals read as chiselled stone at a distance.
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return merged([paint(ng, new THREE.Color(0.42, 0.4, 0.37), 1, (y) => 0.75 + 0.35 * THREE.MathUtils.clamp(y / 0.6, 0, 1))]);
}

export function bush(): THREE.BufferGeometry {
  const parts = [
    [0, 0.3, 0, 0.36],
    [0.25, 0.22, 0.1, 0.26],
    [-0.22, 0.24, -0.12, 0.28],
    [0.05, 0.2, -0.27, 0.24],
  ].map(([x, y, z, s], i) => paint(lumpy(new THREE.IcosahedronGeometry(s, 0).translate(x, y, z), 0.15, 300 + i, new THREE.Vector3(x, y, z)), LEAF, 1, (yy) => 0.5 + 0.5 * THREE.MathUtils.clamp(yy / 0.6, 0, 1)));
  return merged(parts);
}

/**
 * A clump of `blades` bent blades, ~1 m tall before instance scale. Each
 * blade is two triangles (base quad tapering to a tip) so it can bend in the
 * vertex shader by height. Normals point mostly up: grass lit like the
 * ground it grows from blends into it instead of flickering.
 */
export function grassClump(blades = 6, seed = 5): THREE.BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  // Root close to the ground texture so clumps grow out of it rather than sit on it.
  const root = new THREE.Color(0.12, 0.15, 0.05);
  const tip = new THREE.Color(0.4, 0.52, 0.17);
  for (let b = 0; b < blades; b++) {
    const a = r() * Math.PI * 2;
    const d = r() * 0.13;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = 0.55 + r() * 0.45;
    const w = 0.018 + r() * 0.012;
    const yaw = r() * Math.PI;
    const lean = (r() - 0.5) * 0.35;
    const cx = Math.cos(yaw) * w;
    const cz = Math.sin(yaw) * w;
    const lx = Math.cos(a) * lean;
    const lz = Math.sin(a) * lean;
    const p0 = [x - cx, 0, z - cz];
    const p1 = [x + cx, 0, z + cz];
    const p2 = [x + cx * 0.6 + lx * 0.5, h * 0.55, z + cz * 0.6 + lz * 0.5];
    const p3 = [x - cx * 0.6 + lx * 0.5, h * 0.55, z - cz * 0.6 + lz * 0.5];
    const p4 = [x + lx, h, z + lz];
    const tri = (a1: number[], a2: number[], a3: number[]) => {
      for (const p of [a1, a2, a3]) {
        pos.push(p[0], p[1], p[2]);
        nor.push(lx * 0.4, 1, lz * 0.4);
        const c = root.clone().lerp(tip, p[1] / h);
        col.push(c.r, c.g, c.b);
      }
    };
    tri(p0, p1, p2);
    tri(p0, p2, p3);
    tri(p3, p2, p4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(1), 1));
  g.computeBoundingSphere();
  return g;
}

export type TreeArchetype = 'broadleaf' | 'conifer' | 'dead';
export const TREE_ARCHETYPES: TreeArchetype[] = ['broadleaf', 'conifer', 'dead'];

export function treeGeometry(a: TreeArchetype, lod: 0 | 1): THREE.BufferGeometry {
  return a === 'broadleaf' ? broadleafTree(lod) : a === 'conifer' ? coniferTree(lod) : deadTree(lod);
}

const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
export { triCount };
