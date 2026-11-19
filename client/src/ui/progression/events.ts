// Playtest 1 wire glue (contracts/events.md 900-949, CR 012): character
// stats, the area you stand in, tower attunement. TS twin of
// server/zone/internal/game/progression.go (EncodeStats) and difficulty.go
// (EncodeArea).

import { COMBAT, type Event as ZoneEvent } from '@lodestone/contracts';

export const PEV = {
  levelUp: 604,
  characterStats: 900,
  area: 901,
  towerAttuned: 902,
  attuneRefused: 903,
} as const;

/** Interact 10 (site) action 2: attune to a tower's crystal (you must stand on its top). */
export const INTERACT_SITE = 10;
export const ACTION_ATTUNE = 2;
/** WP13 combat Interact: learn a tree node with a skill point. */
export const INTERACT_COMBAT = 50;
export const ACTION_LEARN = 4;
/** Combat Interact: put a known spell in a loadout slot (arg = loadout | slot << 4 | spell id << 8; id 0 clears). */
export const ACTION_EQUIP_SPELL = 3;

/** The ACTION_EQUIP_SPELL argument. */
export function equipSpellArg(loadout: number, slot: number, spellId: number): number {
  return (loadout & 0xf) | ((slot & 0xf) << 4) | (spellId << 8);
}

/** Event 900 reasons; hotbar (CR 039): once after a join, spell slots / a loadout the level opened that you were never told about. */
export const STATS_REASON = { sync: 0, levelUp: 1, attuned: 2, hotbar: 3 } as const;

export const ATTUNE_REFUSED: Record<number, string> = {
  1: 'Stand on the top of the tower, beside the crystal',
  2: 'You are already attuned to this crystal',
  3: 'That is not a tower',
};

export interface Stats {
  reason: number;
  level: number;
  prevLevel: number;
  xp: bigint;
  xpInto: number;
  xpNext: number;
  healthMax: number;
  manaMax: number;
  staminaMax: number;
  /** Bonus to all damage from the level, percent. */
  damagePct: number;
  skillFree: number;
  skillTotal: number;
  attunedCount: number;
  /** Bitset by atlas site index (towers attuned). */
  attuned: Uint8Array;
}

/** character_stats (900) payload. */
export function decodeStats(d: Uint8Array): Stats | null {
  if (d.length < 35 || d[0] !== 1) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint16(33, true);
  if (35 + n > d.length) return null;
  return {
    reason: d[1],
    level: v.getUint16(2, true),
    prevLevel: v.getUint16(4, true),
    xp: v.getBigUint64(6, true),
    xpInto: v.getUint32(14, true),
    xpNext: v.getUint32(18, true),
    healthMax: v.getUint16(22, true),
    manaMax: v.getUint16(24, true),
    staminaMax: v.getUint16(26, true),
    damagePct: v.getUint16(28, true) / 10,
    skillFree: d[30],
    skillTotal: d[31],
    attunedCount: d[32],
    attuned: d.slice(35, 35 + n),
  };
}

export interface Area {
  cell: number;
  level: number;
  tierIndex: number;
  tierKey: string;
  tierName: string;
  haven: boolean;
  /** You stamped it just now (first to arrive). */
  byYou: boolean;
  provisional: boolean;
  cellM: number;
  /** The discoverer's level when they stamped it (only when byYou). */
  byLevel: number;
  by: string;
  x: number;
  z: number;
}

/** area (901). */
export function decodeArea(ev: Pick<ZoneEvent, 'targetId' | 'value' | 'x' | 'z' | 'data'>): Area | null {
  const d = ev.data;
  if (d.length < 7 || d[0] !== 1) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const tiers = COMBAT.difficulty.tiers;
  const t = tiers[Math.min(tiers.length - 1, d[1])];
  return {
    cell: ev.targetId,
    level: ev.value,
    tierIndex: d[1],
    tierKey: t.key,
    tierName: t.name,
    haven: (d[2] & 1) !== 0,
    byYou: (d[2] & 2) !== 0,
    provisional: (d[2] & 4) !== 0,
    cellM: v.getUint16(3, true),
    byLevel: v.getUint16(5, true),
    by: new TextDecoder().decode(d.subarray(7)),
    x: ev.x / 100,
    z: ev.z / 100,
  };
}

/** Test/mocks: the Go encoders' layout. */
export function encodeStats(s: Omit<Stats, 'attuned'> & { attuned?: Uint8Array }): Uint8Array {
  const set = s.attuned ?? new Uint8Array(0);
  const b = new Uint8Array(35 + set.length);
  const v = new DataView(b.buffer);
  b[0] = 1;
  b[1] = s.reason;
  v.setUint16(2, s.level, true);
  v.setUint16(4, s.prevLevel, true);
  v.setBigUint64(6, s.xp, true);
  v.setUint32(14, s.xpInto, true);
  v.setUint32(18, s.xpNext, true);
  v.setUint16(22, s.healthMax, true);
  v.setUint16(24, s.manaMax, true);
  v.setUint16(26, s.staminaMax, true);
  v.setUint16(28, Math.round(s.damagePct * 10), true);
  b[30] = s.skillFree;
  b[31] = s.skillTotal;
  b[32] = s.attunedCount;
  v.setUint16(33, set.length, true);
  b.set(set, 35);
  return b;
}

export function encodeArea(tier: number, flags: number, cellM: number, byLevel: number, by: string): Uint8Array {
  const name = new TextEncoder().encode(by);
  const b = new Uint8Array(7 + name.length);
  const v = new DataView(b.buffer);
  b[0] = 1;
  b[1] = tier;
  b[2] = flags;
  v.setUint16(3, cellM, true);
  v.setUint16(5, byLevel, true);
  b.set(name, 7);
  return b;
}
