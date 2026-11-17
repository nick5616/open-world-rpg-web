// Settlement dressing (playtest 3 "towns art"): the clutter that makes a village look lived in, drawn on top
// of worldgen's layout without changing it. Pure decoration: none of it has collision (the zone knows
// nothing about it, like porch posts and chimneys), so every item is placed
//
//   - hard against a side or back wall, never in front of a door (flowerpots stand beside the doorstep),
//   - outside every collision box of the settlement (floors, walls, fences, furniture, props, ramps) and
//     outside every street, footpath and road ribbon, with a margin,
//   - out of the square,
//   - on ground that is nearly level,
//
// and deterministically from the building index, so a settlement always dresses the same way.
//
// `Yard` is the obstacle query (built once per settlement). `dressBuilding` puts yard clutter into the shell
// mesh; `drawInterior` adds the room finish (skirting, wainscot, ceiling beams, hanging herbs, an inn's
// candle wheel) into the interior mesh, which is only drawn within 80 m.

import { BUILDING_FLAG, type Building, type Settlement, type Towns } from '@lodestone/worldgen';
import { detail } from './detail';
import { MeshBuilder, at, dirOf, local, moved, turned, type Frame, type V3 } from './meshBuilder';
import { flame, P } from './props';

const BK_BLOCK = new Set([0, 1, 5, 6, 7, 8, 4, 9, 12, 13]); // floor wall furniture fence townWall gate ramp deck townProp railing
const ROLE_INN = 1;
const ROLE_FORGE = 2;
const ROLE_STORE = 7;
const ROLE_FARM = 5;
const ROLE_WORK = 6;
const STYLE_STILT = 3;

const hash = (a: number, b: number) => {
  let h = Math.imul((a * 73856093) ^ (b * 19349663), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

interface ObbLite {
  cx: number;
  cz: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
}

/** What a dressing item must stay clear of, for one settlement. */
export class Yard {
  private readonly boxes: ObbLite[] = [];
  private readonly segs: { ax: number; az: number; bx: number; bz: number; hw: number }[] = [];
  private readonly placed: { x: number; z: number; r: number }[] = [];

  constructor(
    private readonly t: Towns,
    private readonly s: Settlement,
  ) {
    const f = t.boxes.f;
    for (let i = s.boxFirst; i < s.boxFirst + s.boxCount; i++) {
      if (!BK_BLOCK.has(t.boxes.kind[i])) continue;
      const o = i * 9;
      this.boxes.push({ cx: f[o], cz: f[o + 1], c: f[o + 2], s: f[o + 3], hx: f[o + 4], hz: f[o + 5] });
    }
    // Roads, streets and footpaths that pass within the settlement (plus the margin items need).
    const R = s.radius + 25;
    for (const road of t.roads) {
      const p = road.points;
      for (let k = 0; k + 3 < p.length; k += 3) {
        const ax = p[k];
        const az = p[k + 2];
        const bx = p[k + 3];
        const bz = p[k + 5];
        if (Math.hypot(ax - s.x, az - s.z) > R && Math.hypot(bx - s.x, bz - s.z) > R) continue;
        this.segs.push({ ax, az, bx, bz, hw: road.width * 0.5 });
      }
    }
  }

  /** Is the disc (x, z, r) clear of boxes, roads, the square and earlier items? */
  free(x: number, z: number, r: number, margin = 0.15): boolean {
    const m = r + margin;
    for (const b of this.boxes) {
      const dx = x - b.cx;
      const dz = z - b.cz;
      const u = dx * b.c + dz * b.s;
      const v = dz * b.c - dx * b.s;
      if (u > -b.hx - m && u < b.hx + m && v > -b.hz - m && v < b.hz + m) return false;
    }
    for (const g of this.segs) {
      const ex = g.bx - g.ax;
      const ez = g.bz - g.az;
      const L2 = ex * ex + ez * ez || 1;
      const k = Math.max(0, Math.min(1, ((x - g.ax) * ex + (z - g.az) * ez) / L2));
      if (Math.hypot(x - (g.ax + ex * k), z - (g.az + ez * k)) < g.hw + m + 0.3) return false;
    }
    if (Math.hypot(x - this.s.x, z - this.s.z) < 13) return false;
    for (const p of this.placed) if (Math.hypot(x - p.x, z - p.z) < p.r + r + 0.1) return false;
    return true;
  }

  claim(x: number, z: number, r: number): void {
    this.placed.push({ x, z, r });
  }
}

const WOOD: V3[] = [
  [0.85, 0.66, 0.46],
  [0.7, 0.55, 0.4],
  [0.95, 0.78, 0.55],
];
const CLOTHS: V3[] = [
  [0.95, 0.95, 0.9],
  [0.55, 0.65, 0.85],
  [0.85, 0.45, 0.4],
  [0.9, 0.82, 0.55],
  [0.6, 0.78, 0.55],
];

type Ground = (x: number, z: number) => number;

/** Sits on the ground at (x, z) with a frame turned so local +v points away from its wall. */
interface Spot {
  f: Frame;
  y: number;
  x: number;
  z: number;
}

function barrel(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, h = 0.9, r = 0.3, water = false): void {
  P(mb, 'wood', WOOD[Math.floor(hash(u * 7 + 3, v * 5 + 1) * 3) % 3]);
  mb.cyl(f, u, v, y, y + h * 0.5, r * 0.88, 8, { r1: r, top: false });
  mb.cyl(f, u, v, y + h * 0.5, y + h, r, 8, { r1: r * 0.88, top: false });
  P(mb, 'metal');
  for (const k of [0.14, 0.34, 0.66, 0.86]) {
    const rr = r * (k < 0.5 ? 0.88 + (k / 0.5) * 0.12 : 1 - ((k - 0.5) / 0.5) * 0.12) + 0.012;
    mb.cyl(f, u, v, y + h * k - 0.03, y + h * k + 0.03, rr, 8, { top: false });
  }
  if (water) {
    P(mb, 'water');
    mb.cyl(f, u, v, y + h - 0.05, y + h - 0.04, r * 0.84, 8);
  } else {
    P(mb, 'planks', [0.8, 0.65, 0.5]);
    mb.cyl(f, u, v, y + h - 0.02, y + h, r * 0.88, 8);
  }
}

function crate(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, s = 0.4, turn = 0): void {
  const g = turned(moved(f, u, v), turn);
  P(mb, 'planks', WOOD[Math.floor(hash(u * 3 + 7, v * 9 + 2) * 3) % 3]);
  mb.box(g, -s, s, y, y + 2 * s * 0.9, -s, s);
  P(mb, 'wood', [0.6, 0.48, 0.36]);
  const t = 0.04;
  for (const su of [-1, 1]) for (const sv of [-1, 1]) mb.box(g, su * s - t - (su > 0 ? 0 : -t), su * s + t + (su > 0 ? 0 : -t), y, y + 2 * s * 0.9, sv * s - t - (sv > 0 ? 0 : -t), sv * s + t + (sv > 0 ? 0 : -t), { top: false });
  mb.box(g, -s - 0.01, s + 0.01, y + s * 0.8, y + s * 0.9 + 0.1, -s - 0.01, s + 0.01, { bottom: true });
}

function sack(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, tint: V3): void {
  P(mb, 'cloth', tint);
  mb.cyl(f, u, v, y, y + 0.24, 0.2, 6, { r1: 0.24, top: false });
  mb.cyl(f, u, v, y + 0.24, y + 0.46, 0.24, 6, { r1: 0.12 });
  P(mb, 'wood', [0.55, 0.45, 0.35]);
  mb.cyl(f, u, v, y + 0.45, y + 0.52, 0.06, 5, { r1: 0.1 });
}

function woodpile(mb: MeshBuilder, f: Frame, y: number): void {
  // Logs lie along local v (the pile's depth); rows of 4, 3, 2 stacked between two stakes.
  const g = turned(f, Math.PI / 2);
  const r = 0.1;
  for (let row = 0; row < 3; row++) {
    const n = 4 - row;
    for (let i = 0; i < n; i++) {
      P(mb, 'logs', [0.75 + 0.2 * hash(row * 9 + i, 4), 0.65, 0.5]);
      mb.hcyl(g, -0.3, 0.3, y + r + row * 0.19, -(n - 1) * r + i * 2 * r * 1.02, r, 5);
    }
  }
  P(mb, 'wood', [0.5, 0.4, 0.3]);
  for (const sv of [-0.46, 0.46]) mb.box(f, sv - 0.03, sv + 0.03, y, y + 0.7, -0.33, -0.27, { top: true });
  for (const sv of [-0.46, 0.46]) mb.box(f, sv - 0.03, sv + 0.03, y, y + 0.7, 0.27, 0.33, { top: true });
}

function hay(mb: MeshBuilder, f: Frame, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const u = (i - (n - 1) / 2) * 0.95;
    const up = i === 1 && n === 3;
    P(mb, 'thatch', [1.15, 1.05, 0.8]);
    const g = turned(moved(f, u, 0), (hash(i, 8) - 0.5) * 0.3);
    const yy = up ? y + 0.46 : y;
    mb.box(g, -0.42, 0.42, yy, yy + 0.46, -0.24, 0.24);
    P(mb, 'wood', [0.45, 0.36, 0.26]);
    for (const uu of [-0.2, 0.2]) mb.box(g, uu - 0.015, uu + 0.015, yy, yy + 0.47, -0.245, 0.245, { top: true });
  }
}

function cart(mb: MeshBuilder, f: Frame, y: number, load: number): void {
  // Long axis along local u; axle along v. The bed rests on its stand at the -u end.
  P(mb, 'planks', [0.85, 0.7, 0.52]);
  mb.box(f, -0.9, 0.9, y + 0.5, y + 0.58, -0.5, 0.5, { bottom: true });
  P(mb, 'wood', [0.62, 0.48, 0.36]);
  for (const sv of [-0.5, 0.5]) mb.box(f, -0.9, 0.9, y + 0.58, y + 0.88, sv - 0.03, sv + 0.03);
  mb.box(f, -0.93, -0.87, y + 0.58, y + 0.88, -0.5, 0.5);
  mb.box(f, 0.87, 0.93, y + 0.58, y + 0.88, -0.5, 0.5);
  mb.box(f, -0.9, 0.9, y + 0.46, y + 0.5, -0.4, 0.4, { top: false });
  for (const sv of [-1, 1]) {
    // Wheel: rim, hub and four spokes in the wheel's plane.
    const w = moved(f, 0.1, sv * 0.58);
    const wy = y + 0.42;
    P(mb, 'wood', [0.5, 0.4, 0.3]);
    mb.hcyl(turned(w, Math.PI / 2), -0.04, 0.04, wy, 0, 0.42, 10);
    P(mb, 'metal');
    mb.hcyl(turned(w, Math.PI / 2), -0.05, 0.05, wy, 0, 0.44, 10, false);
    P(mb, 'wood', [0.4, 0.3, 0.22]);
    mb.box(w, -0.4, 0.4, wy - 0.035, wy + 0.035, sv * 0.0 - 0.04, 0.04);
    mb.box(w, -0.035, 0.035, wy - 0.4, wy + 0.4, sv * 0.0 - 0.04, 0.04);
    mb.cyl(w, 0, 0, wy - 0.07, wy + 0.07, 0.09, 6);
  }
  // Stand and shafts' stub.
  P(mb, 'wood', [0.5, 0.4, 0.3]);
  mb.box(f, -1.1, -0.9, y + 0.4, y + 0.46, -0.35, -0.29, { bottom: true });
  mb.box(f, -1.1, -0.9, y + 0.4, y + 0.46, 0.29, 0.35, { bottom: true });
  mb.box(f, -1.05, -1.0, y, y + 0.4, -0.35, -0.29);
  mb.box(f, -1.05, -1.0, y, y + 0.4, 0.29, 0.35);
  if (load === 0) hay(mb, moved(f, 0, 0), y + 0.58, 2);
  else if (load === 1) {
    for (let i = 0; i < 3; i++) sack(mb, f, -0.5 + i * 0.5, ((i & 1) - 0.5) * 0.35, y + 0.58, CLOTHS[(i + 3) % 5]);
  } else {
    crate(mb, f, -0.4, 0, y + 0.58, 0.28);
    crate(mb, f, 0.25, 0.05, y + 0.58, 0.24, 0.3);
  }
}

function washLine(mb: MeshBuilder, f: Frame, y: number, seed: number): void {
  // Two posts 3 m apart (along local u), a sagging line and a few hung cloths.
  const L = 1.6;
  P(mb, 'wood', [0.55, 0.45, 0.35]);
  for (const su of [-1, 1]) mb.cyl(f, su * L, 0, y - 0.1, y + 2.1, 0.05, 5);
  P(mb, 'plain', [0.8, 0.76, 0.66]);
  const segs = 8;
  const hy = (k: number) => y + 2.0 - 0.18 * Math.sin((k / segs) * Math.PI);
  for (let k = 0; k < segs; k++) {
    const a = -L + (k * 2 * L) / segs;
    const b = -L + ((k + 1) * 2 * L) / segs;
    mb.poly([at(f, a, hy(k), -0.01), at(f, b, hy(k + 1), -0.01), at(f, b, hy(k + 1) - 0.018, -0.01), at(f, a, hy(k) - 0.018, -0.01)], dirOf(f, 0, 0, 1));
    mb.poly([at(f, a, hy(k), -0.01), at(f, b, hy(k + 1), -0.01), at(f, b, hy(k + 1) - 0.018, -0.01), at(f, a, hy(k) - 0.018, -0.01)], dirOf(f, 0, 0, -1));
  }
  const n = 3 + Math.floor(hash(seed, 31) * 2);
  for (let i = 0; i < n; i++) {
    const uc = -L + 0.45 + ((i + 0.5) * (2 * L - 0.9)) / n;
    const k = Math.round(((uc + L) / (2 * L)) * segs);
    const top = hy(k) - 0.02;
    const w = 0.28 + 0.12 * hash(seed + i, 32);
    const h = 0.55 + 0.35 * hash(seed + i, 33);
    P(mb, 'cloth', CLOTHS[Math.floor(hash(seed + i, 34) * 5) % 5]);
    const q: V3[] = [at(f, uc - w, top, 0), at(f, uc + w, top, 0), at(f, uc + w * 0.9, top - h, 0.01), at(f, uc - w * 0.9, top - h * 0.95, 0.01)];
    mb.poly(q, dirOf(f, 0, 0, 1));
    mb.poly(q, dirOf(f, 0, 0, -1));
  }
}

function pots(mb: MeshBuilder, f: Frame, u: number, v: number, y: number, seed: number): void {
  P(mb, 'clayTile', [1.05, 0.95, 0.9]);
  mb.cyl(f, u, v, y, y + 0.3, 0.12, 8, { r1: 0.17, top: false });
  P(mb, 'soil');
  mb.cyl(f, u, v, y + 0.28, y + 0.29, 0.16, 8);
  P(mb, 'plain', [0.3, 0.52, 0.24]);
  mb.cyl(f, u, v, y + 0.28, y + 0.52, 0.17, 6, { r1: 0.08 });
  P(mb, 'plain', FL[Math.floor(hash(seed, 35) * 5) % 5]);
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + seed;
    mb.cyl(f, u + Math.cos(a) * 0.07, v + Math.sin(a) * 0.07, y + 0.46 + 0.04 * i, y + 0.56 + 0.04 * i, 0.055, 5, { r1: 0.03 });
  }
}
const FL: V3[] = [
  [0.95, 0.3, 0.22],
  [0.97, 0.82, 0.28],
  [0.96, 0.95, 0.9],
  [0.72, 0.48, 0.92],
  [0.97, 0.55, 0.72],
];

function benchOutside(mb: MeshBuilder, f: Frame, y: number): void {
  P(mb, 'wood', [0.78, 0.62, 0.45]);
  mb.box(f, -0.65, 0.65, y + 0.42, y + 0.48, -0.17, 0.17, { bottom: true });
  for (const su of [-0.5, 0.5]) mb.box(f, su - 0.05, su + 0.05, y, y + 0.42, -0.14, 0.14, { top: false });
  mb.box(f, -0.65, 0.65, y + 0.48, y + 0.9, -0.2, -0.16); // backrest against the wall
  P(mb, 'plain', [0.62, 0.5, 0.38]);
  mb.cyl(f, 0.3, 0, y + 0.48, y + 0.6, 0.05, 6);
}

function stump(mb: MeshBuilder, f: Frame, y: number): void {
  P(mb, 'logs', [0.8, 0.65, 0.5]);
  mb.cyl(f, 0, 0, y, y + 0.42, 0.26, 7, { r1: 0.23 });
  P(mb, 'metal');
  mb.box(turned(moved(f, 0.05, 0.02), 0.5), -0.12, 0.12, y + 0.42, y + 0.5, -0.02, 0.02);
  P(mb, 'wood', [0.6, 0.48, 0.36]);
  mb.box(turned(moved(f, 0.05, 0.02), 0.5), 0.1, 0.38, y + 0.42, y + 0.46, -0.025, 0.025);
}

function coalHeap(mb: MeshBuilder, f: Frame, y: number): void {
  P(mb, 'rock', [0.28, 0.27, 0.3]);
  mb.cyl(f, 0, 0, y - 0.05, y + 0.5, 0.55, 7, { r1: 0.12 });
  mb.cyl(f, 0.45, 0.2, y - 0.05, y + 0.28, 0.3, 6, { r1: 0.08 });
}

function ladder(mb: MeshBuilder, f: Frame, y: number, h: number): void {
  // Leans on the wall (local -v side): rails are thin strips, rungs every 0.3 m.
  const lean = 0.28;
  P(mb, 'wood', [0.62, 0.5, 0.38]);
  for (const su of [-0.22, 0.22]) {
    const a = at(f, su - 0.025, y, 0.0);
    const b = at(f, su + 0.025, y, 0.0);
    const c = at(f, su + 0.025, y + h, -lean);
    const d = at(f, su - 0.025, y + h, -lean);
    mb.poly([a, b, c, d], dirOf(f, 0, 0, 1));
    mb.poly([a, b, c, d], dirOf(f, 0, 0, -1));
    mb.poly([at(f, su - 0.025, y, 0.0), at(f, su - 0.025, y, 0.0), c, d], dirOf(f, -1, 0, 0));
  }
  for (let k = 1; k * 0.3 < h; k++) {
    const yy = y + k * 0.3;
    const vv = -lean * (k * 0.3) / h;
    mb.box(f, -0.22, 0.22, yy - 0.02, yy + 0.02, vv - 0.025, vv + 0.025);
  }
}

/** Yard clutter for one building into the shell mesh. */
export function dressBuilding(mb: MeshBuilder, yard: Yard, b: Building, F: Frame, heightAt: Ground): void {
  if (detail() < 1 || b.floors === 0 || b.style === STYLE_STILT) return;
  mb.originY = 0;
  const wants: string[] = [];
  const h = (k: number) => hash(b.index, 100 + k);
  switch (b.role) {
    case ROLE_INN:
      wants.push('barrels', 'crates', 'bench', h(1) > 0.4 ? 'cart' : 'woodpile', 'pots');
      break;
    case ROLE_FORGE:
      wants.push('coal', 'barrels', h(2) > 0.5 ? 'crates' : 'woodpile');
      break;
    case ROLE_STORE:
      wants.push('crates', 'sacks', 'cart', 'hay');
      break;
    case ROLE_FARM:
      wants.push('hay', 'cart', 'barrels', 'woodpile');
      break;
    case ROLE_WORK:
      wants.push('woodpile', 'barrels', 'crates', 'ladder');
      break;
    default:
      wants.push('pots', h(3) > 0.4 ? 'woodpile' : 'barrels', h(4) > 0.5 ? 'wash' : 'rainbarrel', h(5) > 0.6 ? 'ladder' : 'pots');
      break;
  }
  if (detail() < 2) {
    // Medium: no carts, wash lines or ladders.
    for (let i = wants.length - 1; i >= 0; i--) if (wants[i] === 'cart' || wants[i] === 'wash' || wants[i] === 'ladder') wants.splice(i, 1);
  }
  const porch = (b.flags & BUILDING_FLAG.porch) !== 0;
  // Doorstep pots first (beside the doorway, outside the stairs and porch).
  let idx = 0;
  for (const w of wants) {
    idx++;
    if (w === 'pots') {
      if (porch) continue;
      for (const sd of [-1, 1]) {
        if (sd === 1 && h(6) < 0.4) continue;
        const u = b.doorU + sd * (b.doorW / 2 + 0.38);
        const p = at(F, u, 0, -b.hz - 0.3);
        if (!yard.free(p[0], p[2], 0.2, 0.1)) continue;
        yard.claim(p[0], p[2], 0.2);
        pots(mb, F, u, -b.hz - 0.3, heightAt(p[0], p[2]) - 0.03, b.index + sd);
      }
      continue;
    }
    // Everything else: against a side or back wall.
    const r = w === 'cart' ? 1.25 : w === 'wash' ? 1.9 : w === 'bench' ? 0.7 : 0.7;
    for (let attempt = 0; attempt < 6; attempt++) {
      const which = Math.floor(hash(b.index * 7 + idx, attempt + 11) * 3); // 0 back, 1 left, 2 right
      const along = (hash(b.index * 5 + idx, attempt + 21) * 2 - 1) * 0.85;
      let u: number;
      let v: number;
      let a: number;
      const gap = w === 'wash' ? 0.2 + r : 0.12 + (w === 'cart' ? 1.0 : w === 'woodpile' ? 0.35 : 0.3);
      if (which === 0) {
        u = along * (b.hx - 1);
        v = b.hz + gap;
        a = 0;
      } else {
        const sd = which === 1 ? -1 : 1;
        u = sd * (b.hx + gap);
        v = along * (b.hz - 1);
        a = sd < 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      // Items that lie along the wall turn a quarter so their long side faces it.
      const base = turned(moved(F, u, v), a);
      const p = at(base, 0, 0, 0);
      if (!yard.free(p[0], p[2], r)) continue;
      const gy = heightAt(p[0], p[2]);
      let flat = true;
      for (const [du, dv] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]] as const) {
        const q = at(base, du * r, 0, dv * r);
        if (Math.abs(heightAt(q[0], q[2]) - gy) > 0.45) flat = false;
      }
      if (!flat) continue;
      yard.claim(p[0], p[2], r);
      const y = gy - 0.04;
      const s = Math.floor(hash(b.index, 200 + idx) * 1000);
      switch (w) {
        case 'barrels': {
          const n = 1 + (s % 3);
          for (let i = 0; i < n; i++) barrel(mb, base, (i - (n - 1) / 2) * 0.62, i === 1 ? 0.08 : 0, y);
          break;
        }
        case 'rainbarrel':
          barrel(mb, base, 0, 0, y, 0.95, 0.32, true);
          break;
        case 'crates':
          crate(mb, base, -0.3, 0, y, 0.34);
          crate(mb, base, 0.4, 0.05, y, 0.3, 0.2);
          if (s % 2) crate(mb, base, -0.25, 0, y + 0.61, 0.26, 0.35);
          break;
        case 'sacks':
          for (let i = 0; i < 4; i++) sack(mb, base, (i % 2) * 0.45 - 0.2, (i >> 1) * 0.42 - 0.1, y + (i === 3 ? 0.3 : 0), CLOTHS[(i + s) % 5]);
          break;
        case 'woodpile':
          woodpile(mb, base, y);
          if (b.role === 0 && s % 3 === 0) stump(mb, moved(base, 1.1, 0.1), y);
          break;
        case 'hay':
          hay(mb, base, y, 2 + (s % 2));
          break;
        case 'cart':
          cart(mb, base, y, s % 3);
          break;
        case 'wash':
          washLine(mb, base, y, b.index);
          break;
        case 'bench':
          benchOutside(mb, base, y);
          break;
        case 'coal':
          coalHeap(mb, base, y);
          break;
        case 'ladder':
          ladder(mb, base, y, Math.min(3.1, b.floors * b.storey * 0.95));
          break;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------

/** Room finish into the interior mesh (shown within 80 m): skirting, wainscot, ceiling beams, hanging things. */
export function drawInterior(mb: MeshBuilder, b: Building, F: Frame, wt: number, wood: V3): void {
  const D = detail();
  if (D < 1 || b.floors === 0) return;
  mb.originY = b.floorY;
  const iu = b.hx - wt;
  const iv = b.hz - wt;
  const fy = b.floorY;
  const cy = b.floorY + b.storey;
  const open = (b.flags & BUILDING_FLAG.openFront) !== 0;
  const style = b.style;
  const panelled = D >= 2 && (style === 0 || style === 5 || style === 1) && b.role !== ROLE_FORGE;
  // Door gap on the -v (front) wall.
  const d0 = b.doorU - b.doorW / 2 - 0.03;
  const d1 = b.doorU + b.doorW / 2 + 0.03;
  const skirting = style !== 2 && style !== 3 && style !== 4;
  const strip = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, depth: number) => {
    // A thin board along an inner wall: (u0..u1, v0..v1) is the wall's inner face line, `depth` stands into the room.
    if (Math.abs(v1 - v0) < 1e-6) {
      const inward = v0 > 0 ? -1 : 1;
      mb.box(F, u0, u1, y0, y1, inward > 0 ? v0 : v0 - depth, inward > 0 ? v0 + depth : v0, { skip: [], bottom: false });
    } else {
      const inward = u0 > 0 ? -1 : 1;
      mb.box(F, inward > 0 ? u0 : u0 - depth, inward > 0 ? u0 + depth : u0, y0, y1, v0, v1, { bottom: false });
    }
  };
  const walls = (y0: number, y1: number, depth: number) => {
    strip(-iu, iu, iv, iv, y0, y1, depth); // back
    strip(-iu, -iu, -iv, iv, y0, y1, depth); // left
    strip(iu, iu, -iv, iv, y0, y1, depth); // right
    if (open) strip(-iu, iu, -iv, -iv, y0, y1, depth);
    else {
      if (d0 > -iu + 0.05) strip(-iu, d0, -iv, -iv, y0, y1, depth);
      if (d1 < iu - 0.05) strip(d1, iu, -iv, -iv, y0, y1, depth);
    }
  };
  if (skirting) {
    P(mb, 'wood', wood);
    walls(fy, fy + 0.14, 0.025);
    P(mb, 'wood', [wood[0] * 0.9, wood[1] * 0.9, wood[2] * 0.9]);
    walls(fy + 0.13, fy + 0.16, 0.04);
  }
  if (panelled) {
    P(mb, 'planks', [wood[0] * 1.5, wood[1] * 1.4, wood[2] * 1.3]);
    walls(fy + 0.16, fy + 0.88, 0.02);
    P(mb, 'wood', wood);
    walls(fy + 0.88, fy + 0.93, 0.05);
  }
  // Ceiling beams across the narrower span, a plate round the wall tops.
  P(mb, 'wood', [wood[0] * 0.95, wood[1] * 0.95, wood[2] * 0.95]);
  const acrossU = b.hx <= b.hz; // beams run along the shorter side
  const span = acrossU ? iu : iv;
  const length = acrossU ? iv : iu;
  const nb = Math.max(1, Math.round(length / 1.7));
  for (let k = 0; k < nb; k++) {
    const a = -length + ((k + 0.5) * 2 * length) / nb;
    if (acrossU) mb.box(F, -span, span, cy - 0.24, cy, a - 0.1, a + 0.1, { top: false });
    else mb.box(F, a - 0.1, a + 0.1, cy - 0.24, cy, -span, span, { top: false });
  }
  walls(cy - 0.12, cy, 0.1);
  if (D < 2) return;
  // Hanging herbs from the beams (houses), a candle wheel (inns).
  const h = (k: number) => hash(b.index, 300 + k);
  if (b.role === ROLE_INN) {
    const C = moved(F, 0, 0);
    const wy = cy - 0.75;
    P(mb, 'metal', [0.9, 0.85, 0.8]);
    mb.box(C, -0.015, 0.015, wy + 0.05, cy - 0.24, -0.015, 0.015, { top: false });
    for (let a = 0; a < 8; a++) mb.box(turned(C, (a * Math.PI) / 4), 0.36, 0.7, wy - 0.02, wy + 0.03, -0.035, 0.035);
    for (let a = 0; a < 6; a++) {
      const ang = (a * Math.PI) / 3;
      const px = Math.cos(ang) * 0.62;
      const pv = Math.sin(ang) * 0.62;
      P(mb, 'cloth', [1, 0.96, 0.85]);
      mb.cyl(C, px, pv, wy + 0.03, wy + 0.16, 0.03, 5);
      const w = at(C, px, wy + 0.16, pv);
      flame(mb, w[0], w[1], w[2], 0.07, 0.12, 210);
    }
  } else if (b.role === 0 || b.role === ROLE_FARM) {
    const n = 2 + Math.floor(h(1) * 3);
    for (let i = 0; i < n; i++) {
      const u = (h(10 + i) * 2 - 1) * (iu - 0.6);
      const v = (h(20 + i) * 2 - 1) * (iv - 0.6);
      const base = cy - 0.24;
      P(mb, 'plain', [0.5, 0.4, 0.3]);
      mb.box(F, u - 0.01, u + 0.01, base - 0.22, base, v - 0.01, v + 0.01, { top: false });
      P(mb, 'crops', i & 1 ? [0.72, 0.7, 0.4] : [0.5, 0.6, 0.3]);
      mb.cyl(F, u, v, base - 0.6, base - 0.2, 0.01, 5, { r1: 0.075, top: false });
      mb.cyl(F, u + 0.09, v, base - 0.5, base - 0.2, 0.01, 5, { r1: 0.06, top: false });
      mb.cyl(F, u - 0.08, v + 0.03, base - 0.45, base - 0.2, 0.01, 5, { r1: 0.06, top: false });
    }
  }
  void local;
  void dirOf;
}
