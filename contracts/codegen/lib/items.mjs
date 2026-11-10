// items.yaml -> normalized item tables (WP14, CR 010).
//
// Like combat.mjs: the YAML is written for people (maps keyed by item key,
// families implied), the normalized form for code (arrays, every family
// expanded into explicit items, every reference resolved and checked). The
// same object is emitted as a TS module (client) and as JSON embedded by
// server/pkg/itemdefs (zone).
//
// Expanded families: gem:<gem>:<cut> for every gem x cut, ore:<ore> and
// ingot:<ore> for every ore, blueprint:<item> for every recipe that needs
// one. `npm run gen` fails on a recipe that names an unknown item, a weapon
// type combat.yaml doesn't have, an arrow ore without a combat arrow, or
// rarity odds that sum past 1.
import { HEADER_NOTE } from './util.mjs';

function fail(msg) {
  throw new Error(`items.yaml: ${msg}`);
}

const CATEGORY_KIND = {
  weapon: 'weapon', armor: 'armor', ammo: 'ammo', potion: 'consumable', food: 'consumable',
  meat: 'material', herb: 'material', hide: 'material', seed: 'material', tool: 'tool', quest: 'material', wood: 'material', camp: 'tool', fish: 'material',
  currency: 'currency', gem: 'gem', ore: 'ore', ingot: 'ingot', blueprint: 'blueprint', tome: 'tome', key: 'key',
};

const STATS = ['damagePct', 'critPct', 'spellPowerPct', 'health', 'armorPct', 'lootFindPct', 'staminaPct'];

/** Parse and validate; `combat` is the normalized combat tables (weapon types, arrows). */
export function parseItems(doc, combat) {
  if (doc.version !== 1) fail('version must be 1');
  const weaponTypes = new Map(combat.weapons.map((w) => [w.key, w]));
  const bow = weaponTypes.get('bow');
  const arrowOres = new Set((bow?.arrows ?? []).map((a) => a.key));

  const rarities = doc.rarities.map((r, i) => ({
    key: r.key, id: i, name: r.name, color: r.color, affixes: r.affixes, uniques: r.uniques ?? 0,
    named: !!r.named, odds: r.odds, lucky: !!r.lucky, announce: !!r.announce, bases: r.bases ?? [],
  }));
  if (rarities.length !== 8) fail('spec 8 has eight rarity tiers');
  const oddsSum = rarities.reduce((s, r) => s + r.odds, 0);
  if (oddsSum > 1 + 1e-12) fail(`rarity odds sum to ${oddsSum} > 1`);

  const materials = Object.entries(doc.materials).map(([key, m]) => ({
    key, name: m.name, mult: m.mult, tier: m.tier, killsDemons: !!m.killsDemons, demonStagger: !!m.demonStagger,
  }));
  const matKeys = new Set(materials.map((m) => m.key));
  for (const r of rarities) for (const b of r.bases) if (!matKeys.has(b)) fail(`rarity ${r.key}: unknown base material ${b}`);

  const gems = Object.entries(doc.gems).map(([key, g]) => ({ key, name: g.name, element: g.element, stat: g.stat ?? null }));
  const cuts = doc.cuts.map((c, i) => ({ ...c, tier: i }));
  const ores = Object.entries(doc.ores).map(([key, o]) => ({ key, name: o.name, smelt: o.smelt }));
  const stacks = doc.stacks;
  const pouches = doc.pouches;

  const items = [];
  const byKey = new Map();
  const add = (it) => {
    if (byKey.has(it.key)) fail(`duplicate item ${it.key}`);
    const cat = it.key.split(':')[0];
    const kind = CATEGORY_KIND[cat];
    if (!kind) fail(`item ${it.key}: unknown category ${cat}`);
    if (!(cat in stacks)) fail(`item ${it.key}: no stack size for category ${cat}`);
    const out = {
      key: it.key, name: it.name, category: cat, kind, stack: stacks[cat], pouch: pouches[cat] ?? 'inv',
      level: it.level ?? 1, value: it.value ?? 1, sockets: 0,
      ...it,
    };
    out.category = cat;
    out.kind = kind;
    items.push(out);
    byKey.set(it.key, out);
    return out;
  };
  for (const [key, it] of Object.entries(doc.items)) {
    const o = { key, ...it };
    if (o.weapon) {
      if (!weaponTypes.has(o.weapon)) fail(`item ${key}: combat.yaml has no weapon ${o.weapon}`);
      if (!matKeys.has(o.material)) fail(`item ${key}: unknown material ${o.material}`);
      o.sockets = 3; // spec 8: weapons roll 0 to 3 gem sockets
    }
    if (o.armor) {
      if (!['head', 'body', 'legs'].includes(o.armor)) fail(`item ${key}: armor slot must be head, body or legs`);
      if (!matKeys.has(o.material)) fail(`item ${key}: unknown material ${o.material}`);
    }
    if (o.arrow && !arrowOres.has(o.arrow)) fail(`item ${key}: combat.yaml bow has no ${o.arrow} arrows`);
    add(o);
  }
  for (const g of gems) {
    for (const c of cuts) {
      add({ key: `gem:${g.key}:${c.key}`, name: `${c.name} ${g.name}`, gem: g.key, cut: c.key, element: g.element, value: c.value });
    }
  }
  for (const o of ores) {
    add({ key: `ore:${o.key}`, name: `${o.name} Ore`, metal: o.key, value: 3 * (materials.find((m) => m.key === o.key)?.tier ?? 1) });
    add({ key: `ingot:${o.key}`, name: `${o.name} Ingot`, metal: o.key, value: 8 * (materials.find((m) => m.key === o.key)?.tier ?? 1) });
  }

  const recipes = Object.entries(doc.recipes).map(([key, r], i) => {
    if (!['forge', 'cook', 'camp', 'workbench'].includes(r.station)) fail(`recipe ${key}: station must be forge, cook, camp (CR 025: anywhere) or workbench (a camp piece)`);
    const out = byKey.get(r.output);
    if (!out) fail(`recipe ${key}: unknown output ${r.output}`);
    const inputs = Object.entries(r.inputs).map(([item, qty]) => {
      if (!byKey.has(item)) fail(`recipe ${key}: unknown input ${item}`);
      if (!Number.isInteger(qty) || qty <= 0) fail(`recipe ${key}: bad quantity for ${item}`);
      return { item, qty };
    });
    let blueprint = null;
    if (r.blueprint) {
      blueprint = `blueprint:${r.output.split(':')[1]}`;
      if (!byKey.has(blueprint)) add({ key: blueprint, name: `Blueprint: ${out.name}`, recipe: key, value: Math.max(10, Math.round(out.value / 2)) });
    }
    return { key, id: i + 1, station: r.station, inputs, output: r.output, qty: r.qty ?? 1, sockets: r.sockets ?? 0, blueprint, xp: r.xp ?? 5 };
  });

  const affixes = Object.entries(doc.affixes).map(([key, a]) => {
    if (!STATS.includes(a.stat)) fail(`affix ${key}: unknown stat ${a.stat}`);
    return { key, name: a.name, stat: a.stat, min: a.min, max: a.max, slots: a.slots, weight: a.weight ?? 1, elements: a.elements ?? [], themes: a.themes ?? [] };
  });
  const uniques = Object.entries(doc.uniques).map(([key, u]) => {
    for (const s of Object.keys(u.stats)) if (!STATS.includes(s)) fail(`unique ${key}: unknown stat ${s}`);
    return { key, name: u.name, stats: u.stats };
  });
  const starter = Object.entries(doc.starter).map(([item, qty]) => {
    if (!byKey.has(item)) fail(`starter: unknown item ${item}`);
    return { item, qty };
  });
  const loot = doc.loot;
  for (const [fam, t] of Object.entries(loot.families)) {
    for (const k of Object.keys(t)) {
      if (!['item', 'meat', 'hide', 'gem', 'ore', 'blueprint', 'consumable', 'food'].includes(k)) fail(`loot family ${fam}: unknown drop ${k}`);
    }
  }
  const ws = loot.sockets.reduce((s, x) => s + x, 0);
  if (Math.abs(ws - 1) > 1e-9) fail('loot.sockets weights must sum to 1');

  return {
    version: doc.version, rarities, luckCap: doc.luckCap, materials, gems, cuts, combineCount: doc.combineCount, ores,
    stacks, pouches, items, tome: doc.tome, affixes, uniques, names: doc.names, recipes, starter, loot, stats: STATS,
  };
}

export function genItemsJson(d) {
  return JSON.stringify(d, null, 1) + '\n';
}

const TS_TYPES = `
export type ItemStat = 'damagePct' | 'critPct' | 'spellPowerPct' | 'health' | 'armorPct' | 'lootFindPct' | 'staminaPct';
export interface RarityDef { key: string; id: number; name: string; color: string; affixes: number; uniques: number; named: boolean; odds: number; lucky: boolean; announce: boolean; bases: string[] }
export interface MaterialDef { key: string; name: string; mult: number; tier: number; killsDemons: boolean; demonStagger: boolean }
export interface GemDef { key: string; name: string; element: number; stat: ItemStat | null }
export interface CutDef { key: string; name: string; formMult: number; utility: number; value: number; tier: number }
export interface OreDef { key: string; name: string; smelt: number }
export interface ItemDef {
  key: string; name: string; category: string;
  kind: 'weapon' | 'armor' | 'ammo' | 'consumable' | 'material' | 'tool' | 'currency' | 'gem' | 'ore' | 'ingot' | 'blueprint' | 'tome' | 'key';
  stack: number; pouch: 'inv' | 'gem' | 'ore' | 'purse'; level: number; value: number; sockets: number;
  weapon?: string; armor?: 'head' | 'body' | 'legs'; material?: string; health?: number; armorPct?: number; heal?: number; arrow?: string;
  gem?: string; cut?: string; element?: number; metal?: string; recipe?: string;
}
export interface ItemAffixDef { key: string; name: string; stat: ItemStat; min: number; max: number; slots: string[]; weight: number; elements: number[]; themes: string[] }
export interface UniqueDef { key: string; name: string; stats: Partial<Record<ItemStat, number>> }
export interface RecipeDef { key: string; id: number; station: 'forge' | 'cook' | 'camp' | 'workbench'; inputs: { item: string; qty: number }[]; output: string; qty: number; sockets: number; blueprint: string | null; xp: number }
export interface ItemDefs {
  version: number; rarities: RarityDef[]; luckCap: number; materials: MaterialDef[]; gems: GemDef[]; cuts: CutDef[]; combineCount: number; ores: OreDef[];
  stacks: Record<string, number>; pouches: Record<string, string>; items: ItemDef[]; tome: { name: string; value: number };
  affixes: ItemAffixDef[]; uniques: UniqueDef[]; names: { first: string[]; second: string[] }; recipes: RecipeDef[];
  starter: { item: string; qty: number }[]; loot: Record<string, unknown>; stats: ItemStat[];
}
`;

export function genItemsTs(d) {
  return `// ${HEADER_NOTE}\n// Source: contracts/items.yaml (normalized by contracts/codegen/lib/items.mjs)\n/* eslint-disable */\n${TS_TYPES}\nexport const ITEMS: ItemDefs = ${JSON.stringify(d)};\n`;
}
