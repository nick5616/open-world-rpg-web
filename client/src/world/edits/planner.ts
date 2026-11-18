// The dig/fill planner (CR 040), a port of server/pkg/worldedit/dig.go: which
// vertices change for one shovel swing. Online the zone plans and the client
// only applies what TerrainEdits says; this port is solo play's authority and
// the dig preview.
import { MAX_DELTA, STEP_M } from './overlay';

export const BRUSH_R = 1.6;
export const BRUSH_CORE = 0.8;
export const MAX_SLOPE = 3; // steps per metre; diagonals 4 (see worldedit/dig.go)
export const MAX_CHANGED = 360;
export const WATER_MARGIN = 0.3;
export const STEPS_PER_ITEM = 6;

export type Op = 'dig' | 'fill';
/** 'bedrock': a dig whose strike vertex already sits at the -MAX_DELTA cap (the Go twin's Bedrock); 'limit' is the water line or a fill's cap. */
export type Refusal = 'ok' | 'forbidden' | 'limit' | 'big' | 'bedrock';

export interface PlanWorld {
  /** The generated lattice height at a vertex. */
  base(x: number, z: number): number;
  water(x: number, z: number): number;
  allowed(x: number, z: number): boolean;
  /** Current delta at a vertex. */
  delta(x: number, z: number): number;
}

export interface Plan {
  changes: { x: number; z: number; d: number }[];
  lowered: number;
  raised: number;
  cx: number;
  cz: number;
}

const NBRS: [number, number, number][] = [
  [1, 0, 3], [-1, 0, 3], [0, 1, 3], [0, -1, 3],
  [1, 1, 4], [-1, 1, 4], [1, -1, 4], [-1, -1, 4],
];

export function planSwing(w: PlanWorld, op: Op, px: number, pz: number): { plan: Plan | null; reason: Refusal } {
  const cur = new Map<number, number>();
  const orig = new Map<number, number>();
  const queue: [number, number][] = [];
  const k = (x: number, z: number) => (z + 100000) * 1000003 + (x + 100000);
  const get = (x: number, z: number) => cur.get(k(x, z)) ?? w.delta(x, z);
  let reason: Refusal = 'ok';
  const set = (x: number, z: number, d: number): boolean => {
    const key = k(x, z);
    if (!orig.has(key)) {
      if (x < 0 || z < 0 || x >= 4096 || z >= 4096 || !w.allowed(x, z)) {
        reason = 'forbidden';
        return false;
      }
      orig.set(key, w.delta(x, z));
      if (orig.size > MAX_CHANGED) {
        reason = 'big';
        return false;
      }
    }
    cur.set(key, d);
    queue.push([x, z]);
    return true;
  };
  const floor = (x: number, z: number): number => {
    const c = get(x, z);
    const lowest = Math.max(-MAX_DELTA, Math.ceil((w.water(x, z) + WATER_MARGIN - w.base(x, z)) / STEP_M - 1e-9));
    return lowest > c ? c : lowest;
  };
  let cx = 0;
  let cz = 0;
  let best = Infinity;
  for (let z = Math.floor(pz - BRUSH_R); z <= Math.ceil(pz + BRUSH_R); z++) {
    for (let x = Math.floor(px - BRUSH_R); x <= Math.ceil(px + BRUSH_R); x++) {
      const d = Math.hypot(x - px, z - pz);
      if (d > BRUSH_R) continue;
      if (d < best) {
        best = d;
        cx = x;
        cz = z;
      }
      const amt = d < BRUSH_CORE ? 2 : 1;
      const c = get(x, z);
      let nd: number;
      if (op === 'dig') nd = Math.min(c, Math.max(c - amt, floor(x, z)));
      else nd = Math.min(c + amt, MAX_DELTA);
      if (nd === c) continue;
      if (!set(x, z, nd)) return { plan: null, reason };
    }
  }
  const noChange = (): Refusal => (op === 'dig' && get(cx, cz) <= -MAX_DELTA ? 'bedrock' : 'limit');
  if (!queue.length) return { plan: null, reason: noChange() };
  while (queue.length) {
    const [x, z] = queue.shift()!;
    const d = cur.get(k(x, z))!;
    for (const [dx, dz, lim] of NBRS) {
      const nx = x + dx;
      const nz = z + dz;
      const nd = get(nx, nz);
      let want: number;
      if (op === 'dig') {
        if (nd <= d + lim) continue;
        want = d + lim;
        if (want < floor(nx, nz)) return { plan: null, reason: 'limit' };
      } else {
        if (nd >= d - lim) continue;
        want = Math.min(d - lim, MAX_DELTA);
      }
      if (!set(nx, nz, want)) return { plan: null, reason };
    }
  }
  const plan: Plan = { changes: [], lowered: 0, raised: 0, cx, cz };
  for (const [key, nd] of cur) {
    const od = orig.get(key)!;
    if (nd === od) continue;
    const x = (key % 1000003) - 100000;
    const z = Math.floor(key / 1000003) - 100000;
    plan.changes.push({ x, z, d: nd });
    if (nd < od) plan.lowered += od - nd;
    else plan.raised += nd - od;
  }
  if (!plan.changes.length) return { plan: null, reason: noChange() };
  plan.changes.sort((a, b) => a.z - b.z || a.x - b.x);
  return { plan, reason: 'ok' };
}

export const itemsFor = (steps: number, acc: number): { items: number; rest: number } => {
  const t = steps + acc;
  return { items: Math.floor(t / STEPS_PER_ITEM), rest: t % STEPS_PER_ITEM };
};

export const costFor = (raised: number): number => Math.max(1, Math.ceil(raised / STEPS_PER_ITEM));
