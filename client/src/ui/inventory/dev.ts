// window.__lodestoneInventory: debug handle for headless scripts
// (dev/shots.mjs) and the browser console. Debug builds only (DEBUG: dev,
// solo, ?debug=1), like window.__lodestoneMap. mock() injects a realistic
// sample inventory and containers so the panels can be seen and
// screenshotted in solo mode with no zone; it never runs online unless
// called by hand.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { localPlayer } from '../../state/live';
import { encodeContainers, EV, type Container, type StationKind } from './events';
import type { WireItem } from './items';
import { applyItemEvent, closeStation, openStationOffline, setInventoryOpen, useInventory } from './store';

let h = 100;
const it = (b: string, s: string, extra: Partial<WireItem> = {}): WireItem => ({ h: h++, b, q: 1, l: 1, r: 0, s, t: true, v: true, p: 1, ...extra });

/** The sample inventory mock() shows (exported for tests). */
export function mockItems(): { gold: number; quick: string; items: WireItem[] } {
  h = 100;
  const items: WireItem[] = [
    // Equipped: a rare Sunsteel Blade with a socketed topaz in loadout 1, a staff in loadout 2, armor.
    it('weapon:sunsteel_blade', 'eq:main0', { r: 2, l: 11, a: [{ k: 'brutal', s: 'damagePct', v: 8.4 }, { k: 'keen', s: 'critPct', v: 3.1 }], k: ['gem:topaz:cut'], p: 2 }),
    it('weapon:oak_staff', 'eq:main1', { l: 3 }),
    it('armor:iron_helm', 'eq:head', { r: 1, l: 6, a: [{ k: 'sturdy', s: 'health', v: 9 }] }),
    it('armor:silver_cuirass', 'eq:body', { r: 3, l: 9, a: [{ k: 'hale', s: 'health', v: 17 }, { k: 'warding', s: 'armorPct', v: 4.2 }, { k: 'lucky', s: 'lootFindPct', v: 3.5 }] }),
    it('armor:leather_leggings', 'eq:legs', { l: 2 }),
    // Bag.
    it('weapon:starmetal_sword', 'inv:0', { r: 4, l: 15, a: [{ k: 'brutal', s: 'damagePct', v: 11.2 }, { k: 'of_embers', s: 'damagePct', v: 15.8 }, { k: 'keen', s: 'critPct', v: 5.4 }], u: ['emberheart'], k: ['', ''], p: 1 }),
    it('weapon:voidglass_spear', 'inv:1', { r: 5, l: 19, n: 'Riftreaver', a: [{ k: 'of_the_void', s: 'spellPowerPct', v: 21.6 }, { k: 'brutal', s: 'damagePct', v: 13.9 }, { k: 'keen', s: 'critPct', v: 6.2 }, { k: 'lucky', s: 'lootFindPct', v: 7.1 }], u: ['stormcall'], k: ['gem:amethyst:brilliant', '', ''], v: false, t: false, p: 3 }),
    it('weapon:starmetal_bow', 'inv:2', { r: 7, l: 20, n: 'Starsong', a: [{ k: 'of_dawn', s: 'spellPowerPct', v: 19.5 }, { k: 'brutal', s: 'damagePct', v: 14.4 }, { k: 'keen', s: 'critPct', v: 7.0 }, { k: 'of_storms', s: 'critPct', v: 9.2 }, { k: 'lucky', s: 'lootFindPct', v: 8.0 }], u: ['starlit', 'magpie'], k: ['gem:opal:brilliant', '', ''], p: 1 }),
    it('potion:health', 'inv:3', { q: 5 }),
    it('potion:greater_health', 'inv:4', { q: 2 }),
    it('food:stew', 'inv:5', { q: 4 }),
    it('blueprint:sunsteel_blade', 'inv:6'),
    it('tome:fireball', 'inv:7'),
    it('ammo:iron_arrow', 'inv:8', { q: 60 }),
    it('weapon:iron_sword', 'inv:9', { r: 1, l: 5, a: [{ k: 'keen', s: 'critPct', v: 2.6 }], k: [''] }),
    it('meat:raw', 'inv:10', { q: 3 }),
    it('herb:heartleaf', 'inv:11', { q: 6 }),
    it('armor:iron_greaves', 'inv:12', { r: 2, l: 6, a: [{ k: 'sturdy', s: 'health', v: 12 }, { k: 'warding', s: 'armorPct', v: 3.3 }] }),
    it('weapon:silver_bow', 'inv:13', { r: 6, l: 16, n: 'Moonfang', a: [{ k: 'of_frost', s: 'damagePct', v: 16.1 }, { k: 'keen', s: 'critPct', v: 6.6 }, { k: 'brutal', s: 'damagePct', v: 12.0 }, { k: 'arcane', s: 'spellPowerPct', v: 11.0 }, { k: 'lucky', s: 'lootFindPct', v: 6.0 }], u: ['hollowstep'], k: [''] }),
    it('tool:pickaxe', 'inv:14'),
    it('blueprint:iron_sword', 'inv:15'),
    // Gem pouch.
    it('gem:ruby:rough', 'gem:0', { q: 4 }),
    it('gem:topaz:cut', 'gem:1', { q: 1 }),
    it('gem:opal:rough', 'gem:2', { q: 2 }),
    it('gem:sapphire:cut', 'gem:3', { q: 3 }),
    it('gem:moonstone:rough', 'gem:4', { q: 1 }),
    // Ore pouch (ores and ingots).
    it('ore:iron', 'ore:0', { q: 7 }),
    it('ore:sunsteel', 'ore:1', { q: 3 }),
    it('ingot:iron', 'ore:2', { q: 5 }),
    it('ingot:sunsteel', 'ore:3', { q: 2 }),
    it('ore:copper', 'ore:4', { q: 12 }),
    it('currency:gold', 'purse', { q: 1287 }),
  ];
  return { gold: 1287, quick: 'potion:health', items };
}

function ev(kind: number, data: Uint8Array, extra: { value?: number; targetId?: number } = {}): ZoneEvent {
  return { type: 'Event', kind, entityId: 1, targetId: extra.targetId ?? 0, value: extra.value ?? 0, x: 0, y: 0, z: 0, data };
}

export function mockContainers(): Container[] {
  const p = localPlayer.pos;
  return [
    { id: 9001n, x: p.x + 2, y: p.y, z: p.z - 3, kind: 0, opened: false },
    { id: 9002n, x: p.x - 3, y: p.y, z: p.z - 4, kind: 2, opened: false },
    { id: 9003n, x: p.x + 5, y: p.y, z: p.z + 1, kind: 3, opened: true },
    { id: 9004n, x: p.x - 6, y: p.y, z: p.z + 2, kind: 1, opened: false },
  ];
}

export function installInventoryDebug(): () => void {
  if (!DEBUG || typeof window === 'undefined') return () => {};
  const enc = new TextEncoder();
  const handle = {
    state: () => {
      const s = useInventory.getState();
      return { inv: s.inv, containers: s.containers.map((c) => ({ ...c, id: c.id.toString() })), station: s.station ? { ...s.station, prop: s.station.prop.toString() } : null, invOpen: s.invOpen, selected: s.selected, toasts: s.toasts.map((t) => t.text), bitchin: s.bitchin, stats: s.stats, online: !!s.actions };
    },
    open: () => setInventoryOpen(true),
    close: () => setInventoryOpen(false),
    openCraft: (kind: StationKind = 'forge') => openStationOffline(kind),
    closeCraft: () => closeStation(),
    /** Select an item by handle, or by key / generated name. */
    select: (q: number | string) => {
      const items = useInventory.getState().inv?.items ?? [];
      const found = typeof q === 'number' ? items.find((x) => x.h === q) : items.find((x) => x.b === q || x.n === q);
      useInventory.setState({ selected: found?.h ?? null });
      return found?.h ?? null;
    },
    /** Inject the sample inventory and containers (through the same reducer as zone Events). */
    mock: () => {
      const m = mockItems();
      applyItemEvent(ev(EV.inventory, enc.encode(JSON.stringify({ v: 1, gold: m.gold, quick: m.quick, persist: 'memory', items: m.items })), { value: m.gold }));
      applyItemEvent(ev(EV.containers, encodeContainers(mockContainers()), { value: 4 }));
      return m.items.length;
    },
    /** Fake zone Events (any kind), e.g. loot toasts: event(401, JSON.stringify([{b, q, r}])). */
    event: (kind: number, data: string, value = 0, targetId = 0) => applyItemEvent(ev(kind, enc.encode(data), { value, targetId })),
    showBitchin: (text = "Someone found Starsong, a Bitchin' Starmetal Bow!", name = 'Someone') =>
      applyItemEvent(ev(EV.bitchin, enc.encode(JSON.stringify({ name, item: 'weapon:starmetal_bow', displayName: 'Starsong', text })))),
  };
  (window as unknown as { __lodestoneInventory: typeof handle }).__lodestoneInventory = handle;
  return () => {
    delete (window as unknown as { __lodestoneInventory?: unknown }).__lodestoneInventory;
  };
}
