// Base building rules (playtest 3, CR 041): the TS mirror of
// server/pkg/camps/build.go (CheckBuild, Stability, Orphans), pure over an
// environment so vitest can replay the zone's golden vectors
// (server/pkg/camps/testdata/build.json, rules.test.ts). Integer centimetres
// and quarter turns: every comparison is exact on both sides. The zone is the
// authority; it also refuses sites and roads (its env's noBuild), which the
// ghost cannot see.

import { CAMPS, WORLD_SIZE_M, type BuildShape } from '@lodestone/contracts';
import { footprint, overlaps, type Footprint } from '../camps/placement';
import { quarter, shapeOf, surfaceOf, world, type BP, type Surface } from './geometry';

/** Refusal reasons 24-34 (Event 1103 value; server/pkg/camps build.go). */
export const REFUSE = {
  unknown: 1,
  tooFar: 2,
  town: 3,
  slope: 4,
  water: 5,
  blocked: 6,
  otherBuild: 7,
  body: 12,
  notYours: 14,
  underground: 13,
  grid: 24,
  site: 25,
  road: 26,
  high: 27,
  support: 28,
  budget: 29,
  areaFull: 30,
  materials: 31,
  holds: 32,
  noHome: 33,
  cooldown: 34,
} as const;

export interface BuildEnv {
  heightAt(x: number, z: number): number;
  waterAt(x: number, z: number): number;
  /** 0, or REFUSE.town / site / road for a point and the radius around it. */
  noBuild(x: number, z: number, r: number): number;
  structure(f: Footprint): boolean;
}

export interface BuildWant {
  kind: number;
  rot: number;
  /** cm */
  x: number;
  y: number;
  z: number;
  hasY: boolean;
  owner: string;
  party: number;
  feetX: number;
  feetY: number;
  feetZ: number;
}

type Pt3 = [number, number, number];
type AABB = [number, number, number, number, number, number];

/** Ground pieces may differ this much (cm) from the terrain the client measured. */
const GROUND_TOL = 3;

const socketsOf = (bp: BP, pts: readonly (readonly number[])[]): Pt3[] => pts.map((p) => world(bp, p[0], p[1], p[2]));
const same = (a: Pt3, b: Pt3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const ptIn = (p: Pt3, l: Pt3[]) => l.some((q) => same(p, q));
const sharesPt = (a: Pt3[], b: Pt3[]) => a.some((p) => ptIn(p, b));
const hasAnchor = (sh: BuildShape, a: string) => (sh.anchor as string[]).includes(a);
const mod = (a: number, m: number) => ((a % m) + m) % m;
const M2Cm = (m: number) => Math.round(m * 100);

function boxWorld(bp: BP, b: readonly number[]): AABB {
  const a = world(bp, b[0], b[2], b[4]);
  const c = world(bp, b[1], b[3], b[5]);
  return [Math.min(a[0], c[0]), Math.max(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[1], c[1]), bp.y + b[4], bp.y + b[5]];
}

/** The piece's occupancy box in the world. */
export function occOf(bp: BP, sh: BuildShape): AABB {
  return boxWorld(bp, sh.occ);
}

function overlapsBy(a: AABB, b: AABB, pen: number): boolean {
  return a[0] + pen < b[1] && b[0] + pen < a[1] && a[2] + pen < b[3] && b[2] + pen < a[3] && a[4] + pen < b[5] && b[4] + pen < a[5];
}

function nearBox(a: AABB, b: AABB, d: number): boolean {
  return a[0] - d < b[1] && b[0] - d < a[1] && a[2] - d < b[3] && b[2] - d < a[3] && a[4] - d < b[5] + 300 && b[4] - d < a[5] + 300;
}

const coexists = (a: BuildShape, b: BuildShape) => a.coexist.includes(b.base) || b.coexist.includes(a.base);

// ---- support ----

interface Node {
  bp: BP;
  sh: BuildShape;
  up: Pt3[];
  down: Pt3[];
  side: Pt3[];
  face: Pt3[];
  depth: number;
  stable: boolean;
}

function newNode(bp: BP): Node | null {
  const sh = shapeOf(bp.kind);
  if (!sh) return null;
  return { bp, sh, up: socketsOf(bp, sh.up), down: socketsOf(bp, sh.down), side: socketsOf(bp, sh.side), face: socketsOf(bp, sh.face), depth: 0, stable: false };
}

function onRect(s: Surface, x: number, z: number): boolean {
  const dx = x - s.x;
  const dz = z - s.z;
  const u = dx * s.cs + dz * s.sn;
  const v = dz * s.cs - dx * s.sn;
  return Math.abs(u) <= s.hx + 1e-9 && Math.abs(v) <= s.hz + 1e-9;
}

function rooted(n: Node, env: BuildEnv): boolean {
  const sh = n.sh;
  if (hasAnchor(sh, 'foundation')) return true;
  if (hasAnchor(sh, 'ground') || hasAnchor(sh, 'surface')) {
    const g = world(n.bp, sh.gpt[0], sh.gpt[1], 0);
    const h = M2Cm(env.heightAt(g[0] / 100, g[1] / 100));
    const d = h - n.bp.y;
    if (d >= -GROUND_TOL && d <= GROUND_TOL) return true;
  }
  return false;
}

function supported(n: Node, stable: Node[]): [boolean, number] {
  const sh = n.sh;
  if (hasAnchor(sh, 'wall')) {
    const pt: Pt3 = [n.bp.x, n.bp.z, n.bp.y];
    for (const q of stable) if (ptIn(pt, q.face)) return [true, 0];
    return [false, 0];
  }
  if (hasAnchor(sh, 'surface')) {
    for (const q of stable) {
      const s = surfaceOf(q.bp);
      if (s && s.ya === s.yb && Math.abs(s.ya * 100 - n.bp.y) < 1 && onRect(s, n.bp.x / 100, n.bp.z / 100)) return [true, 0];
    }
  }
  if (!hasAnchor(sh, 'sockets') || (n.down.length === 0 && n.side.length === 0)) return [false, 0];
  for (const q of stable) if (sharesPt(n.down, q.up)) return [true, 0];
  if (sh.reach > 0) {
    let best = -1;
    for (const q of stable) {
      if (q.side.length > 0 && sharesPt(n.side, q.side) && q.depth < sh.reach) if (best < 0 || q.depth + 1 < best) best = q.depth + 1;
    }
    if (best > 0) return [true, best];
  }
  return [false, 0];
}

function stabilize(ps: readonly BP[], env: BuildEnv): Node[] {
  const nodes: Node[] = [];
  for (const p of ps) {
    const n = newNode(p);
    if (n) nodes.push(n);
  }
  const stable: Node[] = [];
  for (const n of nodes)
    if (rooted(n, env)) {
      n.stable = true;
      stable.push(n);
    }
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (n.stable) continue;
      const [ok, d] = supported(n, stable);
      if (ok) {
        n.stable = true;
        n.depth = d;
        stable.push(n);
        changed = true;
      }
    }
  }
  return stable;
}

/** The ids of the pieces that are held up. */
export function stability(ps: readonly BP[], env: BuildEnv): Set<number> {
  return new Set(stabilize(ps, env).map((n) => n.bp.id));
}

/** Pieces held up now that would not be without piece `id` (what a deconstruct would drop). */
export function orphans(ps: readonly BP[], id: number, env: BuildEnv): number[] {
  const before = stability(ps, env);
  const rest = ps.filter((p) => p.id !== id);
  const after = stability(rest, env);
  return rest.filter((p) => before.has(p.id) && !after.has(p.id)).map((p) => p.id);
}

function okSupport(bp: BP, all: readonly BP[], env: BuildEnv): boolean {
  const n = newNode(bp);
  if (!n) return false;
  return supported(n, stabilize(all, env))[0];
}

// ---- placement ----

function parityOK(sh: BuildShape, rot: number, x: number, z: number): boolean {
  if (!sh.par) return mod(x, 50) === 0 && mod(z, 50) === 0;
  let [px, pz] = sh.par;
  if ((quarter(rot) & 1) === 1) [px, pz] = [pz, px];
  return mod(x, 200) === px && mod(z, 200) === pz;
}

/** Whether `actor` may touch a piece: the owner, or the owner's party when shared. */
export function allows(actor: string, actorParty: number, p: Pick<BP, 'owner' | 'lock' | 'party'>): boolean {
  return p.owner === actor || (p.lock === 1 && p.party !== 0 && p.party === actorParty);
}

function buildHeight(w: BuildWant, bp: BP, sh: BuildShape, all: readonly BP[], env: BuildEnv): [number, number] {
  const b = CAMPS.build;
  const x = w.x / 100;
  const z = w.z / 100;
  if (hasAnchor(sh, 'foundation')) {
    let lo = Infinity;
    let hi = -Infinity;
    const f = footprint(bp.kind, bp.rot, x, z);
    const cs = corners4(f);
    for (const c of [...cs, [x, z] as [number, number]]) {
      const h = env.heightAt(c[0], c[1]);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > b.foundation.maxSpreadM) return [0, REFUSE.slope];
    const snap = Math.round(b.foundation.snapM * 100);
    const def0 = Math.ceil(Math.ceil(hi * 100 - 1e-6) / snap - 1e-9) * snap;
    const ok = (y: number) => hi <= y / 100 + b.foundation.maxBuriedM + 1e-9 && lo >= y / 100 - b.foundation.skirtM - 1e-9;
    const alts: number[] = [];
    if (ok(def0)) alts.push(def0);
    const n = newNode(bp)!;
    for (const q of all) {
      const qs = shapeOf(q.kind);
      if (!qs || !hasAnchor(qs, 'foundation')) continue;
      for (const s of socketsOf(q, qs.side))
        for (const m of n.side) if (s[0] === m[0] && s[1] === m[1]) if (ok(q.y) && !alts.includes(q.y)) alts.push(q.y);
    }
    if (alts.length === 0) return [0, REFUSE.slope];
    if (w.hasY) return alts.includes(w.y) ? [w.y, 0] : [0, REFUSE.support];
    return [alts[alts.length - 1], 0];
  }
  if (hasAnchor(sh, 'ground')) {
    const g = world(bp, sh.gpt[0], sh.gpt[1], 0);
    const gh = M2Cm(env.heightAt(g[0] / 100, g[1] / 100));
    if (!w.hasY || Math.abs(w.y - gh) <= GROUND_TOL) return [gh, 0];
  }
  if (!w.hasY) {
    if (hasAnchor(sh, 'surface')) return [M2Cm(env.heightAt(x, z)), 0];
    return [0, REFUSE.support];
  }
  bp.y = w.y;
  if (hasAnchor(sh, 'wall') || hasAnchor(sh, 'sockets')) return okSupport(bp, all, env) ? [w.y, 0] : [0, REFUSE.support];
  if (hasAnchor(sh, 'surface')) {
    if (Math.abs(w.y - M2Cm(env.heightAt(x, z))) <= GROUND_TOL) return [M2Cm(env.heightAt(x, z)), 0];
    return okSupport(bp, all, env) ? [w.y, 0] : [0, REFUSE.support];
  }
  return [0, REFUSE.support];
}

function corners4(f: Footprint): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const u = a * f.hx;
    const v = b * f.hz;
    out.push([f.x + u * f.c - v * f.s, f.z + u * f.s + v * f.c]);
  }
  return out;
}

/**
 * Validate a building piece's placement; returns its base height (cm) or the
 * refusal reason (0 = fine). `all` is every piece within ~16 m of the spot.
 */
export function checkBuild(w: BuildWant, all: readonly BP[], env: BuildEnv): { y: number; reason: number } {
  const d = CAMPS;
  const no = (reason: number) => ({ y: 0, reason });
  const def = d.pieces.find((p) => p.id === w.kind);
  const sh = def?.build;
  if (!def || !sh) return no(REFUSE.unknown);
  const b = d.build;
  if ((w.rot & 1) !== 0 || w.rot < 0 || w.rot > 7) return no(REFUSE.grid);
  if (!parityOK(sh, w.rot, w.x, w.z)) return no(REFUSE.grid);
  const x = w.x / 100;
  const z = w.z / 100;
  if (x < 4 || z < 4 || x > WORLD_SIZE_M - 4 || z > WORLD_SIZE_M - 4) return no(REFUSE.tooFar);
  if (Math.hypot(x - w.feetX, z - w.feetZ) > b.reachM) return no(REFUSE.tooFar);
  const nb = env.noBuild(x, z, Math.hypot(def.w, def.d) / 2);
  if (nb !== 0) return no(nb);
  const surf = env.heightAt(x, z);
  if (w.feetY < surf - d.placement.maxDepthM) return no(REFUSE.underground);
  const bp: BP = { id: 0, kind: w.kind, rot: w.rot, x: w.x, y: 0, z: w.z, state: 0, owner: w.owner, party: w.party, lock: 0 };
  const [y, why] = buildHeight(w, bp, sh, all, env);
  if (why !== 0) return no(why);
  bp.y = y;
  if (y / 100 > surf + b.maxHeightM) return no(REFUSE.high);
  const f = footprint(w.kind, w.rot, x, z);
  if (hasAnchor(sh, 'foundation') || hasAnchor(sh, 'ground')) {
    for (const c of [...corners4(f), [x, z] as [number, number]]) if (env.waterAt(c[0], c[1]) > env.heightAt(c[0], c[1]) - 0.05) return no(REFUSE.water);
  }
  const occ = occOf(bp, sh);
  for (const q of all) {
    const qd = d.pieces.find((p) => p.id === q.kind);
    if (!qd) continue;
    if (!qd.build) {
      if (overlaps(f, footprint(q.kind, q.rot, q.x / 100, q.z / 100), d.placement.gapM / 2)) return no(REFUSE.blocked);
      continue;
    }
    const qocc = occOf(q, qd.build);
    if (overlapsBy(occ, qocc, 4) && !coexists(sh, qd.build)) return no(REFUSE.blocked);
    if (q.owner !== w.owner && !(q.lock === 1 && q.party !== 0 && q.party === w.party) && nearBox(occ, qocc, Math.trunc(b.otherBuildM * 100))) return no(REFUSE.otherBuild);
  }
  if (env.structure(f)) return no(REFUSE.blocked);
  return { y, reason: 0 };
}
