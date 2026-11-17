// The guiding wisp's route (CR 052): where it flies, as a pure function of the
// road graph, you and the goal. Roads come from the towns buffer the client
// already has (TownRoad: polylines of x, y, z triples). The graph is built
// once per world: every road is resampled to at most STEP_M between nodes,
// consecutive nodes are linked, and nodes of different roads within JOIN_M
// are linked too (a fork or a T-junction is a road ending beside another).
//
// planRoute() follows roads when you stand on (or within SNAP_M of) one, the
// goal is near one, and the road is not a big detour; otherwise the route is
// the straight line over the terrain. Either way the result is one polyline
// with a flag per leg saying whether it runs on a road. No three.js here.

export interface Pt {
  x: number;
  z: number;
}

export interface RoadLike {
  /** x, y, z triples. */
  points: ArrayLike<number>;
  from?: number;
  to?: number;
  cls?: number;
}

export interface RoadGraph {
  count: number;
  x: Float32Array;
  z: Float32Array;
  adj: number[][];
  /** Spatial hash of node indices, cell CELL_M. */
  grid: Map<number, number[]>;
}

/** Longest edge between two nodes of a road (m). */
export const STEP_M = 14;
/** Nodes of different roads this close are one junction (m). */
export const JOIN_M = 10;
/** You are "on a road" within this distance of a node (m). */
export const SNAP_M = 26;
/** The goal counts as near a road within this distance (m). */
export const GOAL_SNAP_M = 140;
/** A road route longer than this multiple of the straight line (plus slack) is not worth it. */
export const DETOUR = 1.7;
export const DETOUR_SLACK_M = 80;
const CELL_M = 32;

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

export function buildRoadGraph(roads: RoadLike[]): RoadGraph {
  const xs: number[] = [];
  const zs: number[] = [];
  const owner: number[] = [];
  const adj: number[][] = [];
  const grid = new Map<number, number[]>();
  const add = (x: number, z: number, road: number): number => {
    const i = xs.length;
    xs.push(x);
    zs.push(z);
    owner.push(road);
    adj.push([]);
    const k = cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M));
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
    return i;
  };
  const link = (a: number, b: number) => {
    if (a === b || adj[a].includes(b)) return;
    adj[a].push(b);
    adj[b].push(a);
  };
  roads.forEach((r, ri) => {
    const n = Math.floor(r.points.length / 3);
    if (n < 2) return;
    let prev = add(r.points[0], r.points[2], ri);
    for (let i = 1; i < n; i++) {
      const ax = r.points[(i - 1) * 3];
      const az = r.points[(i - 1) * 3 + 2];
      const bx = r.points[i * 3];
      const bz = r.points[i * 3 + 2];
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP_M));
      for (let j = 1; j <= k; j++) {
        const f = j / k;
        const cur = add(ax + (bx - ax) * f, az + (bz - az) * f, ri);
        link(prev, cur);
        prev = cur;
      }
    }
  });
  const g: RoadGraph = { count: xs.length, x: Float32Array.from(xs), z: Float32Array.from(zs), adj, grid };
  // Junctions: nodes of different roads close together.
  for (let i = 0; i < g.count; i++) {
    const cx = Math.floor(g.x[i] / CELL_M);
    const cz = Math.floor(g.z[i] / CELL_M);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const l = grid.get(cellKey(cx + dx, cz + dz));
        if (!l) continue;
        for (const j of l) if (j > i && owner[j] !== owner[i] && Math.hypot(g.x[i] - g.x[j], g.z[i] - g.z[j]) <= JOIN_M) link(i, j);
      }
  }
  return g;
}

/** Nearest node within maxM of a point (-1: none). */
export function nearestNode(g: RoadGraph, x: number, z: number, maxM: number): number {
  const r = Math.ceil(maxM / CELL_M);
  const cx = Math.floor(x / CELL_M);
  const cz = Math.floor(z / CELL_M);
  let best = -1;
  let bd = maxM;
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) {
      const l = g.grid.get(cellKey(cx + dx, cz + dz));
      if (!l) continue;
      for (const i of l) {
        const d = Math.hypot(g.x[i] - x, g.z[i] - z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
  return best;
}

/** A* over the graph (euclidean heuristic); the node indices from a to b, or null. */
export function shortestPath(g: RoadGraph, a: number, b: number): number[] | null {
  if (a < 0 || b < 0) return null;
  if (a === b) return [a];
  const dist = new Float64Array(g.count).fill(Infinity);
  const from = new Int32Array(g.count).fill(-1);
  const done = new Uint8Array(g.count);
  const heap: [number, number][] = []; // [f, node]
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (n: number) => Math.hypot(g.x[n] - g.x[b], g.z[n] - g.z[b]);
  dist[a] = 0;
  push(h(a), a);
  while (heap.length) {
    const [, n] = pop();
    if (done[n]) continue;
    done[n] = 1;
    if (n === b) break;
    for (const m of g.adj[n]) {
      const d = dist[n] + Math.hypot(g.x[n] - g.x[m], g.z[n] - g.z[m]);
      if (d < dist[m]) {
        dist[m] = d;
        from[m] = n;
        push(d + h(m), m);
      }
    }
  }
  if (!done[b]) return null;
  const out: number[] = [];
  for (let n = b; n >= 0; n = from[n]) out.push(n);
  return out.reverse();
}

export interface Route {
  pts: Pt[];
  /** Per leg (pts[i] -> pts[i+1]): runs along a road. */
  onRoad: boolean[];
  /** Cumulative arc length at each point (m). */
  cum: number[];
  length: number;
  /** Whether any leg follows a road. */
  usesRoad: boolean;
}

function finish(pts: Pt[], onRoad: boolean[]): Route {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, onRoad, cum, length: cum[cum.length - 1] ?? 0, usesRoad: onRoad.some(Boolean) };
}

/** The straight route over the terrain. */
export function straightRoute(from: Pt, to: Pt): Route {
  return finish([{ x: from.x, z: from.z }, { x: to.x, z: to.z }], [false]);
}

/** Roads when you are on one and they lead near the goal without a big detour, else straight. */
export function planRoute(g: RoadGraph | null, from: Pt, to: Pt): Route {
  const straight = Math.hypot(to.x - from.x, to.z - from.z);
  if (!g || g.count === 0 || straight < 30) return straightRoute(from, to);
  const a = nearestNode(g, from.x, from.z, SNAP_M);
  if (a < 0) return straightRoute(from, to);
  const b = nearestNode(g, to.x, to.z, GOAL_SNAP_M);
  if (b < 0) return straightRoute(from, to);
  const path = shortestPath(g, a, b);
  if (!path) return straightRoute(from, to);
  const legA = Math.hypot(g.x[a] - from.x, g.z[a] - from.z);
  const legB = Math.hypot(g.x[b] - to.x, g.z[b] - to.z);
  let along = 0;
  for (let i = 1; i < path.length; i++) along += Math.hypot(g.x[path[i]] - g.x[path[i - 1]], g.z[path[i]] - g.z[path[i - 1]]);
  if (along + legA + legB > DETOUR * straight + DETOUR_SLACK_M) return straightRoute(from, to);
  const pts: Pt[] = [{ x: from.x, z: from.z }];
  const onRoad: boolean[] = [];
  // Skip a first node that sits behind you (the road node nearest you can be a step back).
  path.forEach((n, i) => {
    const p = { x: g.x[n], z: g.z[n] };
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.z - last.z) < 0.5) return;
    onRoad.push(i > 0);
    pts.push(p);
  });
  if (Math.hypot(pts[pts.length - 1].x - to.x, pts[pts.length - 1].z - to.z) > 0.5) {
    onRoad.push(false);
    pts.push({ x: to.x, z: to.z });
  }
  return finish(pts, onRoad);
}

/** The point at arc length s along a route (clamped), and the leg it lies on. */
export function pointAt(r: Route, s: number, out: Pt = { x: 0, z: 0 }): { p: Pt; leg: number } {
  const t = Math.max(0, Math.min(r.length, s));
  let i = 1;
  while (i < r.cum.length - 1 && r.cum[i] < t) i++;
  const seg = r.cum[i] - r.cum[i - 1] || 1;
  const f = (t - r.cum[i - 1]) / seg;
  out.x = r.pts[i - 1].x + (r.pts[i].x - r.pts[i - 1].x) * f;
  out.z = r.pts[i - 1].z + (r.pts[i].z - r.pts[i - 1].z) * f;
  return { p: out, leg: i - 1 };
}

/** Arc length of the point on the route nearest to (x, z), searched within [from, to] metres of the route; with its distance. */
export function project(r: Route, x: number, z: number, lo = 0, hi = Infinity): { s: number; d: number } {
  let best = { s: lo, d: Infinity };
  for (let i = 1; i < r.pts.length; i++) {
    if (r.cum[i] < lo || r.cum[i - 1] > hi) continue;
    const ax = r.pts[i - 1].x;
    const az = r.pts[i - 1].z;
    const dx = r.pts[i].x - ax;
    const dz = r.pts[i].z - az;
    const L2 = dx * dx + dz * dz || 1;
    const f = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const d = Math.hypot(ax + dx * f - x, az + dz * f - z);
    if (d < best.d) best = { s: r.cum[i - 1] + Math.sqrt(L2) * f, d };
  }
  return best;
}

// ── The wisp itself ───────────────────────────────────────────────────────

/** How far ahead of you the wisp keeps (m): it drifts between these. */
export const LEAD_MIN_M = 8;
export const LEAD_MAX_M = 15;
/** It fades when you are this close to the goal (m of route left). */
export const ARRIVE_M = 14;
export const WISP_SPEED = 10;
export const WISP_CATCHUP_SPEED = 16;

export interface WispState {
  /** Arc length of the wisp, and of you, along the route. */
  s: number;
  ps: number;
  alpha: number;
  t: number;
  mode: 'fly' | 'fade' | 'gone';
  /** True while it is holding still waiting for you. */
  waiting: boolean;
  /** You are far off the route: plan again. */
  lost: boolean;
}

export function newWisp(route: Route, player: Pt): WispState {
  const ps = project(route, player.x, player.z).s;
  return { s: Math.min(route.length, ps + 4), ps, alpha: 0, t: 0, mode: 'fly', waiting: false, lost: false };
}

/** Lead distance this moment: a slow drift between LEAD_MIN_M and LEAD_MAX_M (pure of t). */
export function leadAt(t: number): number {
  return LEAD_MIN_M + ((LEAD_MAX_M - LEAD_MIN_M) * (0.5 + 0.5 * Math.sin(t * 0.35))) * 0.85 + 0.5;
}

/** One step of the wisp (mutates w). It never gets more than LEAD_MAX_M ahead of you: it waits. */
export function stepWisp(w: WispState, route: Route, player: Pt, dt: number): WispState {
  w.t += dt;
  const pr = project(route, player.x, player.z, Math.max(0, w.ps - 25), w.ps + 90);
  w.lost = pr.d > 70;
  if (!w.lost) w.ps = Math.max(pr.s, w.ps - 2); // you can step back a little, not teleport back
  const left = route.length - w.ps;
  if (w.mode === 'fly' && left < ARRIVE_M) w.mode = 'fade';
  if (w.mode === 'fade') {
    w.alpha = Math.max(0, w.alpha - dt * 0.7);
    // Drift on to the goal while it fades.
    w.s = Math.min(route.length, w.s + dt * 4);
    if (w.alpha <= 0) w.mode = 'gone';
    return w;
  }
  w.alpha = Math.min(1, w.alpha + dt * 1.6);
  const want = Math.min(route.length, w.ps + leadAt(w.t));
  const gap = w.s - w.ps;
  if (gap > LEAD_MAX_M) {
    // Too far ahead: wait.
    w.waiting = true;
  } else if (w.s < want) {
    w.waiting = false;
    const sp = gap < LEAD_MIN_M ? WISP_CATCHUP_SPEED : WISP_SPEED;
    w.s = Math.min(want, w.s + sp * dt);
  } else {
    // At its spot: hold, and ease back toward the wanted lead if you stopped.
    w.waiting = true;
  }
  if (w.s < w.ps + 3) w.s = Math.min(route.length, w.ps + 3); // never lag behind your feet
  return w;
}
