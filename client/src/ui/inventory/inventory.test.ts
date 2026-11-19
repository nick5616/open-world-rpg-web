// WP14 client: Event decoders, item helpers and the store reducer.
import { describe, expect, it } from 'vitest';
import { COMBAT, ITEMS, type Event as ZoneEvent } from '@lodestone/contracts';
import { decodeBitchin, decodeContainers, decodeCrafted, decodeInventory, decodeLootGranted, decodeRefusedTarget, decodeStationOpened, encodeContainers, EV, LOOT_SOURCE, stationKind805, u64 } from './events';
import { affixLine, baseName, compareToEquipped, countOf, defaultWeapon, gearScore, gearStats, displayName, formatStat, isHolo, itemDef, kindLabel, loadoutWeaponLabel, parseSlot, rarityColor, rarityDef, recipeGroup, recipesFor, recipeStatus, smithingView, socketTarget, trainingEquipArg, trainingWeaponName, uniqueInfo, type WireItem } from './items';
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

  it('a craft toasts once: 405 says "Crafted ...", its 401 (source craft) stays silent', () => {
    let s = state();
    const out = item('weapon:sunsteel_blade', 'inv:3', { r: 2 });
    s = { ...s, ...reduceItemEvent(s, ev(EV.crafted, JSON.stringify(out), 1, 12), 100)! };
    s = { ...s, ...reduceItemEvent(s, ev(EV.lootGranted, '[{"b":"weapon:sunsteel_blade","q":1,"r":2}]', 1, LOOT_SOURCE.craft), 101)! };
    expect(s.toasts.map((t) => t.text)).toEqual(['Crafted Sunsteel Blade']);
    expect(s.stats.grants).toBe(1);
    expect(s.lastCrafted?.key).toBe('weapon:sunsteel_blade');
    // Other sources still toast.
    const k = reduceItemEvent(state(), ev(EV.lootGranted, '[{"b":"weapon:sunsteel_blade","q":1,"r":2}]', 1, LOOT_SOURCE.purchase), 100)!;
    expect(k.toasts?.map((t) => t.text)).toEqual(['Sunsteel Blade']);
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

describe('combat HUD weapon label', () => {
  const blade = item('weapon:sunsteel_blade', 'eq:main0', { h: 9 });
  it('names the equipped item, not the weapon type', () => {
    expect(loadoutWeaponLabel('sword', 0, [item('food:bread', 'inv:0'), blade])).toBe('Sunsteel Blade');
    expect(loadoutWeaponLabel('sword', 0, [{ ...blade, n: 'Dawnbreaker', r: 5 }])).toBe('Dawnbreaker');
  });
  it('uses the active loadout main hand', () => {
    const bow = item('weapon:silver_bow', 'eq:main1', { h: 10 });
    expect(loadoutWeaponLabel('bow', 1, [blade, bow])).toBe('Silver-Strung Bow');
    expect(loadoutWeaponLabel('sword', 1, [blade])).toBe('Sword');
  });
  it('falls back to the weapon type', () => {
    expect(loadoutWeaponLabel('sword', 0, null)).toBe('Sword');
    expect(loadoutWeaponLabel('spear', 0, [])).toBe('Spear');
    // A training weapon picked while the item is still equipped: the types disagree.
    expect(loadoutWeaponLabel('staff', 0, [blade])).toBe('Staff');
    expect(loadoutWeaponLabel('', 0, [])).toBe('-');
  });
});

describe('default training weapon (playtest 2: switch back to the starter sword)', () => {
  it('names each loadout default from combat.yaml start', () => {
    expect(defaultWeapon(0)).toBe('sword');
    expect(defaultWeapon(1)).toBe('staff');
    expect(trainingWeaponName('sword')).toBe('Training Sword');
  });
  it('encodes Interact 50/2 like the zone (loadout | weapon id << 8)', () => {
    const sword = COMBAT.weapons.find((w) => w.key === 'sword')!;
    expect(trainingEquipArg(0, 'sword')).toBe(sword.id << 8);
    expect(trainingEquipArg(1, 'sword')).toBe(1 | (sword.id << 8));
    expect(trainingEquipArg(0, 'nope')).toBe(0);
  });
});

describe('crafting panel Smithing', () => {
  it('shows level and progress at the forge from the synced skill XP', () => {
    const v = smithingView('forge', null, true, 30)!;
    // Level 2 starts at 12 XP, level 3 at 36 (combat.yaml skills: 12 x (n-1)^1.6).
    expect(v).toEqual({ level: 2, progress: { level: 2, into: 18, span: 24, frac: 0.75, max: false } });
    const z = smithingView('anvil', null, true, undefined)!;
    expect(z).toMatchObject({ level: 1, progress: { into: 0, span: 12, frac: 0 } });
  });
  it('cooking shows the level only; offline falls back to Event 404', () => {
    expect(smithingView('cook', 4, true, 40)).toEqual({ level: 3, progress: null });
    expect(smithingView('cook', 4, false, undefined)).toEqual({ level: 4, progress: null });
    expect(smithingView('forge', null, false, undefined)).toBeNull();
  });
});

describe('better gear in the bag (playtest 2 co-op)', () => {
  const blade = item('weapon:sunsteel_blade', 'eq:main0', { h: 1, l: 10 });
  it('twins the zone gear numbers (items/gear.go)', () => {
    // Weapon: material mult x (1 + 0.02 x levels above the base level).
    expect(gearStats(item('weapon:sunsteel_blade', 'inv:0', { l: 20 }), 'weapon').weaponMult).toBeCloseTo(1.2 * 1.2);
    expect(gearStats(item('weapon:sunsteel_blade', 'inv:0', { l: 5 }), 'weapon').weaponMult).toBeCloseTo(1.2);
    // Armour: round(health x mult x (1 + 0.05 x levels above base)) + affixes.
    const helm = gearStats(item('armor:iron_helm', 'inv:0', { l: 30, a: [{ k: 'sturdy', s: 'health', v: 9 }] }), 'armor');
    expect(helm.health).toBe(23 + 9);
    expect(helm.armorPct).toBe(3);
    expect(gearStats(item('armor:silver_cuirass', 'inv:0', { l: 8 }), 'armor').health).toBe(Math.round(28 * 1.1));
    // Uniques add their stats; crit and damage raise the expected hit.
    const ember = gearStats(item('weapon:starmetal_sword', 'inv:0', { l: 14, u: ['emberheart'] }), 'weapon');
    expect(ember.damagePct).toBe(20);
    expect(ember.critPct).toBe(4);
    expect(gearScore(ember)).toBeGreaterThan(gearScore(gearStats(item('weapon:starmetal_sword', 'inv:0', { l: 14 }), 'weapon')));
  });
  it('compares a weapon with the main hand holding the same type', () => {
    const star = item('weapon:starmetal_sword', 'inv:0', { h: 2, l: 14 });
    let c = compareToEquipped(star, [blade, star])!;
    expect(c.verdict).toBe(1);
    expect(c.text).toBe('+13% weapon damage vs your Sunsteel Blade'); // 1.35 / 1.2
    const iron = item('weapon:iron_sword', 'inv:1', { h: 3, l: 4 });
    c = compareToEquipped(iron, [blade, iron])!;
    expect(c.verdict).toBe(-1);
    expect(c.text).toBe('-17% weapon damage vs your Sunsteel Blade');
    // A staff goes against Loadout 2 (its empty main hand is the training staff).
    const staff = item('weapon:oak_staff', 'inv:2', { h: 4, l: 1 });
    c = compareToEquipped(staff, [blade, staff])!;
    expect(c).toEqual({ verdict: 0, text: 'About the same as your Training Staff' });
    c = compareToEquipped({ ...staff, a: [{ k: 'brutal', s: 'damagePct', v: 8 }] }, [blade])!;
    expect(c.verdict).toBe(1);
    // No loadout holds a bow: Loadout 1's main hand.
    c = compareToEquipped(item('weapon:oak_bow', 'inv:3', { h: 5 }), [blade])!;
    expect(c.text).toMatch(/vs your Sunsteel Blade$/);
    expect(c.verdict).toBe(-1);
  });
  it('compares armour with its slot, an empty slot as nothing', () => {
    const cap = item('armor:leather_cap', 'eq:head', { h: 6, l: 1 });
    const helm = item('armor:iron_helm', 'inv:4', { h: 7, l: 30 });
    expect(compareToEquipped(helm, [blade, cap, helm])).toEqual({ verdict: 1, text: '+17 health, +1% armour vs your Leather Cap' });
    expect(compareToEquipped(item('armor:leather_cap', 'inv:5', { l: 1 }), [item('armor:iron_helm', 'eq:head', { l: 4 })])).toEqual({ verdict: -1, text: '-4 health, -1% armour vs your Iron Helm' });
    expect(compareToEquipped(item('armor:leather_leggings', 'inv:6', { l: 1 }), [cap])).toEqual({ verdict: 1, text: '+8 health, +3% armour vs an empty legs slot' });
  });
  it('ignores equipped items and anything that is not gear', () => {
    expect(compareToEquipped(blade, [blade])).toBeNull();
    expect(compareToEquipped(item('food:bread', 'inv:0'), [blade])).toBeNull();
    expect(compareToEquipped(item('gem:topaz:cut', 'gem:0'), [blade])).toBeNull();
  });
});
