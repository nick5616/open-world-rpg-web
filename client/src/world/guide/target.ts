// What the guiding wisp leads to (CR 052): the tracked quest's nearest marker,
// else your own map pin, else a party pin. Pure; the layer feeds it the live
// markers and pins.

import type { Pt } from './route';

export interface GuideGoal extends Pt {
  kind: 'quest' | 'pin';
  label: string;
}

export interface MarkerLike {
  x: number;
  z: number;
  r?: number;
  label?: string;
}

export interface PinLike {
  x: number;
  z: number;
  party: boolean;
}

/** A marker with a radius is an area: lead to a point inside its edge, on the near side, not its centre. */
export function goalOf(from: Pt, m: MarkerLike): Pt {
  const r = m.r ?? 0;
  if (r <= 0) return { x: m.x, z: m.z };
  const d = Math.hypot(m.x - from.x, m.z - from.z);
  if (d <= r * 0.5) return { x: from.x, z: from.z };
  const k = (r * 0.4) / d;
  return { x: m.x + (from.x - m.x) * k, z: m.z + (from.z - m.z) * k };
}

export function pickGuideGoal(from: Pt, markers: MarkerLike[], pins: PinLike[]): GuideGoal | null {
  let best: MarkerLike | null = null;
  let bd = Infinity;
  for (const m of markers) {
    const d = Math.hypot(m.x - from.x, m.z - from.z) - (m.r ?? 0);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  if (best) return { ...goalOf(from, best), kind: 'quest', label: best.label ?? '' };
  const mine = pins.find((p) => !p.party) ?? pins[0];
  if (mine) return { x: mine.x, z: mine.z, kind: 'pin', label: 'your pin' };
  return null;
}
