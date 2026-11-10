// The placement preview's rules (playtest 2 camps, CR 025): a TS mirror of
// server/pkg/camps Check, pure over an environment so vitest can drive it.
// The zone is the authority (it also refuses a solid piece on someone's
// feet and knows every camp); the ghost turns red for everything the client
// can see: reach, settlements, slope, water, structures, overlaps, someone
// else's camp, your camp's limits and area, a missing kit, caves.

import { CAMPS, WORLD_SIZE_M } from '@lodestone/contracts';
import { rotCS } from './collide';

export interface Footprint {
  x: number;
  z: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
}

export function footprint(kind: number, rot: number, x: number, z: number): Footprint {
  const p = CAMPS.pieces[kind - 1];
  const [c, s] = rotCS(rot);
  return { x, z, c, s, hx: (p?.w ?? 1) / 2, hz: (p?.d ?? 1) / 2 };
}

export function corners(f: Footprint, g = 0): [number, number][] {
  const hx = f.hx + g;
  const hz = f.hz + g;
  return (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const
  ).map(([a, b]) => {
    const u = a * hx;
    const v = b * hz;
    return [f.x + u * f.c - v * f.s, f.z + u * f.s + v * f.c] as [number, number];
  });
}

export const radius = (f: Footprint) => Math.hypot(f.hx, f.hz);

/** Separating axes: do two footprints, each grown by g, overlap? */
export function overlaps(a: Footprint, b: Footprint, g = 0): boolean {
  if (Math.hypot(a.x - b.x, a.z - b.z) > radius(a) + radius(b) + 2 * g) return false;
  const ca = corners(a, g);
  const cb = corners(b, g);
  const axes = [
    [a.c, a.s],
    [-a.s, a.c],
    [b.c, b.s],
    [-b.s, b.c],
  ];
  for (const [ax, az] of axes) {
    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (let i = 0; i < 4; i++) {
      const pa = ca[i][0] * ax + ca[i][1] * az;
      const pb = cb[i][0] * ax + cb[i][1] * az;
      amin = Math.min(amin, pa);
      amax = Math.max(amax, pa);
      bmin = Math.min(bmin, pb);
      bmax = Math.max(bmax, pb);
    }
    if (amax <= bmin || bmax <= amin) return false;
  }
  return true;
}

/** Distance from (x, z) to the footprint (0 inside). */
export function distTo(f: Footprint, x: number, z: number): number {
  const dx = x - f.x;
  const dz = z - f.z;
  const u = dx * f.c + dz * f.s;
  const v = dz * f.c - dx * f.s;
  return Math.hypot(Math.max(0, Math.abs(u) - f.hx), Math.max(0, Math.abs(v) - f.hz));
}

export interface PlaceEnv {
  heightAt(x: number, z: number): number;
  waterAt(x: number, z: number): number;
  inTown(x: number, z: number, margin: number): boolean;
  structure(f: Footprint): boolean;
}

export interface Placed {
  id: number;
  kind: number;
  rot: number;
  x: number;
  z: number;
  mine: boolean;
}

export interface Want {
  kind: number;
  rot: number;
  x: number;
  z: number;
  feetX: number;
  feetY: number;
  feetZ: number;
  /** Kits of this kind in the pack. */
  kits: number;
}

/** The footprint's base height (mean of corners and centre, to the cm), or null when too steep or uneven. */
export function baseHeight(f: Footprint, env: PlaceEnv): number | null {
  const pts = [...corners(f), [f.x, f.z] as [number, number]];
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (const [x, z] of pts) {
    const h = env.heightAt(x, z);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
    sum += h;
  }
  const pl = CAMPS.placement;
  const spread = hi - lo;
  if (spread > pl.maxSpreadM || spread > Math.tan((pl.maxSlopeDeg * Math.PI) / 180) * Math.max(2 * radius(f), 1)) return null;
  return Math.round((sum / 5) * 100) / 100;
}

/** 0 = valid (with the base height), else the refusal reason (events.ts CAMP_REFUSAL). */
export function checkPlacement(w: Want, near: readonly Placed[], env: PlaceEnv): { y: number; reason: number } {
  const d = CAMPS;
  const p = d.pieces[w.kind - 1];
  const no = (reason: number) => ({ y: 0, reason });
  if (!p) return no(1);
  if (w.kits < 1) return no(11);
  if (Math.hypot(w.x - w.feetX, w.z - w.feetZ) > d.limits.reachM) return no(2);
  if (w.x < 4 || w.z < 4 || w.x > WORLD_SIZE_M - 4 || w.z > WORLD_SIZE_M - 4) return no(2);
  let own = 0;
  let ofKind = 0;
  let anchor: Placed | null = null;
  for (const q of near) {
    if (!q.mine) continue;
    own++;
    if (q.kind === w.kind) ofKind++;
    if (!anchor || q.id < anchor.id) anchor = q;
  }
  if (own >= d.limits.maxPieces) return no(8);
  if (ofKind >= p.max) return no(9);
  if (anchor && Math.hypot(w.x - anchor.x, w.z - anchor.z) > d.limits.campRadiusM) return no(10);
  if (env.inTown(w.x, w.z, d.placement.townMarginM)) return no(3);
  if (w.feetY < env.heightAt(w.x, w.z) - d.placement.maxDepthM) return no(13);
  const f = footprint(w.kind, w.rot, w.x, w.z);
  const y = baseHeight(f, env);
  if (y === null) return no(4);
  for (const [x, z] of [...corners(f), [w.x, w.z]]) if (env.waterAt(x, z) > env.heightAt(x, z) - 0.05) return no(5);
  for (const q of near) {
    const qf = footprint(q.kind, q.rot, q.x, q.z);
    if (!q.mine && distTo(qf, w.x, w.z) < d.placement.otherCampM + radius(f)) return no(7);
    if (overlaps(f, qf, d.placement.gapM / 2)) return no(6);
  }
  if (env.structure(f)) return no(6);
  return { y, reason: 0 };
}

/** Where the ghost goes: `dist` metres ahead of the feet along the view, snapped to the centimetre. */
export function ghostSpot(feetX: number, feetZ: number, yaw: number, dist: number): { x: number; z: number } {
  const x = feetX - Math.sin(yaw) * dist;
  const z = feetZ - Math.cos(yaw) * dist;
  return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
}

/** The rotation step that faces the piece's front (local +z) toward the player, from the view yaw. */
export function facingRot(yaw: number): number {
  const steps = Math.round(-yaw / (Math.PI / 4));
  return ((steps % 8) + 8) % 8;
}
