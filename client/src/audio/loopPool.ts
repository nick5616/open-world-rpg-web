// Which positional loops sound (pure; loopPool.test.ts). The world can hold
// hundreds of fires (every torch, hearth and brazier of a town, burning
// grass); only the loudest few at the listener get a voice, the rest cost
// nothing. Each pass (10 Hz) scores every emitter in range by what you would
// actually hear (category level x distance curve x occlusion), keeps the top
// MAX_LOOP_VOICES, and favours the ones already playing so two similar fires
// don't swap voices back and forth.

import { distanceGain, LOOP_PROFILES, occlusion, airLowpassHz, type LoopKind } from './spatial';

export const MAX_LOOP_VOICES = 8;
/** Quieter than this (about -46 dB) is not worth a voice. */
export const MIN_LOOP_GAIN = 0.005;
/** A playing voice keeps its slot unless a newcomer is this much louder. */
export const KEEP_BIAS = 1.6;

export interface LoopEmitter {
  /** Stable id (a prop's stable id, a fire cluster key). */
  id: string;
  kind: LoopKind;
  x: number;
  y: number;
  z: number;
  /** Extra level multiplier (a big wildfire > a small one). */
  level?: number;
  /** Range multiplier (a big wildfire carries further). */
  reach?: number;
  /** SPACE_OUTDOORS, SPACE_CAVE or the building index it is in. */
  space: number;
}

export interface LoopListener {
  x: number;
  y: number;
  z: number;
  space: number;
  /** caveLeak for surface sources when the listener is underground. */
  leak: number;
}

export interface LoopTarget {
  emitter: LoopEmitter;
  /** Final linear gain (category level included). */
  gain: number;
  /** Air + occlusion low-pass. */
  lowpassHz: number;
  distance: number;
}

/** What one emitter sounds like at the listener (gain 0 = inaudible). */
export function loopTarget(e: LoopEmitter, l: LoopListener): LoopTarget {
  const p = LOOP_PROFILES[e.kind];
  const reach = e.reach ?? 1;
  const d = Math.hypot(e.x - l.x, e.y - l.y, e.z - l.z);
  const g = distanceGain(d, { ref: p.ref * reach, max: p.max * reach });
  if (g <= 0) return { emitter: e, gain: 0, lowpassHz: 20000, distance: d };
  const o = occlusion(l.space, e.space, l.leak);
  return { emitter: e, gain: p.level * (e.level ?? 1) * g * o.gain, lowpassHz: Math.min(airLowpassHz(d), o.lowpassHz), distance: d };
}

/** The loops to voice now, loudest first; `playing` = ids that have a voice. */
export function selectLoops(emitters: Iterable<LoopEmitter>, l: LoopListener, playing: ReadonlySet<string>, max = MAX_LOOP_VOICES): LoopTarget[] {
  const all: { t: LoopTarget; score: number }[] = [];
  for (const e of emitters) {
    const t = loopTarget(e, l);
    if (t.gain < MIN_LOOP_GAIN) continue;
    all.push({ t, score: playing.has(e.id) ? t.gain * KEEP_BIAS : t.gain });
  }
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, max).map((x) => x.t);
}

/**
 * Burning chemistry cells -> a few fire emitters: cells are bucketed on a
 * `cell` metre grid and each bucket becomes one fire at its centroid, louder
 * and carrying further the more cells burn in it.
 */
export function clusterFires(cells: Iterable<{ x: number; y: number; z: number }>, space: (x: number, y: number, z: number) => number, cell = 12): LoopEmitter[] {
  const buckets = new Map<string, { x: number; y: number; z: number; n: number }>();
  for (const c of cells) {
    const k = `${Math.floor(c.x / cell)},${Math.floor(c.z / cell)}`;
    const b = buckets.get(k);
    if (b) {
      b.x += c.x;
      b.y += c.y;
      b.z += c.z;
      b.n++;
    } else buckets.set(k, { x: c.x, y: c.y, z: c.z, n: 1 });
  }
  const out: LoopEmitter[] = [];
  for (const [k, b] of buckets) {
    const x = b.x / b.n;
    const y = b.y / b.n;
    const z = b.z / b.n;
    out.push({ id: `fire:${k}`, kind: 'wildfire', x, y, z, level: Math.min(1, 0.35 + b.n / 24), reach: Math.min(1.6, 0.6 + Math.sqrt(b.n) / 6), space: space(x, y, z) });
  }
  return out;
}
