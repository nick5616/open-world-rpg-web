// Playtest 2 dev console (CR 032): everything the console can hand out or
// summon, straight from the generated contract tables: every item in
// items.yaml (families expanded: gems by cut, ores, ingots, blueprints)
// plus a tome for every spell in combat.yaml, every spell, enemy, boss,
// taming species, world event, weather state and achievement.
// devconsole.test.ts checks nothing in the YAML is missing.

import { COMBAT, CONTENT, ITEMS } from '@lodestone/contracts';
import { baseLine, baseName, itemDef, kindLabel } from '../inventory/items';
import { spellName } from '../skills/tree';
import { STATE_KEYS } from '../../systems/weather/weather';

export interface CatalogItem {
  key: string;
  name: string;
  group: string;
  kind: string;
  level: number;
  /** Weapons and armor: rolled at a rarity, level, affix and gem. */
  gear: boolean;
  /** What the base does ("Starmetal sword · x1.35 damage", "Restores 40 health"). */
  line: string;
  /** Lower-case text the search box matches. */
  search: string;
}

/** Item groups in the Items tab's filter, in order. */
export const ITEM_GROUPS: { key: string; label: string; categories: string[] }[] = [
  { key: 'weapon', label: 'Weapons', categories: ['weapon'] },
  { key: 'armor', label: 'Armor', categories: ['armor'] },
  { key: 'ammo', label: 'Arrows', categories: ['ammo'] },
  { key: 'tool', label: 'Tools & whistle', categories: ['tool'] },
  { key: 'potion', label: 'Potions', categories: ['potion'] },
  { key: 'food', label: 'Food', categories: ['food', 'meat'] },
  { key: 'herb', label: 'Herbs', categories: ['herb'] },
  { key: 'fish', label: 'Fish', categories: ['fish'] },
  { key: 'ore', label: 'Ores & ingots', categories: ['ore', 'ingot'] },
  { key: 'gem', label: 'Gems', categories: ['gem'] },
  { key: 'instrument', label: 'Instruments', categories: ['instrument'] },
  { key: 'camp', label: 'Camp kits & firewood', categories: ['camp', 'wood'] },
  { key: 'blueprint', label: 'Blueprints', categories: ['blueprint'] },
  { key: 'tome', label: 'Spell tomes', categories: ['tome'] },
  { key: 'quest', label: 'Quest items & keys', categories: ['quest', 'key'] },
  { key: 'other', label: 'Other (hides, seeds, gold)', categories: [] },
];

function groupOf(category: string): string {
  return ITEM_GROUPS.find((g) => g.categories.includes(category))?.key ?? 'other';
}

let items: CatalogItem[] | null = null;

/** Every item key the zone can give (game.DevItemKeys), with what the UI shows. */
export function itemCatalog(): CatalogItem[] {
  if (items) return items;
  const keys = [...ITEMS.items.map((i) => i.key), ...COMBAT.spells.map((s) => `tome:${s.key}`)];
  items = keys.map((key) => {
    const d = itemDef(key)!;
    const name = key.startsWith('tome:') ? `Tome: ${spellName(key.slice(5))}` : baseName(key);
    const line = baseLine(key);
    return { key, name, group: groupOf(d.category), kind: kindLabel(key), level: d.level, gear: d.kind === 'weapon' || d.kind === 'armor', line, search: `${key} ${name} ${line}`.toLowerCase() };
  });
  return items;
}

export function itemByKey(key: string): CatalogItem | undefined {
  return itemCatalog().find((i) => i.key === key);
}

export interface Named {
  key: string;
  id: number;
  name: string;
}

const cap = (s: string) =>
  s
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

export const SPELLS: (Named & { tree: string; tier: number; type: string })[] = COMBAT.spells.map((s) => ({ key: s.key, id: s.id, name: spellName(s.key), tree: s.tree, tier: s.tier, type: s.type }));
export const ENEMIES: (Named & { family: string })[] = COMBAT.enemies.map((e) => ({ key: e.key, id: e.id, name: e.name, family: e.family }));
/** Bosses: `id` is the index the zone takes (Interact 250/17 with the boss bit). */
export const BOSSES: Named[] = COMBAT.bosses.map((b, i) => ({ key: b.key, id: i, name: COMBAT.bossNames[b.key] ?? cap(b.key) }));
export const ELITES: Named[] = COMBAT.affixes.map((a) => ({ key: a.key, id: a.id, name: cap(a.key) }));
export const SPECIES: (Named & { food: string })[] = CONTENT.taming.species.map((s) => ({ key: s.key, id: s.id, name: COMBAT.enemies.find((e) => e.key === s.enemy)?.name ?? cap(s.key), food: s.foods[0] }));
export const WORLD_EVENTS: Named[] = CONTENT.events.kinds.map((k, i) => ({ key: k.key, id: i + 1, name: k.name }));
export const WEATHER: Named[] = STATE_KEYS.map((k, i) => ({ key: k, id: i, name: cap(k) }));
export const SKILLS: Named[] = COMBAT.skills.list.map((s) => ({ key: s.key, id: s.id, name: cap(s.key) }));
export const ACHIEVEMENTS: (Named & { pts: number; desc: string })[] = CONTENT.achievements.map((a) => ({ key: a.key, id: a.id, name: a.name, pts: a.pts, desc: a.desc }));
export const RARITIES: Named[] = ITEMS.rarities.map((r) => ({ key: r.key, id: r.id, name: r.name }));
export const GEMS: Named[] = ITEMS.gems.map((g, i) => ({ key: g.key, id: i, name: g.name }));
export const CUTS: Named[] = ITEMS.cuts.map((c, i) => ({ key: c.key, id: i, name: c.name }));
export const GEAR_AFFIXES: (Named & { slots: string[] })[] = ITEMS.affixes.map((a, i) => ({ key: a.key, id: i, name: a.name, slots: a.slots }));
export const ELEMENTS = ['fire', 'ice', 'lightning', 'earth', 'wind', 'light', 'dark', 'void'] as const;

/**
 * Find one entry by key, id, name or an unambiguous prefix (case and
 * spaces/underscores ignored). Items also match the part after the
 * category ("starmetal_sword" for weapon:starmetal_sword).
 */
export function resolve<T extends { key: string; name: string; id?: number }>(list: readonly T[], q: string): T | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_'-]+/g, '');
  const n = norm(q);
  if (!n) return undefined;
  const tail = (k: string) => norm(k.includes(':') ? k.slice(k.indexOf(':') + 1) : k);
  const exact = list.find((x) => norm(x.key) === n || norm(x.name) === n || (x.id !== undefined && String(x.id) === q.trim()));
  if (exact) return exact;
  const byTail = list.filter((x) => tail(x.key) === n);
  if (byTail.length === 1) return byTail[0];
  const pre = list.filter((x) => norm(x.key).startsWith(n) || norm(x.name).startsWith(n) || tail(x.key).startsWith(n));
  if (pre.length === 1) return pre[0];
  const has = list.filter((x) => norm(x.key).includes(n) || norm(x.name).includes(n));
  return has.length === 1 ? has[0] : undefined;
}

/** Up to n candidates for autocomplete (prefix matches first). */
export function suggest<T extends { key: string; name: string }>(list: readonly T[], q: string, n = 8): T[] {
  const s = q.toLowerCase().replace(/\s+/g, '_');
  const starts = list.filter((x) => x.key.toLowerCase().startsWith(s) || x.key.toLowerCase().split(':').pop()!.startsWith(s) || x.name.toLowerCase().startsWith(q.toLowerCase()));
  const rest = list.filter((x) => !starts.includes(x) && (x.key.toLowerCase().includes(s) || x.name.toLowerCase().includes(q.toLowerCase())));
  return [...starts, ...rest].slice(0, n);
}
