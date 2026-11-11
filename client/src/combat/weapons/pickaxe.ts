// The pickaxe in the hand while mining (Nicole: "mining ore should have a
// server side pickaxe animation"): the same prop for your first-person view
// and every avatar, shown only while a mine swing plays. Convention as the
// weapons: +Y from the grip to the head, the hand at y = 0.
import * as THREE from 'three';

let shared: { geo: THREE.BufferGeometry; mat: THREE.Material } | null = null;

const WOOD = new THREE.Color(0x7a5534);
const IRON = new THREE.Color(0xa4abb4);
const LEATHER = new THREE.Color(0x4a2f1f);

function res() {
  if (shared) return shared;
  const handle = new THREE.CylinderGeometry(0.019, 0.024, 0.78, 7).translate(0, 0.3, 0);
  // the head: a curved pick, point on one side, a flat blade on the other
  const arc = new THREE.TorusGeometry(0.3, 0.026, 5, 12, Math.PI * 0.62);
  arc.rotateZ(Math.PI * 0.19);
  arc.translate(0, 0.38, 0);
  const tipA = new THREE.ConeGeometry(0.026, 0.09, 5).rotateZ(Math.PI / 2 + 0.35).translate(-0.27, 0.6, 0);
  const tipB = new THREE.BoxGeometry(0.06, 0.05, 0.05).translate(0.27, 0.6, 0);
  const collar = new THREE.CylinderGeometry(0.034, 0.034, 0.09, 7).translate(0, 0.66, 0);
  const wrap = new THREE.CylinderGeometry(0.027, 0.027, 0.16, 7).translate(0, 0.02, 0);
  // one mesh, coloured per vertex: the prop costs one draw call (it replaces the hidden weapon's)
  const geo = mergeAll([
    [handle, WOOD],
    [arc, IRON],
    [tipA, IRON],
    [tipB, IRON],
    [collar, IRON],
    [wrap, LEATHER],
  ]);
  shared = { geo, mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 }) };
  return shared;
}

function mergeAll(parts: [THREE.BufferGeometry, THREE.Color][]): THREE.BufferGeometry {
  // non-indexed position/normal/color merge (no addons import needed)
  const geos = parts.map(([g, c]) => [g.index ? g.toNonIndexed() : g, c] as const);
  let n = 0;
  for (const [g] of geos) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const [g, c] of geos) {
    const p = g.getAttribute('position');
    pos.set(p.array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    for (let i = 0; i < p.count; i++) col.set([c.r, c.g, c.b], (o + i) * 3);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** A new pickaxe prop (shared geometry/material, one draw call); hidden until a mine swing shows it. */
export function makePickaxe(): THREE.Mesh {
  const r = res();
  const m = new THREE.Mesh(r.geo, r.mat);
  m.name = 'pickaxe';
  m.castShadow = true;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}
