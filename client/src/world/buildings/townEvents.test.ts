// WP20 Event payloads (contracts/events.md 801 shop, 802 bounties, 805
// station) decoded from hand-built little-endian byte vectors.

import { describe, expect, it } from 'vitest';
import { decodeBounties, decodeShop, decodeStation, itemName, REFUSAL, shopNote } from './townEvents';

class W {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  str(s: string) {
    const e = new TextEncoder().encode(s);
    this.u16(e.length);
    this.b.push(...e);
    return this;
  }
  get bytes() {
    return new Uint8Array(this.b);
  }
}

describe('801 shop', () => {
  it('decodes items, prices and stock', () => {
    const w = new W().u8(1).u8(2).str('food:bread').u32(3).u16(12).str('tool:pickaxe').u32(250).u16(0);
    expect(decodeShop(w.bytes)).toEqual([
      { index: 0, item: 'food:bread', price: 3, stock: 12 },
      { index: 1, item: 'tool:pickaxe', price: 250, stock: 0 },
    ]);
  });
  it('handles UTF-8 and an empty list', () => {
    expect(decodeShop(new W().u8(1).u8(1).str('herb:mÿrtle').u32(70000).u16(65535).bytes)).toEqual([{ index: 0, item: 'herb:mÿrtle', price: 70000, stock: 65535 }]);
    expect(decodeShop(new W().u8(1).u8(0).bytes)).toEqual([]);
  });
  it('rejects a truncated payload or another version', () => {
    expect(() => decodeShop(new W().u8(1).u8(1).str('food:bread').u32(3).bytes)).toThrow(/truncated/);
    expect(() => decodeShop(new W().u8(2).u8(0).bytes)).toThrow(/version/);
  });
});

describe('802 bounties', () => {
  it('decodes ids, kinds, targets, quantities, rewards and accepted flags', () => {
    const w = new W().u8(1).u8(2);
    w.u32(0xdeadbeef).u8(0).u16(42).u16(1).u32(120).u8(0).str('Clear the bandit camp to the north');
    w.u32(7).u8(1).u16(0xffff).u16(5).u32(60).u8(1).str('Bring 5 iron ingots');
    expect(decodeBounties(w.bytes)).toEqual([
      { id: 0xdeadbeef, kind: 0, site: 42, qty: 1, reward: 120, accepted: false, text: 'Clear the bandit camp to the north' },
      { id: 7, kind: 1, site: -1, qty: 5, reward: 60, accepted: true, text: 'Bring 5 iron ingots' },
    ]);
  });
  it('rejects truncation', () => {
    expect(() => decodeBounties(new W().u8(1).u8(1).u32(1).u8(0).bytes)).toThrow(/truncated/);
  });
});

describe('805 station and helpers', () => {
  it('reads the prop stable id and settlement', () => {
    const b = new Uint8Array(10);
    const dv = new DataView(b.buffer);
    dv.setBigUint64(0, 0x1234_5678_9abc_def0n, true);
    dv.setUint16(8, 3, true);
    expect(decodeStation(b)).toEqual({ propId: 0x1234_5678_9abc_def0n, settlement: 3 });
    expect(decodeStation(new Uint8Array(4))).toBeNull();
  });
  it('names placeholder items and every refusal reason', () => {
    expect(itemName('food:smoked_fish')).toBe('smoked fish');
    // Playtest 2: real names, so a blueprint never reads as the finished item.
    expect(itemName('blueprint:sunsteel_blade')).toBe('Blueprint: Sunsteel Blade');
    expect(itemName('weapon:iron_sword')).toBe('Iron Sword');
    expect(itemName('blueprint:iron_sword')).not.toBe(itemName('weapon:iron_sword'));
    expect(itemName('rope')).toBe('rope');
    for (let r = 1; r <= 8; r++) expect(REFUSAL[r]).toBeTruthy();
  });
  it('never shows a stock count that reads as exclusive (playtest 2 co-op)', () => {
    const bp = shopNote({ item: 'blueprint:sunsteel_blade', stock: 1 });
    expect(bp).toContain('each traveller buys their own');
    expect(bp).toContain('forge recipe');
    expect(bp).not.toMatch(/stock|\d/);
    expect(shopNote({ item: 'food:smoked_fish', stock: 7 })).toBe('');
    expect(shopNote({ item: 'blueprint:sunsteel_blade', stock: 0 })).toBe('Sold out');
    expect(shopNote({ item: 'food:smoked_fish', stock: 0 })).toBe('Sold out');
  });
});
