// Distance, air and occlusion: how loud and how bright a sound placed in the
// world is at the listener. Pure (no Web Audio) so the curves are unit-tested
// (spatial.test.ts); sfx.ts (one-shots) and loops.ts (fires, water) apply them
// as plain gains and low-pass cutoffs, with the PannerNode doing direction
// only (rolloffFactor 0). The Web Audio distance models never reach silence
// (inverse clamps at maxDistance), so a sound used to jump from -23 dB to
// nothing at its range; here every curve eases to exactly zero at `max`.

/** How a category of sound falls off with distance (metres). */
export interface Falloff {
  /** Full volume inside this radius. */
  ref: number;
  /** Silent from here (and never started / culled). */
  max: number;
  /** Inverse-distance steepness (1 = physical 6 dB per doubling). */
  rolloff?: number;
}

/** The last 35 % of the range eases (raised cosine) into silence. */
export const FADE_TAIL = 0.35;

/**
 * Gain at distance d: 1 inside `ref`, inverse distance beyond it
 * (ref / (ref + rolloff * (d - ref)), the Web Audio "inverse" model), times a
 * raised-cosine tail over the last FADE_TAIL of the range so it reaches 0 at
 * `max` without a step.
 */
export function distanceGain(d: number, f: Falloff): number {
  if (!(d >= 0)) d = 0;
  const { ref, max } = f;
  if (d >= max) return 0;
  const r = f.rolloff ?? 1;
  let g = d <= ref ? 1 : ref / (ref + r * (d - ref));
  const tail = max - (max - ref) * FADE_TAIL;
  if (d > tail) g *= 0.5 * (1 + Math.cos((Math.PI * (d - tail)) / (max - tail)));
  return g;
}

/** Air absorption: far sounds lose their top end (~16 kHz at 10 m, ~5 kHz at 60 m). */
export function airLowpassHz(d: number): number {
  return Math.min(20000, Math.max(1800, 20000 * Math.exp(-Math.max(0, d) / 45)));
}

/** A low-pass cutoff at or above this is not worth a filter node. */
export const LOWPASS_BYPASS_HZ = 15000;

/**
 * Where a point is, for occlusion: outdoors, inside building `b` (towns
 * buffer index, enclosed buildings only), or in a cave.
 */
export const SPACE_OUTDOORS = -1;
export const SPACE_CAVE = -2;

export interface Occlusion {
  gain: number;
  lowpassHz: number;
}

const OPEN: Occlusion = { gain: 1, lowpassHz: 20000 };

/**
 * Walls and rock between a source and the listener. `leak` is how much of
 * the surface reaches the listener when they are in a cave (acoustics.ts
 * caveLeak: 1 at the mouth, ~0 deep inside).
 */
export function occlusion(listenerSpace: number, sourceSpace: number, leak = 1): Occlusion {
  if (listenerSpace === sourceSpace) return OPEN;
  if (listenerSpace === SPACE_CAVE) return { gain: Math.max(0, Math.min(1, leak)), lowpassHz: 350 + 7000 * Math.pow(Math.max(0, Math.min(1, leak)), 1.5) };
  if (sourceSpace === SPACE_CAVE) return { gain: 0.15, lowpassHz: 500 };
  // One wall (in <-> out) or two (building to building).
  if (listenerSpace === SPACE_OUTDOORS || sourceSpace === SPACE_OUTDOORS) return { gain: 0.42, lowpassHz: 1100 };
  return { gain: 0.22, lowpassHz: 700 };
}

/** Kinds of positional loops (loops.ts renders one buffer per family). */
export type LoopKind = 'torch' | 'brazier' | 'campfire' | 'hearth' | 'forge' | 'wildfire' | 'river' | 'shore';

export interface LoopProfile extends Falloff {
  /** Which rendered loop buffer. */
  family: 'fire' | 'flow' | 'lap';
  /** Linear mix level at full volume. */
  level: number;
  /** Playback rate (a small fire is quicker and brighter, a forge deeper). */
  rate: number;
}

/** Per-category ranges: a torch is heard across a room, a campfire across a camp, a river across a valley floor. */
export const LOOP_PROFILES: Record<LoopKind, LoopProfile> = {
  torch: { family: 'fire', ref: 1.2, max: 12, level: 0.22, rate: 1.3 },
  brazier: { family: 'fire', ref: 1.8, max: 18, level: 0.34, rate: 1.12 },
  hearth: { family: 'fire', ref: 2, max: 16, level: 0.4, rate: 1.05 },
  campfire: { family: 'fire', ref: 2.5, max: 26, level: 0.55, rate: 1 },
  forge: { family: 'fire', ref: 3, max: 30, level: 0.6, rate: 0.78 },
  wildfire: { family: 'fire', ref: 5, max: 60, level: 0.8, rate: 0.9 },
  river: { family: 'flow', ref: 6, max: 55, level: 0.5, rate: 1 },
  shore: { family: 'lap', ref: 4, max: 34, level: 0.32, rate: 1 },
};
