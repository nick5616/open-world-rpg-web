// Inputs for the shared normalize fixtures (tools/creator/fixtures/normalize.json).
// Each case is a patch over BASE: objects merge, anything else replaces, and
// DELETE removes the key. Raw cases bypass BASE (non-object inputs).
// Regenerate the fixture file after editing: npm run fixtures -w @lodestone/creator

/** spec_from_seed(7) from worldgen genVersion 1 (unnormalized weights on purpose). */
export const BASE = {
  specVersion: 1,
  name: 'Shores of Sonaliassver',
  seed: '7',
  seaLevel: 0.407,
  landFraction: 0.538,
  mountainHeight: 0.856,
  roughness: 0.492,
  plateaus: 0.347,
  riverDensity: 0.705,
  temperatureBias: -0.064,
  moistureBias: 0.163,
  windDirection: 195,
  stormFrequency: 0.436,
  biomeWeights: { meadow: 0.657, forest: 0.863, highlands: 0.355, snowpeak: 0.71, badlands: 0.693, wetland: 0.67 },
  elementWeights: { fire: 0.483, ice: 0.601, lightning: 0.774, earth: 0.617, wind: 0.759, light: 0.401, dark: 0.333, void: 0.377 },
  caveDensity: 0.682,
  caveMaxDepth: 221,
  gemRarityCurve: 1.972,
  oreAbundance: 0.681,
  dangerCurve: 0.664,
  enemyDensity: 0.562,
  demonIntensity: 0.327,
  flammability: 0.389,
  nightLength: 0.342,
  settlementDensity: 0.521,
  structureDensity: 0.361,
  palette: 'verdant',
  lootThemes: ['voidtouched', 'feral'],
  nameGrammar: 'coastal',
};

export const DELETE = '__delete__';

const ONES_B = { meadow: 1, forest: 1, highlands: 1, snowpeak: 1, badlands: 1, wetland: 1 };
const ONES_E = { fire: 1, ice: 1, lightning: 1, earth: 1, wind: 1, light: 1, dark: 1, void: 1 };

export interface FixtureCase {
  name: string;
  patch?: Record<string, unknown>;
  raw?: unknown;
}

export const CASES: FixtureCase[] = [
  { name: 'already normalized spec passes unchanged', patch: { biomeWeights: { forest: 1, meadow: 0.5, highlands: 0.25, snowpeak: 0.125, badlands: 0.75, wetland: 0 }, elementWeights: { lightning: 1 } } },
  { name: 'spec_from_seed weights are divided by their max', patch: {} },
  { name: 'top-level numbers clamp to schema ranges', patch: { seaLevel: 1.7, landFraction: 0.1, mountainHeight: -0.2, caveMaxDepth: 999, gemRarityCurve: -2, nightLength: 0.9, temperatureBias: -3, moistureBias: 1.0000001, structureDensity: 12 } },
  { name: 'integers clamp then round half up', patch: { windDirection: 400.4 } },
  { name: 'negative integer clamps to minimum', patch: { windDirection: -20 } },
  { name: 'integer half rounds up', patch: { windDirection: 90.5 } },
  { name: 'integer just under half rounds down', patch: { windDirection: 12.49 } },
  { name: 'specVersion clamps to 1', patch: { specVersion: 2 } },
  { name: 'fractional caveMaxDepth stays fractional (number field)', patch: { caveMaxDepth: 100.25 } },
  { name: 'all-zero weights become all ones', patch: { biomeWeights: { meadow: 0, forest: 0, highlands: 0, snowpeak: 0, badlands: 0, wetland: 0 }, elementWeights: { fire: 0, ice: 0, lightning: 0, earth: 0, wind: 0, light: 0, dark: 0, void: 0 } } },
  { name: 'weights above 1 clamp, then renormalize', patch: { biomeWeights: { forest: 3, meadow: -1 }, elementWeights: ONES_E } },
  { name: 'all-one weights are left alone', patch: { biomeWeights: ONES_B, elementWeights: ONES_E } },
  { name: 'negative zero becomes zero', patch: { plateaus: -0, temperatureBias: -0 } },
  { name: 'unknown, repeated and surplus loot tags are dropped', patch: { lootThemes: ['drowned', 'cathedral', 'arcane', 'drowned', 'ROYAL', 'feral', 'sylvan', 'ancient', 'infernal'] } },
  { name: 'empty loot themes are fine', patch: { lootThemes: [] } },
  { name: 'name punctuation becomes spaces', patch: { name: 'Drowned Cathedral: Isles!!' } },
  { name: 'name keeps apostrophes and hyphens', patch: { name: "  The Warden's   Rest-by-Sea  " } },
  { name: 'long name is cut to 40 and trimmed', patch: { name: 'The Very Long and Winding Archipelago of Many Small Cold Islands' } },
  { name: 'non-ASCII letters become spaces', patch: { name: 'Ærøskøbing Reach' } },
  { name: 'name words merely containing a stem are fine', patch: { name: 'Lavender Wanderer Isles' } },
  { name: 'name with too few usable characters is rejected', patch: { name: '!!' } },
  { name: 'name starting a word with a blocked stem is rejected', patch: { name: 'Fields of Hyrule' } },
  { name: 'blocked stem after an apostrophe is rejected', patch: { name: "Wolf's Odinsgate" } },
  { name: 'seed with leading zeros is canonicalized', patch: { seed: '000123' } },
  { name: 'max uint64 seed is fine', patch: { seed: '18446744073709551615' } },
  { name: 'seed above uint64 is rejected', patch: { seed: '18446744073709551616' } },
  { name: 'seed with a sign is rejected', patch: { seed: '-5' } },
  { name: 'numeric seed is rejected', patch: { seed: 7 } },
  { name: 'missing field is rejected', patch: { riverDensity: DELETE } },
  { name: 'missing weight is rejected', patch: { biomeWeights: { wetland: DELETE } } },
  { name: 'extra top-level property is rejected', patch: { lore: 'a drowned cathedral rises from the sea' } },
  { name: 'extra weight key is rejected', patch: { biomeWeights: { desert: 0.5 } } },
  { name: 'string where a number belongs is rejected', patch: { seaLevel: 'high' } },
  { name: 'unknown palette is rejected', patch: { palette: 'neon' } },
  { name: 'unknown nameGrammar is rejected', patch: { nameGrammar: 'elvish' } },
  { name: 'lootThemes that is not an array is rejected', patch: { lootThemes: 'drowned' } },
  { name: 'non-string loot tag is rejected', patch: { lootThemes: ['drowned', 3] } },
  { name: 'boolean number is rejected', patch: { roughness: true } },
  { name: 'array input is rejected', raw: [BASE] },
  { name: 'string input is rejected', raw: 'drowned cathedral archipelago' },
  { name: 'null input is rejected', raw: null },
  { name: 'everything at once', patch: { name: 'Cold  Isles of the North!', seed: '0042', seaLevel: 2, windDirection: 359.5, biomeWeights: { wetland: 4 }, lootThemes: ['drowned', 'drowned', 'gothic', 'arcane'] } },
];

type Obj = Record<string, unknown>;

/** Apply a fixture patch (see the header comment). */
export function applyPatch(base: Obj, patch: Obj): Obj {
  const out: Obj = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === DELETE) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = applyPatch(out[k] as Obj, v as Obj);
    else out[k] = structuredClone(v);
  }
  return out;
}

/** The input value of a case. */
export function caseInput(c: FixtureCase): unknown {
  return 'raw' in c ? c.raw : applyPatch(BASE, c.patch ?? {});
}
