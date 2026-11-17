// Procedural nature textures (playtest 3, CR 045): a leaf/flower atlas with
// alpha, tileable bark textures and a tileable stone texture. Painted once,
// lazily, into DataTextures from a few noise functions and a tiny shape
// rasteriser: original art with no files to download, deterministic on every
// load (so the impostor bake and the shadow alpha always agree).
//
// Leaf atlas: 4 x 2 cells of 256 px, alpha-cut clusters with the stem at the
// bottom centre of the cell:
//   0 broad leaves   1 small round leaves   2 needle spray   3 fern / palm frond
//   4 flowers        5 willow strand        6 dry scrub      7 seed head (reeds)
// The last 8 x 8 px of the atlas are opaque: trunk vertices point their atlas
// UV there so the alpha-tested shadow depth pass sees solid wood.
//
// Colours are near-neutral and bright: the mesh vertex colours (canopy shade)
// and the per-instance tint (species, season, variation) multiply them.

import * as THREE from 'three';

export const ATLAS_W = 1024;
export const ATLAS_H = 512;
export const CELL = 256;
export const LEAF_CELLS = { broad: 0, small: 1, needle: 2, frond: 3, flower: 4, willow: 5, scrub: 6, seed: 7 } as const;
export type LeafCell = keyof typeof LEAF_CELLS;
/** UV rectangle of a cell, inset so mip bleed from neighbours stays outside the shape. */
export function cellUv(cell: number): [number, number, number, number] {
  const cx = cell % 4;
  const cy = Math.floor(cell / 4);
  const e = 2 / 1024;
  return [(cx * CELL) / ATLAS_W + e, (cy * CELL) / ATLAS_H + e * 2, ((cx + 1) * CELL) / ATLAS_W - e, ((cy + 1) * CELL) / ATLAS_H - e * 2];
}
/** A texel that is always opaque (atlas corner). */
export const SOLID_UV: [number, number] = [(ATLAS_W - 4) / ATLAS_W, 1 - 4 / ATLAS_H];

// ---------------------------------------------------------------- noise

function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const sstep = (t: number) => t * t * (3 - 2 * t);
/** Value noise, periodic with integer periods px, py (0 = not periodic). */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = sstep(x - x0);
  const fy = sstep(y - y0);
  const wrap = (v: number, p: number) => (p > 0 ? ((v % p) + p) % p : v);
  const a = hash2(wrap(x0, px), wrap(y0, py), seed);
  const b = hash2(wrap(x0 + 1, px), wrap(y0, py), seed);
  const c = hash2(wrap(x0, px), wrap(y0 + 1, py), seed);
  const d = hash2(wrap(x0 + 1, px), wrap(y0 + 1, py), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, px: number, py: number, seed: number, oct = 4): number {
  let a = 0.5;
  let s = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, px, py, seed + i * 17);
    n += a;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    a *= 0.5;
  }
  return s / n;
}
function rngSeq(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- shape painter

type RGB = [number, number, number];
class Canvas {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly w: number,
    readonly ox: number,
    readonly oy: number,
  ) {}
  /** Source-over blend of a colour at coverage a into pixel (x, y) of this cell. */
  px(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0) return;
    // Painted top-down (tips at small y); texture rows run bottom-up, so flip.
    const i = ((this.oy + (CELL - 1 - y)) * this.w + this.ox + x) * 4;
    const d = this.data;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[i] = (c[0] * a + d[i] * da * (1 - a)) / oa;
    d[i + 1] = (c[1] * a + d[i + 1] * da * (1 - a)) / oa;
    d[i + 2] = (c[2] * a + d[i + 2] * da * (1 - a)) / oa;
    d[i + 3] = oa * 255;
  }
}

/** One pointed leaf from (x, y) along `ang` (radians, 0 = +x, canvas y down): length L, half width W. */
function leaf(c: Canvas, x: number, y: number, ang: number, L: number, W: number, col: RGB, vein = 0.25, round = 0): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const r = Math.ceil(L + W) + 2;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const px = Math.round(x) + i;
      const py = Math.round(y) + j;
      if (px < 1 || py < 1 || px >= CELL - 1 || py >= CELL - 1) continue;
      const dx = px - x;
      const dy = py - y;
      const u = (dx * ca + dy * sa) / L; // along
      const v = (-dx * sa + dy * ca) / W; // across
      if (u < 0 || u > 1) continue;
      // Pointed ovate: widest at ~35 %, `round` blunts the tip.
      const prof = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.8 - round * 0.3);
      const e = 1 - Math.abs(v) / Math.max(prof, 1e-3);
      if (e <= 0) continue;
      const a = Math.min(1, e * W * 0.9);
      const rib = Math.max(0, 1 - Math.abs(v) * W * 0.9) * vein;
      const side = vein * 0.5 * Math.max(0, Math.sin((u * 14 + Math.abs(v) * 3) * Math.PI) - 0.55);
      const k = 0.88 + rib * 0.5 + side * 0.25 - Math.abs(v) * 0.1 + 0.12 * u;
      c.px(px, py, [col[0] * k, col[1] * k, col[2] * k], a);
    }
  }
}

/** A thin tapered line (twigs, stems, needles). */
function stroke(c: Canvas, x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, col: RGB): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.ceil(len));
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const w = w0 + (w1 - w0) * t;
    const r = Math.ceil(w) + 1;
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const px = Math.round(x) + i;
        const py = Math.round(y) + j;
        if (px < 1 || py < 1 || px >= CELL - 1 || py >= CELL - 1) continue;
        const d = Math.hypot(px - x, py - y);
        const a = Math.min(1, (w - d) + 0.5);
        if (a > 0) c.px(px, py, col, a);
      }
    }
  }
}

const TWIG: RGB = [118, 92, 66];
const jitter = (r: () => number, c: RGB, a: number): RGB => {
  const k = 1 + (r() - 0.5) * a;
  return [c[0] * k * (1 + (r() - 0.5) * 0.1), c[1] * k, c[2] * k * (1 + (r() - 0.5) * 0.1)];
};

function paintBroad(c: Canvas): void {
  const r = rngSeq(11);
  const base: RGB = [118, 168, 74];
  // A leafy shoot: a main twig with alternating leaves, plus side twigs with their own, so one
  // card carries a dense spray of leaves of a plausible size instead of a few big ones.
  const pts: [number, number][] = [];
  const N = 11;
  for (let i = 0; i <= N; i++) pts.push([128 + Math.sin(i * 0.5) * 8, 252 - i * 21]);
  for (let i = 0; i < N; i++) stroke(c, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2.2 - i * 0.12, 2.0 - i * 0.12, TWIG);
  // Side twigs first (behind), then the main leaves.
  for (const [at, side] of [
    [2, -1],
    [3, 1],
    [5, -1],
    [6, 1],
    [8, -1],
  ] as [number, number][]) {
    const [x, y] = pts[at];
    const a = -Math.PI / 2 + side * (0.95 + r() * 0.2);
    const len = 58 - at * 3;
    const ex = x + Math.cos(a) * len;
    const ey = y + Math.sin(a) * len;
    stroke(c, x, y, ex, ey, 1.6, 0.9, TWIG);
    for (let k = 0; k < 3; k++) {
      const t = 0.4 + k * 0.3;
      leaf(c, x + (ex - x) * t, y + (ey - y) * t, a + (k % 2 ? 0.7 : -0.7) * 0.8, 40 - at, 13, jitter(r, base, 0.3), 0.3);
    }
    leaf(c, ex, ey, a, 40 - at, 14, jitter(r, base, 0.3), 0.3);
  }
  for (let i = 1; i <= N; i++) {
    const [x, y] = pts[i];
    const s = 1 - i * 0.04;
    for (const side of [-1, 1]) {
      const ang = -Math.PI / 2 + side * (0.95 + r() * 0.25);
      leaf(c, x, y + 2, ang, 54 * s, 17 * s, jitter(r, base, 0.28), 0.3);
    }
  }
  leaf(c, pts[N][0], pts[N][1], -Math.PI / 2, 52, 17, jitter(r, base, 0.2), 0.3);
}

function paintSmall(c: Canvas): void {
  const r = rngSeq(23);
  const base: RGB = [128, 176, 80];
  const stems: [number, number][] = [
    [128, 250],
    [128, 130],
  ];
  stroke(c, stems[0][0], stems[0][1], stems[1][0], stems[1][1], 2, 1.4, TWIG);
  for (let b = 0; b < 7; b++) {
    const y0 = 220 - b * 26;
    for (const side of [-1, 1]) {
      const ex = 128 + side * (50 + r() * 50);
      const ey = y0 - 25 - r() * 22;
      stroke(c, 128, y0, ex, ey, 1.4, 0.8, TWIG);
      for (let k = 0; k < 4; k++) {
        const t = 0.35 + k * 0.2;
        const lx = 128 + (ex - 128) * t;
        const ly = y0 + (ey - y0) * t;
        leaf(c, lx, ly, Math.atan2(ey - y0, ex - 128) + (r() - 0.5) * 1.6, 28 + r() * 8, 15 + r() * 4, jitter(r, base, 0.3), 0.18, 0.6);
      }
    }
  }
  for (let k = 0; k < 4; k++) leaf(c, 128, 150 - k * 6, -Math.PI / 2 + (r() - 0.5) * 1.2, 30, 15, jitter(r, base, 0.3), 0.18, 0.6);
}

function paintNeedle(c: Canvas): void {
  const r = rngSeq(31);
  const base: RGB = [70, 118, 72];
  stroke(c, 128, 252, 128, 8, 3, 1.2, [96, 70, 50]);
  for (let i = 0; i < 70; i++) {
    const t = i / 70;
    const y = 240 - t * 226;
    const spread = 1 - t * 0.55;
    for (const side of [-1, 1]) {
      const len = (62 + r() * 30) * spread;
      const ang = -Math.PI / 2 + side * (0.7 + r() * 0.5);
      const x1 = 128 + Math.cos(ang) * len;
      const y1 = y + Math.sin(ang) * len * 0.8;
      stroke(c, 128, y, x1, y1, 2.2, 0.5, jitter(r, base, 0.35));
    }
  }
}

function paintFrond(c: Canvas): void {
  const r = rngSeq(43);
  const base: RGB = [96, 158, 72];
  // Arching rachis, pinnate leaflets getting shorter toward the tip.
  const N = 22;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    px.push(128 + Math.sin(t * 1.6) * 26 * t);
    py.push(252 - t * 244 + t * t * 20);
  }
  for (let i = 0; i < N; i++) stroke(c, px[i], py[i], px[i + 1], py[i + 1], 2.4 * (1 - i / N) + 0.6, 2.4 * (1 - (i + 1) / N) + 0.6, [104, 128, 70]);
  for (let i = 2; i < N; i++) {
    const t = i / N;
    const len = Math.sin(Math.PI * Math.min(1, t * 1.05)) * 64 + 6;
    for (const side of [-1, 1]) leaf(c, px[i], py[i], -Math.PI / 2 + side * (1.15 - t * 0.35), len, 6.5, jitter(r, base, 0.25), 0.25, 0);
  }
}

function paintFlower(c: Canvas): void {
  const r = rngSeq(53);
  // Stem and two flower heads (white petals, golden centre; the instance tint colours the petals).
  stroke(c, 128, 254, 128, 140, 2.2, 1.6, [70, 130, 60]);
  leaf(c, 128, 230, -Math.PI / 2 - 0.9, 46, 9, [80, 140, 66], 0.2);
  leaf(c, 128, 215, -Math.PI / 2 + 0.9, 40, 8, [80, 140, 66], 0.2);
  const head = (hx: number, hy: number, R: number, petals: number, rot: number) => {
    for (let p = 0; p < petals; p++) {
      const a = rot + (p / petals) * Math.PI * 2;
      leaf(c, hx, hy, a, R, R * 0.36, jitter(r, [238, 238, 236], 0.1), 0.1, 1);
    }
    for (let j = -9; j <= 9; j++) for (let i = -9; i <= 9; i++) if (i * i + j * j < 64) c.px(Math.round(hx) + i, Math.round(hy) + j, [236, 190, 52], 1);
  };
  head(128, 100, 62, 6, 0.3);
  stroke(c, 128, 190, 196, 168, 1.4, 1.0, [70, 130, 60]);
  head(196, 150, 40, 5, 0.9);
  stroke(c, 128, 200, 62, 176, 1.4, 1.0, [70, 130, 60]);
  head(62, 160, 34, 5, 0.1);
}

function paintWillow(c: Canvas): void {
  const r = rngSeq(61);
  const base: RGB = [140, 182, 88];
  stroke(c, 128, 4, 128, 250, 1.6, 0.8, [120, 110, 70]);
  for (let i = 0; i < 40; i++) {
    const y = 10 + i * 6;
    for (const side of [-1, 1]) {
      const a = Math.PI / 2 + side * (0.55 + r() * 0.35);
      leaf(c, 128, y, a, 34 + r() * 20, 5.5, jitter(r, base, 0.3), 0.2, 0);
    }
  }
}

function paintScrub(c: Canvas): void {
  const r = rngSeq(71);
  const base: RGB = [140, 150, 80];
  const twig = (x: number, y: number, ang: number, len: number, depth: number) => {
    const x1 = x + Math.cos(ang) * len;
    const y1 = y + Math.sin(ang) * len;
    stroke(c, x, y, x1, y1, 2.2 - depth * 0.6, 1.4 - depth * 0.4, [112, 88, 62]);
    if (depth < 3) {
      twig(x + (x1 - x) * 0.5, y + (y1 - y) * 0.5, ang + 0.7 + r() * 0.4, len * 0.62, depth + 1);
      twig(x1, y1, ang - 0.5 - r() * 0.4, len * 0.62, depth + 1);
    } else {
      for (let k = 0; k < 5; k++) leaf(c, x1, y1, ang + (r() - 0.5) * 2.4, 16 + r() * 8, 5, jitter(r, base, 0.3), 0.1, 0.4);
    }
  };
  twig(128, 252, -Math.PI / 2, 64, 0);
}

function paintSeed(c: Canvas): void {
  const r = rngSeq(83);
  // Reed / cattail-like seed heads on a stalk: a brown cylinder with feathery tips.
  stroke(c, 128, 254, 128, 90, 2.4, 1.8, [120, 140, 80]);
  stroke(c, 128, 150, 128, 50, 9, 8, [124, 84, 52]);
  stroke(c, 128, 54, 128, 12, 1.2, 0.3, [150, 130, 90]);
  for (let i = 0; i < 30; i++) {
    const y = 60 + r() * 90;
    stroke(c, 128, y, 128 + (r() - 0.5) * 26, y - 8, 1.2, 0.5, [150, 108, 70]);
  }
  leaf(c, 128, 254, -Math.PI / 2 - 0.12, 150, 7, [118, 156, 80], 0.2);
  leaf(c, 128, 254, -Math.PI / 2 + 0.14, 130, 7, [108, 150, 76], 0.2);
}

let atlasTex: THREE.DataTexture | null = null;
export function leafAtlas(): THREE.DataTexture {
  if (atlasTex) return atlasTex;
  const data = new Uint8ClampedArray(ATLAS_W * ATLAS_H * 4);
  // Transparent texels carry a leaf-ish colour so mip filtering never bleeds black into the edges.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 120;
    data[i + 1] = 150;
    data[i + 2] = 80;
    data[i + 3] = 0;
  }
  const painters = [paintBroad, paintSmall, paintNeedle, paintFrond, paintFlower, paintWillow, paintScrub, paintSeed];
  painters.forEach((p, i) => p(new Canvas(data, ATLAS_W, (i % 4) * CELL, Math.floor(i / 4) * CELL)));
  for (let y = ATLAS_H - 8; y < ATLAS_H; y++) {
    for (let x = ATLAS_W - 8; x < ATLAS_W; x++) {
      const i = (y * ATLAS_W + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  atlasTex = new THREE.DataTexture(new Uint8Array(data.buffer), ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.generateMipmaps = true;
  atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTex.magFilter = THREE.LinearFilter;
  atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping;
  atlasTex.anisotropy = 4;
  atlasTex.needsUpdate = true;
  return atlasTex;
}

// ---------------------------------------------------------------- bark and stone

export type BarkKind = 'oak' | 'birch' | 'pine' | 'dead';
export const BARK_KINDS: BarkKind[] = ['oak', 'birch', 'pine', 'dead'];
const T = 256;

function tileTexture(fill: (u: number, v: number) => RGB): THREE.DataTexture {
  const d = new Uint8Array(T * T * 4);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const c = fill(x / T, y / T);
      const i = (y * T + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, T, T, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const barkCache = new Map<BarkKind, THREE.DataTexture>();
/** Tileable bark: furrowed ridges running along v (the trunk's length). */
export function barkTexture(kind: BarkKind): THREE.DataTexture {
  const hit = barkCache.get(kind);
  if (hit) return hit;
  const tex = tileTexture((u, v) => {
    if (kind === 'birch') {
      const n = fbm(u * 6, v * 6, 6, 6, 5, 3);
      // Horizontal dark lenticels on pale papery bark.
      const dash = vnoise(u * 5, v * 46, 5, 46, 9);
      const mark = Math.max(0, dash - 0.72) * 3.4 * (0.4 + fbm(u * 4, v * 8, 4, 8, 2, 2));
      const base = mixc([196, 190, 176], [232, 228, 214], n);
      return mixc(base, [38, 34, 30], Math.min(1, mark));
    }
    if (kind === 'pine') {
      // Large flat plates split by deep cracks.
      const w = vnoise(u * 5 + fbm(u * 3, v * 3, 3, 3, 4, 2) * 1.4, v * 3.2, 0, 0, 12);
      const cell = Math.floor(u * 5 + 0.0) + Math.floor(v * 3.2) * 7;
      void cell;
      const plate = fbm(u * 5, v * 2.2, 5, 2, 7, 3);
      const crack = Math.min(1, Math.abs(Math.sin(Math.PI * (u * 5 + (w - 0.5) * 0.8))) * 5 - 0.2);
      return mixc([34, 22, 16], mixc([112, 72, 52], [150, 104, 76], plate), Math.max(0, crack));
    }
    if (kind === 'dead') {
      const n = fbm(u * 8, v * 2, 8, 2, 21, 4);
      const streak = fbm(u * 14, v * 1.5, 14, 2, 22, 3);
      const crack = Math.max(0, 1 - Math.abs(n - 0.5) * 9);
      return mixc(mixc([118, 108, 98], [168, 158, 144], streak), [40, 34, 30], crack * 0.7);
    }
    // oak: deep, interlaced furrows.
    const warp = fbm(u * 3, v * 2, 3, 2, 31, 2) * 1.2;
    const f = fbm(u * 9 + warp, v * 1.6, 9, 2, 32, 4);
    const ridge = 1 - Math.abs(f * 2 - 1);
    const coarse = fbm(u * 5, v * 4, 5, 4, 33, 3);
    return mixc([30, 22, 17], mixc([92, 72, 56], [136, 112, 90], coarse), Math.pow(ridge, 1.6));
  });
  barkCache.set(kind, tex);
  return tex;
}

let stoneTex: THREE.DataTexture | null = null;
/** Tileable grey stone with fine grain, mineral flecks and hairline cracks. */
export function stoneTexture(): THREE.DataTexture {
  stoneTex ??= tileTexture((u, v) => {
    const n = fbm(u * 8, v * 8, 8, 8, 41, 5);
    const grain = vnoise(u * 64, v * 64, 64, 64, 43);
    const cr = Math.abs(fbm(u * 5 + 0.3, v * 5, 5, 5, 44, 3) - 0.5);
    const crack = Math.max(0, 1 - cr * 26);
    const warm = fbm(u * 3, v * 3, 3, 3, 45, 2);
    const base = mixc([118, 114, 108], [168, 162, 152], n);
    const tinted = mixc(base, [150, 134, 114], warm * 0.35);
    const g = 0.88 + grain * 0.24;
    return mixc([tinted[0] * g, tinted[1] * g, tinted[2] * g], [50, 48, 46], crack * 0.7);
  });
  return stoneTex;
}

export function disposeNatureTextures(): void {
  atlasTex?.dispose();
  atlasTex = null;
  for (const t of barkCache.values()) t.dispose();
  barkCache.clear();
  stoneTex?.dispose();
  stoneTex = null;
}
