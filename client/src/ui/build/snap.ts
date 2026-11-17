// The build ghost's snapping (CR 041): from the aim point to a grid cell or
// edge, a rotation and a height taken from the sockets of the pieces around
// (a wall onto a foundation edge, a floor onto wall tops, stairs onto a
// floor's edge) or the ground, checked by rules.ts. Pure over its inputs.

import { CAMPS } from '@lodestone/contracts';
import { shapeOf, pieceDef, world, type BP } from './geometry';
import { checkBuild, occOf, REFUSE, type BuildEnv, type BuildWant } from './rules';

export interface SnapInput {
  kind: number;
  rot: number;
  /** Aim point on the ground or a surface (metres). */
  px: number;
  py: number;
  pz: number;
  feet: { x: number; y: number; z: number };
  owner: string;
  party: number;
  /** Pieces within ~20 m. */
  all: readonly BP[];
  env: BuildEnv;
}

export interface Snapped {
  kind: number;
  rot: number;
  /** cm */
  x: number;
  y: number;
  z: number;
  hasY: boolean;
  reason: number;
}

const snapTo = (v: number, par: number): number => Math.round((v - par) / 2) * 2 + par;
const half = (v: number): number => Math.round(v * 2) / 2;

/** Pieces that are a thin edge (walls, fences...): their orientation follows the nearest grid line. */
export function isEdgePiece(kind: number): boolean {
  const sh = shapeOf(kind);
  const d = pieceDef(kind);
  return !!sh?.par && sh.par[0] !== sh.par[1] && !!d && d.d <= 0.5;
}

/** How many rot steps one turn takes (edge pieces flip their facing). */
export const turnStep = (kind: number): number => (isEdgePiece(kind) ? 4 : 2);

function snapXZ(kind: number, rot: number, px: number, pz: number): [number, number] {
  const sh = shapeOf(kind)!;
  if (!sh.par) return [half(px), half(pz)];
  let a = sh.par[0] / 100;
  let b = sh.par[1] / 100;
  if (((rot >> 1) & 1) === 1) [a, b] = [b, a];
  return [snapTo(px, a), snapTo(pz, b)];
}

/** Candidate heights (cm) around (x, z): the sockets and surfaces of nearby pieces, the ground. */
export function candidateHeights(kind: number, x: number, z: number, all: readonly BP[], env: BuildEnv): number[] {
  const out = new Set<number>();
  const sh = shapeOf(kind)!;
  const bp = { rot: 0, x: Math.round(x * 100), y: 0, z: Math.round(z * 100) };
  const g = Math.round(env.heightAt(x, z) * 100);
  out.add(g);
  if (sh.anchor.includes('ground')) {
    const p = world({ ...bp }, sh.gpt[0], sh.gpt[1], 0);
    out.add(Math.round(env.heightAt(p[0] / 100, p[1] / 100) * 100));
  }
  for (const q of all) {
    if (Math.hypot(q.x / 100 - x, q.z / 100 - z) > 6) continue;
    const qs = shapeOf(q.kind);
    if (!qs) continue;
    for (const l of [qs.up, qs.side, qs.face]) for (const p of l) out.add(q.y + p[2]);
    if (qs.surface) {
      out.add(q.y + qs.surface[4]);
      out.add(q.y + qs.surface[5]);
    }
    out.add(q.y);
  }
  return [...out];
}

/** The ghost's spot: the best valid candidate, else the nearest to the aim with its refusal. */
export function snap(inp: SnapInput): Snapped {
  const { kind, px, pz } = inp;
  const sh = shapeOf(kind);
  if (!sh) return { kind, rot: inp.rot, x: 0, y: 0, z: 0, hasY: false, reason: REFUSE.unknown };
  // Orientation: an edge piece takes the grid line nearer the aim, keeping its facing.
  let rot = inp.rot;
  if (isEdgePiece(kind)) {
    const side = rot & 4;
    let best = Infinity;
    for (const r of [side, side | 2]) {
      const [sx, sz] = snapXZ(kind, r, px, pz);
      const d = Math.hypot(sx - px, sz - pz);
      if (d < best - 1e-9) {
        best = d;
        rot = r;
      }
    }
  }
  const [x, z] = snapXZ(kind, rot, px, pz);
  const want = (y: number | null): BuildWant => ({ kind, rot, x: Math.round(x * 100), y: y ?? 0, z: Math.round(z * 100), hasY: y !== null, owner: inp.owner, party: inp.party, feetX: inp.feet.x, feetY: inp.feet.y, feetZ: inp.feet.z });
  // A foundation takes the ground (or a flush neighbour) by itself.
  if (sh.anchor.includes('foundation')) {
    const r = checkBuild(want(null), inp.all, inp.env);
    return { kind, rot, x: Math.round(x * 100), y: r.reason === 0 ? r.y : Math.round(inp.env.heightAt(x, z) * 100), z: Math.round(z * 100), hasY: false, reason: r.reason };
  }
  const ys = candidateHeights(kind, x, z, inp.all, inp.env).sort((a, b) => Math.abs(a / 100 - inp.py) - Math.abs(b / 100 - inp.py));
  let first: { y: number; reason: number } | null = null;
  for (const y of ys) {
    const r = checkBuild(want(y), inp.all, inp.env);
    if (r.reason === 0) return { kind, rot, x: Math.round(x * 100), y: r.y, z: Math.round(z * 100), hasY: true, reason: 0 };
    first ??= { y, reason: r.reason };
  }
  // None valid: show it where the aim says, with the nearest candidate's reason.
  const f = first ?? { y: Math.round(inp.env.heightAt(x, z) * 100), reason: REFUSE.support };
  return { kind, rot, x: Math.round(x * 100), y: f.y, z: Math.round(z * 100), hasY: true, reason: f.reason };
}

/** March a view ray (eye, unit dir) to the first point under the ground or inside a surface top; up to `max` metres. */
export function aimPoint(eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, groundAt: (x: number, z: number) => number, surfaceAt: (x: number, z: number, y: number) => number | null, max = 8): { x: number; y: number; z: number; hit: boolean } {
  let last = { x: eye.x, y: eye.y, z: eye.z };
  for (let t = 0.25; t <= max; t += 0.25) {
    const x = eye.x + dir.x * t;
    const y = eye.y + dir.y * t;
    const z = eye.z + dir.z * t;
    const gy = Math.max(groundAt(x, z), surfaceAt(x, z, y) ?? -Infinity);
    if (y <= gy) return { x, y: gy, z, hit: true };
    last = { x, y, z };
  }
  return { x: last.x, y: Math.max(groundAt(last.x, last.z), 0), z: last.z, hit: false };
}

/** The piece under the crosshair: the nearest piece whose occupancy box (grown) the view ray enters. */
export function aimPiece(eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, pieces: readonly BP[], reach = CAMPS.build.reachM): BP | null {
  const boxes = pieces
    .filter((p) => Math.hypot(p.x / 100 - eye.x, p.z / 100 - eye.z) < reach + 3)
    .map((p) => {
      const sh = shapeOf(p.kind);
      return sh ? { p, b: occOf(p, sh) } : null;
    })
    .filter((v): v is { p: BP; b: ReturnType<typeof occOf> } => !!v);
  const g = 0.12;
  for (let t = 0.3; t <= reach; t += 0.1) {
    const x = (eye.x + dir.x * t) * 100;
    const y = (eye.y + dir.y * t) * 100;
    const z = (eye.z + dir.z * t) * 100;
    let hit: BP | null = null;
    let area = Infinity;
    for (const { p, b } of boxes) {
      if (x < b[0] - g * 100 || x > b[1] + g * 100 || z < b[2] - g * 100 || z > b[3] + g * 100 || y < b[4] - g * 100 || y > b[5] + g * 100) continue;
      const a = (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4]);
      if (a < area) {
        area = a; // the smallest box wins (a torch on a wall)
        hit = p;
      }
    }
    if (hit) return hit;
  }
  return null;
}
