// WP14 client: Event decoders, item helpers and the store reducer.
import { describe, expect, it } from 'vitest';
import { ITEMS, type Event as ZoneEvent } from '@lodestone/contracts';
import { decodeBitchin, decodeContainers, decodeCrafted, decodeInventory, decodeLootGranted, decodeRefusedTarget, decodeStationOpened, encodeContainers, EV, stationKind805, u64 } from './events';
import { affixLine, baseName, countOf, displayName, formatStat, isHolo, itemDef, kindLabel, parseSlot, rarityColor, rarityDef, recipeGroup, recipesFor, recipeStatus, socketTarget, uniqueInfo, type WireItem } from './items';
import { initialInventoryState, reduceItemEvent, type InventoryState } from './store';
import { mockItems } from './dev';

const enc = new TextEncoder();
const ev = (kind: number, data: Uint8Array | string, value = 0, targetId = 0): ZoneEvent => ({ type: 'Event', kind, entityId: 7, targetId, value, x: 0, y: 0, z: 0, data: typeof data === 'string' ? enc.encode(data) : data });
const state = (): InventoryState => ({ ...initialInventoryState(), actions: null });
const item = (b: string, s: string, extra: Partial<WireItem> = {}): WireItem => ({ h: 1, b, q: 1, l: 1, r: 0, s, t: true, v: true, p: 1, ...extra });

describe('decoders', () => {
  it('decodes the inventory JSON (Event 400)', () => {
    const inv = decodeInventory(
      enc.encode(JSON.stringify({ v: 1, gold: 42, quick: 'potion:health', persist: 'db', items: [{ h: 3, b: 'weapon:iron_sword', q: 1, l: 4, r: 2, s: 'inv:0', a: [{ k: 'brutal', s: 'damagePct', v: 7.5 }], k: [''], t: true, v: true, p: 1 }, { h: 4, b: 'currency:gold', q: 42, l: 1, r: 0, s: 'purse', t: true, v: true, p: 0 }] })),
    );
    expect(inv.gold).toBe(42);
    expect(inv.quick).toBe('potion:health');
    expect(inv.persist).toBe('db');
    expect(inv.items).toHaveLength(2);
    expect(inv.items[0].a?.[0]).toEqual({ k: 'brutal', s: 'damagePct', v: 7.5 });
  });

  it('tolerates a sparse inventory and rejects garbage', () => {
    const inv = decodeInventory(enc.encode('{"v":1,"items":[{"h":1,"b":"food:bread","s":"inv:2"},{"nope":1}]}'));
    expect(inv.gold).toBe(0);
    expect(inv.items).toEqual([{ h: 1, b: 'food:bread', s: 'inv:2', q: 1, l: 1, r: 0, p: 0 }]);
    expect(() => decodeInventory(enc.encode('not json'))).toThrow();
  });

  it('decodes loot grants, Bitchin news and refusals', () => {
    expect(decodeLootGranted(enc.encode('[{"b":"gem:ruby:rough","q":2,"r":0},{"b":"weapon:silver_bow","q":1,"r":5,"n":"Ashsong"}]'))).toEqual([
      { b: 'gem:ruby:rough', q: 2, r: 0 },
      { b: 'weapon:silver_bow', q: 1, r: 5, n: 'Ashsong' },
    ]);
    const b = decodeBitchin(enc.encode(JSON.stringify({ name: 'Mira', item: 'weapon:starmetal_bow', displayName: 'Starsong', text: "Mira found Starsong, a Bitchin' Starmetal Bow!" })));
    expect(b.text).toContain('Starsong');
    expect(decodeBitchin(enc.encode('{"name":"Ash","displayName":"Riftfall"}')).text).toBe('Ash found Riftfall!');
    expect(decodeRefusedTarget((22 << 8) | 1)).toEqual({ kind: 22, action: 1 });
    expect(decodeRefusedTarget((21 << 8) | 6)).toEqual({ kind: 21, action: 6 });
  });

  it('decodes station ids (404 / 805) and crafted items', () => {
    const d = new Uint8Array(10);
    const dv = new DataView(d.buffer);
    dv.setBigUint64(0, 0x1122334455667788n, true);
    dv.setUint16(8, 12, true);
    expect(decodeStationOpened(d)).toEqual({ prop: 0x1122334455667788n, settlement: 12 });
    expect(u64(d)).toBe(0x1122334455667788n);
    expect(stationKind805(1)).toBe('forge');
    expect(stationKind805(2)).toBe('anvil');
    const c = decodeCrafted(16, 1, enc.encode(JSON.stringify(item('weapon:sunsteel_blade', 'inv:3', { r: 3, k: [''] }))));
    expect(c.recipeId).toBe(16);
    expect(c.item?.b).toBe('weapon:sunsteel_blade');
    expect(decodeCrafted(1, 1, enc.encode('??')).item).toBeNull();
  });

  it('round-trips the containers payload (Event 406)', () => {
    const list = [
      { id: 0xfedcba9876543210n, x: 1234.5, y: -12.25, z: -987.75, kind: 0, opened: false },
      { id: 7n, x: 0, y: 30, z: 5.5, kind: 2, opened: true },
    ];
    const bytes = encodeContainers(list);
    expect(bytes.length).toBe(3 + 2 * 22);
    expect(decodeContainers(bytes)).toEqual(list);
    expect(() => decodeContainers(bytes.slice(0, 20))).toThrow();
    const bad = bytes.slice();
    bad[0] = 2;
    expect(() => decodeContainers(bad)).toThrow(/version/);
  });
});

describe('item helpers', () => {
  it('names items: generated names, bases, tomes, unknown keys', () => {
    expect(baseName('weapon:sunsteel_blade')).toBe('Sunsteel Blade');
    expect(displayName({ b: 'weapon:voidglass_spear', n: 'Riftreaver' })).toBe('Riftreaver');
    expect(displayName({ b: 'weapon:voidglass_spear' })).toBe('Voidglass Spear');
    expect(baseName('tome:fireball')).toBe('Tome: Fireball');
    expect(itemDef('tome:fireball')?.kind).toBe('tome');
    expect(baseName('food:mystery_pie')).toBe('Mystery Pie');
    expect(baseName('gem:topaz:cut')).toBe('Cut Topaz');
    expect(kindLabel('armor:iron_helm')).toBe('Head armor');
    expect(kindLabel('weapon:oak_bow')).toBe('Bow');
  });

  it('maps rarities to names and colours (Bitchin is holographic)', () => {
    expect(rarityDef(4).name).toBe('Legendary');
    expect(rarityColor(5)).toBe(ITEMS.rarities[5].color);
    expect(isHolo(7)).toBe(true);
    expect(isHolo(6)).toBe(false);
    expect(rarityColor(7)).toMatch(/^#/);
    expect(rarityDef(99).key).toBe('bitchin');
  });

  it('formats stats, affixes and uniques', () => {
    expect(formatStat('damagePct', 12.34)).toBe('+12.3% damage');
    expect(formatStat('health', 14)).toBe('+14 health');
    expect(formatStat('critPct', 4)).toBe('+4% critical chance');
    expect(formatStat('lootFindPct', -2.5)).toBe('-2.5% loot find');
    expect(affixLine({ k: 'of_embers', s: 'damagePct', v: 9.96 })).toEqual({ name: 'of Embers', text: '+10% damage' });
    const u = uniqueInfo('emberheart');
    expect(u.name).toBe('Emberheart');
    expect(u.lines).toEqual(['+20% damage', '+4% critical chance']);
  });

  it('parses slots and packs socket targets', () => {
    expect(parseSlot('inv:12')).toEqual({ pouch: 'inv', index: 12 });
    expect(parseSlot('gem:3')).toEqual({ pouch: 'gem', index: 3 });
    expect(parseSlot('eq:head')).toEqual({ pouch: 'eq', index: 2 });
    expect(parseSlot('purse')).toEqual({ pouch: 'purse', index: 0 });
    expect(socketTarget(5, 9)).toBe(5n | (9n << 32n));
    expect(socketTarget(0xffffffff, 1)).toBe(0x1ffffffffn);
  });

  it('checks recipes against the inventory (have/need, blueprint)', () => {
    const forge = recipesFor('forge');
    expect(forge.every((r) => r.station === 'forge')).toBe(true);
    expect(recipesFor('anvil')).toEqual(forge);
    expect(recipesFor('cook').every((r) => r.station === 'cook')).toBe(true);
    const blade = forge.find((r) => r.key === 'forge_sunsteel_blade')!;
    expect(recipeGroup(blade)).toBe('Forging');
    expect(recipeGroup(forge.find((r) => r.key === 'smelt_iron')!)).toBe('Smelting');
    const inv = [item('ingot:sunsteel', 'ore:0', { q: 1 }), item('ingot:sunsteel', 'ore:1', { q: 1 })];
    let st = recipeStatus(blade, inv);
    expect(st.inputs).toEqual([{ item: 'ingot:sunsteel', name: 'Sunsteel Ingot', have: 2, need: 2 }]);
    expect(st.blueprint).toEqual({ item: 'blueprint:sunsteel_blade', name: 'Blueprint: Sunsteel Blade', have: false });
    expect(st.canCraft).toBe(false);
    st = recipeStatus(blade, [...inv, item('blueprint:sunsteel_blade', 'inv:0')]);
    expect(st.canCraft).toBe(true);
    // Equipped gear never counts as an ingredient.
    expect(countOf([item('weapon:iron_sword', 'eq:main0'), item('weapon:iron_sword', 'inv:1')], 'weapon:iron_sword')).toBe(1);
  });

  it('the dev mock only uses real item keys and unique slots', () => {
    const m = mockItems();
    for (const it of m.items) expect(itemDef(it.b), it.b).toBeTruthy();
    expect(new Set(m.items.map((x) => x.s)).size).toBe(m.items.length);
    expect(new Set(m.items.map((x) => x.h)).size).toBe(m.items.length);
    for (const it of m.items) for (const a of it.a ?? []) expect(ITEMS.affixes.some((d) => d.key === a.k && d.stat === a.s), a.k).toBe(true);
    for (const it of m.items) for (const u of it.u ?? []) expect(ITEMS.uniques.some((d) => d.key === u), u).toBe(true);
  });
});

describe('reducer', () => {
  it('replaces the inventory and keeps a selection only while its item exists', () => {
    let s = state();
    s = { ...s, selected: 3, socketPick: { weapon: 9, socket: 0 } };
    const p = reduceItemEvent(s, ev(EV.inventory, JSON.stringify({ v: 1, gold: 5, quick: '', persist: 'memory', items: [item('food:bread', 'inv:0', { h: 3 })] }), 5), 0)!;
    expect(p.inv?.gold).toBe(5);
    expect(p.selected).toBe(3);
    expect(p.socketPick).toBeNull();
    const p2 = reduceItemEvent({ ...s, ...p }, ev(EV.inventory, '{"v":1,"items":[]}'), 0)!;
    expect(p2.selected).toBeNull();
  });

  it('turns grants, refusals and crafts into rarity-coloured toasts', () => {
    const s = state();
    const p = reduceItemEvent(s, ev(EV.lootGranted, '[{"b":"weapon:silver_bow","q":1,"r":5,"n":"Ashsong"},{"b":"currency:gold","q":12,"r":0}]', 2, 1), 100)!;
    expect(p.toasts?.map((t) => t.text)).toEqual(['Ashsong', 'Gold x12']);
    expect(p.toasts?.[0].color).toBe(ITEMS.rarities[5].color);
    expect(p.toasts?.[0].detail).toBe('Silver-Strung Bow');
    const r = reduceItemEvent(s, ev(EV.refused, '', 5, (22 << 8) | 1), 100)!;
    expect(r.toasts?.[0]).toMatchObject({ kind: 'warn', text: 'You need the blueprint for that' });
    const c = reduceItemEvent(s, ev(EV.crafted, JSON.stringify(item('ingot:iron', 'ore:0', { q: 1 })), 1, 2), 100)!;
    expect(c.lastCrafted?.key).toBe('ingot:iron');
    expect(c.toasts?.[0].text).toBe('Crafted Iron Ingot');
  });

  it('opens stations on 805 (forge/anvil) and 404 (cook)', () => {
    const d = new Uint8Array(10);
    new DataView(d.buffer).setBigUint64(0, 99n, true);
    const f = reduceItemEvent(state(), ev(EV.stationOpened, d, 0, 2), 0)!;
    expect(f.station).toMatchObject({ kind: 'anvil', prop: 99n, offline: false });
    const c = reduceItemEvent(state(), ev(EV.station, d.slice(0, 8), 7, 3), 0)!;
    expect(c.station).toMatchObject({ kind: 'cook', prop: 99n, level: 7 });
  });

  it('tracks containers, opened containers and the Bitchin banner', () => {
    const list = [{ id: 5n, x: 1, y: 2, z: 3, kind: 0, opened: false }];
    let s = state();
    s = { ...s, ...reduceItemEvent(s, ev(EV.containers, encodeContainers(list), 1), 0)! };
    expect(s.containers).toEqual(list);
    const id = new Uint8Array(8);
    new DataView(id.buffer).setBigUint64(0, 5n, true);
    s = { ...s, ...reduceItemEvent(s, ev(EV.containerOpened, id, 2), 0)! };
    expect(s.containers[0].opened).toBe(true);
    const b = reduceItemEvent(s, ev(EV.bitchin, '{"name":"Mira","displayName":"Starsong","text":"Mira found Starsong!"}'), 50)!;
    expect(b.bitchin).toEqual({ text: 'Mira found Starsong!', at: 50 });
    expect(b.toasts?.[0].holo).toBe(true);
  });

  it('ignores other Event kinds', () => {
    expect(reduceItemEvent(state(), ev(800, ''), 0)).toBeNull();
    expect(reduceItemEvent(state(), ev(412, ''), 0)).toBeNull();
  });
});
