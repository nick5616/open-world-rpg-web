// Which one-shots may start (pure; voiceLimit.test.ts). SfxEngine asks
// admit() before every play; the voice pool (oldest stolen per cue, global
// cap by priority) then makes room for what got in.
//
//  - cooldown: a cue's repeats closer than `cooldownMs` collapse into one;
//  - duplicates: the same cue again at (nearly) the same place within
//    DEDUPE_MS is one sound, not two stacked copies (a hit reported twice,
//    two systems voicing the same moment);
//  - stacking: an area hit on eight enemies is not eight identical hits in
//    one frame: at most STACK_MAX starts of a cue per STACK_WINDOW_MS.
//
// And how repeats vary: never the same file twice in a row, a small random
// pitch and gain per play, so footsteps and swings never machine-gun.

import type { Vec3 } from './bridge';

export const DEDUPE_MS = 70;
export const DEDUPE_M = 1.2;
export const STACK_WINDOW_MS = 45;
export const STACK_MAX = 3;

export interface AdmitRules {
  cooldownMs?: number;
  /** Max starts within STACK_WINDOW_MS (default STACK_MAX). */
  stackMax?: number;
}

interface Start {
  t: number;
  at: Vec3 | null;
}

export type Verdict = 'play' | 'cooldown' | 'duplicate' | 'stacked';

export class VoiceLimiter {
  private recent = new Map<string, Start[]>();

  admit(cue: string, now: number, at: Vec3 | null, rules: AdmitRules = {}): Verdict {
    let list = this.recent.get(cue);
    if (!list) this.recent.set(cue, (list = []));
    // Keep only what any rule can still look at.
    const keep = Math.max(rules.cooldownMs ?? 0, DEDUPE_MS, STACK_WINDOW_MS);
    while (list.length && now - list[0].t > keep) list.shift();
    const last = list[list.length - 1];
    if (last && rules.cooldownMs && now - last.t < rules.cooldownMs) return 'cooldown';
    let inWindow = 0;
    for (const s of list) {
      const dt = now - s.t;
      if (dt < DEDUPE_MS) {
        if (!at && !s.at) return 'duplicate';
        if (at && s.at && Math.hypot(at.x - s.at.x, at.y - s.at.y, at.z - s.at.z) < DEDUPE_M) return 'duplicate';
      }
      if (dt < STACK_WINDOW_MS) inWindow++;
    }
    if (inWindow >= (rules.stackMax ?? STACK_MAX)) return 'stacked';
    list.push({ t: now, at: at ? { x: at.x, y: at.y, z: at.z } : null });
    return 'play';
  }
}

/** A variant index in [0, n), never `last` when there is a choice. */
export function pickVariant(n: number, last: number, rnd: () => number = Math.random): number {
  if (n <= 1) return 0;
  if (last < 0 || last >= n) return Math.floor(rnd() * n);
  const k = Math.floor(rnd() * (n - 1));
  return k >= last ? k + 1 : k;
}

/** Playback rate and gain multipliers for one play: +/- pitch, +/- gainVar (both fractions). */
export function variation(pitch: number, gainVar: number, rnd: () => number = Math.random): { rate: number; gain: number } {
  return { rate: 1 + (rnd() * 2 - 1) * pitch, gain: 1 + (rnd() * 2 - 1) * gainVar };
}
