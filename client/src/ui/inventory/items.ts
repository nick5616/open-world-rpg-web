// Item helpers for the inventory UI (WP14): names, rarity colours, stat
// lines, slots and recipe checks, all from the generated item table
// (contracts/items.yaml -> @lodestone/contracts ITEMS), so the client can
// never disagree with the zone about what an item is. Pure; unit-tested in
// inventory.test.ts.

import { COMBAT, ITEMS, type ItemDef, type ItemStat, type RarityDef, type RecipeDef } from '@lodestone/contracts';
import { skillProgress, type SkillProgress } from '../progression/gains';
import type { StationKind } from './events';

/** One affix on an item (Event 400 `a`). */
export interface WireAffix {
  k: string;
  s: string;
  v: number;
}

/** One item as Event 400 carries it (contracts/events.md row 400). */
export interface WireItem {
  /** Wire handle (u32): the Interact 21 targetId. */
  h: number;
  /** Item key (contracts/items.yaml). */
  b: string;
  q: number;
  l: number;
  r: number;
  /** Slot: inv:0-39, gem:N, ore:N, purse, eq:main0/main1/head/body/legs. */
  s: string;
  /** Generated name (mythic and above). */
  n?: string;
  a?: WireAffix[];
  u?: string[];
  /** Sockets: gem key or "" per socket. */
  k?: string[];
  t: boolean;
  v: boolean;
  /** Provenance entries (hands it passed through). */
  p: number;
}

export const INV_SLOTS = 40;
export const INV_COLS = 8;
/** Equipment slots in Interact 21/4 (unequip) argument order. */
export const EQ_SLOTS = ['eq:main0', 'eq:main1', 'eq:head', 'eq:body', 'eq:legs'] as const;
export type EqSlot = (typeof EQ_SLOTS)[number];

/**
 * Playtest 2: an empty main hand wields the loadout's default training
 * weapon (combat.yaml start: Loadout 1 the sword, Loadout 2 the staff);
 * unequipping a weapon item falls back to it (the zone's applyGear).
 */
export function defaultWeapon(loadout: number): string {
  return COMBAT.start.loadouts[loadout]?.weapon ?? 'sword';
}

/** "Training Sword". */
export function trainingWeaponName(weapon: string): string {
  return `Training ${weapon.charAt(0).toUpperCase()}${weapon.slice(1)}`;
}

/** Interact 50/2 (combat equipWeapon) argument: loadout | weapon id << 8 (0 when unknown). */
export function trainingEquipArg(loadout: number, weapon: string): number {
  const w = COMBAT.weapons.find((x) => x.key === weapon);
  return w ? ((loadout & 0xff) | (w.id << 8)) >>> 0 : 0;
}
export const EQ_LABEL: Record<EqSlot, string> = { 'eq:main0': 'Main hand · Loadout 1', 'eq:main1': 'Main hand · Loadout 2', 'eq:head': 'Head', 'eq:body': 'Body', 'eq:legs': 'Legs' };

const defs = new Map<string, ItemDef>(ITEMS.items.map((d) => [d.key, d]));
const affixDefs = new Map(ITEMS.affixes.map((a) => [a.key, a]));
const uniqueDefs = new Map(ITEMS.uniques.map((u) => [u.key, u]));
const gemDefs = new Map(ITEMS.gems.map((g) => [g.key, g]));
const cutDefs = new Map(ITEMS.cuts.map((c) => [c.key, c]));
const spells = new Map(COMBAT.spells.map((s) => [s.key, s]));

export function itemDef(key: string): ItemDef | undefined {
  if (key.startsWith('tome:')) {
    const sp = spells.get(key.slice(5));
    return { key, name: ITEMS.tome.name.replace('{spell}', sp?.name ?? prettify(key.slice(5))), category: 'tome', kind: 'tome', stack: 1, pouch: 'inv', level: 1, value: ITEMS.tome.value, sockets: 0 };
  }
  return defs.get(key);
}

function prettify(s: string): string {
  return s
    .split(/[_:]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** The base item's name ("Sunsteel Blade", "Tome: Fireball"); unknown keys are prettified. */
export function baseName(key: string): string {
  return itemDef(key)?.name ?? prettify(key.includes(':') ? key.slice(key.indexOf(':') + 1) : key);
}

/** What the item is called: its generated name (mythic+) or the base name. */
export function displayName(it: { b: string; n?: string }): string {
  return it.n || baseName(it.b);
}

export function rarityDef(r: number): RarityDef {
  return ITEMS.rarities[Math.max(0, Math.min(ITEMS.rarities.length - 1, r | 0))];
}

/** Bitchin' (and anything whose colour is "holographic") draws with the animated gradient. */
export function isHolo(r: number): boolean {
  return rarityDef(r).color === 'holographic';
}

/** A solid colour for the rarity (holographic falls back to its pink highlight). */
export function rarityColor(r: number): string {
  const c = rarityDef(r).color;
  return c.startsWith('#') ? c : '#ff6be6';
}

export const STAT_LABEL: Record<ItemStat, string> = {
  damagePct: 'damage',
  critPct: 'critical chance',
  spellPowerPct: 'spell power',
  health: 'health',
  armorPct: 'armor',
  lootFindPct: 'loot find',
  staminaPct: 'stamina',
};

function num(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "+12.3% damage", "+14 health". */
export function formatStat(stat: string, v: number): string {
  const label = STAT_LABEL[stat as ItemStat] ?? stat;
  const sign = v < 0 ? '-' : '+';
  const pct = stat.endsWith('Pct');
  return `${sign}${num(Math.abs(v))}${pct ? '%' : ''} ${label}`;
}

/** An affix as a line: its name and what it does. */
export function affixLine(a: WireAffix): { name: string; text: string } {
  return { name: affixDefs.get(a.k)?.name ?? prettify(a.k), text: formatStat(a.s, a.v) };
}

/** A unique effect: its name and its stat lines. */
export function uniqueInfo(key: string): { name: string; lines: string[] } {
  const u = uniqueDefs.get(key);
  if (!u) return { name: prettify(key), lines: [] };
  return { name: u.name, lines: Object.entries(u.stats).map(([s, v]) => formatStat(s, v as number)) };
}

export const ELEMENT_NAMES = ['Fire', 'Ice', 'Lightning', 'Earth', 'Wind', 'Light', 'Dark', 'Void'] as const;

/** Display colour per gem (UI icons and socket dots). */
export const GEM_COLOR: Record<string, string> = {
  ruby: '#e0304a',
  sapphire: '#3a6cf0',
  topaz: '#f2b42c',
  emerald: '#2fbf6a',
  aquamarine: '#5fd8e0',
  sunstone: '#ff9a3c',
  onyx: '#4a4458',
  amethyst: '#a35ef0',
  opal: '#e9e4f2',
  moonstone: '#b9c8e8',
};

/** What a gem does in a socket ("Powers the Lightning form (x1.25)", "+8% loot find"). */
export function gemEffect(key: string): string {
  const [, g, cut] = key.split(':');
  const gd = gemDefs.get(g);
  const cd = cutDefs.get(cut);
  if (!gd) return '';
  if (gd.element >= 0) return `Socketed: powers the ${ELEMENT_NAMES[gd.element]} form${cd ? ` (x${cd.formMult})` : ''}`;
  return gd.stat && cd ? `Socketed: ${formatStat(gd.stat, cd.utility)}` : '';
}

/** Parse a slot string: inv:3 -> {pouch: 'inv', index: 3}; eq:head -> {pouch: 'eq', index: 2}. */
export function parseSlot(s: string): { pouch: string; index: number } {
  const i = s.indexOf(':');
  if (i < 0) return { pouch: s, index: 0 };
  const pouch = s.slice(0, i);
  if (pouch === 'eq') return { pouch, index: EQ_SLOTS.indexOf(s as EqSlot) };
  return { pouch, index: Number(s.slice(i + 1)) | 0 };
}

/** Interact 21/6 targetId: weapon handle | gem handle << 32. */
export function socketTarget(weaponH: number, gemH: number): bigint {
  return BigInt(weaponH >>> 0) | (BigInt(gemH >>> 0) << 32n);
}

export const isWeapon = (it: { b: string }) => itemDef(it.b)?.kind === 'weapon';
export const isArmor = (it: { b: string }) => itemDef(it.b)?.kind === 'armor';
export const isGem = (it: { b: string }) => it.b.startsWith('gem:');
export const isConsumable = (it: { b: string }) => itemDef(it.b)?.kind === 'consumable';
export const isEquipped = (it: { s: string }) => it.s.startsWith('eq:');

/** A short kind line ("Sword", "Body armor", "Potion"). */
export function kindLabel(key: string): string {
  const d = itemDef(key);
  if (!d) return '';
  if (d.kind === 'weapon') return prettify(d.weapon ?? 'weapon');
  if (d.kind === 'armor') return `${prettify(d.armor ?? '')} armor`;
  if (d.kind === 'consumable') return prettify(d.category);
  if (d.kind === 'ammo') return 'Arrows';
  return prettify(d.kind);
}

/** The base's own line under the name: what it does without affixes. */
export function baseLine(key: string): string {
  const d = itemDef(key);
  if (!d) return '';
  const mat = d.material ? ITEMS.materials.find((m) => m.key === d.material) : undefined;
  switch (d.kind) {
    case 'weapon':
      return `${mat?.name ?? ''} ${d.weapon ?? ''}${mat ? ` · x${mat.mult} damage` : ''}${mat?.killsDemons ? ' · kills demons' : ''}${mat?.demonStagger ? ' · staggers demons' : ''}`.trim();
    case 'armor':
      return `${mat?.name ?? ''} · ${d.health ? formatStat('health', d.health) : ''}${d.armorPct ? `, ${formatStat('armorPct', d.armorPct)}` : ''} at item level 1`;
    case 'consumable':
      return d.heal ? `Restores ${d.heal} health` : '';
    case 'ammo':
      return `Use: fit ${prettify(d.arrow ?? '')} arrowheads to your bow (bows never run out of arrows; the stack is kept)`; // CR 033
    case 'gem':
      return gemEffect(key);
    case 'ore': {
      const r = ITEMS.recipes.find((x) => x.inputs.some((i) => i.item === key) && x.key.startsWith('smelt_'));
      return r ? `Smelt ${r.inputs[0].qty} at a forge: ${baseName(r.output)}` : '';
    }
    case 'blueprint': {
      const r = ITEMS.recipes.find((x) => x.key === d.recipe);
      return r ? `Teaches: ${baseName(r.output)} (forge, not consumed)` : '';
    }
    case 'tome':
      return 'Use: learn the spell';
    default:
      return '';
  }
}

/** Total quantity of an item key across the inventory (equipped gear excluded). */
export function countOf(items: readonly WireItem[], key: string): number {
  let n = 0;
  for (const it of items) if (it.b === key && !isEquipped(it)) n += it.q;
  return n;
}

export function recipesFor(station: StationKind): RecipeDef[] {
  const s = station === 'cook' || station === 'workbench' || station === 'camp' ? station : 'forge';
  return ITEMS.recipes.filter((r) => r.station === s);
}

export interface RecipeStatus {
  inputs: { item: string; name: string; have: number; need: number }[];
  blueprint: { item: string; name: string; have: boolean } | null;
  canCraft: boolean;
}

export function recipeStatus(r: RecipeDef, items: readonly WireItem[]): RecipeStatus {
  const inputs = r.inputs.map((i) => ({ item: i.item, name: baseName(i.item), have: countOf(items, i.item), need: i.qty }));
  const blueprint = r.blueprint ? { item: r.blueprint, name: baseName(r.blueprint), have: countOf(items, r.blueprint) > 0 } : null;
  return { inputs, blueprint, canCraft: inputs.every((i) => i.have >= i.need) && (!blueprint || blueprint.have) };
}

/** Recipe section heading (smelting / forging / cooking / brewing). */
export function recipeGroup(r: RecipeDef): string {
  if (r.key.startsWith('smelt_')) return 'Smelting';
  if (r.key.startsWith('brew_')) return 'Brewing';
  if (r.station === 'cook') return 'Cooking';
  if (r.station === 'camp') return 'Camp kits';
  if (r.station === 'workbench') return r.key.includes('arrows') ? 'Fletching' : 'Tools';
  return 'Forging';
}

/** Event 403 reasons. */
export const REFUSAL: Record<number, string> = {
  1: 'Your inventory is full',
  2: 'That item is gone',
  3: 'You cannot do that',
  4: 'Missing ingredients',
  5: 'You need the blueprint for that',
  6: 'Not enough gold',
  7: 'Too far away',
  8: 'You already opened this one',
  9: 'No such socket',
  10: 'Gems combine only at a waypoint',
  11: 'Busy, try again',
  12: 'No crafting station open here',
};

/** Event 401 sources. */
export const SOURCE_LABEL: Record<number, string> = { 1: 'loot', 2: 'container', 3: 'mined', 4: 'crafted', 5: 'bought', 6: 'starter kit', 7: 'picked up', 8: 'gem', 11: 'dev console' };

/** Container kinds (Event 406). */
export const CONTAINER_LABEL = ['chest', 'buried cache', 'urn', 'crate'] as const;

/**
 * The combat HUD's weapon label for loadout `loadout` (0 or 1): the name of
 * the item equipped in that main hand ("Sunsteel Blade", or a mythic's
 * generated name) when it is a `weapon` of that type, else the weapon type
 * ("Sword") - no inventory yet, nothing equipped, or the two momentarily
 * disagree between Event 400 and combat_sync.
 */
export function loadoutWeaponLabel(weapon: string, loadout: number, items: readonly WireItem[] | null | undefined): string {
  const it = items?.find((x) => x.s === `eq:main${loadout}`);
  if (it && itemDef(it.b)?.weapon === weapon) return displayName(it);
  return weapon ? weapon[0].toUpperCase() + weapon.slice(1) : '-';
}

/** What the crafting panel shows about Smithing (null: nothing known yet). */
export interface SmithingView {
  level: number;
  /** Progress toward the next level: forge/anvil with the zone's skill XP (combat_sync) only. */
  progress: SkillProgress | null;
}

/**
 * The crafting panel's Smithing line. The zone's combat_sync carries every
 * skill's cumulative XP (smithing included, re-sent after each forge craft),
 * so with it the forge and anvil show the level and the progress bar; the
 * cooking fire (which trains no Smithing) shows the level only. Without a
 * sync (offline, or before the first one) Event 404's level is used if any.
 */
export function smithingView(kind: StationKind, stationLevel: number | null, synced: boolean, xp: number | undefined): SmithingView | null {
  if (synced) {
    const p = skillProgress(xp ?? 0);
    return { level: p.level, progress: kind === 'forge' || kind === 'anvil' ? p : null };
  }
  return stationLevel !== null ? { level: stationLevel, progress: null } : null;
}
