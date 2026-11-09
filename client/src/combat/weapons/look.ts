// What a weapon looks like (pt/ux): weapon type, material and socketed gem.
// For other players it rides in the player entity's snapshot typeId
// (contracts/events.md "Player entities"; server/zone/internal/game/
// weaponlook.go packs it): bits 0-3 combat.yaml weapon id (0 none), bits 4-7
// material code (0 ordinary, else 1 + index in items.yaml `materials`),
// bits 8-11 gem element + 1 (0 none). For yourself the same material code
// comes per loadout at the end of combat_sync (Event 212).

import { COMBAT, ITEMS } from '@lodestone/contracts';

export type WeaponKind = 'sword' | 'spear' | 'bow' | 'staff' | 'wand';
export const WEAPON_KINDS: readonly WeaponKind[] = ['sword', 'spear', 'bow', 'staff', 'wand'];

export interface WeaponLook {
  weapon: WeaponKind | null;
  /** items.yaml material key, or '' for an ordinary (training) weapon. */
  material: string;
  /** Element of the socketed gem (0 fire .. 7 void), -1 none. */
  gem: number;
}

const kindById = new Map(COMBAT.weapons.map((w) => [w.id, w.key as WeaponKind]));
const idByKind = new Map(COMBAT.weapons.map((w) => [w.key, w.id]));

/** Material code: 0 ordinary, else 1 + index in items.yaml materials. */
export function materialCode(key: string): number {
  const i = ITEMS.materials.findIndex((m) => m.key === key);
  return i < 0 ? 0 : i + 1;
}

export function materialKey(code: number): string {
  return code > 0 ? (ITEMS.materials[code - 1]?.key ?? '') : '';
}

export function packLook(l: WeaponLook): number {
  const w = l.weapon ? (idByKind.get(l.weapon) ?? 0) : 0;
  const g = l.gem >= 0 && l.gem < 15 ? l.gem + 1 : 0;
  return (w & 0xf) | ((materialCode(l.material) & 0xf) << 4) | ((g & 0xf) << 8);
}

export function unpackLook(typeId: number | undefined): WeaponLook {
  const t = typeId ?? 0;
  return { weapon: kindById.get(t & 0xf) ?? null, material: materialKey((t >> 4) & 0xf), gem: ((t >> 8) & 0xf) - 1 };
}

export function lookKey(l: WeaponLook): string {
  return `${l.weapon ?? '-'}|${l.material}|${l.gem}`;
}
