// Inventory state in the browser (WP14): the zone's truth about this
// character's items (Event 400, a full replace each time), nearby loot
// containers (406), the open crafting station (404 / WP20's 805), toasts,
// the Bitchin' banner and which panels are open. Everything authoritative
// arrives as zone Events; the store never invents items (the dev handle's
// mock() is the only exception, for solo screenshots). `reduceItemEvent` is
// pure and unit-tested.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { decodeBitchin, decodeContainers, decodeCrafted, decodeInventory, decodeLootGranted, decodeRefusedTarget, decodeStationOpened, EV, LOOT_SOURCE, stationKind805, u64, utf8, type Container, type Inventory, type StationKind } from './events';
import { baseName, CONTAINER_LABEL, displayName, isHolo, rarityColor, REFUSAL, type WireItem } from './items';

export type ToastKind = 'loot' | 'warn' | 'info';

export interface LootToast {
  id: number;
  kind: ToastKind;
  text: string;
  detail?: string;
  color?: string;
  holo?: boolean;
  at: number;
}

export interface OpenStation {
  kind: StationKind;
  prop: bigint;
  settlement: number;
  /** Smithing level (404 only). */
  level: number | null;
  /** Opened in solo (no zone): crafting is disabled. */
  offline: boolean;
}

/** What the panels can ask the zone to do (null while offline). */
export interface InventoryActions {
  item(handle: number, action: number, arg?: number): void;
  socket(weaponH: number, gemH: number, socket: number): void;
  craft(recipeId: number): void;
  openContainer(id: bigint): void;
  takePickup(entityId: number): void;
  /** Interact 22/2: open the inn hearth / campfire (prop stable id); the zone answers with 404. */
  openCook(prop: bigint): void;
  /** Interact 50/2: wield the loadout's default training weapon in an empty main hand (playtest 2). */
  trainingWeapon?(loadout: number, weapon: string): void;
}

export interface InventoryState {
  /** null until the first Event 400. */
  inv: Inventory | null;
  containers: Container[];
  station: OpenStation | null;
  lastCrafted: { item: WireItem | null; key: string; qty: number; at: number } | null;
  toasts: LootToast[];
  bitchin: { text: string; at: number } | null;
  invOpen: boolean;
  /** Selected item handle (details card + actions). */
  selected: number | null;
  /** Socket mode: the weapon (and socket) waiting for a gem click. */
  socketPick: { weapon: number; socket: number } | null;
  actions: InventoryActions | null;
  /** Counters for tests and headless runs. */
  stats: { events: number; inventories: number; grants: number; refusals: number };
}

let toastId = 1;
export const TOAST_MS = 4500;
export const BITCHIN_MS = 7000;
const MAX_TOASTS = 6;

export function makeToast(kind: ToastKind, text: string, now: number, extra: Partial<LootToast> = {}): LootToast {
  return { id: toastId++, kind, text, at: now, ...extra };
}

function pushToasts(s: InventoryState, now: number, ...t: LootToast[]): LootToast[] {
  return [...s.toasts.filter((x) => now - x.at < TOAST_MS), ...t].slice(-MAX_TOASTS);
}

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceItemEvent(s: InventoryState, ev: ZoneEvent, now: number): Partial<InventoryState> | null {
  if (!((ev.kind >= 400 && ev.kind <= 411) || ev.kind === EV.stationOpened)) return null;
  const stats = { ...s.stats, events: s.stats.events + 1 };
  switch (ev.kind) {
    case EV.inventory: {
      const inv = decodeInventory(ev.data);
      const has = (h: number | null) => h !== null && inv.items.some((it) => it.h === h);
      return {
        inv,
        selected: has(s.selected) ? s.selected : null,
        socketPick: s.socketPick && has(s.socketPick.weapon) ? s.socketPick : null,
        stats: { ...stats, inventories: stats.inventories + 1 },
      };
    }
    case EV.lootGranted: {
      const list = decodeLootGranted(ev.data);
      // A craft sends 405 (crafted) and then 401 (source 4) for the same item;
      // the 405 already toasted "Crafted ...", so the grant stays silent.
      const t = ev.targetId === LOOT_SOURCE.craft ? [] : list.map((e) => makeToast('loot', `${displayName(e)}${e.q > 1 ? ` x${e.q}` : ''}`, now, { color: rarityColor(e.r), holo: isHolo(e.r), detail: e.n ? baseName(e.b) : undefined }));
      return { toasts: pushToasts(s, now, ...t), stats: { ...stats, grants: stats.grants + list.length } };
    }
    case EV.bitchin: {
      const b = decodeBitchin(ev.data);
      return { bitchin: { text: b.text, at: now }, toasts: pushToasts(s, now, makeToast('loot', `${b.name} found ${b.displayName}`, now, { holo: true })), stats };
    }
    case EV.refused: {
      const { kind } = decodeRefusedTarget(ev.targetId);
      const text = REFUSAL[ev.value] ?? `Refused (${ev.value})`;
      return { toasts: pushToasts(s, now, makeToast('warn', text, now, { detail: kind === 22 ? 'crafting' : undefined })), stats: { ...stats, refusals: stats.refusals + 1 } };
    }
    case EV.station:
      // CR 025 camps: targetId 4 is a camp workbench; 3 a hearth, campfire or camp campfire.
      return { station: { kind: ev.targetId === 4 ? 'workbench' : 'cook', prop: ev.data.length >= 8 ? u64(ev.data) : 0n, settlement: -1, level: ev.value, offline: false }, stats };
    case EV.stationOpened: {
      const st = ev.data.length >= 8 ? decodeStationOpened(ev.data) : { prop: 0n, settlement: -1 };
      return { station: { kind: stationKind805(ev.targetId), prop: st.prop, settlement: st.settlement, level: s.station?.level ?? null, offline: false }, stats };
    }
    case EV.crafted: {
      const c = decodeCrafted(ev.targetId, ev.value, ev.data);
      const key = c.item?.b ?? '';
      const name = c.item ? displayName(c.item) : 'an item';
      return {
        lastCrafted: { item: c.item, key, qty: c.qty, at: now },
        toasts: pushToasts(s, now, makeToast('loot', `Crafted ${c.qty > 1 ? `${c.qty} ` : ''}${name}`, now, { color: rarityColor(c.item?.r ?? 0), holo: isHolo(c.item?.r ?? 0) })),
        stats,
      };
    }
    case EV.containers:
      return { containers: decodeContainers(ev.data), stats };
    case EV.containerOpened: {
      const id = ev.data.length >= 8 ? u64(ev.data) : -1n;
      const c = s.containers.find((x) => x.id === id);
      return {
        containers: s.containers.map((x) => (x.id === id ? { ...x, opened: true } : x)),
        toasts: ev.value === 0 ? pushToasts(s, now, makeToast('info', `The ${c ? CONTAINER_LABEL[c.kind] ?? 'container' : 'container'} is empty`, now)) : s.toasts,
        stats,
      };
    }
    case EV.dropped:
      return { toasts: pushToasts(s, now, makeToast('info', `Dropped ${ev.value > 1 ? `${ev.value} x ` : ''}${baseName(utf8(ev.data))}`, now)), stats };
    case EV.bossLockout:
      return { toasts: pushToasts(s, now, makeToast('warn', `${utf8(ev.data) || 'This boss'} already gave you loot this week`, now, { detail: `week ${ev.value}` })), stats };
    case EV.gemCombined:
      return { toasts: pushToasts(s, now, makeToast('loot', `Gems combined: ${baseName(utf8(ev.data))}`, now, { color: '#9fe6ff' })), stats };
    case EV.itemTaken:
      return { toasts: pushToasts(s, now, makeToast('info', `Took ${ev.value > 1 ? `${ev.value} x ` : ''}${baseName(utf8(ev.data))}`, now)), stats };
  }
  return { stats };
}

export function initialInventoryState(): Omit<InventoryState, 'actions'> {
  return {
    inv: null,
    containers: [],
    station: null,
    lastCrafted: null,
    toasts: [],
    bitchin: null,
    invOpen: false,
    selected: null,
    socketPick: null,
    stats: { events: 0, inventories: 0, grants: 0, refusals: 0 },
  };
}

export const useInventory = create<InventoryState>()(() => ({ ...initialInventoryState(), actions: null }));

/** Apply one zone Event (the link calls this for every Event). */
export function applyItemEvent(ev: ZoneEvent): void {
  const s = useInventory.getState();
  try {
    const p = reduceItemEvent(s, ev, performance.now());
    if (p) useInventory.setState(p);
  } catch (err) {
    console.warn('[inventory] bad event payload', ev.kind, err);
  }
}

export function setInventoryActions(a: InventoryActions | null): void {
  useInventory.setState({ actions: a });
}

/** Reset on a new session (the next 400 refills it). */
export function resetInventory(): void {
  useInventory.setState({ ...initialInventoryState(), invOpen: useInventory.getState().invOpen });
}

export function pushToast(kind: ToastKind, text: string, extra: Partial<LootToast> = {}): void {
  const now = performance.now();
  const s = useInventory.getState();
  useInventory.setState({ toasts: pushToasts(s, now, makeToast(kind, text, now, extra)) });
}

/** Open the smithing panel without a zone (solo: WP20's offline forge, the dev handle). */
export function openStationOffline(kind: StationKind): void {
  useInventory.setState({ station: { kind, prop: 0n, settlement: -1, level: null, offline: !useInventory.getState().actions } });
  if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function closeStation(): void {
  useInventory.setState({ station: null });
}

export function setInventoryOpen(open: boolean): void {
  useInventory.setState(open ? { invOpen: true } : { invOpen: false, socketPick: null });
  if (open && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}
