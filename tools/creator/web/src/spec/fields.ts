// Slider layout: every numeric WorldSpec field, grouped as in spec 6's
// table, with ranges taken from the generated WORLDSPEC_RANGES (so a schema
// change moves the sliders with it). fields.test.ts checks every range key
// has exactly one slider.
import { BIOME_WEIGHTS_KEYS, ELEMENT_WEIGHTS_KEYS, WORLDSPEC_RANGES } from '@lodestone/contracts';

export interface SliderField {
  /** WORLDSPEC_RANGES key: "seaLevel" or "biomeWeights.forest". */
  key: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export interface FieldGroup {
  id: string;
  title: string;
  /** Weight groups show each weight's share of the total next to it. */
  weights?: boolean;
  fields: SliderField[];
}

function field(key: string, label: string, hint?: string): SliderField {
  const r = WORLDSPEC_RANGES[key];
  if (!r) throw new Error(`no range for ${key}`);
  // 200 steps across a range is finer than anyone drags; integers step by 1.
  const step = r.integer || r.max - r.min >= 50 ? 1 : (r.max - r.min) / 200;
  return { key, label, hint, min: r.min, max: r.max, step, integer: r.integer };
}

const title = (k: string) => k[0].toUpperCase() + k.slice(1);

export const GROUPS: FieldGroup[] = [
  {
    id: 'terrain', title: 'Terrain',
    fields: [
      field('seaLevel', 'Sea level'), field('landFraction', 'Land fraction', 'share of the map above water'),
      field('mountainHeight', 'Mountain height'), field('roughness', 'Roughness'), field('plateaus', 'Plateaus', 'mesas and terraces'),
      field('riverDensity', 'Rivers'),
    ],
  },
  {
    id: 'climate', title: 'Climate',
    fields: [
      field('temperatureBias', 'Temperature', 'cold to hot'), field('moistureBias', 'Moisture', 'dry to wet'),
      field('windDirection', 'Wind from (deg)', '0 = north'), field('stormFrequency', 'Storms'),
    ],
  },
  { id: 'biomes', title: 'Biome weights', weights: true, fields: BIOME_WEIGHTS_KEYS.map((k) => field(`biomeWeights.${k}`, title(k))) },
  { id: 'elements', title: 'Element weights', weights: true, fields: ELEMENT_WEIGHTS_KEYS.map((k) => field(`elementWeights.${k}`, title(k))) },
  {
    id: 'underground', title: 'Underground',
    fields: [
      field('caveDensity', 'Caves'), field('caveMaxDepth', 'Cave depth (m)'), field('gemRarityCurve', 'Gem rarity curve', 'exponent on depth'),
      field('oreAbundance', 'Ore abundance'),
    ],
  },
  {
    id: 'danger', title: 'Danger',
    fields: [field('dangerCurve', 'Danger curve', 'how fast it rises from spawn'), field('enemyDensity', 'Enemies'), field('demonIntensity', 'Demon intensity', 'how dangerous nights are')],
  },
  {
    id: 'systems', title: 'Systems',
    fields: [
      field('flammability', 'Flammability'), field('nightLength', 'Night length', 'fraction of a day'),
      field('settlementDensity', 'Settlements'), field('structureDensity', 'Structures'),
    ],
  },
];

/** Read a field by its range key. */
export function getField(spec: object, key: string): number {
  const [a, b] = key.split('.');
  const o = spec as Record<string, unknown>;
  return (b ? (o[a] as Record<string, number>)[b] : o[a]) as number;
}

/** Write a field by its range key (mutates). */
export function setField(spec: object, key: string, v: number) {
  const [a, b] = key.split('.');
  const o = spec as Record<string, unknown>;
  if (b) (o[a] as Record<string, number>)[b] = v;
  else o[a] = v;
}
