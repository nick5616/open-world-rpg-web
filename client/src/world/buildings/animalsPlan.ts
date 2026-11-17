// Which animals live in which town (playtest 4, CR 050): chickens pecking
// near the farms, a dog or two trotting the streets (the first one follows
// a passer-by a few steps), cats on the doorsteps. Pure and deterministic
// from the settlement's id: every client plans the same animals, nothing
// is sent over the wire. Halved on the Low quality tier.

import { h32 } from './npcLines';

export const ANIMAL = { chicken: 0, dog: 1, cat: 2 } as const;

export interface AnimalSpec {
  kind: number;
  x: number;
  z: number;
  /** Hash for tints and timers. */
  seed: number;
  /** Chickens: the farm they stay near; dogs: the settlement; cats: the door they sit by. */
  home: number;
  /** The one dog that tags along behind a visitor. */
  follower: boolean;
}

export interface PlanInput {
  /** Settlement id (any stable number: the low 32 bits are used). */
  id: number;
  /** 0 hamlet, 1 village, 2 town. */
  size: number;
  x: number;
  z: number;
  /** Farmers' work spots (the fields). */
  farms: { x: number; z: number }[];
  /** Spots just outside doors of the settlement's buildings (cat seats), already offset to the side. */
  doors: { x: number; z: number }[];
}

export const MAX_CHICKENS = 10;

/** The animals of one settlement (halved when `low`). */
export function planAnimals(p: PlanInput, low: boolean): AnimalSpec[] {
  const out: AnimalSpec[] = [];
  const sid = p.id >>> 0;
  // Chickens: 3-5 around each of the first two farms (a farm's yard is small).
  const farms = p.farms.slice(0, 2);
  let chickens = 0;
  farms.forEach((f, fi) => {
    const n = 3 + (h32(sid, fi, 1) % 3);
    for (let k = 0; k < n && chickens < MAX_CHICKENS; k++) {
      if (low && k % 2 === 1) continue;
      const a = ((h32(sid, fi * 16 + k, 2) % 628) / 100) * 1;
      const r = 0.8 + (h32(sid, fi * 16 + k, 3) % 30) / 10;
      out.push({ kind: ANIMAL.chicken, x: f.x + Math.cos(a) * r, z: f.z + Math.sin(a) * r, seed: h32(sid, fi * 16 + k, 4), home: fi, follower: false });
      chickens++;
    }
  });
  // Dogs: none to one in a hamlet, one in a village, two in a town.
  const dogs = p.size >= 2 ? 2 : p.size === 1 ? 1 : h32(sid, 5, 5) % 2;
  for (let k = 0; k < Math.min(dogs, low ? 1 : 2); k++) {
    const a = (h32(sid, k, 6) % 628) / 100;
    const r = 4 + (h32(sid, k, 7) % 80) / 10;
    out.push({ kind: ANIMAL.dog, x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, seed: h32(sid, k, 8), home: 0, follower: k === 0 });
  }
  // Cats: one per six doors, at most four (two on Low), on the sunniest steps (hash order).
  const want = Math.min(low ? 2 : 4, Math.floor(p.doors.length / 6));
  const order = p.doors.map((d, i) => ({ d, i, h: h32(sid, i, 9) })).sort((a, b) => a.h - b.h || a.i - b.i);
  for (let k = 0; k < want; k++) out.push({ kind: ANIMAL.cat, x: order[k].d.x, z: order[k].d.z, seed: order[k].h, home: order[k].i, follower: false });
  return out;
}

/** Where a dog that follows a visitor heads: `gap` metres short of them, on the line from them to the dog. */
export function followGoal(dx: number, dz: number, px: number, pz: number, gap: number): { x: number; z: number; arrived: boolean } {
  const d = Math.hypot(dx - px, dz - pz);
  if (d <= gap + 0.25) return { x: dx, z: dz, arrived: true };
  const k = gap / d;
  return { x: px + (dx - px) * k, z: pz + (dz - pz) * k, arrived: false };
}

/** Pecking pitch of a chicken t seconds into a peck cycle of `period` s: dips twice quickly, then looks up. */
export function peckPitch(t: number, period: number): number {
  const u = (t % period) / period;
  if (u > 0.55) return 0;
  const s = Math.sin((u / 0.55) * Math.PI * 2 * 1.5);
  return -0.9 * Math.max(0, s);
}

/** Leg swing (radians) of a trotting dog at phase ph for leg `leg` (0 front-left, 1 front-right, 2 back-left, 3 back-right): a diagonal gait. */
export function trotLeg(ph: number, leg: number): number {
  const diagonal = leg === 0 || leg === 3 ? 0 : Math.PI;
  return Math.sin(ph + diagonal) * 0.7;
}
