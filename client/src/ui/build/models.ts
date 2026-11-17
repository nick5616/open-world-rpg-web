// Procedural building pieces (CR 041), in the art direction of docs/decisions/0023:
// chunky, warm, hand-made shapes with readable material (no textures). One
// merged, vertex-coloured geometry per (piece base, material, door state), local
// frame like contracts/build.yaml (x along the length, z across, y up from the
// base; turned about y by -rot * 45 degrees). Wood is beveled planks with gaps
// and a grain tint, stone is blocks in running bond with mortar, sunsteel is
// stone with gold strapping and rivets, roofs are rows of shingles (slate for
// stone). Glowing parts (coals, lantern glass, torch heads) are a second
// geometry drawn unlit with HDR colours.

import * as THREE from 'three';
import { CAMPS } from '@lodestone/contracts';
import { pieceDef } from './geometry';

export interface PieceGeo {
  solid: THREE.BufferGeometry;
  glow: THREE.BufferGeometry | null;
  /** Flame spots [x, y, z, scale] in the local frame (the night layer's flame cards). */
  flames: number[][];
  /** Pooled-light spot [x, y, z] (local) or null. */
  light: number[] | null;
}

// ---- a tiny geometry builder ----

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly nm = new THREE.Matrix3();
  private readonly v = new THREE.Vector3();
  private readonly c = new THREE.Color();

  quad(p: THREE.Vector3[], n: THREE.Vector3, color: THREE.Color, shade: number): void {
    const base = this.pos.length / 3;
    for (const q of p) {
      this.pos.push(q.x, q.y, q.z);
      this.nor.push(n.x, n.y, n.z);
      this.col.push(color.r * shade, color.g * shade, color.b * shade);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A box (centre, size) through an optional matrix; top faces light, bottoms dark. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.ColorRepresentation, mat?: THREE.Matrix4, k = 1): this {
    this.c.set(color);
    const col = this.c.clone();
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const M = mat ?? this.m.identity();
    this.nm.getNormalMatrix(M);
    const faces: [number[], number[], number][] = [
      [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], 0.88],
      [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], 0.8],
      [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], 1.12],
      [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]], 0.6],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], 0.94],
      [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], 0.84],
    ] as never;
    for (const [n, corners, shade] of faces) {
      const pts = (corners as unknown as number[][]).map((q) => new THREE.Vector3(cx + q[0] * hx, cy + q[1] * hy, cz + q[2] * hz).applyMatrix4(M));
      const nn = new THREE.Vector3(n[0], n[1], n[2]).applyMatrix3(this.nm).normalize();
      this.quad(pts, nn, col, shade * k);
    }
    return this;
  }

  /** A box turned about its own centre (z for slopes, y for turns). */
  boxR(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.ColorRepresentation, rz: number, ry = 0, k = 1): this {
    const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, ry, rz, 'YXZ'));
    const T = new THREE.Matrix4().makeTranslation(cx, cy, cz);
    const Tn = new THREE.Matrix4().makeTranslation(-cx, -cy, -cz);
    return this.box(cx, cy, cz, sx, sy, sz, color, T.multiply(R).multiply(Tn), k);
  }

  /** A right-angle-free triangle prism: points in the x-y plane, thickness along z. */
  tri(p: [number, number][], z0: number, z1: number, color: THREE.ColorRepresentation, k = 1): this {
    this.c.set(color);
    const col = this.c.clone();
    const A = p.map(([x, y]) => [new THREE.Vector3(x, y, z1), new THREE.Vector3(x, y, z0)]);
    const front = new THREE.Vector3(0, 0, 1);
    const back = new THREE.Vector3(0, 0, -1);
    const b = this.pos.length / 3;
    for (const [f] of A) {
      this.pos.push(f.x, f.y, f.z);
      this.nor.push(0, 0, 1);
      this.col.push(col.r * 0.94 * k, col.g * 0.94 * k, col.b * 0.94 * k);
    }
    this.idx.push(b, b + 1, b + 2);
    const b2 = this.pos.length / 3;
    for (const [, r] of A) {
      this.pos.push(r.x, r.y, r.z);
      this.nor.push(0, 0, -1);
      this.col.push(col.r * 0.8 * k, col.g * 0.8 * k, col.b * 0.8 * k);
    }
    this.idx.push(b2, b2 + 2, b2 + 1);
    void front;
    void back;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      const e = new THREE.Vector3(p[j][0] - p[i][0], p[j][1] - p[i][1], 0);
      const n = new THREE.Vector3(e.y, -e.x, 0).normalize();
      const sh = n.y > 0.5 ? 1.1 : n.y < -0.5 ? 0.6 : 0.88;
      this.quad([new THREE.Vector3(p[i][0], p[i][1], z1), new THREE.Vector3(p[i][0], p[i][1], z0), new THREE.Vector3(p[j][0], p[j][1], z0), new THREE.Vector3(p[j][0], p[j][1], z1)], n, col, sh * k);
    }
    return this;
  }

  cyl(cx: number, cy: number, cz: number, r: number, h: number, color: THREE.ColorRepresentation, seg = 8, rTop = r): this {
    this.c.set(color);
    const col = this.c.clone();
    const b = this.pos.length / 3;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const n = new THREE.Vector3(Math.cos(am), 0, Math.sin(am));
      const p = [
        new THREE.Vector3(cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r),
        new THREE.Vector3(cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r),
        new THREE.Vector3(cx + Math.cos(a1) * rTop, cy + h, cz + Math.sin(a1) * rTop),
        new THREE.Vector3(cx + Math.cos(a0) * rTop, cy + h, cz + Math.sin(a0) * rTop),
      ];
      this.quad([p[1], p[0], p[3], p[2]], n, col, 0.9 + 0.1 * Math.cos(am));
    }
    const top = this.pos.length / 3;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      this.pos.push(cx + Math.cos(a) * rTop, cy + h, cz + Math.sin(a) * rTop);
      this.nor.push(0, 1, 0);
      this.col.push(col.r * 1.1, col.g * 1.1, col.b * 1.1);
    }
    for (let i = 1; i < seg - 1; i++) this.idx.push(top, top + i + 1, top + i);
    void b;
    return this;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }
}

/** Deterministic jitter in [0, 1). */
const hash = (a: number, b = 0, c = 0): number => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

const tint = (hex: string, k: number): THREE.Color => new THREE.Color(hex).multiplyScalar(k);

interface Pal {
  main: string;
  alt: string;
  dark: string;
  trim: string;
  roof: string;
  roofAlt: string;
}

const PAL: Pal[] = [
  { main: '#a07548', alt: '#86613b', dark: '#3d2a19', trim: '#6a4a2c', roof: '#7a4f30', roofAlt: '#8b5d38' },
  { main: '#9a978e', alt: '#85827a', dark: '#44413c', trim: '#716e67', roof: '#505763', roofAlt: '#5d6572' },
  { main: '#a09a8c', alt: '#8a8478', dark: '#44413c', trim: '#d9a93a', roof: '#4d5460', roofAlt: '#6b5f3b' },
];
const GOLD = '#e0b040';
const IRON = '#4a4c52';
const WOOD = PAL[0];

// ---- surfaces ----

/** A wall-like slab x0..x1 by y0..y1 and thickness t (centred on z = 0), planks or stone blocks. */
function slab(b: Builder, m: number, x0: number, x1: number, y0: number, y1: number, t: number, seed: number): void {
  const P = PAL[m];
  b.box((x0 + x1) / 2, (y0 + y1) / 2, 0, x1 - x0, y1 - y0, t * 0.8, P.dark);
  if (m === 0) {
    const n = Math.max(1, Math.round((x1 - x0) / 0.2));
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const j = hash(seed, i);
      const yy0 = y0 + (j < 0.15 ? 0.04 : 0);
      b.box(x0 + w * (i + 0.5), (yy0 + y1) / 2, 0, w - 0.018, y1 - yy0, t, tint(i % 2 ? P.main : P.alt, 0.9 + j * 0.2));
    }
    return;
  }
  const rows = Math.max(1, Math.round((y1 - y0) / 0.3125));
  const rh = (y1 - y0) / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * 0.28;
    let x = x0 - off;
    let i = 0;
    while (x < x1 - 0.01) {
      const w = 0.45 + hash(seed, r, i) * 0.3;
      const a = Math.max(x0, x);
      const e = Math.min(x1, x + w);
      if (e - a > 0.04) b.box((a + e) / 2, y0 + rh * (r + 0.5), 0, e - a - 0.016, rh - 0.016, t, tint(hash(seed, r, i + 9) > 0.5 ? P.main : P.alt, 0.88 + hash(seed, i, r) * 0.24));
      x += w;
      i++;
    }
  }
  if (m === 2) {
    // gold strapping and rivets
    for (const bx of [x0 + 0.05, x1 - 0.05, (x0 + x1) / 2]) {
      b.box(bx, (y0 + y1) / 2, 0, 0.09, y1 - y0, t + 0.03, GOLD);
      for (let ry = y0 + 0.25; ry < y1 - 0.1; ry += 0.6) b.box(bx, ry, t / 2 + 0.02, 0.05, 0.05, 0.03, '#fff0b0');
    }
    b.box((x0 + x1) / 2, y1 - 0.05, 0, x1 - x0, 0.08, t + 0.03, GOLD);
  }
}

function topSlab(b: Builder, m: number, hx: number, hz: number, y0: number, y1: number, seed: number, planksAlongX = true): void {
  const P = PAL[m];
  b.box(0, (y0 + y1) / 2, 0, hx * 2, y1 - y0, hz * 2, P.dark);
  if (m === 0) {
    const n = Math.round((planksAlongX ? hz : hx) * 2 / 0.25);
    const w = ((planksAlongX ? hz : hx) * 2) / n;
    for (let i = 0; i < n; i++) {
      const j = hash(seed, i);
      const c = -(planksAlongX ? hz : hx) + w * (i + 0.5);
      const len = (planksAlongX ? hx : hz) * 2;
      if (planksAlongX) b.box(0, y1 - 0.02 - (y1 - y0) / 2 + (y1 - y0) / 2, c, len - 0.01, y1 - y0 - 0.0, w - 0.02, tint(i % 2 ? P.main : P.alt, 0.9 + j * 0.2));
      else b.box(c, (y0 + y1) / 2, 0, w - 0.02, y1 - y0, len - 0.01, tint(i % 2 ? P.main : P.alt, 0.9 + j * 0.2));
    }
  } else {
    const n = Math.round((hx * 2) / 0.5);
    const w = (hx * 2) / n;
    const nz = Math.round((hz * 2) / 0.5);
    const d = (hz * 2) / nz;
    for (let i = 0; i < n; i++)
      for (let k = 0; k < nz; k++) b.box(-hx + w * (i + 0.5), (y0 + y1) / 2 + 0.005, -hz + d * (k + 0.5), w - 0.025, y1 - y0, d - 0.025, tint((i + k) % 2 ? P.main : P.alt, 0.9 + hash(seed, i, k) * 0.2));
    if (m === 2) for (const sx of [-1, 1]) b.box(sx * (hx - 0.04), y1, 0, 0.08, 0.03, hz * 2, GOLD);
  }
}

// ---- structure ----

function foundation(b: Builder, m: number): void {
  const P = PAL[m];
  b.box(0, -0.75, 0, 1.96, 1.5, 1.96, P.dark);
  // skirt stones / posts
  if (m === 0) {
    for (const [x, z] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9], [0, -0.92], [0, 0.92], [-0.92, 0], [0.92, 0]]) b.box(x, -0.7, z, 0.18, 1.4, 0.18, tint(P.trim, 0.9));
  } else {
    for (let i = 0; i < 4; i++)
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) b.box(sx ? sx * 0.99 : -0.75 + i * 0.5, -0.3 - (i % 2) * 0.45, sz ? sz * 0.99 : -0.75 + i * 0.5, sx ? 0.06 : 0.46, 0.6, sx ? 0.46 : 0.06, tint(P.main, 0.85 + hash(i, sx, sz) * 0.2));
  }
  topSlab(b, m, 1, 1, -0.22, 0, 3);
}

function floor(b: Builder, m: number): void {
  topSlab(b, m, 1, 1, -0.2, 0, 5, false);
  const P = PAL[m];
  for (const z of [-0.96, 0.96]) b.box(0, -0.12, z, 2, 0.16, 0.08, P.trim);
  for (const x of [-0.96, 0.96]) b.box(x, -0.12, 0, 0.08, 0.16, 2, P.trim);
}

function wallBase(b: Builder, m: number, y1 = 2.5, seed = 1): void {
  slab(b, m, -1, 1, 0, y1, 0.2, seed);
  const P = PAL[m];
  b.box(0, 0.06, 0, 2, 0.12, 0.26, P.trim); // base rail
  b.box(0, y1 - 0.05, 0, 2, 0.1, 0.26, P.trim); // cap rail
  if (m === 0) for (const x of [-0.97, 0.97]) b.box(x, y1 / 2, 0, 0.1, y1, 0.26, tint(P.trim, 0.9)); // corner posts
}

function window(b: Builder, m: number): void {
  const P = PAL[m];
  slab(b, m, -1, 1, 0, 0.9, 0.2, 2);
  slab(b, m, -1, 1, 1.9, 2.5, 0.2, 3);
  slab(b, m, -1, -0.5, 0.9, 1.9, 0.2, 4);
  slab(b, m, 0.5, 1, 0.9, 1.9, 0.2, 5);
  // frame and mullions
  for (const [x, y, w, h] of [[0, 0.93, 1.1, 0.07], [0, 1.87, 1.1, 0.07], [-0.52, 1.4, 0.07, 1.0], [0.52, 1.4, 0.07, 1.0], [0, 1.4, 0.04, 1.0], [0, 1.4, 1.0, 0.04]]) b.box(x, y, 0, w, h, 0.17, WOOD.trim);
  b.box(0, 0.88, 0, 1.2, 0.06, 0.3, P.trim); // sill
  b.box(0, 0.04, 0, 2, 0.08, 0.26, P.trim);
  b.box(0, 2.45, 0, 2, 0.1, 0.26, P.trim);
}

function doorLeaf(b: Builder, open: boolean): void {
  // Hinge at x = -0.45; the leaf is 0.9 wide, 1.9 tall.
  const leaf = new Builder();
  for (let i = 0; i < 5; i++) leaf.box(0.09 + i * 0.18, 0.95, 0, 0.17, 1.86, 0.07, tint(WOOD.main, 0.9 + hash(i, 4) * 0.2));
  for (const y of [0.35, 1.55]) leaf.box(0.45, y, 0.045, 0.9, 0.1, 0.03, IRON);
  leaf.box(0.78, 0.95, 0.07, 0.07, 0.07, 0.07, GOLD); // handle
  const g = leaf.geometry();
  const R = new THREE.Matrix4().makeRotationY(open ? Math.PI / 2.2 : 0);
  const T = new THREE.Matrix4().makeTranslation(-0.45, 0, 0);
  g.applyMatrix4(T.multiply(R));
  const pa = g.getAttribute('position');
  const na = g.getAttribute('normal');
  const ca = g.getAttribute('color');
  const base = b.pos.length / 3;
  for (let i = 0; i < pa.count; i++) {
    b.pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
    b.nor.push(na.getX(i), na.getY(i), na.getZ(i));
    b.col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
  }
  g.index!.array.forEach((v) => b.idx.push(base + v));
}

function door(b: Builder, m: number, open: boolean): void {
  const P = PAL[m];
  slab(b, m, -1, -0.5, 0, 2.5, 0.2, 6);
  slab(b, m, 0.5, 1, 0, 2.5, 0.2, 7);
  slab(b, m, -0.5, 0.5, 2.0, 2.5, 0.2, 8);
  for (const x of [-0.5, 0.5]) b.box(x, 1.0, 0, 0.1, 2.0, 0.24, P.trim);
  b.box(0, 2.0, 0, 1.1, 0.1, 0.24, P.trim);
  b.box(0, 0.03, 0, 1, 0.06, 0.26, tint(P.trim, 0.8)); // threshold
  doorLeaf(b, open);
}

function stairs(b: Builder, m: number): void {
  const P = PAL[m];
  const n = 8;
  const run = 4 / n;
  const rise = 2.5 / n;
  for (let i = 0; i < n; i++) {
    const h = (i + 1) * rise + 0.8;
    b.box(-2 + run * (i + 0.5), h / 2 - 0.8, 0, run - 0.01, h, 1.9, tint(i % 2 ? P.main : P.alt, 0.95), undefined, 1);
    b.box(-2 + run * (i + 0.5), (i + 1) * rise - 0.02, 0, run + 0.04, 0.05, 1.96, tint(P.trim, 1.05)); // nosing
  }
  for (const z of [-0.97, 0.97]) {
    const len = Math.hypot(4, 2.5);
    b.boxR(0, 1.25 - 0.1, z, len + 0.2, 0.18, 0.08, P.trim, Math.atan2(2.5, 4));
    b.box(-2, 0.4, z, 0.1, 0.9, 0.1, P.trim);
    b.box(2, 2.1, z, 0.1, 0.9, 0.1, P.trim);
  }
  if (m === 2) for (const z of [-0.97, 0.97]) b.boxR(0, 1.25 - 0.02, z, 4.8, 0.05, 0.1, GOLD, Math.atan2(2.5, 4));
}

function ramp(b: Builder, m: number): void {
  const P = PAL[m];
  const a = Math.atan2(1, 2);
  b.boxR(0, 0.5 - 0.1, 0, Math.hypot(2, 1) + 0.04, 0.2, 1.96, P.main, a);
  b.tri([[-1, -0.6], [1, -0.6], [1, 1]], -0.95, -0.85, P.dark);
  b.tri([[-1, -0.6], [1, -0.6], [1, 1]], 0.85, 0.95, P.dark);
  for (let i = 0; i < 6; i++) b.boxR(-0.8 + i * 0.32, 0.4 + i * 0.16 - 0.1, 0, 0.04, 0.03, 1.9, P.trim, a); // cleats
  b.tri([[-1, -0.6], [1, -0.6], [1, 1]], -1.02, -0.96, P.trim);
  b.tri([[-1, -0.6], [1, -0.6], [1, 1]], 0.96, 1.02, P.trim);
}

function roof(b: Builder, m: number): void {
  const a = Math.atan2(1.25, 2);
  const len = Math.hypot(2, 1.25) + 0.3;
  const P = PAL[m];
  b.boxR(-0.02, 0.62 - 0.04, 0, len, 0.1, 2.14, P.dark, a);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const t = (r + 0.5) / rows; // along the slope, low to high
    const x = -1.1 + 2.2 * t;
    const y = 1.25 * ((x + 1) / 2);
    const cols = 7;
    const w = 2.24 / cols;
    for (let c = 0; c <= cols; c++) {
      const j = hash(r, c, m);
      const col = tint(j > 0.5 ? P.roof : P.roofAlt, 0.86 + j * 0.28);
      // alternate rows are shifted half a shingle; the ends are clipped to the slab
      let z0 = -1.12 + w * c - (r % 2) * (w / 2);
      let z1 = z0 + w;
      z0 = Math.max(z0, -1.12);
      z1 = Math.min(z1, 1.12);
      if (z1 - z0 < 0.04) continue;
      b.boxR(x, y + 0.03, (z0 + z1) / 2, 2.2 / rows + 0.14, 0.07, z1 - z0 - 0.015, col, a);
    }
  }
  // eave fascia
  b.box(-1.12, -0.02, 0, 0.08, 0.14, 2.2, P.trim);
}

function roofCap(b: Builder, m: number): void {
  const P = PAL[m];
  b.box(0, 0.12, 0, 2, 0.12, 0.5, P.roof);
  b.box(0, 0.22, 0, 2, 0.1, 0.22, P.trim);
}

function gable(b: Builder, m: number): void {
  const P = PAL[m];
  b.tri([[-1, 0], [1, 0], [1, 1.25]], -0.1, 0.1, P.dark);
  if (m === 0) {
    for (let i = 0; i < 9; i++) {
      const x = -0.9 + i * 0.2;
      const h = ((x + 1) / 2) * 1.25;
      if (h > 0.05) b.box(x, h / 2, 0, 0.18, h - 0.03, 0.12, tint(i % 2 ? P.main : P.alt, 0.9 + hash(i, 1) * 0.2));
    }
  } else {
    for (let r = 0; r < 4; r++) {
      const y = 0.16 + r * 0.3;
      const x1 = 1;
      const x0 = -1 + (y / 1.25) * 2;
      if (x1 - x0 > 0.1) b.box((x0 + x1) / 2, y, 0, x1 - x0 - 0.02, 0.28, 0.12, tint(r % 2 ? P.main : P.alt, 0.95));
    }
  }
  b.boxR(0, 0.625, 0.0, Math.hypot(2, 1.25), 0.07, 0.24, P.trim, Math.atan2(1.25, 2));
}

function pillar(b: Builder, m: number): void {
  const P = PAL[m];
  if (m === 0) {
    b.box(0, 1.15, 0, 0.26, 2.3, 0.26, P.main);
    for (let i = 0; i < 3; i++) b.box(0, 0.4 + i * 0.7, 0, 0.3, 0.05, 0.3, P.trim);
  } else {
    for (let r = 0; r < 7; r++) b.box(0, 0.16 + r * 0.32, 0, 0.26 + (r % 2) * 0.02, 0.3, 0.26 + (r % 2) * 0.02, tint(r % 2 ? P.main : P.alt, 0.95));
  }
  b.box(0, 0.07, 0, 0.36, 0.14, 0.36, P.trim);
  b.box(0, 2.3, 0, 0.36, 0.1, 0.36, m === 2 ? GOLD : P.trim);
}

function beam(b: Builder, m: number): void {
  const P = PAL[m];
  b.box(0, -0.3, 0, 2, 0.2, 0.2, m === 0 ? P.main : P.alt);
  if (m === 0) for (let i = 0; i < 4; i++) b.box(-0.75 + i * 0.5, -0.3, 0, 0.03, 0.21, 0.21, P.dark);
  if (m === 2) b.box(0, -0.3, 0, 2, 0.05, 0.22, GOLD);
}

function fence(b: Builder, m: number, gate = false, open = false): void {
  const P = PAL[m];
  const posts = gate ? [-0.95, 0.95] : [-0.95, 0, 0.95];
  for (const x of posts) {
    if (m === 0) b.box(x, 0.6, 0, 0.12, 1.2, 0.12, P.alt);
    else b.box(x, 0.55, 0, 0.18, 1.1, 0.18, tint(P.alt, 1));
    b.box(x, m === 0 ? 1.22 : 1.12, 0, 0.16, 0.05, 0.16, m === 2 ? GOLD : P.trim);
  }
  if (!gate) {
    for (const y of [0.4, 0.8]) b.box(0, y, 0, 1.9, 0.09, 0.07, tint(P.main, 0.95 + hash(y, 1) * 0.1));
    if (m !== 0) b.box(0, 0.95, 0, 1.9, 0.08, 0.1, P.trim);
    return;
  }
  const leaf = new Builder();
  for (const y of [0.3, 0.55, 0.8, 1.0]) leaf.box(0.45, y, 0, 0.9, 0.08, 0.06, P.main);
  leaf.box(0.05, 0.65, 0, 0.08, 0.85, 0.07, P.alt);
  leaf.box(0.85, 0.65, 0, 0.08, 0.85, 0.07, P.alt);
  leaf.boxR(0.45, 0.65, 0, 1.1, 0.06, 0.05, P.trim, Math.atan2(0.65, 0.8));
  const g = leaf.geometry();
  const R = new THREE.Matrix4().makeRotationY(open ? Math.PI / 2.1 : 0);
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(-0.9, 0, 0).multiply(R));
  const pa = g.getAttribute('position');
  const na = g.getAttribute('normal');
  const ca = g.getAttribute('color');
  const base = b.pos.length / 3;
  for (let i = 0; i < pa.count; i++) {
    b.pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
    b.nor.push(na.getX(i), na.getY(i), na.getZ(i));
    b.col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
  }
  g.index!.array.forEach((v) => b.idx.push(base + v));
}

// ---- furnishings ----

const CLOTH_RED = '#9a3b2c';
const CLOTH_CREAM = '#d8c9a0';
const COAL = [3.2, 1.1, 0.25];

function glowBox(g: Builder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rgb: number[]): void {
  g.box(cx, cy, cz, sx, sy, sz, new THREE.Color(rgb[0], rgb[1], rgb[2]), undefined, 1);
}

interface FurnishOut {
  solid: Builder;
  glow: Builder;
  flames: number[][];
  light: number[] | null;
}

function furnish(key: string): FurnishOut {
  const b = new Builder();
  const g = new Builder();
  const flames: number[][] = [];
  let light: number[] | null = null;
  const W = WOOD;
  switch (key) {
    case 'bench':
      b.box(0, 0.44, 0, 1.4, 0.07, 0.42, W.main);
      b.box(0, 0.4, 0.17, 1.4, 0.03, 0.04, W.dark);
      for (const x of [-0.58, 0.58]) b.box(x, 0.2, 0, 0.1, 0.4, 0.38, W.alt);
      b.box(0, 0.28, 0, 1.2, 0.05, 0.06, W.trim);
      break;
    case 'table':
      b.box(0, 0.77, 0, 1.3, 0.07, 0.8, W.main);
      for (let i = 0; i < 4; i++) b.box(-0.6 + i * 0.4, 0.795, 0, 0.36, 0.01, 0.76, tint(i % 2 ? W.main : W.alt, 0.95));
      for (const [x, z] of [[-0.55, -0.32], [0.55, -0.32], [-0.55, 0.32], [0.55, 0.32]]) b.box(x, 0.37, z, 0.09, 0.74, 0.09, W.alt);
      b.box(0, 0.3, 0, 1.0, 0.04, 0.05, W.trim);
      b.cyl(0.3, 0.8, 0.1, 0.08, 0.12, '#b9824a', 8, 0.06); // a jug
      break;
    case 'rug':
      b.box(0, 0.015, 0, 2, 0.03, 1.4, CLOTH_RED);
      b.box(0, 0.032, 0, 1.7, 0.01, 1.1, CLOTH_CREAM);
      b.box(0, 0.036, 0, 1.5, 0.01, 0.9, CLOTH_RED);
      b.box(0, 0.04, 0, 0.5, 0.01, 0.3, '#d9a93a');
      for (let i = 0; i < 12; i++) for (const s of [-1, 1]) b.box(s * 1.03, 0.012, -0.62 + i * 0.113, 0.06, 0.02, 0.04, CLOTH_CREAM);
      break;
    case 'banner':
      b.box(0, 1.72, 0.14, 0.9, 0.04, 0.04, W.alt);
      for (const s of [-1, 1]) b.cyl(s * 0.46, 1.69, 0.14, 0.04, 0.09, GOLD, 6);
      b.box(0, 1.0, 0.13, 0.7, 1.35, 0.02, CLOTH_RED);
      b.box(0, 1.0, 0.145, 0.12, 1.2, 0.01, '#d9a93a');
      b.tri([[-0.35, 0.325], [0.35, 0.325], [0, 0.1]], 0.12, 0.14, CLOTH_RED);
      b.box(0, 1.25, 0.15, 0.3, 0.3, 0.01, '#d9a93a');
      break;
    case 'lantern':
      b.box(0, 0.03, 0, 0.26, 0.06, 0.26, IRON);
      b.box(0, 0.45, 0, 0.3, 0.04, 0.3, IRON);
      for (const [x, z] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]]) b.box(x, 0.24, z, 0.03, 0.42, 0.03, IRON);
      b.cyl(0, 0.48, 0, 0.1, 0.05, IRON, 6, 0.03);
      glowBox(g, 0, 0.24, 0, 0.2, 0.34, 0.2, [2.6, 1.7, 0.7]);
      flames.push([0, 0.14, 0, 0.22]);
      light = [0, 0.3, 0];
      break;
    case 'wall_torch':
      b.box(0, 1.5, 0.18, 0.08, 0.5, 0.06, IRON);
      b.box(0, 1.28, 0.24, 0.06, 0.06, 0.2, IRON);
      b.cyl(0, 1.42, 0.3, 0.05, 0.12, IRON, 6, 0.07);
      b.cyl(0, 1.5, 0.3, 0.035, 0.38, W.alt, 6);
      glowBox(g, 0, 1.92, 0.3, 0.1, 0.12, 0.1, [3, 1.4, 0.4]);
      flames.push([0, 1.95, 0.3, 0.4]);
      light = [0, 1.9, 0.5];
      break;
    case 'trophy':
      b.box(0, 1.5, 0.14, 0.5, 0.5, 0.05, W.main);
      b.box(0, 1.5, 0.17, 0.42, 0.42, 0.02, W.dark);
      b.box(0, 1.47, 0.24, 0.2, 0.26, 0.14, '#7a6048'); // head
      b.box(0, 1.37, 0.34, 0.1, 0.1, 0.12, '#6a5240'); // snout
      for (const s of [-1, 1]) {
        b.boxR(s * 0.2, 1.72, 0.22, 0.05, 0.3, 0.05, '#e8dfc8', -s * 0.5);
        b.boxR(s * 0.3, 1.9, 0.22, 0.04, 0.2, 0.04, '#e8dfc8', s * 0.7);
        b.box(s * 0.1, 1.55, 0.34, 0.04, 0.04, 0.04, '#111');
      }
      break;
    case 'bed':
      b.box(0, 0.18, 0, 2.0, 0.14, 1.0, W.alt);
      for (const [x, z] of [[-0.93, -0.43], [0.93, -0.43], [-0.93, 0.43], [0.93, 0.43]]) b.box(x, 0.08, z, 0.1, 0.16, 0.1, W.dark);
      b.box(-0.96, 0.42, 0, 0.08, 0.6, 1.0, W.main); // headboard
      b.box(0.96, 0.3, 0, 0.08, 0.36, 1.0, W.main);
      b.box(0.02, 0.32, 0, 1.8, 0.16, 0.88, '#d8cfb4'); // mattress
      b.box(-0.65, 0.46, 0, 0.5, 0.12, 0.6, '#f0ead8'); // pillow
      b.box(0.3, 0.43, 0, 1.1, 0.08, 0.92, CLOTH_RED); // blanket
      b.box(0.3, 0.475, 0, 1.1, 0.01, 0.3, '#d9a93a');
      break;
    case 'big_chest':
      b.box(0, 0.3, 0, 1.6, 0.6, 0.8, W.main);
      for (let i = 0; i < 6; i++) b.box(-0.66 + i * 0.264, 0.3, 0.405, 0.25, 0.58, 0.01, tint(i % 2 ? W.main : W.alt, 0.95));
      b.box(0, 0.74, 0, 1.64, 0.24, 0.84, tint(W.alt, 1.05));
      b.box(0, 0.88, 0, 1.5, 0.08, 0.7, W.main); // the lid's crown
      for (const x of [-0.5, 0.5]) b.box(x, 0.5, 0, 0.1, 0.96, 0.86, IRON);
      b.box(0, 0.62, 0.43, 0.14, 0.16, 0.05, GOLD);
      for (const x of [-0.8, 0.8]) for (const z of [-0.4, 0.4]) b.box(x, 0.3, z, 0.07, 0.62, 0.07, IRON);
      break;
    case 'forge':
      b.box(0, 0.45, 0, 1.6, 0.9, 1.2, PAL[1].main);
      for (let r = 0; r < 3; r++) for (let i = 0; i < 4; i++) b.box(-0.6 + i * 0.4 + (r % 2) * 0.1, 0.15 + r * 0.3, 0.605, 0.38, 0.28, 0.02, tint(PAL[1].alt, 0.9 + hash(r, i) * 0.2));
      b.box(0, 0.5, 0.58, 0.9, 0.34, 0.1, '#1f1c1a'); // firebox mouth
      glowBox(g, 0, 0.5, 0.6, 0.8, 0.24, 0.04, [2.4, 0.9, 0.2]);
      glowBox(g, 0, 0.91, 0.1, 0.9, 0.04, 0.5, COAL);
      b.box(0, 1.1, -0.25, 0.7, 0.4, 0.5, PAL[1].dark); // hood
      b.box(0, 1.3, -0.35, 0.34, 0.5, 0.3, PAL[1].alt); // chimney
      b.box(-0.35, 0.98, 0.2, 0.34, 0.1, 0.2, IRON); // anvil face
      b.box(-0.35, 0.92, 0.2, 0.18, 0.1, 0.14, IRON);
      b.cyl(0.55, 0.9, 0.35, 0.1, 0.18, '#3a5f7a', 8, 0.12); // quench tub
      flames.push([0, 0.95, 0.1, 0.36]);
      light = [0, 1.0, 0.7];
      break;
    case 'cook':
      b.box(0, 0.4, 0, 1.4, 0.8, 0.9, PAL[1].main);
      for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) b.box(-0.45 + i * 0.45 + (r % 2) * 0.1, 0.12 + r * 0.3, 0.455, 0.42, 0.28, 0.02, tint(PAL[1].alt, 0.9 + hash(r, i, 2) * 0.2));
      b.box(0, 0.82, 0, 1.4, 0.06, 0.9, PAL[1].trim);
      b.box(0, 0.5, 0.44, 0.7, 0.34, 0.06, '#1f1c1a');
      glowBox(g, 0, 0.45, 0.46, 0.6, 0.2, 0.03, [2.2, 0.8, 0.2]);
      glowBox(g, 0.0, 0.86, -0.1, 0.5, 0.03, 0.4, COAL);
      b.cyl(-0.1, 0.88, -0.1, 0.22, 0.2, IRON, 10, 0.24); // pot
      b.box(-0.1, 1.08, -0.1, 0.5, 0.04, 0.04, IRON);
      b.box(0.45, 0.82 + 0.12, 0.15, 0.3, 0.05, 0.22, W.main); // board
      flames.push([0.0, 0.9, -0.1, 0.28]);
      light = [0, 1.0, 0.45];
      break;
    case 'home_workbench':
      b.box(0, 0.93, 0, 1.9, 0.1, 0.9, W.main);
      for (let i = 0; i < 5; i++) b.box(-0.76 + i * 0.38, 0.985, 0, 0.36, 0.01, 0.86, tint(i % 2 ? W.main : W.alt, 0.95));
      for (const [x, z] of [[-0.82, -0.35], [0.82, -0.35], [-0.82, 0.35], [0.82, 0.35]]) b.box(x, 0.44, z, 0.12, 0.88, 0.12, W.alt);
      b.box(0, 0.25, 0, 1.7, 0.06, 0.7, W.trim);
      b.box(0.5, 1.04, 0.1, 0.5, 0.03, 0.04, IRON); // saw
      b.box(-0.55, 1.07, -0.1, 0.18, 0.12, 0.3, '#8a8f98'); // vise
      b.cyl(0.0, 1.0, 0.25, 0.05, 0.1, '#b9824a', 6);
      break;
    case 'hearth':
      b.box(0, 0.08, 0, 1.6, 0.16, 1.0, PAL[1].dark);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        b.box(Math.cos(a) * 0.62, 0.3, Math.sin(a) * 0.38, 0.3, 0.3, 0.26, tint(PAL[1].main, 0.85 + hash(i, 3) * 0.3), new THREE.Matrix4().makeRotationY(-a * 0.0));
      }
      b.box(-0.0, 0.52, -0.46, 1.5, 0.9, 0.18, PAL[1].main); // back wall
      b.box(0, 1.02, -0.46, 1.5, 0.12, 0.26, GOLD);
      for (const s of [-1, 1]) b.box(s * 0.74, 0.5, -0.2, 0.14, 0.84, 0.5, PAL[1].alt);
      glowBox(g, 0, 0.23, 0, 0.8, 0.1, 0.5, COAL);
      // standing ward crystal
      {
      const diamond = new Builder();
      diamond.tri([[-0.16, 0.65], [0.16, 0.65], [0, 1.0]], -0.06, 0.06, new THREE.Color(2.2, 1.9, 1.2));
      diamond.tri([[-0.16, 0.65], [0.16, 0.65], [0, 0.35]], -0.06, 0.06, new THREE.Color(2.6, 1.8, 0.8));
      const at = g.pos.length / 3;
      g.pos.push(...diamond.pos);
      g.nor.push(...diamond.nor);
      g.col.push(...diamond.col);
      g.idx.push(...diamond.idx.map((v) => v + at));
      }
      for (let i = 0; i < 6; i++) b.box(-0.6 + i * 0.24, 0.62, -0.36, 0.06, 0.18, 0.02, GOLD); // runes
      flames.push([0, 0.2, 0, 0.9]);
      light = [0, 0.9, 0.2];
      break;
    default:
      b.box(0, 0.25, 0, 0.5, 0.5, 0.5, '#ff00ff');
  }
  return { solid: b, glow: g, flames, light };
}

// ---- catalogue ----

const cache = new Map<string, PieceGeo>();

/** Door and gate pieces draw differently open; everything else ignores `open`. */
export function pieceGeo(kind: number, open = false): PieceGeo {
  const def = pieceDef(kind);
  if (!def?.build) throw new Error(`pieceGeo: kind ${kind} is not a building piece`);
  const sh = def.build;
  const key = `${kind}:${sh.door && open ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = Math.max(0, sh.mat);
  let b = new Builder();
  let g: Builder | null = null;
  let flames: number[][] = [];
  let light: number[] | null = null;
  switch (sh.base) {
    case 'foundation':
      foundation(b, m);
      break;
    case 'floor':
      floor(b, m);
      break;
    case 'wall':
      wallBase(b, m, 2.5, 1);
      break;
    case 'half_wall':
      slab(b, m, -1, 1, 0, 1.1, 0.2, 9);
      b.box(0, 1.12, 0, 2, 0.1, 0.28, PAL[m].trim);
      b.box(0, 0.05, 0, 2, 0.1, 0.26, PAL[m].trim);
      break;
    case 'window':
      window(b, m);
      break;
    case 'door':
      door(b, m, open);
      break;
    case 'stairs':
      stairs(b, m);
      break;
    case 'ramp':
      ramp(b, m);
      break;
    case 'roof':
      roof(b, m);
      break;
    case 'roof_cap':
      roofCap(b, m);
      break;
    case 'gable':
      gable(b, m);
      break;
    case 'pillar':
      pillar(b, m);
      break;
    case 'beam':
      beam(b, m);
      break;
    case 'fence':
      fence(b, m);
      break;
    case 'gate':
      fence(b, m, true, open);
      break;
    default: {
      const f = furnish(sh.base);
      b = f.solid;
      g = f.glow;
      flames = f.flames;
      light = f.light;
    }
  }
  const out: PieceGeo = { solid: b.geometry(), glow: g && !g.empty ? g.geometry() : null, flames, light };
  cache.set(key, out);
  return out;
}

/** The sizes of everything drawn, for tests: triangle count of a piece. */
export function pieceTriangles(kind: number): number {
  const g = pieceGeo(kind);
  return (g.solid.index?.count ?? 0) / 3 + (g.glow?.index?.count ?? 0) / 3;
}

export const hasModel = (kind: number): boolean => !!CAMPS.pieces.find((p) => p.id === kind)?.build;
