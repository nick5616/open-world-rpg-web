// What the local player is standing on, for footsteps (pure; surface.test.ts).
// The engine samples it at 10 Hz from cheap queries it already has: the cave
// depth, the town box under the feet (shelter.ts surfaceUnder), the water
// surface and the atlas biome at the feet.

/** Footstep surfaces (triggers.ts `step` maps them to cues). */
export type StepSurface = 'soft' | 'hard' | 'wood' | 'water' | 'snow';

export interface SurfaceInputs {
  /** CaveManager's 0..1 depth. */
  underground: number;
  /** BOX_KINDS name of the town box underfoot, or null on terrain. */
  box: string | null;
  /** Water surface minus feet height (m); > 0 = wading. */
  waterDepth: number;
  /** Atlas biome name at the feet (BIOMES), or null. */
  biome: string | null;
  inTown: boolean;
}

const WOOD = new Set(['floor', 'upper', 'deck', 'bridgeRamp', 'ramp', 'railing', 'fence']);

export function classifySurface(s: SurfaceInputs): StepSurface {
  if (s.waterDepth > 0.06 && s.waterDepth < 1.4) return 'water';
  if (s.box) return WOOD.has(s.box) ? 'wood' : 'hard';
  if (s.underground > 0.5) return 'hard';
  if (s.inTown) return 'hard';
  if (s.biome === 'snowpeak') return 'snow';
  return 'soft';
}
