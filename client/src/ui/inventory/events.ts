// WP14 Event payloads (contracts/events.md rows 400-411, and WP20's 805
// station_opened that opens the forge): pure decoders, plus the Interact
// codes the inventory sends (targetKind 20 container, 21 item, 22 craft,
// 41 pickup). Little-endian, as the zone writes them
// (server/zone/internal/game/items.go, loot.go).

import type { WireItem } from './items';

export const EV = {
  inventory: 400,
  lootGranted: 401,
  bitchin: 402,
  refused: 403,
  station: 404,
  crafted: 405,
  containers: 406,
  containerOpened: 407,
  dropped: 408,
  bossLockout: 409,
  gemCombined: 410,
  itemTaken: 411,
  /** WP20: a forge (1) or anvil (2) was used; WP14 opens the smithing panel. */
  stationOpened: 805,
} as const;

/** Event 401 targetId: where the items came from (contracts/events.md row 401). */
export const LOOT_SOURCE = { kill: 1, container: 2, vein: 3, craft: 4, purchase: 5, starter: 6, pickup: 7, gem: 8, quest: 9 } as const;

export const INTERACT = { container: 20, item: 21, craft: 22, pickup: 41 } as const;

/** Interact 21 actions. */
export const ITEM_ACT = { use: 1, drop: 2, equip: 3, unequip: 4, move: 5, socket: 6, unsocket: 7, combine: 8, quick: 9 } as const;
/** Interact 22 actions. */
export const CRAFT_ACT = { craft: 1, openCook: 2 } as const;

export interface Inventory {
  gold: number;
  quick: string;
  persist: string;
  items: WireItem[];
}

export interface LootEntry {
  b: string;
  q: number;
  r: number;
  n?: string;
}

export interface BitchinNews {
  name: string;
  item: string;
  displayName: string;
  text: string;
}

export interface Container {
  id: bigint;
  /** Metres. */
  x: number;
  y: number;
  z: number;
  /** 0 chest, 1 buried cache, 2 urn, 3 crate. */
  kind: number;
  opened: boolean;
}

export type StationKind = 'forge' | 'anvil' | 'cook';

const dec = new TextDecoder();

export const utf8 = (b: Uint8Array): string => dec.decode(b);

function json<T>(b: Uint8Array): T {
  return JSON.parse(dec.decode(b)) as T;
}

/** Event 400: the whole inventory (full replace). */
export function decodeInventory(data: Uint8Array): Inventory {
  const j = json<{ v?: number; gold?: number; quick?: string; persist?: string; items?: WireItem[] }>(data);
  if (typeof j !== 'object' || j === null) throw new Error('inventory: not an object');
  const items = Array.isArray(j.items) ? j.items.filter((it) => it && typeof it.b === 'string' && typeof it.s === 'string') : [];
  for (const it of items) {
    it.q = it.q ?? 1;
    it.l = it.l ?? 1;
    it.r = it.r ?? 0;
    it.p = it.p ?? 0;
  }
  return { gold: j.gold ?? 0, quick: j.quick ?? '', persist: j.persist ?? 'memory', items };
}

/** Event 401: what was just added. */
export function decodeLootGranted(data: Uint8Array): LootEntry[] {
  const j = json<LootEntry[]>(data);
  return Array.isArray(j) ? j.filter((e) => e && typeof e.b === 'string') : [];
}

/** Event 402: someone found a Bitchin' item. */
export function decodeBitchin(data: Uint8Array): BitchinNews {
  const j = json<Partial<BitchinNews>>(data);
  const name = j.name ?? 'Someone';
  const display = j.displayName ?? j.item ?? 'something';
  return { name, item: j.item ?? '', displayName: display, text: j.text || `${name} found ${display}!` };
}

/** Event 403 targetId: Interact kind << 8 | action. */
export function decodeRefusedTarget(targetId: number): { kind: number; action: number } {
  return { kind: (targetId >>> 8) & 0xffffff, action: targetId & 0xff };
}

export function u64(data: Uint8Array, off = 0): bigint {
  if (data.length < off + 8) throw new Error('truncated u64');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
}

/** Event 805 data: u64 prop stable id LE + u16 settlement index. */
export function decodeStationOpened(data: Uint8Array): { prop: bigint; settlement: number } {
  const prop = u64(data);
  const settlement = data.length >= 10 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(8, true) : -1;
  return { prop, settlement };
}

/** Event 405: the recipe, quantity and new item. */
export function decodeCrafted(targetId: number, value: number, data: Uint8Array): { recipeId: number; qty: number; item: WireItem | null } {
  let item: WireItem | null = null;
  try {
    const j = json<WireItem>(data);
    if (j && typeof j.b === 'string') item = j;
  } catch {
    item = null;
  }
  return { recipeId: targetId, qty: value, item };
}

/** Event 406: u8 version | u16 n | n x (u64 id, i32 x, y, z cm, u8 kind, u8 opened). */
export function decodeContainers(data: Uint8Array): Container[] {
  if (data.length < 3) throw new Error('containers: truncated header');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = dv.getUint8(0);
  if (v !== 1) throw new Error(`containers: unknown version ${v}`);
  const n = dv.getUint16(1, true);
  const REC = 8 + 12 + 2;
  if (data.length < 3 + n * REC) throw new Error('containers: truncated list');
  const out: Container[] = [];
  for (let i = 0, o = 3; i < n; i++, o += REC) {
    out.push({
      id: dv.getBigUint64(o, true),
      x: dv.getInt32(o + 8, true) / 100,
      y: dv.getInt32(o + 12, true) / 100,
      z: dv.getInt32(o + 16, true) / 100,
      kind: dv.getUint8(o + 20),
      opened: dv.getUint8(o + 21) === 1,
    });
  }
  return out;
}

/** Test/mocks helper: the 406 payload for a list (inverse of decodeContainers). */
export function encodeContainers(list: readonly Container[]): Uint8Array {
  const b = new Uint8Array(3 + list.length * 22);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, 1);
  dv.setUint16(1, list.length, true);
  list.forEach((c, i) => {
    const o = 3 + i * 22;
    dv.setBigUint64(o, c.id, true);
    dv.setInt32(o + 8, Math.round(c.x * 100), true);
    dv.setInt32(o + 12, Math.round(c.y * 100), true);
    dv.setInt32(o + 16, Math.round(c.z * 100), true);
    dv.setUint8(o + 20, c.kind);
    dv.setUint8(o + 21, c.opened ? 1 : 0);
  });
  return b;
}

/** Event 805 targetId -> station kind (1 forge, 2 anvil). */
export function stationKind805(targetId: number): StationKind {
  return targetId === 2 ? 'anvil' : 'forge';
}
