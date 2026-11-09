// WP20 Event payloads (contracts/events.md rows 800-807): pure decoders for
// the binary `data` of 801 shop and 802 bounties, the refusal reasons of
// 806, and the Interact codes the HUD sends (targetKind 30-33). All
// little-endian, as the zone writes them (server/zone/internal/npc/talk.go).

import { ITEMS } from '@lodestone/contracts';

export const EV = { npcSay: 800, shop: 801, bounties: 802, bountyAccepted: 803, rested: 804, stationOpened: 805, refused: 806, purchase: 807 } as const;
export const INTERACT = { npc: 30, board: 31, station: 32, shaft: 33 } as const;
/** Interact actions per target kind. */
export const ACT = { talk: 1, buy: 2, rest: 3, acceptFromKeeper: 4, read: 1, acceptFromBoard: 2, use: 1, descend: 1 } as const;

export const NPC_ROLE_LABEL = ['villager', 'merchant', 'blacksmith', 'innkeeper', 'bounty keeper', 'farmer', 'guard'] as const;
export const MERCHANT_LABEL = ['general goods', 'provisions', 'herbalist', 'tools'] as const;
export const BOUNTY_KIND_LABEL = ['Clear', 'Deliver', 'Slay', 'Explore'] as const;

/** Reasons of 806 town_refused. */
export const REFUSAL: Record<number, string> = {
  1: 'Too far away',
  2: 'Nothing there to use',
  3: 'Closed for the night',
  4: 'No such item or bounty',
  5: 'You already have that bounty',
  6: 'You carry too many bounties (5 at most)',
  7: 'You are already rested',
  8: 'The shaft is collapsed: no cave below',
};

export interface ShopItem {
  index: number;
  item: string;
  price: number;
  stock: number;
}

export interface Bounty {
  id: number;
  kind: number;
  /** Target atlas site index, -1 none. */
  site: number;
  qty: number;
  reward: number;
  accepted: boolean;
  /** You completed it (CR 013: the accepted byte is 2). */
  done?: boolean;
  text: string;
}

const dec = new TextDecoder();

class Reader {
  o = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number): void {
    if (this.o + n > this.b.length) throw new Error(`truncated payload at byte ${this.o}`);
  }
  u8(): number {
    this.need(1);
    return this.dv.getUint8(this.o++);
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  str(): string {
    const n = this.u16();
    this.need(n);
    const s = dec.decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

/** 801 shop: u8 version(1) | u8 count | count x (u16 len + UTF-8 item id, u32 price, u16 stock). */
export function decodeShop(data: Uint8Array): ShopItem[] {
  const r = new Reader(data);
  const ver = r.u8();
  if (ver !== 1) throw new Error(`shop payload version ${ver}`);
  const n = r.u8();
  const out: ShopItem[] = [];
  for (let i = 0; i < n; i++) out.push({ index: i, item: r.str(), price: r.u32(), stock: r.u16() });
  return out;
}

/** 802 bounties: u8 version(1) | u8 count | count x (u32 id, u8 kind, u16 site, u16 qty, u32 reward, u8 accepted, u16 len + UTF-8 text). */
export function decodeBounties(data: Uint8Array): Bounty[] {
  const r = new Reader(data);
  const ver = r.u8();
  if (ver !== 1) throw new Error(`bounties payload version ${ver}`);
  const n = r.u8();
  const out: Bounty[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.u32();
    const kind = r.u8();
    const site = r.u16();
    const qty = r.u16();
    const reward = r.u32();
    const acc = r.u8();
    const accepted = acc === 1;
    out.push({ id, kind, site: site === 0xffff ? -1 : site, qty, reward, accepted, ...(acc === 2 ? { done: true } : {}), text: r.str() });
  }
  return out;
}

/** 805 station_opened data: u64 prop stable id LE + u16 settlement index. */
export function decodeStation(data: Uint8Array): { propId: bigint; settlement: number } | null {
  if (data.length < 10) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { propId: dv.getBigUint64(0, true), settlement: dv.getUint16(8, true) };
}

const itemNames = new Map(ITEMS.items.map((d) => [d.key, d.name]));

/**
 * An item's name from contracts/items.yaml ("blueprint:sunsteel_blade" ->
 * "Blueprint: Sunsteel Blade", "weapon:iron_sword" -> "Iron Sword");
 * unknown ids fall back to "food:smoked_fish" -> "smoked fish". Playtest 2:
 * shops showed the blueprint and the finished blade under the same name
 * ("sunsteel blade 40 g" looked like the blade itself, "iron sword" twice).
 */
export function itemName(id: string): string {
  const known = itemNames.get(id);
  if (known) return known;
  const i = id.indexOf(':');
  return (i >= 0 ? id.slice(i + 1) : id).replace(/_/g, ' ');
}

export const utf8 = (b: Uint8Array) => dec.decode(b);
