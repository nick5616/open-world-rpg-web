// Rich ground cover (playtest 3, CR 045): shrubs, scrub and heather made of
// leaf cards on twigs, ferns and reeds, grass blade clumps with bent, tapered
// blades (and flower heads on some), flower clumps, and rocks (fractured,
// stratified, faceted). Same attribute set and units as the legacy
// archetypes (see meshBuilder.ts): the scatter manager's per-kind scales and
// instance tints carry over.

import * as THREE from 'three';
import { MeshBuilder, clamp01, lerp, perp, randDir, rng, type Rng } from './meshBuilder';
import { LEAF_CELLS, cellUv, SOLID_UV, type LeafCell } from './natureTextures';
import { WOOD, WOOD_ROOT, V, col, leafCards, limb, type Ctx, type TreeSpecies } from './treeGen';

// ---------------------------------------------------------------- bushes

export type BushType = 'shrub' | 'scrub' | 'heather' | 'fern' | 'reeds';
export const BUSH_TYPES: BushType[] = ['shrub', 'scrub', 'heather', 'fern', 'reeds'];

/** A curved ribbon through `nodes` (width per node), double-sided, stem at the first node. */
function strip(b: MeshBuilder, nodes: THREE.Vector3[], widths: number[], side: THREE.Vector3, uv: [number, number, number, number], normal: THREE.Vector3, c0: THREE.Color, c1: THREE.Color, phase: number, flex0: number, flex1: number, fol = 1): void {
  const n = nodes.length;
  const base = b.vertexCount;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    c.lerpColors(c0, c1, f);
    const v = lerp(uv[1], uv[3], f);
    const fl = lerp(flex0, flex1, f);
    for (const s of [-1, 1]) b.vertex(nodes[i].clone().addScaledVector(side, s * widths[i] * 0.5), normal, c, s < 0 ? uv[0] : uv[2], v, 0, 0, fol, phase, fl);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    b.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
}

function fakeSpecies(leaf: LeafCell, leafCol: [number, number, number], card: number): TreeSpecies {
  return { name: leaf, habit: 'broad', bark: 'oak', leaf, card, cards: 0, leafCol };
}

function bushCtx(b: MeshBuilder, r: Rng, leaf: LeafCell, leafCol: [number, number, number], card: number, lod: 0 | 1, scale: number, cc: THREE.Vector3, cr: THREE.Vector3): Ctx {
  return { b, r, sp: fakeSpecies(leaf, leafCol, card), d: { lod, scale }, tips: [], seg: lod === 0 ? 4 : 3, cc, cr };
}

const bushCache = new Map<string, THREE.BufferGeometry>();

/** Bush-sized scatter objects: ~0.75 units tall, ~1 wide, origin at the base. */
export function richBush(type: BushType, lod: 0 | 1, scale: number): THREE.BufferGeometry {
  const key = `${type}:${lod}:${scale}`;
  const hit = bushCache.get(key);
  if (hit) return hit;
  const r = rng(0xb05 + BUSH_TYPES.indexOf(type) * 31);
  const b = new MeshBuilder();
  const hi = lod === 0;
  if (type === 'shrub' || type === 'heather' || type === 'scrub') {
    const heather = type === 'heather';
    const scrub = type === 'scrub';
    const cell: LeafCell = scrub ? 'scrub' : heather ? 'small' : 'broad';
    const cc = V(0, heather ? 0.22 : 0.38, 0);
    const cr = V(0.5, heather ? 0.2 : 0.36, 0.5);
    const c = bushCtx(b, r, cell, scrub ? [0.8, 0.82, 0.55] : [0.78, 0.88, 0.58], scrub ? 0.5 : heather ? 0.16 : 0.26, lod, scale, cc, cr);
    const stems = hi ? 5 : 3;
    for (let i = 0; i < stems; i++) {
      const az = (i / stems) * 6.283 + r();
      const el = heather ? 1.15 + r() * 0.3 : 0.5 + r() * 0.5;
      const dir = V(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az));
      const base = V((r() - 0.5) * 0.06, -0.01, (r() - 0.5) * 0.06);
      limb(c, base, dir, (heather ? 0.3 : 0.45) + r() * 0.15, 0.014, 0.004, { n: hi ? 4 : 3, curl: 0.3, up: scrub ? 0.1 : 0.3, depth: 0, maxDepth: 0, subs: 1, subLen: 0.55, flex: 0.35 });
    }
    const N = Math.round((scrub ? 26 : heather ? 90 : 80) * scale * (hi ? 1 : 0.25));
    leafCards(c, { count: N, size: (scrub ? 0.52 : heather ? 0.17 : 0.27) * (hi ? 1 : 1.7), spread: 0.14, outward: 0.7, flat: heather ? 0.6 : 1 });
  } else if (type === 'fern') {
    const cell = cellUv(LEAF_CELLS.frond);
    const lc = col(0.62, 0.82, 0.5);
    const fronds = hi ? Math.round(10 * Math.max(scale, 0.7)) : 6;
    for (let i = 0; i < fronds; i++) {
      const az = (i / fronds) * 6.283 + r() * 0.4;
      const len = 0.62 + r() * 0.3;
      const rise = 0.55 + r() * 0.5;
      const dir = V(Math.cos(az), 0, Math.sin(az));
      const nodes: THREE.Vector3[] = [];
      const widths: number[] = [];
      const m = hi ? 4 : 3;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        // Rise, then arch over: a parabola in the frond's vertical plane.
        nodes.push(V(dir.x * t * len * 0.8, rise * (t * 1.3 - t * t * 1.15) * 0.8, dir.z * t * len * 0.8));
        widths.push(len * 0.42 * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1))));
      }
      const side = V(-dir.z, 0, dir.x);
      const k = 0.6 + r() * 0.5;
      strip(b, nodes, widths, side, cell, V(dir.x * 0.3, 0.9, dir.z * 0.3).normalize(), col(lc.r * k * 0.55, lc.g * k * 0.55, lc.b * k * 0.55), col(lc.r * k * 1.05, lc.g * k * 1.05, lc.b * k), r() * 6.28, 0.2, 0.95);
    }
  } else {
    // Reeds: tall seed-head stalks (cards) among long narrow blades.
    const cell = cellUv(LEAF_CELLS.seed);
    const n = hi ? 12 : 6;
    for (let i = 0; i < n; i++) {
      const a = r() * 6.283;
      const d = Math.sqrt(r()) * 0.3;
      const h = 0.75 + r() * 0.4;
      const lean = V((r() - 0.5) * 0.25, 1, (r() - 0.5) * 0.25).normalize();
      const k = 0.65 + r() * 0.4;
      const o = V(Math.cos(a) * d, -0.01, Math.sin(a) * d);
      const sd = perp(lean, r);
      b.cardQuad(o, lean, sd, { uv: cell, w: h * 0.5, h, normal: V(0, 1, 0), c0: col(0.55 * k, 0.65 * k, 0.4 * k), c1: col(1.0 * k, 1.0 * k, 0.9 * k), phase: r() * 6.28, flex0: 0.1, flex1: 0.9, taper: 0.9, mirror: r() < 0.5 });
      b.cardQuad(o, lean, new THREE.Vector3().crossVectors(lean, sd).normalize(), { uv: cell, w: h * 0.5, h, normal: V(0, 1, 0), c0: col(0.55 * k, 0.65 * k, 0.4 * k), c1: col(1.0 * k, 1.0 * k, 0.9 * k), phase: r() * 6.28, flex0: 0.1, flex1: 0.9, taper: 0.9, mirror: r() < 0.5 });
    }
  }
  const g = b.build();
  bushCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------- grass

const GRASS_ROOT = new THREE.Color(0.05, 0.075, 0.025);
const GRASS_MID = new THREE.Color(0.2, 0.3, 0.08);
const GRASS_TIP_A = new THREE.Color(0.46, 0.6, 0.18);
const GRASS_TIP_B = new THREE.Color(0.6, 0.58, 0.22);

/**
 * Blades for a clump: each is a curved, tapering ribbon (bottom to tip in 3
 * bends) with a darker root and a lighter, hue-varied tip. `heads` adds
 * flower-head cards on a few stalks (aFoliage 2: the grass shader shows them
 * on a hashed subset of clumps and picks the colour).
 */
function blades(b: MeshBuilder, r: Rng, count: number, spread: number, o: { hMin: number; hMax: number; wBase: number; bend: number; heads?: number; headSize?: number; stiff?: number }): void {
  const tips: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * spread;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = o.hMin + r() * (o.hMax - o.hMin);
    const w = o.wBase * (0.8 + 0.5 * r());
    const yaw = r() * Math.PI;
    const side = V(Math.cos(yaw), 0, Math.sin(yaw));
    // Lean mostly away from the clump centre, curving over toward the tip.
    const la = a + (r() - 0.5) * 1.2;
    const lean = (0.12 + r() * 0.32) * o.bend;
    const lx = Math.cos(la) * lean;
    const lz = Math.sin(la) * lean;
    const nodes: THREE.Vector3[] = [];
    const widths: number[] = [];
    const m = 3;
    for (let k = 0; k <= m; k++) {
      const t = k / m;
      const curve = t * t * (1.0 + (1 - (o.stiff ?? 0)));
      nodes.push(V(x + lx * curve, h * t * (1 - 0.1 * curve), z + lz * curve));
      widths.push(k === m ? 0 : w * (1 - t * 0.72));
    }
    tips.push(nodes[m]);
    // Last node is the point of the blade: collapse the ribbon there.
    const tip = lerp(0, 1, r());
    const tipCol = GRASS_TIP_A.clone().lerp(GRASS_TIP_B, tip * tip);
    const k = 0.78 + r() * 0.4;
    const n = V(lx * 1.5, 1, lz * 1.5).normalize();
    const base = b.vertexCount;
    const c = new THREE.Color();
    for (let j = 0; j <= m; j++) {
      const t = j / m;
      if (t < 0.5) c.lerpColors(GRASS_ROOT, GRASS_MID, t * 2);
      else c.lerpColors(GRASS_MID, tipCol, (t - 0.5) * 2);
      c.multiplyScalar(k);
      const fl = t;
      if (j === m) b.vertex(nodes[j], n, c, SOLID_UV[0], SOLID_UV[1], 0, 0, 1, r() * 6.28, fl);
      else for (const s of [-1, 1]) b.vertex(nodes[j].clone().addScaledVector(side, s * widths[j] * 0.5), n, c, SOLID_UV[0], SOLID_UV[1], 0, 0, 1, 0, fl);
    }
    for (let j = 0; j < m - 1; j++) {
      const p = base + j * 2;
      b.idx.push(p, p + 1, p + 3, p, p + 3, p + 2);
    }
    const last = base + (m - 1) * 2;
    b.idx.push(last, last + 1, base + m * 2);
  }
  // Flower heads sit on the tips of the last (tallest) blades: the blade is the stalk.
  const heads = o.heads ?? 0;
  const cell = cellUv(LEAF_CELLS.flower);
  for (let i = 0; i < heads && i < tips.length; i++) {
    const at = tips[tips.length - 1 - i].clone().add(V(0, -0.015, 0));
    const a = r() * Math.PI * 2;
    const sd = V(Math.cos(a), 0, Math.sin(a));
    const q = (side: THREE.Vector3) => b.cardQuad(at, V(0, 1, 0), side, { uv: cell, w: 0.075 * (o.headSize ?? 1), h: 0.1 * (o.headSize ?? 1), normal: V(0, 1, 0), c0: col(0.9, 0.9, 0.9), c1: col(1, 1, 1), phase: r() * 6.28, flex0: 0.9, flex1: 1, taper: 0.8, foliage: 2 });
    q(sd);
    q(V(-sd.z, 0, sd.x));
  }
}

const grassCache = new Map<string, THREE.BufferGeometry>();
/** Dense-meadow clump (dense grass layer): ~1 unit tall, flower heads on some stalks. */
export function richGrassClump(blade: number, withHeads: boolean): THREE.BufferGeometry {
  const key = `g:${blade}:${withHeads}`;
  const hit = grassCache.get(key);
  if (hit) return hit;
  const b = new MeshBuilder();
  blades(b, rng(0x6a55 + blade), blade, 0.13, { hMin: 0.55, hMax: 1.0, wBase: 0.036, bend: 1, heads: withHeads ? 2 : 0 });
  const g = b.build();
  grassCache.set(key, g);
  return g;
}

/** Scatter tuft kinds: 0 tuft, 1 tall, 3 dry, 4 snow, 5 marsh: a clump of blades; 2 flowers: blades and many heads. */
export function richTuft(flowers: boolean): THREE.BufferGeometry {
  const key = `t:${flowers}`;
  const hit = grassCache.get(key);
  if (hit) return hit;
  const b = new MeshBuilder();
  const r = rng(flowers ? 0xf10e : 0x7f7);
  blades(b, r, flowers ? 8 : 11, 0.16, { hMin: 0.5, hMax: 1.0, wBase: 0.036, bend: 1, heads: flowers ? 8 : 0, headSize: 1.8 });
  if (flowers) {
    // Heads (aFoliage 2 in the shared blade builder) take the instance tint; blades keep their green.
    const f = b.fol;
    for (let i = 0; i < f.length; i++) f[i] = f[i] > 1.5 ? 1 : 0;
  }
  const g = b.build();
  grassCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------- rocks

export type RockShape = 'boulder' | 'slab' | 'spire';

function hash3(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x85ebca6b) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function noise3(x: number, y: number, z: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const st = (t: number) => t * t * (3 - 2 * t);
  const u = st(fx);
  const v = st(fy);
  const w = st(fz);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const h = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, s);
  return L(L(L(h(0, 0, 0), h(1, 0, 0), u), L(h(0, 1, 0), h(1, 1, 0), u), v), L(L(h(0, 0, 1), h(1, 0, 1), u), L(h(0, 1, 1), h(1, 1, 1), u), v), w);
}
const fbm3 = (x: number, y: number, z: number, s: number) => noise3(x, y, z, s) * 0.55 + noise3(x * 2.1, y * 2.1, z * 2.1, s + 7) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3, s + 13) * 0.15;

const rockCache = new Map<string, THREE.BufferGeometry>();

/**
 * A fractured rock: a sphere cut by random planes (hard facets and edges),
 * noise-lumped, with horizontal strata ledges and baked band colours.
 * Faceted (per-face normals); `detail` 3 near, 1 for the far LOD.
 */
export function richRock(shape: RockShape, seed: number, detail: 1 | 3): THREE.BufferGeometry {
  const key = `${shape}:${seed}:${detail}`;
  const hit = rockCache.get(key);
  if (hit) return hit;
  const r = rng(0x70c4 + seed * 977 + (shape === 'slab' ? 31 : shape === 'spire' ? 63 : 0));
  const ico = new THREE.IcosahedronGeometry(1, detail);
  const pos = ico.getAttribute('position') as THREE.BufferAttribute;
  const planes: { n: THREE.Vector3; o: number }[] = [];
  const np = shape === 'spire' ? 9 : shape === 'slab' ? 8 : 10;
  for (let i = 0; i < np; i++) {
    const n = randDir(r);
    if (shape === 'slab') n.y *= 2.4;
    if (shape === 'spire') n.y *= 0.5;
    n.normalize();
    planes.push({ n, o: 0.62 + r() * 0.3 });
  }
  const ph = [r() * 20, r() * 20, r() * 20];
  const colorOf = (y: number, up: number, ao: number, band: number) => {
    // Sedimentary bands: warm and cool greys alternate with height.
    const t = 0.5 + 0.5 * Math.sin(y * 17 + band * 3);
    const warm = new THREE.Color(0.52, 0.48, 0.42);
    const cool = new THREE.Color(0.42, 0.42, 0.42);
    const c = cool.lerp(warm, t);
    const k = ao * (0.82 + 0.3 * up);
    return c.multiplyScalar(k);
  };
  const v = new THREE.Vector3();
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let R = 1.15;
    for (const p of planes) {
      const dn = v.dot(p.n);
      if (dn > 1e-3) {
        const lim = p.o / dn;
        // Smooth minimum: crisp-ish edges that are not razor sharp.
        const k = 0.07;
        const h = Math.max(k - Math.abs(R - lim), 0) / k;
        R = Math.min(R, lim) - h * h * k * 0.25;
      }
    }
    const nz = fbm3(v.x * 1.6 + ph[0], v.y * 1.6 + ph[1], v.z * 1.6 + ph[2], seed);
    R *= 0.9 + 0.2 * nz;
    const p = v.clone().multiplyScalar(R * 0.5);
    // Shape: boulders are squashed, slabs wide and flat, spires taller and narrowing.
    if (shape === 'boulder') p.y *= 0.72;
    else if (shape === 'slab') {
      p.x *= 1.25;
      p.z *= 1.25;
      p.y *= 0.5;
    } else {
      const t = clamp01((p.y + 0.5) / 1.0);
      p.x *= lerp(0.75, 0.38, t);
      p.z *= lerp(0.75, 0.38, t);
      p.y *= 0.7;
    }
    // Strata ledges: gentle terraces on the near LOD only.
    if (detail === 3) p.multiplyScalar(1 + 0.03 * (((p.y * 9 + nz * 2) % 1) - 0.5));
    verts.push(p.clone());
  }
  // Sit every shape on the ground: lowest point just below y = 0 (instances are sunk a little more).
  const minY = Math.min(...verts.map((q) => q.y));
  for (const q of verts) q.y += -0.13 - minY;
  const idx = ico.getIndex();
  const b = new MeshBuilder();
  const n = idx ? idx.count : pos.count;
  const centre = V(0, (Math.max(...verts.map((q) => q.y)) - 0.13) / 2, 0);
  for (let i = 0; i < n; i += 3) {
    const a = verts[idx ? idx.getX(i) : i];
    const bb = verts[idx ? idx.getX(i + 1) : i + 1];
    const c = verts[idx ? idx.getX(i + 2) : i + 2];
    const nn = new THREE.Vector3().subVectors(bb, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (nn.dot(new THREE.Vector3().addVectors(a, bb).add(c).divideScalar(3).sub(centre)) < 0) nn.negate();
    const mid = new THREE.Vector3().addVectors(a, bb).add(c).divideScalar(3);
    const up = clamp01(nn.y * 0.5 + 0.5);
    const ao = clamp01(0.55 + (mid.y + 0.1) * 1.1);
    const band = hash3(Math.floor(mid.y * 9), seed, 5, 3);
    const cc = colorOf(mid.y, up, ao, band);
    // Planar bark UVs are unused: rocks sample the stone texture in object space.
    const tri = [a, bb, c];
    const flip = new THREE.Vector3().subVectors(bb, a).cross(new THREE.Vector3().subVectors(c, a)).dot(nn) < 0;
    const [p0, p1, p2] = flip ? [a, c, bb] : tri;
    b.tri(p0, p1, p2, nn, cc, cc, cc, 1, [
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  }
  void WOOD;
  void WOOD_ROOT;
  const g = b.build();
  rockCache.set(key, g);
  return g;
}

export function disposeGroundcoverCache(): void {
  for (const m of [bushCache, grassCache, rockCache]) {
    for (const g of m.values()) g.dispose();
    m.clear();
  }
}
