// Cave dressing and dwarven architecture from the descriptor (CR 043,
// genVersion 4): supports, rails and carts, bones, glowworm ceilings,
// chests and lore tablets, and the dwarves' braziers, carved doors, pillars,
// statues, banners, rune circles, thrones and forge glow. Procedural
// low-poly geometry with vertex colours (values over 1 glow), one
// InstancedMesh per kind per layer. Chests are drawn closed and their lids
// swing open locally when the server says so (Event 1861).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Deco } from '@lodestone/worldgen';
import { DW, DECO_INTERACT } from './dwarfKinds';

type Col = [number, number, number];

export interface DwarfHelpers {
  glowMaterial(glow: number, opts?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial;
  instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: Deco[], place: (d: Deco, m: THREE.Matrix4) => void, color?: (d: Deco) => THREE.Color): THREE.InstancedMesh | null;
  compose(m: THREE.Matrix4, x: number, y: number, z: number, yaw: number, sx: number, sy?: number, sz?: number): THREE.Matrix4;
  add(layer: number, o: THREE.Object3D | null): void;
}

class Parts {
  list: THREE.BufferGeometry[] = [];
  /** Add a geometry (already positioned) with a flat colour. */
  put(g: THREE.BufferGeometry, c: Col): this {
    const n = g.index ? g.toNonIndexed() : g;
    const cnt = n.attributes.position.count;
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) col.set(c, i * 3);
    n.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (n.attributes.uv) n.deleteAttribute('uv');
    this.list.push(n);
    return this;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, c: Col, ry = 0, rz = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return this.put(g, c);
  }
  cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, c: Col, sides = 8): this {
    const g = new THREE.CylinderGeometry(r1, r0, h, sides);
    g.translate(x, y + h / 2, z);
    return this.put(g, c);
  }
  cone(r: number, h: number, x: number, y: number, z: number, c: Col, sides = 6): this {
    const g = new THREE.ConeGeometry(r, h, sides);
    g.translate(x, y + h / 2, z);
    return this.put(g, c);
  }
  rock(r: number, x: number, y: number, z: number, c: Col, sy = 0.7, seed = 0): this {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.rotateY(seed * 1.7);
    g.scale(1, sy, 1);
    g.translate(x, y + r * sy * 0.6, z);
    return this.put(g, c);
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list)!;
    g.computeVertexNormals();
    return g;
  }
}

const STONE: Col = [0.34, 0.31, 0.28];
const STONE_D: Col = [0.22, 0.2, 0.19];
const STONE_L: Col = [0.46, 0.42, 0.37];
const IRON: Col = [0.3, 0.3, 0.33];
const BRASS: Col = [0.7, 0.5, 0.2];
const WOOD: Col = [0.36, 0.25, 0.15];
const WOOD_D: Col = [0.24, 0.17, 0.11];
const BONE: Col = [0.82, 0.78, 0.66];
const RUNE: Col = [2.6, 1.3, 0.45];
const RUNE_C: Col = [0.6, 2.2, 2.2];
const EMBER: Col = [3.2, 1.3, 0.35];
const CLOTH: Col = [0.5, 0.09, 0.07];

function minecartGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.box(1.9, 0.12, 1.1, 0, 0.45, 0, IRON);
  p.box(1.9, 0.5, 0.1, 0, 0.75, -0.55, IRON).box(1.9, 0.5, 0.1, 0, 0.75, 0.55, IRON);
  p.box(0.1, 0.5, 1.1, -0.95, 0.75, 0, IRON).box(0.1, 0.5, 1.1, 0.95, 0.75, 0, IRON);
  for (const sx of [-0.6, 0.6]) for (const sz of [-0.5, 0.5]) p.cyl(0.2, 0.2, 0.1, sx, 0.2, sz, STONE_D, 8);
  for (let i = 0; i < 7; i++) p.rock(0.22 + (i % 3) * 0.05, ((i % 4) - 1.5) * 0.4, 0.95, ((i * 7) % 5) * 0.18 - 0.35, [0.5, 0.4, 0.34], 0.8, i);
  p.box(0.08, 0.08, 0.08, 0.2, 1.22, 0.1, [3, 2.2, 0.8]);
  return p.build();
}

/** 14 m of track along +x: two rails on sleepers. */
function railsGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const L = 14;
  for (const z of [-0.45, 0.45]) p.box(L, 0.1, 0.08, 0, 0.17, z, IRON);
  for (let x = -L / 2 + 0.35; x < L / 2; x += 0.7) p.box(0.18, 0.12, 1.3, x, 0.07, 0, WOOD_D);
  return p.build();
}

/** A timber frame across the way: two posts, a cap beam and braces. Unit: span 1 along z, along +x thickness. */
function supportGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const h = 0.62;
  for (const z of [-0.46, 0.46]) p.box(0.07, h, 0.07, 0, h / 2, z, WOOD);
  p.box(0.09, 0.07, 1.08, 0, h + 0.02, 0, WOOD);
  for (const s of [-1, 1]) p.box(0.05, 0.05, 0.22, 0, h - 0.08, s * 0.36, WOOD_D, 0, s * 0.8);
  return p.build();
}

function bonesGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.rock(0.2, 0, 0, 0, BONE, 0.9, 1); // skull
  p.box(0.12, 0.08, 0.14, 0.18, 0.05, 0, BONE);
  for (let i = 0; i < 6; i++) p.box(0.7, 0.05, 0.05, 0.5 + (i % 3) * 0.1, 0.03, -0.35 + i * 0.14, BONE, i * 0.2);
  p.box(0.9, 0.06, 0.06, -0.5, 0.03, 0.4, BONE, 0.5);
  p.box(0.8, 0.06, 0.06, -0.3, 0.03, -0.5, BONE, -0.4);
  return p.build();
}

/** Hanging strands tipped with glowing beads (unit: strands up to 1.6 long, origin at the ceiling). */
function glowwormGeo(): THREE.BufferGeometry {
  const p = new Parts();
  for (let i = 0; i < 11; i++) {
    const a = i * 2.4;
    const r = 0.05 + (i % 4) * 0.12;
    const len = 0.35 + ((i * 37) % 10) * 0.13;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    p.cyl(0.006, 0.006, len, x, -len, z, [0.25, 0.4, 0.4], 3);
    const g = new THREE.IcosahedronGeometry(0.035 + (i % 3) * 0.012, 0);
    g.translate(x, -len, z);
    p.put(g, [0.5 + (i % 3) * 0.4, 3.0, 2.8]);
  }
  return p.build();
}

function chestBaseGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.box(1.0, 0.5, 0.6, 0, 0.25, 0, WOOD);
  for (const x of [-0.38, 0.38]) p.box(0.08, 0.52, 0.64, x, 0.26, 0, IRON);
  p.box(1.04, 0.05, 0.64, 0, 0.02, 0, IRON);
  return p.build();
}
/** The lid hinged at its back edge (origin on the hinge). */
function chestLidGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const g = new THREE.CylinderGeometry(0.3, 0.3, 1.0, 8, 1, false, 0, Math.PI);
  g.rotateZ(Math.PI / 2);
  g.translate(0, 0.0, 0.3);
  p.put(g, WOOD);
  for (const x of [-0.38, 0.38]) {
    const b = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 8, 1, false, 0, Math.PI);
    b.rotateZ(Math.PI / 2);
    b.translate(x, 0, 0.3);
    p.put(b, IRON);
  }
  p.box(0.12, 0.14, 0.05, 0, -0.02, 0.62, BRASS);
  return p.build();
}

function tabletGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.box(0.9, 0.12, 0.5, 0, 0.06, 0, STONE_D);
  p.box(0.75, 1.3, 0.16, 0, 0.75, 0, STONE, 0, 0);
  for (let k = 0; k < 5; k++) p.box(0.5 - (k % 2) * 0.12, 0.05, 0.02, 0, 0.35 + k * 0.2, 0.09, RUNE_C);
  p.box(0.05, 0.3, 0.02, -0.25, 1.1, 0.09, RUNE_C);
  return p.build();
}

function brazierGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.cyl(0.38, 0.38, 0.14, 0, 0, 0, STONE_D, 6);
  p.cyl(0.12, 0.16, 0.85, 0, 0.14, 0, STONE, 6);
  p.cyl(0.28, 0.5, 0.35, 0, 0.95, 0, IRON, 8);
  p.cyl(0.0, 0.42, 0.04, 0, 1.27, 0, EMBER, 8);
  p.cone(0.26, 0.7, 0, 1.28, 0, [3.0, 1.5, 0.4], 6);
  p.cone(0.14, 0.5, 0.05, 1.3, 0.02, [3.4, 2.4, 0.9], 5);
  for (let i = 0; i < 3; i++) p.box(0.04, 0.2, 0.04, Math.cos(i * 2.1) * 0.15, 0.4, Math.sin(i * 2.1) * 0.15, BRASS);
  return p.build();
}

/** The great door: jambs with carved bands, a rune lintel, two leaves swung open. Opening along z, passage along x; unit height 1 (width scaled by caller via sz). */
function doorGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const W = 0.55; // opening half width at unit height
  const jw = 0.1;
  for (const s of [-1, 1]) {
    p.box(0.2, 1.0, jw, 0, 0.5, s * (W + jw / 2), STONE);
    for (let k = 0; k < 5; k++) p.box(0.215, 0.025, jw * 0.8, 0, 0.12 + k * 0.17, s * (W + jw / 2), RUNE);
    p.box(0.26, 0.04, jw + 0.03, 0, 0.02, s * (W + jw / 2), STONE_D);
    // The leaf, swung back against the wall.
    p.box(0.34, 0.9, 0.035, 0.0, 0.46, s * (W + jw + 0.01), IRON);
    p.box(0.36, 0.05, 0.04, 0, 0.88, s * (W + jw + 0.01), BRASS);
    p.box(0.36, 0.05, 0.04, 0, 0.1, s * (W + jw + 0.01), BRASS);
  }
  p.box(0.26, 0.12, 2 * (W + jw) + 0.06, 0, 0.94, 0, STONE_L);
  p.box(0.275, 0.04, 2 * W - 0.06, 0, 0.94, 0, RUNE);
  p.box(0.3, 0.05, 2 * (W + jw) + 0.12, 0, 1.01, 0, STONE_D);
  return p.build();
}

function pillarGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.box(1, 0.04, 1, 0, 0.02, 0, STONE_D);
  p.box(0.82, 0.9, 0.82, 0, 0.49, 0, STONE);
  for (let k = 0; k < 6; k++) p.box(0.86, 0.012, 0.86, 0, 0.1 + k * 0.14, 0, [0.28, 0.26, 0.24]);
  for (const z of [-1, 1]) p.box(0.5, 0.45, 0.01, 0, 0.5, z * 0.42, RUNE);
  for (const x of [-1, 1]) p.box(0.01, 0.45, 0.5, x * 0.42, 0.5, 0, RUNE);
  p.box(1, 0.06, 1, 0, 0.96, 0, STONE_L);
  return p.build();
}

function orePileGeo(): THREE.BufferGeometry {
  const p = new Parts();
  for (let i = 0; i < 9; i++) {
    const a = i * 2.2;
    const r = i < 4 ? 0.12 : 0.42;
    p.rock(0.3 - (i < 4 ? 0 : 0.08), Math.cos(a) * r, i < 4 ? 0.25 : 0, Math.sin(a) * r, [0.45 + (i % 3) * 0.05, 0.38, 0.34], 0.8, i);
  }
  for (let i = 0; i < 4; i++) p.box(0.07, 0.07, 0.07, Math.cos(i * 1.7) * 0.3, 0.55 - (i % 2) * 0.2, Math.sin(i * 1.7) * 0.3, [2.4, 1.8, 0.8]);
  return p.build();
}

/** A flat rune circle of unit radius. */
function runesGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const ring = (r0: number, r1: number, c: Col) => {
    const g = new THREE.RingGeometry(r0, r1, 40);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.07, 0);
    p.put(g, c);
  };
  ring(0.94, 1.0, RUNE);
  ring(0.62, 0.65, RUNE);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    p.box(0.07, 0.01, 0.18, Math.cos(a) * 0.8, 0.075, Math.sin(a) * 0.8, RUNE, -a + Math.PI / 2);
  }
  for (let k = 0; k < 4; k++) p.box(0.9, 0.01, 0.025, 0, 0.075, 0, RUNE, (k * Math.PI) / 4);
  return p.build();
}

/** A carved dwarf king, unit height 1 (in the real model 11 m). */
function statueGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.box(0.34, 0.07, 0.3, 0, 0.035, 0, STONE_D);
  p.box(0.26, 0.2, 0.2, 0, 0.17, 0, STONE); // legs
  p.box(0.34, 0.34, 0.24, 0, 0.44, 0, STONE); // torso
  p.box(0.4, 0.09, 0.26, 0, 0.62, 0, STONE_L); // shoulders
  p.cyl(0.07, 0.07, 0.12, 0, 0.66, 0, STONE, 6); // head
  p.cone(0.09, 0.1, 0, 0.77, 0, STONE_L, 6); // helm
  p.box(0.12, 0.2, 0.06, 0, 0.58, 0.07, STONE_L, 0, 0); // beard
  p.box(0.06, 0.4, 0.06, 0.22, 0.45, 0.1, STONE, 0, 0); // arm
  p.box(0.05, 0.7, 0.05, 0.24, 0.5, 0.18, STONE_D); // hammer haft
  p.box(0.16, 0.1, 0.1, 0.24, 0.86, 0.18, STONE_L); // hammer head
  p.box(0.12, 0.012, 0.012, 0, 0.5, 0.125, RUNE);
  return p.build();
}

function bannerGeo(): THREE.BufferGeometry {
  const p = new Parts();
  p.cyl(0.03, 0.03, 1.0, 0, 0, 0, IRON, 5);
  p.box(0.5, 0.04, 0.05, 0.25, 0.97, 0, IRON);
  p.box(0.42, 0.66, 0.02, 0.25, 0.62, 0, CLOTH);
  p.cone(0.21, 0.14, 0.25, 0.22, 0, CLOTH, 3);
  p.box(0.16, 0.16, 0.025, 0.25, 0.66, 0, [2.6, 1.8, 0.5]);
  return p.build();
}

/** A rune-carved doorway frame (the secret door): jambs and an arched lintel, runes faint. Opening along z. */
function secretDoorGeo(): THREE.BufferGeometry {
  const p = new Parts();
  for (const s of [-1, 1]) {
    p.box(0.09, 0.85, 0.07, 0, 0.42, s * 0.5, STONE);
    for (let k = 0; k < 4; k++) p.box(0.095, 0.02, 0.05, 0, 0.2 + k * 0.17, s * 0.5, [1.2, 0.7, 0.3]);
  }
  p.box(0.13, 0.1, 1.1, 0, 0.88, 0, STONE_L);
  p.box(0.14, 0.03, 0.8, 0, 0.88, 0, [1.4, 0.8, 0.3]);
  for (let k = 0; k < 6; k++) p.rock(0.06, 0, 0.0, -0.5 + k * 0.2, STONE_D, 0.7, k);
  return p.build();
}

function throneGeo(): THREE.BufferGeometry {
  const p = new Parts();
  for (let s = 0; s < 3; s++) p.box(1 - s * 0.14, 0.06, 1.2 - s * 0.16, 0, 0.03 + s * 0.06, 0, s % 2 ? STONE_L : STONE);
  p.box(0.34, 0.2, 0.34, 0, 0.28, 0, STONE); // seat
  p.box(0.08, 0.55, 0.36, -0.14, 0.55, 0, STONE); // back
  p.box(0.1, 0.1, 0.46, -0.14, 0.86, 0, STONE_L);
  for (const z of [-1, 1]) {
    p.box(0.28, 0.1, 0.06, 0, 0.4, z * 0.19, STONE_L);
    p.cone(0.04, 0.3, -0.14, 0.9, z * 0.2, STONE_L, 4);
  }
  p.box(0.012, 0.3, 0.2, -0.095, 0.6, 0, RUNE);
  p.box(0.35, 0.02, 0.012, 0.18, 0.2, 0, RUNE);
  return p.build();
}

/** A molten pool of unit radius with a dark crust rim. */
function forgeGlowGeo(): THREE.BufferGeometry {
  const p = new Parts();
  const d = new THREE.CircleGeometry(0.85, 14);
  d.rotateX(-Math.PI / 2);
  d.translate(0, 0.1, 0);
  p.put(d, EMBER);
  const r = new THREE.RingGeometry(0.85, 1.05, 14);
  r.rotateX(-Math.PI / 2);
  r.translate(0, 0.11, 0);
  p.put(r, [0.25, 0.1, 0.06]);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    p.rock(0.2, Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0, [0.12, 0.09, 0.08], 0.9, i);
  }
  p.box(0.4, 0.04, 0.12, 0.1, 0.12, 0.2, [4, 2.6, 0.9]);
  return p.build();
}

function collapseGeo(): THREE.BufferGeometry {
  const p = new Parts();
  for (let i = 0; i < 12; i++) {
    const a = i * 2.3;
    const r = 0.1 + ((i * 29) % 10) * 0.045;
    p.rock(0.14 + (i % 4) * 0.05, Math.cos(a) * r * 1.4, 0, Math.sin(a) * r, STONE_D, 0.8, i);
  }
  for (let i = 0; i < 3; i++) p.box(0.8, 0.07, 0.07, -0.1 + i * 0.1, 0.22 + i * 0.07, -0.2 + i * 0.2, WOOD_D, i * 0.7, 0.35);
  p.box(0.07, 0.5, 0.07, 0.35, 0.25, 0.1, WOOD, 0, 0.3);
  return p.build();
}

const bendY = (d: Deco) => (d.yaw / 65536) * Math.PI * 2;

/** What the dwarven set needs from outside: opened chests by descriptor index. */
export interface DwarfSet {
  openChest(decoIndex: number): void;
  closeChest(decoIndex: number): void;
}

export interface DwarfColumn { x: number; z: number; r: number; y0: number; y1: number; layer: number }

export function buildDwarfDecos(decos: Deco[], layerOf: (d: Deco) => number, h: DwarfHelpers, columns: DwarfColumn[] = []): DwarfSet {
  const at = (kind: number) => {
    const out: { d: Deco; i: number }[] = [];
    decos.forEach((d, i) => {
      if (d.kind === kind) out.push({ d, i });
    });
    return out;
  };
  const stoneMat = h.glowMaterial(0.5, { vertexColors: true, roughness: 0.85 });
  const woodMat = h.glowMaterial(0.2, { vertexColors: true, roughness: 0.9 });
  const white = () => new THREE.Color(1, 1, 1);
  const place = (kind: number, geo: THREE.BufferGeometry, mat: THREE.Material, fn: (d: Deco, m: THREE.Matrix4) => void) => {
    const list = at(kind).map((e) => e.d);
    if (!list.length) return;
    const byLayer = new Map<number, Deco[]>();
    for (const d of list) byLayer.set(layerOf(d), [...(byLayer.get(layerOf(d)) ?? []), d]);
    for (const [layer, l] of byLayer) h.add(layer, h.instanced(geo, mat, l, fn, white));
  };
  const c = h.compose;
  const along = (d: Deco) => -bendY(d);
  place(DW.minecart, minecartGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), d.size / 1.6));
  place(DW.rails, railsGeo(), woodMat, (d, m) => c(m, d.x, d.y, d.z, along(d), Math.max(0.2, d.size / 14), 1, 1));
  place(DW.support, supportGeo(), woodMat, (d, m) => c(m, d.x, d.y, d.z, along(d), Math.max(1, d.size * 0.7), Math.max(1, d.size * 0.7), d.size));
  place(DW.bones, bonesGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size));
  place(DW.glowworms, glowwormGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size * 0.45, d.size * 0.5, d.size * 0.45));
  place(DW.tablet, tabletGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size));
  place(DW.brazier, brazierGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, 0, d.size / 1.4));
  place(DW.dwarfDoor, doorGeo(), stoneMat, (d, m) => {
    // Height d.size; the opening is 0.9 of it up to 11 m wide.
    const w = Math.min(d.size * 0.9, 11) / 1.1;
    return c(m, d.x, d.y, d.z, along(d), d.size, d.size, w);
  });
  place(DW.dwarfPillar, pillarGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), 3, d.size, 3));
  place(DW.orePile, orePileGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size));
  place(DW.runes, runesGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size * 0.5, 1, d.size * 0.5));
  place(DW.statue, statueGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), d.size, d.size, d.size));
  place(DW.banner, bannerGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), d.size, d.size, d.size));
  place(DW.secretDoor, secretDoorGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), d.size * 1.15, d.size * 0.85, d.size * 1.1));
  place(DW.throne, throneGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, along(d), d.size, d.size, d.size));
  place(DW.forgeglow, forgeGlowGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), d.size * 0.5, 1, d.size * 0.5));
  place(DW.collapse, collapseGeo(), stoneMat, (d, m) => c(m, d.x, d.y, d.z, bendY(d), Math.max(2, d.size * 0.9)));

  // The great colonnades: carved pillars floor to roof (hosts collide with the same cylinders).
  if (columns.length) {
    const im = new THREE.InstancedMesh(pillarGeo(), stoneMat, columns.length);
    const mm = new THREE.Matrix4();
    columns.forEach((k, i) => im.setMatrixAt(i, c(mm, k.x, k.y0 - 0.5, k.z, (i * 0.9) % 6.28, k.r * 1.6, k.y1 - k.y0 + 1, k.r * 1.6)));
    im.setColorAt(0, white());
    for (let i = 1; i < columns.length; i++) im.setColorAt(i, white());
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    h.add(columns[0].layer, im);
  }

  // Chests: a base and a hinged lid per chest (tiers 1-3: wood, brass-bound, dwarven gold).
  const chests = at(DW.chest);
  const lids = new Map<number, { im: THREE.InstancedMesh; k: number; d: Deco }>();
  const tierColor = (d: Deco) => (d.tint >= 3 ? new THREE.Color(1.25, 1.1, 0.7) : d.tint === 2 ? new THREE.Color(0.95, 0.85, 0.75) : new THREE.Color(1, 1, 1));
  const baseG = chestBaseGeo();
  const lidG = chestLidGeo();
  const byLayer = new Map<number, { d: Deco; i: number }[]>();
  for (const e of chests) byLayer.set(layerOf(e.d), [...(byLayer.get(layerOf(e.d)) ?? []), e]);
  const tmp = new THREE.Matrix4();
  const lidMatrix = (m: THREE.Matrix4, d: Deco, open: boolean) => {
    const base = new THREE.Matrix4();
    c(base, d.x, d.y + 0.5, d.z, bendY(d), 1.15);
    const rot = new THREE.Matrix4().makeRotationX(open ? -1.9 : 0);
    // The hinge sits on the back (-z local) edge of the box.
    const hinge = new THREE.Matrix4().makeTranslation(0, 0, -0.3);
    return m.copy(base).multiply(hinge).multiply(rot);
  };
  for (const [layer, list] of byLayer) {
    h.add(layer, h.instanced(baseG, woodMat, list.map((e) => e.d), (d, m) => c(m, d.x, d.y, d.z, bendY(d), 1.15), tierColor));
    const lid = h.instanced(lidG, woodMat, list.map((e) => e.d), (d, m) => lidMatrix(m, d, false), tierColor);
    if (lid) {
      list.forEach((e, k) => lids.set(e.i, { im: lid, k, d: e.d }));
      h.add(layer, lid);
    }
  }
  void DECO_INTERACT;
  const setLid = (i: number, open: boolean) => {
    const e = lids.get(i);
    if (!e) return;
    e.im.setMatrixAt(e.k, lidMatrix(tmp, e.d, open));
    e.im.instanceMatrix.needsUpdate = true;
  };
  return { openChest: (i) => setLid(i, true), closeChest: (i) => setLid(i, false) };
}
