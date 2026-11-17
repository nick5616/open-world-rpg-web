// Rich procedural trees (playtest 3, CR 045). One generator per habit builds
// a real structure: a tapering trunk with a root flare and buttresses, limbs
// that curve and fork, and leaf clusters made of alpha-tested card quads
// (leaf atlas, natureTextures.ts) hung on the branch tips. Two mesh LODs per
// species and variant (the impostor bake uses LOD0); LOD1 is the same tree
// with the branch hierarchy cut back and fewer, larger cards.
//
// Units match the legacy archetypes (archetypes.ts): ~1 unit tall, base at
// the origin, crown within +-0.55 on x and z, so the scatter manager's
// per-kind width/height scales and the impostor framing carry over.
//
// Species follow worldgen's TREE_KINDS order (scatterManager TREE_STYLE):
// 0 oak, 1 birch, 2 broadleaf, 3 pine, 4 snow fir, 5 dead, 6 acacia,
// 7 willow, 8 cypress. A variant is the same species grown from another seed.

import * as THREE from 'three';
import { MeshBuilder, clamp01, lerp, perp, randDir, rng, type Rng } from './meshBuilder';
import { LEAF_CELLS, cellUv, type BarkKind, type LeafCell } from './natureTextures';

export type Habit = 'broad' | 'birch' | 'conifer' | 'dead' | 'umbrella' | 'willow';

export interface TreeSpecies {
  name: string;
  habit: Habit;
  bark: BarkKind;
  leaf: LeafCell;
  /** Card height in units at full detail. */
  card: number;
  /** Cards at full detail (LOD0, scale 1). */
  cards: number;
  /** Vertex-colour multiplier on the atlas colour (instance tint multiplies again). */
  leafCol: [number, number, number];
  /** Conifer shape: longest branch, first whorl height, whorls. */
  cone?: { len: number; start: number; whorls: number; droop: number };
}

export const TREE_SPECIES: TreeSpecies[] = [
  { name: 'oak', habit: 'broad', bark: 'oak', leaf: 'broad', card: 0.18, cards: 260, leafCol: [0.78, 0.86, 0.6] },
  { name: 'birch', habit: 'birch', bark: 'birch', leaf: 'small', card: 0.15, cards: 240, leafCol: [0.85, 0.95, 0.62] },
  { name: 'broadleaf', habit: 'broad', bark: 'oak', leaf: 'broad', card: 0.17, cards: 260, leafCol: [0.7, 0.84, 0.58] },
  { name: 'pine', habit: 'conifer', bark: 'pine', leaf: 'needle', card: 0.2, cards: 200, leafCol: [0.6, 0.78, 0.6], cone: { len: 0.3, start: 0.2, whorls: 12, droop: 0.35 } },
  { name: 'snow fir', habit: 'conifer', bark: 'pine', leaf: 'needle', card: 0.2, cards: 200, leafCol: [0.6, 0.78, 0.62], cone: { len: 0.34, start: 0.08, whorls: 13, droop: 0.5 } },
  { name: 'dead', habit: 'dead', bark: 'dead', leaf: 'scrub', card: 0.1, cards: 0, leafCol: [0.7, 0.7, 0.6] },
  { name: 'acacia', habit: 'umbrella', bark: 'oak', leaf: 'small', card: 0.18, cards: 240, leafCol: [0.85, 0.9, 0.55] },
  { name: 'willow', habit: 'willow', bark: 'oak', leaf: 'willow', card: 0.34, cards: 210, leafCol: [0.8, 0.9, 0.58] },
  { name: 'cypress', habit: 'conifer', bark: 'pine', leaf: 'needle', card: 0.16, cards: 200, leafCol: [0.5, 0.68, 0.52], cone: { len: 0.13, start: 0.05, whorls: 15, droop: 0.2 } },
];
export const TREE_VARIANTS = 2;

export interface TreeDetail {
  lod: 0 | 1;
  /** Card budget multiplier (medium 0.6, high 1, ultra 1.3). */
  scale: number;
}

interface Tip {
  p: THREE.Vector3;
  d: THREE.Vector3;
  flex: number;
}

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const col = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/** Wood vertex colours: darker and greener at the root, dry and pale on thin twigs. */
export const WOOD_ROOT = col(0.62, 0.64, 0.55);
export const WOOD = col(0.95, 0.93, 0.9);

export interface Ctx {
  b: MeshBuilder;
  r: Rng;
  sp: TreeSpecies;
  d: TreeDetail;
  tips: Tip[];
  seg: number;
  /** Crown centre and radii, for shading and the soft normal. */
  cc: THREE.Vector3;
  cr: THREE.Vector3;
}

export function limb(c: Ctx, start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, o: { n: number; curl: number; up: number; depth: number; maxDepth: number; subs: number; subLen: number; flex: number; tipsOnly?: boolean }): void {
  const { b, r } = c;
  const pts = [start.clone()];
  const rad = [r0];
  const d = dir.clone().normalize();
  const p = start.clone();
  // Thinner orders get fewer rings and sides: they are a few pixels wide.
  const nSteps = c.d.lod === 1 ? Math.min(o.n, 2) : o.depth === 0 ? o.n : Math.min(o.n, 3);
  const seg = c.d.lod === 1 ? 3 : o.depth === 0 ? c.seg - 1 : o.depth === 1 ? 4 : 3;
  for (let i = 1; i <= nSteps; i++) {
    d.add(randDir(r).multiplyScalar(o.curl)).add(V(0, o.up / nSteps, 0)).normalize();
    p.addScaledVector(d, len / nSteps);
    pts.push(p.clone());
    rad.push(lerp(r0, r1, i / nSteps));
  }
  const f0 = o.flex;
  const f1 = Math.min(1, o.flex + 0.35);
  b.tube(pts, rad, { seg, c0: WOOD_ROOT.clone().lerp(WOOD, clamp01(start.y * 2)), c1: WOOD, flex0: f0, flex1: f1, capTop: true, vScale: 12, uRep: 2 });
  if (o.depth >= o.maxDepth) {
    c.tips.push({ p: pts[pts.length - 1].clone(), d: d.clone(), flex: f1 });
    // The twig points along the last stretch also carry leaves.
    if (pts.length > 2) c.tips.push({ p: pts[pts.length - 2].clone(), d: d.clone(), flex: lerp(f0, f1, 0.6) });
    return;
  }
  for (let s = 0; s < o.subs; s++) {
    const t = 0.4 + (s / Math.max(1, o.subs)) * 0.55 + r() * 0.08;
    const i = Math.min(pts.length - 2, Math.max(1, Math.round(t * nSteps)));
    const sd = d.clone().applyAxisAngle(perp(d, r), 0.55 + r() * 0.5).normalize();
    limb(c, pts[i], sd, len * o.subLen * (0.8 + r() * 0.4), rad[i] * 0.72, r1 * 0.6, { ...o, depth: o.depth + 1, subs: 1, flex: lerp(f0, f1, t) });
  }
  // The main stem goes on to its own tip.
  c.tips.push({ p: pts[pts.length - 1].clone(), d: d.clone(), flex: f1 });
}

/** Soft "crown normal": leaves shade like the crown's blob, not like each card's plane. */
function crownNormal(c: Ctx, at: THREE.Vector3): THREE.Vector3 {
  const n = at.clone().sub(c.cc);
  n.set(n.x / c.cr.x, n.y / c.cr.y, n.z / c.cr.z);
  const len = n.length();
  n.normalize().multiplyScalar(0.75).add(V(0, 0.45, 0));
  void len;
  return n.normalize();
}

export function leafCards(c: Ctx, o: { count: number; size: number; spread: number; flat?: number; hang?: number; outward?: number; fill?: number }): void {
  const { b, r, sp } = c;
  if (!c.tips.length || o.count <= 0) return;
  const cell = cellUv(LEAF_CELLS[sp.leaf]);
  const lc = col(...sp.leafCol);
  for (let i = 0; i < o.count; i++) {
    // Most cards hang on branch tips; a share fills the crown volume so it reads as a mass, not a sprig per twig.
    let tip = c.tips[Math.floor(r() * c.tips.length)];
    const off = randDir(r).multiplyScalar(o.spread * (0.3 + 0.7 * r()));
    off.y *= o.flat ?? 1;
    let at = tip.p.clone().add(off);
    if (o.fill && i < o.count * o.fill) {
      const dir = randDir(r);
      const k = Math.cbrt(r()) * 0.85 + 0.15;
      at = V(c.cc.x + dir.x * c.cr.x * k, c.cc.y + dir.y * c.cr.y * k * (o.flat ?? 1), c.cc.z + dir.z * c.cr.z * k);
      tip = { p: at, d: dir, flex: 0.35 + 0.5 * k };
    }
    // Outerness drives shade: leaves in the crown's interior are dark, sun-side leaves bright.
    const rel = V((at.x - c.cc.x) / c.cr.x, (at.y - c.cc.y) / c.cr.y, (at.z - c.cc.z) / c.cr.z);
    const outer = clamp01(rel.length());
    const sunSide = clamp01(0.5 + rel.y * 0.5 + rel.x * 0.1);
    const k = 0.34 + 0.5 * outer + 0.3 * sunSide * outer + (r() - 0.5) * 0.14;
    const up =
      o.hang !== undefined
        ? V((r() - 0.5) * 0.3, -1, (r() - 0.5) * 0.3).normalize()
        : tip.d
            .clone()
            .multiplyScalar(o.outward ?? 0.5)
            .add(randDir(r).multiplyScalar(0.9))
            .normalize();
    if (o.flat) up.y = lerp(up.y, 0, 0.55);
    up.normalize();
    const side = perp(up, r);
    const w = o.size * (0.8 + 0.5 * r());
    const n = crownNormal(c, at);
    const c0 = col(lc.r * k * 0.82, lc.g * k * 0.82, lc.b * k * 0.82);
    const c1 = col(lc.r * k * 1.08, lc.g * k * 1.08, lc.b * k * 1.0);
    // Per-card hue drift: a tree is never one green.
    const hue = (r() - 0.5) * 0.16;
    c0.r *= 1 + hue;
    c1.r *= 1 + hue;
    c0.b *= 1 - hue;
    c1.b *= 1 - hue;
    b.cardQuad(at, up, side, { uv: cell, w, h: o.hang !== undefined ? Math.min(w * 3.4, Math.max(0.1, at.y - 0.03)) : w * 1.1, normal: n, c0, c1, phase: r() * 6.283, flex0: tip.flex, flex1: Math.min(1, tip.flex + 0.2), taper: o.hang !== undefined ? 0.35 : 0.8, mirror: r() < 0.5 });
  }
}

/** Trunk from the ground to `top`, with a root flare and buttresses. */
function trunk(c: Ctx, top: THREE.Vector3, r0: number, r1: number, o: { bend: number; flare: number; points: number }): THREE.Vector3[] {
  const { r } = c;
  const pts: THREE.Vector3[] = [];
  const rad: number[] = [];
  const bx = (r() - 0.5) * o.bend;
  const bz = (r() - 0.5) * o.bend;
  const n = o.points;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = Math.sin(t * Math.PI) * 0.6 + t * 0.4;
    pts.push(V(lerp(0, top.x, t) + bx * w, lerp(-0.012, top.y, t), lerp(0, top.z, t) + bz * w));
    // Root flare: the base spreads to ~2x over the first few percent of height.
    const flare = 1 + o.flare * Math.exp(-(t * top.y) / 0.035);
    rad.push(lerp(r0, r1, t) * flare);
  }
  c.b.tube(pts, rad, { seg: c.d.lod === 0 ? Math.max(c.seg, 6) : 4, c0: WOOD_ROOT, c1: WOOD, flex0: 0, flex1: 0.12, vScale: 16, uRep: 2, lobe: { amount: 0.28, k: 5, fade: 1.3 }, capTop: true });
  return pts;
}

function buildBroad(c: Ctx, birch: boolean): void {
  const { r, d } = c;
  const hi = d.lod === 0;
  const th = birch ? 0.44 + r() * 0.08 : 0.34 + r() * 0.08;
  const lean = birch ? 0.05 : 0.08;
  const top = V((r() - 0.5) * lean, th, (r() - 0.5) * lean);
  const pts = trunk(c, top, birch ? 0.026 : 0.05, birch ? 0.012 : 0.026, { bend: birch ? 0.05 : 0.04, flare: birch ? 0.7 : 1.1, points: hi ? 7 : 3 });
  const nl = hi ? (birch ? 6 : 5) : 3;
  const golden = 2.399963;
  const a0 = r() * 6.28;
  for (let i = 0; i < nl; i++) {
    const t = 0.55 + 0.45 * (i / nl);
    const at = pts[Math.min(pts.length - 1, Math.round(t * (pts.length - 1)))];
    const az = a0 + i * golden;
    const el = birch ? 0.38 + r() * 0.3 : 0.7 + r() * 0.5; // radians from vertical
    const dir = V(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
    const len = birch ? 0.2 + r() * 0.1 : 0.27 + r() * 0.1;
    limb(c, at, dir, len, birch ? 0.011 : 0.022, birch ? 0.005 : 0.007, { n: hi ? 4 : 3, curl: 0.35, up: birch ? 0.6 : 0.5, depth: 0, maxDepth: hi ? 2 : 0, subs: 2, subLen: 0.55, flex: 0.25 });
  }
  // The leader continues up into the crown.
  c.tips.push({ p: top.clone(), d: V(0, 1, 0), flex: 0.3 });
  const N = Math.round(c.sp.cards * d.scale * (hi ? 1 : 0.1));
  const size = c.sp.card * (hi ? 1 : 2.7);
  leafCards(c, { count: N, size, spread: birch ? 0.1 : 0.12 + (hi ? 0 : 0.03), outward: 0.35, fill: birch ? 0.3 : 0.4 });
}

function buildUmbrella(c: Ctx): void {
  const { r, d } = c;
  const hi = d.lod === 0;
  const th = 0.4 + r() * 0.06;
  const top = V((r() - 0.5) * 0.14, th, (r() - 0.5) * 0.14);
  const pts = trunk(c, top, 0.042, 0.024, { bend: 0.12, flare: 0.9, points: hi ? 6 : 4 });
  const nl = hi ? 5 : 3;
  const a0 = r() * 6.28;
  for (let i = 0; i < nl; i++) {
    const az = a0 + (i / nl) * 6.283 + (r() - 0.5) * 0.5;
    const el = 1.05 + r() * 0.3; // near-horizontal sweep
    const dir = V(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
    limb(c, pts[pts.length - 1], dir, 0.2 + r() * 0.06, 0.02, 0.006, { n: hi ? 4 : 3, curl: 0.25, up: 0.25, depth: 0, maxDepth: hi ? 2 : 0, subs: 2, subLen: 0.55, flex: 0.3 });
  }
  const N = Math.round(c.sp.cards * d.scale * (hi ? 1 : 0.1));
  leafCards(c, { count: N, size: c.sp.card * (hi ? 1 : 2.6), spread: 0.1, flat: 0.35, outward: 0.9, fill: 0.25 });
}

function buildWillow(c: Ctx): void {
  const { r, d } = c;
  const hi = d.lod === 0;
  const top = V((r() - 0.5) * 0.06, 0.3 + r() * 0.05, (r() - 0.5) * 0.06);
  const pts = trunk(c, top, 0.056, 0.032, { bend: 0.06, flare: 1.0, points: hi ? 5 : 3 });
  const nl = hi ? 6 : 3;
  const a0 = r() * 6.28;
  for (let i = 0; i < nl; i++) {
    const az = a0 + i * 2.4;
    const el = 0.6 + r() * 0.4;
    const dir = V(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
    limb(c, pts[pts.length - 1], dir, 0.3 + r() * 0.1, 0.022, 0.007, { n: hi ? 4 : 3, curl: 0.3, up: -0.1, depth: 0, maxDepth: hi ? 2 : 0, subs: 2, subLen: 0.5, flex: 0.3 });
  }
  // Weeping strands: long narrow cards hanging from every tip, plus a crown of small leaves.
  const N = Math.round(c.sp.cards * d.scale * (hi ? 1 : 0.11));
  leafCards(c, { count: N, size: c.sp.card * (hi ? 0.34 : 0.6), spread: 0.09, hang: 1 });
}

function buildConifer(c: Ctx): void {
  const { r, d, b, sp } = c;
  const hi = d.lod === 0;
  const cone = sp.cone!;
  const cell = cellUv(LEAF_CELLS.needle);
  const lc = col(...sp.leafCol);
  const topY = 0.97;
  // Straight leader with a slight lean.
  const pts: THREE.Vector3[] = [];
  const rad: number[] = [];
  const nPts = hi ? 8 : 4;
  const lx = (r() - 0.5) * 0.04;
  const lz = (r() - 0.5) * 0.04;
  for (let i = 0; i <= nPts; i++) {
    const t = i / nPts;
    pts.push(V(lx * t * t, lerp(-0.012, topY, t), lz * t * t));
    rad.push(lerp(0.042, 0.003, Math.pow(t, 0.85)) * (1 + 1.0 * Math.exp(-(t * topY) / 0.035)));
  }
  b.tube(pts, rad, { seg: hi ? 7 : 4, c0: WOOD_ROOT, c1: WOOD, flex0: 0, flex1: 0.3, vScale: 16, uRep: 2, lobe: { amount: 0.22, k: 5, fade: 1.2 }, capTop: true });
  const whorls = hi ? cone.whorls : Math.ceil(cone.whorls * 0.5);
  const golden = 2.399963;
  let az = r() * 6.28;
  const per = hi ? 4 : 4;
  for (let w = 0; w < whorls; w++) {
    const t = w / Math.max(1, whorls - 1);
    const y = lerp(cone.start, topY - 0.04, t);
    const L = cone.len * Math.pow(1 - t * 0.93, 0.9) * (0.85 + r() * 0.3);
    const rootAt = pts[Math.min(nPts, Math.round((y / topY) * nPts))];
    for (let k = 0; k < per; k++) {
      az += golden * (1 + 0.2 * r()) + (k / per) * 6.283 / per;
      // Branches leave nearly horizontal, sag, and the tips curl up.
      const dir = V(Math.cos(az), -cone.droop * 0.25 + 0.1 * r(), Math.sin(az)).normalize();
      const p0 = V(rootAt.x, y + (r() - 0.5) * 0.02, rootAt.z);
      const bp: THREE.Vector3[] = [p0];
      const br: number[] = [0.008 * (1 - t * 0.6) + 0.003];
      const m = hi ? 3 : 2;
      const p = p0.clone();
      const dd = dir.clone();
      for (let i = 1; i <= m; i++) {
        dd.y += (i / m) * (i === m ? 0.35 : -cone.droop * 0.15);
        dd.normalize();
        p.addScaledVector(dd, L / m);
        bp.push(p.clone());
        br.push(br[0] * (1 - i / m) + 0.0012);
      }
      // The mesh LOD hides its branches inside the needle sprays: tubes only up close.
      if (hi) b.tube(bp, br, { seg: 3, c0: WOOD_ROOT.clone().lerp(WOOD, 0.5), c1: WOOD, flex0: 0.2 + t * 0.2, flex1: 0.6 + t * 0.3, vScale: 10, uRep: 1 });
      // Needle sprays along the branch: each spans from its anchor to the tip,
      // a flat one (in the branch's own plane) and a vertical one crossed with it.
      const pairs = hi ? 2 : 1;
      for (let i = 0; i < pairs; i++) {
        const f = (i / pairs) * 0.62 + r() * 0.06;
        const at = p0.clone().lerp(p, f);
        const up = p.clone().sub(p0).normalize();
        up.y += 0.12;
        up.normalize();
        const flat = V(-up.z, 0, up.x).normalize();
        const vert = new THREE.Vector3().crossVectors(up, flat).normalize();
        const h = L * (1 - f) * 1.05;
        const sw = h * 0.85;
        const outer = clamp01(0.45 + 0.5 * f - 0.3 * t);
        const k = 0.45 + 0.5 * outer + (r() - 0.5) * 0.12;
        const nrm = V(Math.cos(az) * 0.5, 0.7, Math.sin(az) * 0.5).normalize();
        const hue = (r() - 0.5) * 0.12;
        const c0 = col(lc.r * k * 0.8 * (1 + hue), lc.g * k * 0.8, lc.b * k * 0.8 * (1 - hue));
        const c1 = col(lc.r * k * 1.05 * (1 + hue), lc.g * k * 1.05, lc.b * k * 1.0 * (1 - hue));
        const o = { uv: cell, w: sw, h, normal: nrm, c0, c1, flex0: 0.5 + t * 0.3, flex1: 0.9, taper: 0.55 };
        b.cardQuad(at, up, flat, { ...o, phase: r() * 6.283, mirror: r() < 0.5 });
        b.cardQuad(at, up, vert, { ...o, phase: r() * 6.283, mirror: r() < 0.5 });
      }
    }
  }
  // Leader tuft.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * 6.283 + r();
    const up = V(Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25).normalize();
    b.cardQuad(pts[nPts].clone().addScaledVector(V(0, -1, 0), 0.07), up, perp(up, r), { uv: cell, w: 0.1, h: 0.17, normal: V(0, 1, 0), c0: col(lc.r * 0.7, lc.g * 0.7, lc.b * 0.7), c1: col(lc.r, lc.g, lc.b), phase: r() * 6.283, flex0: 0.8, flex1: 1, taper: 0.3 });
  }
}

function buildDead(c: Ctx): void {
  const { r, d } = c;
  const hi = d.lod === 0;
  const top = V((r() - 0.5) * 0.1, 0.62 + r() * 0.15, (r() - 0.5) * 0.1);
  const pts = trunk(c, top, 0.045, 0.014, { bend: 0.1, flare: 0.8, points: hi ? 7 : 4 });
  const nl = hi ? 6 : 3;
  const a0 = r() * 6.28;
  for (let i = 0; i < nl; i++) {
    const t = 0.35 + 0.65 * ((i + r() * 0.5) / nl);
    const at = pts[Math.min(pts.length - 1, Math.round(t * (pts.length - 1)))];
    const az = a0 + i * 2.2;
    const el = 0.8 + r() * 0.7;
    const dir = V(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
    // Dead limbs are bare: nothing to hang leaves on, and they end blunt (broken).
    limb(c, at, dir, 0.16 + r() * 0.2, 0.014, 0.004, { n: hi ? 5 : 3, curl: 0.3, up: 0.12, depth: 0, maxDepth: hi ? 2 : 0, subs: 2, subLen: 0.5, flex: 0.2 });
  }
  c.tips.length = 0;
}

const cache = new Map<string, THREE.BufferGeometry>();

/** A species' tree geometry (cached by species, variant, LOD and card scale). Variants grow from different seeds. */
export function richTree(species: number, variant: number, d: TreeDetail): THREE.BufferGeometry {
  const key = `${species}:${variant}:${d.lod}:${d.scale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sp = TREE_SPECIES[species];
  const r = rng(0x7a3e + species * 7919 + variant * 104729 + 13);
  const b = new MeshBuilder();
  // Crown shape by habit: where the leaf mass sits, for shading and the soft normal.
  const crowns: Record<Habit, [number, number, number, number, number]> = {
    broad: [0, 0.62, 0, 0.42, 0.34],
    birch: [0, 0.64, 0, 0.3, 0.25],
    conifer: [0, 0.52, 0, 0.3, 0.5],
    dead: [0, 0.6, 0, 0.3, 0.3],
    umbrella: [0, 0.72, 0, 0.34, 0.2],
    willow: [0, 0.52, 0, 0.46, 0.34],
  };
  const cw = crowns[sp.habit];
  const c: Ctx = { b, r, sp, d, tips: [], seg: d.lod === 0 ? 7 : 5, cc: V(cw[0], cw[1], cw[2]), cr: V(cw[3], cw[4], cw[3]) };
  if (sp.habit === 'broad') buildBroad(c, false);
  else if (sp.habit === 'birch') buildBroad(c, true);
  else if (sp.habit === 'umbrella') buildUmbrella(c);
  else if (sp.habit === 'willow') buildWillow(c);
  else if (sp.habit === 'conifer') buildConifer(c);
  else buildDead(c);
  const g = b.build();
  cache.set(key, g);
  return g;
}

export function disposeTreeCache(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
