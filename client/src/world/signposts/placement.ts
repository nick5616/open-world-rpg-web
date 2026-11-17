// Signpost placement and wording (CR 052), client side and deterministic: it
// reads only what the client already has (the towns buffer's settlements,
// roads and fork signs, and the atlas' named sites), so no worldgen change.
//
//   fork posts   the towns buffer already stands a post at every fork
//                (roads.ts drawSign) with blank boards; here each arm gets
//                its destination's name and distance
//   exit posts   a new post beside each town road where it leaves the town,
//                boards for the town the road leads to, and the nearest named
//                landmarks ahead of you
//
// Pure functions over plain data (the tests feed fixtures); three.js lives in
// SignpostLayer.tsx.

export interface PSettlement {
  index: number;
  site: number;
  x: number;
  z: number;
  radius: number;
}

export interface PRoad {
  index: number;
  from: number;
  to: number;
  /** 0 road, 1 town street, 2 footpath. */
  cls: number;
  width: number;
  /** x, y, z triples. */
  points: ArrayLike<number>;
}

export interface PFork {
  id: string;
  x: number;
  y: number;
  z: number;
  arms: { yaw: number; settlement: number }[];
}

export interface PSite {
  index: number;
  category: 'poi' | 'settlement' | 'structure';
  kind: string;
  name: string | null;
  x: number;
  z: number;
  layer?: number;
}

export interface PlacementInput {
  settlements: PSettlement[];
  roads: PRoad[];
  forks: PFork[];
  sites: PSite[];
}

export interface SignBoard {
  /** The place's name. */
  name: string;
  /** Straight-line metres from the post. */
  dist: number;
  /** Unit direction (x, z) from the post to it. */
  dx: number;
  dz: number;
  kind: 'town' | 'landmark';
}

export interface Signpost {
  id: string;
  kind: 'fork' | 'exit';
  x: number;
  z: number;
  /** Forks: the ground height the towns buffer gives the post. Exits: NaN (the layer samples the terrain). */
  y: number;
  /** Fork arms' yaws and their index in the towns buffer's arm list (which sets the board's height), per board (forks only). */
  yaws: number[];
  armIndex: number[];
  /** Exit posts: unit direction of the road leaving the town (x, z). */
  roadDir: { x: number; z: number } | null;
  /** Exit posts: the settlement it stands at. */
  settlement: number;
  boards: SignBoard[];
}

/** Landmarks a board may name. */
export const LANDMARK_KINDS = new Set(['tower', 'landmark', 'ruin', 'watchtower', 'shrine', 'wizard_tower', 'sunken_temple', 'mineshaft', 'meteor_crater']);
/** The farthest landmark a board names (m), and how far off the road's heading it may lie (degrees). */
export const LANDMARK_RANGE_M = 3200;
export const FORWARD_CONE_DEG = 75;
/** Boards per exit post, and exit posts per town. */
export const MAX_BOARDS = 3;
export const MAX_EXITS_PER_TOWN = 3;
/** Sideways offset of an exit post from the road's edge (m). */
export const EXIT_SIDE_M = 2.2;
/** How far outside the town's radius the exit post stands (m). */
export const EXIT_BEYOND_M = 7;
/** A fork post this close already serves an exit (m). */
const FORK_NEAR_M = 30;

/** "420 m" / "1.2 km": distances on boards round to 10 m under a km. */
export function distanceLabel(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

const unit = (x: number, z: number) => {
  const L = Math.hypot(x, z) || 1;
  return { x: x / L, z: z / L };
};

/** Where a road leaves a town: the point `beyond` metres outside its radius along the road, and the road's heading there (away from the town). */
export function exitPoint(road: PRoad, s: PSettlement, beyond: number): { x: number; z: number; dir: { x: number; z: number } } | null {
  const n = Math.floor(road.points.length / 3);
  if (n < 2) return null;
  const px = (i: number) => road.points[i * 3];
  const pz = (i: number) => road.points[i * 3 + 2];
  const d0 = Math.hypot(px(0) - s.x, pz(0) - s.z);
  const d1 = Math.hypot(px(n - 1) - s.x, pz(n - 1) - s.z);
  const fwd = d0 <= d1;
  const near = Math.min(d0, d1);
  if (near > s.radius + 60) return null; // the road does not start at this town
  const want = s.radius + beyond;
  let prevI = fwd ? 0 : n - 1;
  for (let k = 1, i = fwd ? 1 : n - 2; k < n; k++, i += fwd ? 1 : -1) {
    const d = Math.hypot(px(i) - s.x, pz(i) - s.z);
    if (d >= want || k === n - 1) {
      // Interpolate on the segment prevI -> i where the distance crosses `want`.
      const dp = Math.hypot(px(prevI) - s.x, pz(prevI) - s.z);
      const f = d === dp ? 1 : Math.max(0, Math.min(1, (want - dp) / (d - dp)));
      const x = px(prevI) + (px(i) - px(prevI)) * f;
      const z = pz(prevI) + (pz(i) - pz(prevI)) * f;
      const dir = unit(px(i) - px(prevI), pz(i) - pz(prevI));
      return { x, z, dir };
    }
    prevI = i;
  }
  return null;
}

function boardTo(name: string, fx: number, fz: number, tx: number, tz: number, kind: SignBoard['kind']): SignBoard {
  const d = unit(tx - fx, tz - fz);
  return { name, dist: Math.hypot(tx - fx, tz - fz), dx: d.x, dz: d.z, kind };
}

export function placeSignposts(inp: PlacementInput): Signpost[] {
  const out: Signpost[] = [];
  const siteName = (i: number) => inp.sites[i]?.name ?? null;
  // Fork posts: one board per arm that points at a settlement.
  for (const f of inp.forks) {
    const boards: SignBoard[] = [];
    const yaws: number[] = [];
    const armIndex: number[] = [];
    for (const [k, a] of f.arms.entries()) {
      if (a.settlement < 0) continue;
      const s = inp.settlements[a.settlement];
      if (!s) continue;
      boards.push(boardTo(siteName(s.site) ?? `Settlement ${a.settlement + 1}`, f.x, f.z, s.x, s.z, 'town'));
      yaws.push(a.yaw);
      armIndex.push(k);
    }
    if (boards.length) out.push({ id: `f:${f.id}`, kind: 'fork', x: f.x, z: f.z, y: f.y, yaws, armIndex, roadDir: null, settlement: -1, boards });
  }
  // Landmarks and towns a board may name (named, surface only).
  const landmarks = inp.sites.filter((s) => s.name && s.category !== 'settlement' && LANDMARK_KINDS.has(s.kind) && !(s.layer && s.layer > 0));
  const cosCone = Math.cos((FORWARD_CONE_DEG * Math.PI) / 180);
  for (const s of inp.settlements) {
    const exits: Signpost[] = [];
    for (const r of inp.roads) {
      if (r.cls !== 0 || (r.from !== s.index && r.to !== s.index)) continue;
      const e = exitPoint(r, s, EXIT_BEYOND_M);
      if (!e) continue;
      // The post stands beside the road, on its right as you leave the town.
      const side = r.width / 2 + EXIT_SIDE_M;
      const x = e.x + -e.dir.z * side;
      const z = e.z + e.dir.x * side;
      if (inp.forks.some((f) => Math.hypot(f.x - x, f.z - z) < FORK_NEAR_M)) continue;
      const boards: SignBoard[] = [];
      const other = r.from === s.index ? r.to : r.from;
      const od = other >= 0 && other !== s.index ? inp.settlements[other] : undefined;
      const used = new Set<string>();
      if (od) {
        const nm = siteName(od.site);
        if (nm) {
          boards.push(boardTo(nm, x, z, od.x, od.z, 'town'));
          used.add(nm);
        }
      }
      const ahead = (tx: number, tz: number) => {
        const d = unit(tx - x, tz - z);
        return d.x * e.dir.x + d.z * e.dir.z >= cosCone;
      };
      // Nearest named landmarks ahead (then other towns ahead if there is room).
      const cands = landmarks
        .map((l) => ({ l, d: Math.hypot(l.x - x, l.z - z) }))
        .filter((c) => c.d <= LANDMARK_RANGE_M && c.d > 60 && ahead(c.l.x, c.l.z))
        .sort((a, b) => a.d - b.d || a.l.index - b.l.index);
      for (const c of cands) {
        if (boards.length >= MAX_BOARDS) break;
        if (used.has(c.l.name!)) continue;
        if (boards.filter((b) => b.kind === 'landmark').length >= 2) break;
        boards.push(boardTo(c.l.name!, x, z, c.l.x, c.l.z, 'landmark'));
        used.add(c.l.name!);
      }
      if (boards.length < MAX_BOARDS) {
        const towns = inp.settlements
          .filter((t) => t.index !== s.index && ahead(t.x, t.z))
          .map((t) => ({ t, d: Math.hypot(t.x - x, t.z - z) }))
          .sort((a, b) => a.d - b.d || a.t.index - b.t.index);
        for (const c of towns) {
          if (boards.length >= MAX_BOARDS) break;
          const nm = siteName(c.t.site);
          if (!nm || used.has(nm)) continue;
          boards.push(boardTo(nm, x, z, c.t.x, c.t.z, 'town'));
          used.add(nm);
        }
      }
      if (!boards.length) continue;
      boards.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));
      exits.push({ id: `x:${s.index}:${r.index}`, kind: 'exit', x, z, y: Number.NaN, yaws: [], armIndex: [], roadDir: e.dir, settlement: s.index, boards });
    }
    // At most a few exits per town: the ones leading to the nearest towns.
    exits.sort((a, b) => a.boards[0].dist - b.boards[0].dist || a.id.localeCompare(b.id));
    out.push(...exits.slice(0, MAX_EXITS_PER_TOWN));
  }
  return out;
}

/** Unit direction of the arrow on a face, as the reader sees it: rotation from "ahead" (up) clockwise, in radians. The reader faces `f` (into the board). */
export function arrowAngle(fx: number, fz: number, dx: number, dz: number): number {
  // right = f x up = (-fz, fx)
  const ahead = dx * fx + dz * fz;
  const right = dx * -fz + dz * fx;
  return Math.atan2(right, ahead);
}
