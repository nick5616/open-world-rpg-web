// What a player wears (playtest 2 visible armor, CR 034): the zone's
// appearance number, the client twin of server/zone/internal/game/
// appearance.go. It rides in the player's snapshot record
// (EntityRecord.appearance, protocol v6: sent on change and on first sight,
// nothing while it stays the same) and, for your own body, in the inventory
// event (Event 400 "ap"), so everyone draws the same pieces:
//
//   per slot s (0 head, 1 body, 2 legs), at bit 17 * s:
//     bits 0-5   visual id: 1 + the piece's index among items.yaml armor (0 none)
//     bits 6-9   material code (1 + index in items.yaml materials, weapons/look.ts)
//     bits 10-12 rarity (0 common .. 7 Bitchin')
//     bits 13-16 gem: 1 + index in items.yaml gems (0 none)
//   bits 51-63 zero: the value stays below 2^53, so a JS number holds it exactly.

import { ITEMS, type ItemDef } from '@lodestone/contracts';
import { materialCode, materialKey } from '../weapons/look';

export type ArmorSlot = 'head' | 'body' | 'legs';
export const ARMOR_SLOTS: readonly ArmorSlot[] = ['head', 'body', 'legs'];
export type ArmorStyle = NonNullable<ItemDef['style']>;

/** One worn piece, decoded. */
export interface WornPiece {
  slot: ArmorSlot;
  /** items.yaml key (armor:iron_helm). */
  key: string;
  style: ArmorStyle;
  /** items.yaml material key (from the appearance: normally the item's own). */
  material: string;
  /** 0 common .. 7 Bitchin'. */
  rarity: number;
  /** items.yaml gems index of the inlay, -1 none. */
  gem: number;
}

const SLOT_BITS = 17;
const SLOT_SPAN = 2 ** SLOT_BITS;

/** Every armor piece in visual-id order (index + 1). */
export const ARMOR_ITEMS: readonly ItemDef[] = ITEMS.items.filter((i) => i.kind === 'armor');
const visualByKey = new Map(ARMOR_ITEMS.map((it, i) => [it.key, i + 1]));

export function armorVisualId(key: string): number {
  return visualByKey.get(key) ?? 0;
}

/** Index of a gem item key's gem ("gem:ruby:cut" -> 0), -1 none. */
export function gemIndex(key: string | undefined): number {
  if (!key) return -1;
  const [cat, name] = key.split(':');
  if (cat !== 'gem') return -1;
  return ITEMS.gems.findIndex((g) => g.key === name);
}

export function unpackAppearance(ap: number | bigint | undefined): (WornPiece | null)[] {
  let v = typeof ap === 'bigint' ? Number(ap & 0x1fffffffffffffn) : Math.max(0, Math.floor(ap ?? 0));
  const out: (WornPiece | null)[] = [];
  for (const slot of ARMOR_SLOTS) {
    const w = v % SLOT_SPAN;
    v = Math.floor(v / SLOT_SPAN);
    const visual = w & 0x3f;
    const def = visual > 0 ? ARMOR_ITEMS[visual - 1] : undefined;
    if (!def || def.armor !== slot) {
      out.push(null);
      continue;
    }
    const mat = materialKey((w >> 6) & 0xf) || def.material || '';
    out.push({ slot, key: def.key, style: def.style ?? defaultStyle(slot), material: mat, rarity: (w >> 10) & 0x7, gem: ((w >> 13) & 0xf) - 1 });
  }
  return out;
}

export function packAppearance(pieces: readonly (Pick<WornPiece, 'key' | 'rarity' | 'gem'> & { material?: string } | null | undefined)[]): number {
  let v = 0;
  for (let s = 0; s < 3; s++) {
    const p = pieces[s];
    if (!p) continue;
    const id = armorVisualId(p.key);
    if (!id) continue;
    const def = ARMOR_ITEMS[id - 1];
    const w = (id & 0x3f) | ((materialCode(p.material ?? def.material ?? '') & 0xf) << 6) | ((p.rarity & 0x7) << 10) | (((p.gem >= 0 ? p.gem + 1 : 0) & 0xf) << 13);
    v += w * SLOT_SPAN ** s;
  }
  return v;
}

function defaultStyle(slot: ArmorSlot): ArmorStyle {
  return slot === 'head' ? 'helm' : slot === 'body' ? 'cuirass' : 'leggings';
}

/** The appearance of equipped inventory items (eq:head / eq:body / eq:legs): the zone's AppearanceOf, for offline and tests. */
export function appearanceOfItems(items: readonly { b: string; s: string; r: number; k?: string[] }[]): number {
  const bySlot = new Map(items.map((it) => [it.s, it]));
  return packAppearance(
    ARMOR_SLOTS.map((slot) => {
      const it = bySlot.get(`eq:${slot}`);
      return it ? { key: it.b, rarity: it.r, gem: gemIndex(it.k?.find((g) => g)) } : null;
    }),
  );
}
