// Exploration state in the browser (WP12): the server's truth about this
// character's progress (towers, waypoints, discoveries, revealed regions,
// level/xp, respawn point), pins, party id, toasts and whether the map is
// open. Everything authoritative arrives as zone Events; the store never
// invents progress. `reduceEvent` is pure and unit-tested.

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { decodePins, decodeProgress, emptyProgress, EV, TRAVEL_DENIED, type Pin, type Progress } from './events';

export type ToastKind = 'discovery' | 'tower' | 'waypoint' | 'level' | 'info' | 'warn';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  at: number;
}

/** What the map and compass can ask the zone to do (null while offline). */
export interface ExplorationActions {
  fastTravel(site: number): void;
  setPin(x: number, z: number, party: boolean, color: number, slot?: number): void;
  clearPin(pin: Pin): void;
}

export interface ExplorationState {
  progress: Progress;
  pins: Pin[];
  /** Snapshot partyId of my party (0 = none): remote entities with the same id are party members. */
  partyId: number;
  toasts: Toast[];
  mapOpen: boolean;
  /** Counters for tests and the acceptance log. */
  stats: { events: number; discoveries: number; towers: number; xpGained: number; teleports: number };
  actions: ExplorationActions | null;
}

let toastId = 1;
const TOAST_MS = 5000;

function toast(kind: ToastKind, title: string, detail: string | undefined, now: number): Toast {
  return { id: toastId++, kind, title, detail, at: now };
}

const utf8 = new TextDecoder();

/** Pure: the state change for one zone Event (null = not ours). */
export function reduceEvent(s: ExplorationState, ev: ZoneEvent, now: number): Partial<ExplorationState> | null {
  const name = ev.data.length ? utf8.decode(ev.data) : '';
  const stats = { ...s.stats, events: s.stats.events + 1 };
  const push = (t: Toast) => [...s.toasts.filter((x) => now - x.at < TOAST_MS), t].slice(-4);
  switch (ev.kind) {
    case EV.progress:
      return { progress: decodeProgress(ev.data), stats };
    case EV.pins:
      return { pins: decodePins(ev.data), stats };
    case EV.party:
      return { partyId: ev.value >>> 0, stats };
    case EV.discovery:
      return { stats: { ...stats, discoveries: stats.discoveries + 1, xpGained: stats.xpGained + ev.value }, toasts: push(toast('discovery', `Discovered: ${name || 'somewhere new'}`, `+${ev.value} XP`, now)) };
    case EV.towerUnlocked:
      return { stats: { ...stats, towers: stats.towers + 1 }, toasts: push(toast('tower', `Region revealed: ${name || 'unknown lands'}`, 'Map updated · tower unlocked for fast travel', now)) };
    case EV.waypoint:
      return { stats, toasts: push(toast('waypoint', `Waypoint activated${name ? `: ${name}` : ''}`, 'Unlocked for fast travel', now)) };
    case EV.respawnPoint:
      return { stats, toasts: push(toast('info', 'Respawn point set', name || undefined, now)) };
    case EV.levelUp:
      return { stats, toasts: push(toast('level', `Level ${ev.value}`, undefined, now)) };
    case EV.fastTravelDenied:
      return { stats, toasts: push(toast('warn', 'Fast travel refused', TRAVEL_DENIED[ev.value] ?? `code ${ev.value}`, now)) };
    case EV.notice:
      return { stats, toasts: push(toast('info', name, undefined, now)) };
    case EV.teleport:
      return { stats: { ...stats, teleports: stats.teleports + 1 } };
    default:
      return null;
  }
}

const initial = (): Omit<ExplorationState, 'actions'> => ({
  progress: emptyProgress(),
  pins: [],
  partyId: 0,
  toasts: [],
  mapOpen: false,
  stats: { events: 0, discoveries: 0, towers: 0, xpGained: 0, teleports: 0 },
});

export const useExploration = create<ExplorationState>(() => ({ ...initial(), actions: null }));

/** Extra observers of every zone Event (the discovery intros, client/src/ui/intro). */
export const zoneEventListeners = new Set<(ev: ZoneEvent) => void>();

/** Apply one zone Event (call from the session's onEvent). */
export function applyZoneEvent(ev: ZoneEvent, now = performance.now()): void {
  const st = useExploration.getState();
  const patch = reduceEvent(st, ev, now);
  if (patch) useExploration.setState(patch);
  for (const l of zoneEventListeners) l(ev);
}

export function setExplorationActions(a: ExplorationActions | null): void {
  useExploration.setState({ actions: a });
}

/** Back to a fresh character (leaving play, switching characters). */
export function resetExploration(): void {
  useExploration.setState({ ...initial() });
}

export function setMapOpen(open: boolean): void {
  useExploration.setState({ mapOpen: open });
}

/** Drop expired toasts (the HUD calls this on a timer). */
export function pruneToasts(now = performance.now()): void {
  const t = useExploration.getState().toasts;
  const keep = t.filter((x) => now - x.at < TOAST_MS);
  if (keep.length !== t.length) useExploration.setState({ toasts: keep });
}
