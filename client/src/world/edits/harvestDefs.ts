// What can be chopped or broken and what it drops (CR 040): the client's copy
// of server/pkg/worldedit/scatter.go, used for targeting (reach capsules), the
// hit bar and solo play. Online the zone decides; if the tables drift the
// worst case is a wrong hit bar, never a wrong world.

export const LAYER_TREE = 1;
export const LAYER_ROCK = 2;
export const LAYER_BUSH = 3;

export const TOOL_AXE = 'tool:axe';
export const TOOL_PICKAXE = 'tool:pickaxe';
export const TOOL_SHOVEL = 'tool:shovel';

export interface Drop {
  item: string;
  min: number;
  max: number;
  chance?: number;
  perScale?: number;
}

export interface HarvestDef {
  /** Item key of the tool required ('' = anything, bare hands slowly). */
  tool: string;
  hp: number;
  damage: number;
  /** Height and radius (m) at scale byte 128. */
  height: number;
  radius: number;
  drops: Drop[];
  /** Solo regrow window (s); 0 = never. */
  regrowS: [number, number];
}

const TREE_H = [7.5, 8.5, 9, 11, 9.5, 6.5, 5.5, 8, 10];
const ROCK_H = [1.6, 0.9, 4.5, 1.4, 1.5];

const treeDrops: Drop[] = [
  { item: 'wood:log', min: 2, max: 3, perScale: 1.5 },
  { item: 'wood:stick', min: 1, max: 2, chance: 0.7 },
  { item: 'wood:resin', min: 1, max: 1, chance: 0.2 },
];
const coniferDrops: Drop[] = [
  { item: 'wood:log', min: 2, max: 4, perScale: 1.5 },
  { item: 'wood:stick', min: 1, max: 2, chance: 0.6 },
  { item: 'wood:resin', min: 1, max: 2, chance: 0.5 },
];
const deadDrops: Drop[] = [
  { item: 'wood:log', min: 1, max: 2, perScale: 1 },
  { item: 'wood:firewood', min: 2, max: 4 },
];
const rockDrops: Drop[] = [
  { item: 'stone:block', min: 2, max: 4, perScale: 2 },
  { item: 'stone:flint', min: 1, max: 1, chance: 0.18 },
];
const spireDrops: Drop[] = [
  { item: 'stone:block', min: 3, max: 5, perScale: 2 },
  { item: 'stone:flint', min: 1, max: 2, chance: 0.3 },
];
const bushDrops: Drop[] = [
  { item: 'plant:fiber', min: 1, max: 2 },
  { item: 'wood:stick', min: 0, max: 1, chance: 0.5 },
];
const berryDrops: Drop[] = [
  { item: 'plant:berries', min: 2, max: 4 },
  { item: 'plant:fiber', min: 1, max: 1 },
];

const H = 3600;

/** The rules of a scatter object, or null when it cannot be broken (grass tufts). */
export function harvestDef(layer: number, kind: number): HarvestDef | null {
  if (layer === LAYER_TREE) {
    if (kind >= TREE_H.length) return null;
    const conifer = kind === 3 || kind === 4 || kind === 8;
    return {
      tool: TOOL_AXE,
      hp: kind === 5 ? 70 : 100,
      damage: 25,
      height: TREE_H[kind],
      radius: 0.45,
      drops: kind === 5 ? deadDrops : conifer ? coniferDrops : treeDrops,
      regrowS: [3 * H, 6 * H],
    };
  }
  if (layer === LAYER_ROCK) {
    if (kind >= ROCK_H.length) return null;
    return {
      tool: TOOL_PICKAXE,
      hp: kind === 2 ? 140 : kind === 1 ? 80 : 100,
      damage: 25,
      height: ROCK_H[kind],
      radius: kind === 2 ? 0.7 : 1.0,
      drops: kind === 2 ? spireDrops : rockDrops,
      regrowS: [8 * H, 16 * H],
    };
  }
  if (layer === LAYER_BUSH) {
    if (kind > 5) return null;
    return { tool: '', hp: 40, damage: 25, height: 1.2, radius: 0.8, drops: kind === 1 ? berryDrops : bushDrops, regrowS: [H, 2 * H] };
  }
  return null;
}

/** The renderer's size multiplier for a record's scale byte (scatterManager.ts put()). */
export const scaleFactor = (scaleByte: number): number => 0.7 + (scaleByte / 255) * 0.6;

export const maxHp = (d: HarvestDef, scaleByte: number): number => d.hp * (0.6 + (0.8 * scaleByte) / 255);

/** Solo drop roll (online the zone rolls and sends pickups). */
export function rollDrops(d: HarvestDef, scaleByte: number, rnd: () => number): { item: string; qty: number }[] {
  const out: { item: string; qty: number }[] = [];
  for (const dr of d.drops) {
    if (dr.chance !== undefined && rnd() >= dr.chance) continue;
    let q = dr.min + Math.floor(rnd() * (dr.max - dr.min + 1));
    if (dr.perScale) q += Math.floor(dr.perScale * (scaleByte / 255) * (0.5 + rnd()));
    if (q > 0) out.push({ item: dr.item, qty: q });
  }
  return out;
}

/** Short names for toasts. */
export const ITEM_NAMES: Record<string, string> = {
  'wood:log': 'Log',
  'wood:stick': 'Stick',
  'wood:resin': 'Resin',
  'wood:firewood': 'Firewood',
  'stone:block': 'Stone',
  'stone:flint': 'Flint',
  'earth:dirt': 'Dirt',
  'plant:fiber': 'Plant Fiber',
  'plant:berries': 'Wild Berries',
};
