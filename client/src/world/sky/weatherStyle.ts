// How each graphics style draws the weather (playtest 2, CR 030). Kept out of
// style/styles.ts's profile table so the styles stay one table of the
// pt2/graphics numbers; these only scale the weather layers.

import type { QualityTier, VisualStyle } from '../../stores/qualityStore';

export interface WeatherLook {
  /** Lightning ribbon width (m) and HDR brightness. */
  boltWidth: number;
  boltIntensity: number;
  /** How much a strike lights the world. */
  flash: number;
  rainbow: number;
  /** Fog bank density multiplier. */
  fogBank: number;
  /** Storm darkening multiplier (sky, sun). */
  stormDark: number;
  /** Snow flake size multiplier and square points. */
  flake: number;
  square: boolean;
  /** Heat shimmer multiplier (0 = off). */
  shimmer: number;
}

export const WEATHER_LOOK: Record<VisualStyle, WeatherLook> = {
  // Soft, luminous: bright bolts in a bloom, full rainbows, rolling banks.
  lodestone: { boltWidth: 1.4, boltIntensity: 7, flash: 1, rainbow: 1, fogBank: 1, stormDark: 0.8, flake: 1, square: false, shimmer: 1 },
  // Bold strokes: thick bolts, saturated bows, bigger flakes.
  painterly: { boltWidth: 2.4, boltIntensity: 5, flash: 0.8, rainbow: 1.3, fogBank: 0.9, stormDark: 0.65, flake: 1.35, square: false, shimmer: 0.6 },
  // Oppressive: darker storms, harsher flashes, washed-out bows, heavier fog.
  grim: { boltWidth: 1.2, boltIntensity: 8, flash: 1.3, rainbow: 0.45, fogBank: 1.35, stormDark: 1, flake: 0.9, square: false, shimmer: 0.8 },
  // Chunky: square flakes, fat bolts, no shimmer (its own wobble is enough).
  retro: { boltWidth: 2.6, boltIntensity: 6, flash: 0.9, rainbow: 0.9, fogBank: 0.8, stormDark: 0.8, flake: 2.4, square: true, shimmer: 0 },
};

/** Particle capacity per quality tier (low stays cheap). */
export const WEATHER_PARTICLES: Record<QualityTier, { snow: number; sand: number; rainScale: number }> = {
  low: { snow: 900, sand: 500, rainScale: 0.5 },
  medium: { snow: 1800, sand: 1000, rainScale: 0.8 },
  high: { snow: 3000, sand: 1600, rainScale: 1 },
  ultra: { snow: 4000, sand: 2200, rainScale: 1 },
};
