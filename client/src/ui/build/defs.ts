// The build catalogue as the menu shows it (CR 041): bases (a wall) with
// their material variants (wood, stone, sunsteel wall), categories, costs.
// Pure over CAMPS so vitest can drive it.

import { CAMPS, ITEMS, type CampPieceDef } from '@lodestone/contracts';

export const CATEGORIES = ['Structure', 'Roof', 'Furnish', 'Base'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface BaseDef {
  base: string;
  name: string;
  desc: string;
  cat: Category;
  /** One piece per material (structure) or a single piece. */
  variants: CampPieceDef[];
}

const ROOF = new Set(['roof', 'roof_cap', 'gable']);

function catOf(p: CampPieceDef): Category {
  const b = p.build!;
  if (b.cat === 'furnish') return b.use ? 'Base' : 'Furnish';
  return ROOF.has(b.base) ? 'Roof' : 'Structure';
}

/** Every building base in catalogue order. */
export const CATALOGUE: BaseDef[] = (() => {
  const out = new Map<string, BaseDef>();
  for (const p of CAMPS.pieces) {
    if (!p.build) continue;
    const m = p.build.mat >= 0 ? CAMPS.build.materials[p.build.mat] : null;
    const cur = out.get(p.build.base);
    if (cur) {
      cur.variants.push(p);
      continue;
    }
    out.set(p.build.base, { base: p.build.base, name: m ? p.name.slice(m.name.length + 1) : p.name, desc: p.desc, cat: catOf(p), variants: [p] });
  }
  return [...out.values()];
})();

export const inCategory = (c: Category): BaseDef[] => CATALOGUE.filter((b) => b.cat === c);

export function baseOf(kind: number): BaseDef | undefined {
  return CATALOGUE.find((b) => b.variants.some((v) => v.id === kind));
}

/** The same piece in another material (wraps), `by` steps along. */
export function cycleMaterial(kind: number, by = 1): number {
  const b = baseOf(kind);
  if (!b || b.variants.length < 2) return kind;
  const i = b.variants.findIndex((v) => v.id === kind);
  return b.variants[(((i + by) % b.variants.length) + b.variants.length) % b.variants.length].id;
}

/** The next piece in the category (wraps), keeping the material when it has one. */
export function cyclePiece(kind: number, by = 1): number {
  const b = baseOf(kind);
  if (!b) return kind;
  const list = inCategory(b.cat);
  const i = list.indexOf(b);
  const nb = list[(((i + by) % list.length) + list.length) % list.length];
  const mat = b.variants.findIndex((v) => v.id === kind);
  return nb.variants[Math.min(Math.max(mat, 0), nb.variants.length - 1)].id;
}

export interface CostLine {
  item: string;
  need: number;
  have: number;
}

export type Have = (item: string) => number;

/** What placing a piece costs, with what you have. */
export function costLines(kind: number, have: Have): CostLine[] {
  const c = CAMPS.pieces.find((p) => p.id === kind)?.build?.cost ?? [];
  return c.map((l) => ({ item: l.item, need: l.qty, have: have(l.item) }));
}

export const missing = (lines: CostLine[]): CostLine[] => lines.filter((l) => l.have < l.need);

/** Deconstruct returns round(qty * refundPct / 100) of each line. */
export function refundLines(kind: number): { item: string; qty: number }[] {
  const c = CAMPS.pieces.find((p) => p.id === kind)?.build?.cost ?? [];
  return c.map((l) => ({ item: l.item, qty: Math.round((l.qty * CAMPS.build.refundPct) / 100) })).filter((l) => l.qty > 0);
}

/** Repair costs max(1, ceil(qty * repairPct / 100 * (100 - cond) / 100)) of each line; nothing at 100. */
export function repairLines(kind: number, cond: number): { item: string; qty: number }[] {
  if (cond >= 100) return [];
  const c = CAMPS.pieces.find((p) => p.id === kind)?.build?.cost ?? [];
  return c.map((l) => ({ item: l.item, qty: Math.max(1, Math.ceil(((l.qty * CAMPS.build.repairPct) / 100) * ((100 - cond) / 100) - 1e-9)) }));
}

/** "Log" for "wood:log". */
export function itemLabel(item: string): string {
  const known = ITEMS.items.find((i) => i.key === item)?.name;
  if (known) return known;
  const name = item.split(':')[1] ?? item;
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
}

/** "Needs 4 more Logs": the refusal line for what is missing. */
export function missingText(lines: { item: string; need: number; have: number }[]): string {
  const m = lines.filter((l) => l.have < l.need).map((l) => `${l.need - l.have} more ${itemLabel(l.item)}${l.need - l.have > 1 ? 's' : ''}`);
  return m.length ? `Needs ${m.join(', ')}` : '';
}
