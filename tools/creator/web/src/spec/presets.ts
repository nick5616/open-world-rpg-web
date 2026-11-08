// Presets (spec 6, way 2): partial WorldSpecs laid over the current seed's
// spec, so "Highland" on seed 7 and "Highland" on seed 8 are different
// highlands. They set the terrain/climate/biome character and leave name and
// seed alone. Weight groups are replaced whole (a preset that names only
// some biomes would otherwise inherit the seed's lean for the others).
// Every value must already be in range: test/presets.test.ts normalizes each
// preset over several seeds and fails on any clamp other than renormalizing.
import type { WorldSpec } from '@lodestone/contracts';

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  spec: Partial<Omit<WorldSpec, 'name' | 'seed' | 'specVersion'>>;
}

export const PRESETS: Preset[] = [
  {
    id: 'archipelago',
    label: 'Archipelago',
    blurb: 'Scattered islands, wet coasts, storms',
    spec: {
      seaLevel: 0.62, landFraction: 0.34, mountainHeight: 0.45, roughness: 0.55, plateaus: 0.1, riverDensity: 0.4,
      temperatureBias: 0.1, moistureBias: 0.35, stormFrequency: 0.55,
      biomeWeights: { meadow: 0.8, forest: 0.75, highlands: 0.35, snowpeak: 0.15, badlands: 0.15, wetland: 1 },
      elementWeights: { fire: 0.3, ice: 0.4, lightning: 1, earth: 0.4, wind: 0.9, light: 0.5, dark: 0.5, void: 0.1 },
      settlementDensity: 0.55, structureDensity: 0.6,
      palette: 'verdant', lootThemes: ['drowned', 'ancient'], nameGrammar: 'coastal',
    },
  },
  {
    id: 'highland',
    label: 'Highland',
    blurb: 'High peaks, deep caves, cold winds',
    spec: {
      seaLevel: 0.25, landFraction: 0.82, mountainHeight: 0.95, roughness: 0.75, plateaus: 0.3, riverDensity: 0.6,
      temperatureBias: -0.3, moistureBias: 0.1, stormFrequency: 0.4,
      biomeWeights: { meadow: 0.4, forest: 0.6, highlands: 1, snowpeak: 0.8, badlands: 0.15, wetland: 0.2 },
      elementWeights: { fire: 0.3, ice: 0.6, lightning: 0.5, earth: 1, wind: 0.8, light: 0.4, dark: 0.4, void: 0.1 },
      caveDensity: 0.75, caveMaxDepth: 230, oreAbundance: 0.7,
      palette: 'autumn', lootThemes: ['ancient', 'royal'], nameGrammar: 'highland',
    },
  },
  {
    id: 'badlands',
    label: 'Badlands',
    blurb: 'Dry mesas, fire in the rocks, bandits',
    spec: {
      seaLevel: 0.22, landFraction: 0.85, mountainHeight: 0.6, roughness: 0.6, plateaus: 0.85, riverDensity: 0.2,
      temperatureBias: 0.55, moistureBias: -0.8, stormFrequency: 0.15,
      biomeWeights: { meadow: 0.25, forest: 0.1, highlands: 0.5, snowpeak: 0.05, badlands: 1, wetland: 0.05 },
      elementWeights: { fire: 1, ice: 0.05, lightning: 0.6, earth: 0.8, wind: 0.5, light: 0.6, dark: 0.3, void: 0.15 },
      flammability: 0.9, enemyDensity: 0.6,
      palette: 'ashen', lootThemes: ['bandit', 'infernal'], nameGrammar: 'austere',
    },
  },
  {
    id: 'frostreach',
    label: 'Frostreach',
    blurb: 'Snowbound, long nights, fierce demons',
    spec: {
      seaLevel: 0.35, landFraction: 0.7, mountainHeight: 0.8, roughness: 0.55, plateaus: 0.2, riverDensity: 0.35,
      temperatureBias: -0.85, moistureBias: 0.2, stormFrequency: 0.6,
      biomeWeights: { meadow: 0.2, forest: 0.6, highlands: 0.6, snowpeak: 1, badlands: 0.05, wetland: 0.15 },
      elementWeights: { fire: 0.2, ice: 1, lightning: 0.4, earth: 0.5, wind: 0.7, light: 0.5, dark: 0.6, void: 0.2 },
      nightLength: 0.55, demonIntensity: 0.75, flammability: 0.2,
      palette: 'frost', lootThemes: ['ancient', 'celestial'], nameGrammar: 'austere',
    },
  },
  {
    id: 'mirewood',
    label: 'Mirewood',
    blurb: 'Fens and old forest, rivers everywhere',
    spec: {
      seaLevel: 0.5, landFraction: 0.65, mountainHeight: 0.35, roughness: 0.4, plateaus: 0.05, riverDensity: 0.9,
      temperatureBias: 0.15, moistureBias: 0.8, stormFrequency: 0.45,
      biomeWeights: { meadow: 0.35, forest: 0.9, highlands: 0.2, snowpeak: 0.05, badlands: 0.05, wetland: 1 },
      elementWeights: { fire: 0.15, ice: 0.2, lightning: 0.4, earth: 0.6, wind: 0.3, light: 0.3, dark: 0.9, void: 0.35 },
      flammability: 0.2, demonIntensity: 0.6,
      palette: 'twilight', lootThemes: ['feral', 'sylvan'], nameGrammar: 'pastoral',
    },
  },
  {
    id: 'verdant-vale',
    label: 'Verdant Vale',
    blurb: 'Gentle meadows and towns, a soft start',
    spec: {
      seaLevel: 0.35, landFraction: 0.75, mountainHeight: 0.45, roughness: 0.35, plateaus: 0.15, riverDensity: 0.6,
      temperatureBias: 0.15, moistureBias: 0.15, stormFrequency: 0.2,
      biomeWeights: { meadow: 1, forest: 0.8, highlands: 0.4, snowpeak: 0.2, badlands: 0.15, wetland: 0.3 },
      elementWeights: { fire: 0.5, ice: 0.3, lightning: 0.4, earth: 0.7, wind: 0.6, light: 0.9, dark: 0.3, void: 0.05 },
      dangerCurve: 0.3, enemyDensity: 0.35, demonIntensity: 0.3, settlementDensity: 0.85,
      palette: 'golden', lootThemes: ['rustic', 'royal'], nameGrammar: 'pastoral',
    },
  },
  {
    id: 'starfall',
    label: 'Starfall Wilds',
    blurb: 'Meteor scars, shining gems, strange towers',
    spec: {
      seaLevel: 0.38, landFraction: 0.7, mountainHeight: 0.7, roughness: 0.65, plateaus: 0.45, riverDensity: 0.45,
      temperatureBias: 0, moistureBias: -0.2, stormFrequency: 0.5,
      biomeWeights: { meadow: 0.6, forest: 0.5, highlands: 0.8, snowpeak: 0.4, badlands: 0.7, wetland: 0.2 },
      elementWeights: { fire: 0.4, ice: 0.3, lightning: 0.8, earth: 0.4, wind: 0.4, light: 1, dark: 0.5, void: 0.6 },
      structureDensity: 0.9, gemRarityCurve: 0.8, oreAbundance: 0.75,
      palette: 'twilight', lootThemes: ['celestial', 'arcane', 'voidtouched'], nameGrammar: 'arcane',
    },
  },
];

/** Lay a preset over a spec (keeps name, seed, specVersion). */
export function applyPreset(spec: WorldSpec, preset: Preset): WorldSpec {
  return { ...structuredClone(spec), ...structuredClone(preset.spec) } as WorldSpec;
}
