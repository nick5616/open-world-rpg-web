// Playtest 2 fishing wire glue (CR 026): Interact 88, Events 1080-1084,
// the texts, and where a cast lands. Pure: tested in fishing.test.ts.

import { CONTENT, type FishDef } from '@lodestone/contracts';

export const FISH_INTERACT = 88;
export const FISH_ACT = { cast: 1, hook: 2, land: 3, lose: 4, devRod: 9 } as const;
export const FEV = { cast: 1080, hooked: 1081, caught: 1082, lost: 1083, refused: 1084 } as const;
export const LOST = { early: 1, missed: 2, snapped: 3, escaped: 4, cancelled: 5, walked: 6, quick: 7, long: 8, full: 9 } as const;

export const FISH_LOST_TEXT: Record<number, string> = {
  1: 'Too soon: you spooked it',
  2: 'It got away (strike when the float goes under)',
  3: 'The line snapped!',
  4: 'It slipped the hook',
  5: 'You reeled in',
  6: 'You walked away from your line',
  7: 'It got away',
  8: 'It tired you out',
  9: 'Your pack is full',
};

export const FISH_REFUSAL_TEXT: Record<number, string> = {
  1: 'You need a fishing rod (general stores and tool merchants sell them, or forge one)',
  2: 'No water deep enough there',
  3: 'Out of reach',
  4: 'Not so fast',
  5: 'Your line is already out',
  6: 'Not now',
  7: 'Not now',
};

export const ROD = CONTENT.fishing.rod;
const FI = CONTENT.fishing;

export function fishById(id: number): FishDef | null {
  return FI.species[id - 1] ?? null;
}

export function rarityName(r: number): string {
  return FI.rarities[r]?.key ?? 'common';
}

export function rarityColor(r: number): string {
  return FI.rarities[r]?.color ?? '#c9d1d9';
}

/** Weight text: 340 g, 2.4 kg. */
export function weightText(g: number): string {
  return g < 1000 ? `${g} g` : `${(g / 1000).toFixed(g < 10000 ? 2 : 1)} kg`;
}

/** Interact 88/1 targetId: x cm | z cm << 32 (u32 each). */
export function packCast(x: number, z: number): bigint {
  const u = (v: number) => BigInt(Math.max(0, Math.min(0xffffffff, Math.round(v * 100))) >>> 0);
  return u(x) | (u(z) << 32n);
}

export interface WaterGround {
  heightAt(x: number, z: number): number;
  waterAt?(x: number, z: number): number;
}

export interface CastPoint {
  x: number;
  y: number;
  z: number;
  d: number;
}

/** Deep enough open water at (x, z): its surface height, else null. */
export function waterSurface(g: WaterGround, x: number, z: number, minDepth: number = FI.minDepthM): number | null {
  const w = g.waterAt ? g.waterAt(x, z) : -Infinity;
  if (!Number.isFinite(w) || w - g.heightAt(x, z) < minDepth + 0.05) return null;
  return w;
}

/**
 * Where a cast from the eye along the view lands: the first deep-enough
 * water along the ground track, as near as possible to where the view ray
 * meets the water (looking up or level: the far end of the cast range);
 * 4 m to (castM max - 3) out. Null when there is no water in front of you.
 */
export function castPoint(g: WaterGround, eye: { x: number; y: number; z: number }, yaw: number, pitch: number): CastPoint | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const near = Math.max(4, FI.castM[0] + 1);
  const far = FI.castM[1] - 3;
  let want = far;
  if (pitch < -0.03) {
    // where the view ray drops to the water level near you
    const probe = waterSurface(g, eye.x + fx * 8, eye.z + fz * 8) ?? eye.y - 1.6;
    want = Math.max(near, Math.min(far, (eye.y - probe) / Math.tan(-pitch)));
  }
  let best: CastPoint | null = null;
  for (let d = near; d <= far + 1e-6; d += 0.5) {
    const x = eye.x + fx * d;
    const z = eye.z + fz * d;
    const w = waterSurface(g, x, z);
    if (w === null || w > eye.y + 1.4 || w < eye.y - 18) continue;
    if (!best || Math.abs(d - want) < Math.abs(best.d - want)) best = { x, y: w, z, d };
  }
  return best;
}
