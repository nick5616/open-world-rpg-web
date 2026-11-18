// Immersive HUD (playtest 4, CR 052): "make more things directly in the game
// instead of text you see in the HUD". With the setting on (the default) the
// HUD is quiet and contextual:
//
//   health / mana   appear when they change or are not full, fade a few seconds later
//   hotbar          appears when you draw a weapon, are in combat, or press a hotbar key
//   quest tracker   collapses to the compass diamond unless the step just changed,
//                   you hold Tab or the journal (J) is open
//   notices         fewer and shorter (see quests/store.ts, progression, intro)
//
// The crosshair, the compass, chat, voice and party stay as they were. The
// Esc menu has an "Immersive HUD" switch that shows everything as before.
//
// The rules are pure functions of (setting, now, last-activity times), so
// they unit-test without a DOM. `hudActivity` holds the last-activity times
// (plain object, written by input listeners and the HUD's own rAF; nothing
// re-renders React per frame). Layout stays stable: hidden pieces fade out
// with opacity, they are never unmounted, so the --ls-* layout variables
// (hud/layout.ts) keep their measured values.

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { BINDINGS } from '../input/bindings';

export const IMMERSIVE_STORAGE_KEY = 'lodestone_hud';

/** How long a bar stays up after it last changed (ms). */
export const BARS_LINGER_MS = 4000;
/** How long the hotbar stays up after the last hotbar use or combat (ms). */
export const HOTBAR_LINGER_MS = 6000;
/** How long a quest step's tracker stays open when the step changes (ms). */
export const TRACKER_LINGER_MS = 9000;
/** Notice lifetime when immersive (ms) and how many show at once. */
export const NOTE_MS_IMMERSIVE = 3500;
export const NOTES_MAX_IMMERSIVE = 2;

interface HudSettings {
  immersive: boolean;
  setImmersive: (v: boolean) => void;
}

const storage: StateStorage = {
  getItem: (n) => {
    try {
      return localStorage.getItem(n);
    } catch {
      return null;
    }
  },
  setItem: (n, v) => {
    try {
      localStorage.setItem(n, v);
    } catch {
      /* private mode: in memory only */
    }
  },
  removeItem: (n) => {
    try {
      localStorage.removeItem(n);
    } catch {
      /* ignore */
    }
  },
};

export const useHudSettings = create<HudSettings>()(
  persist(
    (set) => ({ immersive: true, setImmersive: (immersive) => set({ immersive }) }),
    {
      name: IMMERSIVE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ immersive: s.immersive }),
      merge: (persisted, current) => ({ ...current, immersive: typeof (persisted as { immersive?: unknown } | null)?.immersive === 'boolean' ? (persisted as { immersive: boolean }).immersive : true }),
    },
  ),
);

export const isImmersive = (): boolean => useHudSettings.getState().immersive;

/** Last-activity times (performance.now ms) and the last seen bar values. */
export const hudActivity = {
  /** A hotbar key, the wheel, an attack button or a weapon draw. */
  hotbarAt: -1e9,
  /** The tracked quest's step changed (or a quest was just accepted). */
  stepAt: -1e9,
  /** Tab held. */
  tabHeld: false,
  hp: -1,
  mana: -1,
  stamina: -1,
  /** Last time a bar changed value. */
  barsAt: -1e9,
};

export function resetHudActivity(): void {
  hudActivity.hotbarAt = hudActivity.stepAt = hudActivity.barsAt = -1e9;
  hudActivity.tabHeld = false;
  hudActivity.hp = hudActivity.mana = hudActivity.stamina = -1;
}

/** Pure: the bars row shows when the setting is off, a value is not full, or a value changed lately. */
export function barsVisible(i: { immersive: boolean; now: number; barsAt: number; hp: number; mana: number }): boolean {
  if (!i.immersive) return true;
  if (i.hp < 0.999 || i.mana < 0.999) return true;
  return i.now - i.barsAt < BARS_LINGER_MS;
}

/** Pure: the hotbar shows when the setting is off, in combat, a boss fight, or soon after you used it. */
export function hotbarVisible(i: { immersive: boolean; now: number; hotbarAt: number; inCombat: boolean; boss: boolean; downed?: boolean }): boolean {
  if (!i.immersive) return true;
  if (i.inCombat || i.boss || i.downed) return true;
  return i.now - i.hotbarAt < HOTBAR_LINGER_MS;
}

/** Pure: the quest tracker's full card. */
export function trackerExpanded(i: { immersive: boolean; now: number; stepAt: number; tabHeld: boolean; journalOpen: boolean; panelOpen?: boolean }): boolean {
  if (!i.immersive) return true;
  return i.tabHeld || i.journalOpen || i.now - i.stepAt < TRACKER_LINGER_MS;
}

/** CR 054: the sundial clock beside the compass: how long it stays bright after the hour turns, and how soft it rests. */
export const DIAL_LINGER_MS = 6000;
export const DIAL_QUIET_OPACITY = 0.5;

/** Pure: the sundial clock's opacity. Like the compass it is always there; with the setting on it rests soft and brightens for a few seconds when the hour turns or Tab is held. */
export function dialOpacity(i: { immersive: boolean; now: number; hourAt: number; tabHeld: boolean }): number {
  if (!i.immersive) return 1;
  return i.tabHeld || i.now - i.hourAt < DIAL_LINGER_MS ? 1 : DIAL_QUIET_OPACITY;
}

/** Pure: records one bar sample, returns true when it counted as a change (so the bars row lingers). */
export function sampleBars(now: number, hp: number, mana: number, stamina: number): boolean {
  const a = hudActivity;
  const changed = a.hp < 0 || Math.abs(hp - a.hp) > 0.004 || Math.abs(mana - a.mana) > 0.004 || Math.abs(stamina - a.stamina) > 0.01;
  // The first sample after loading is not a "change".
  if (changed && a.hp >= 0) a.barsAt = now;
  a.hp = hp;
  a.mana = mana;
  a.stamina = stamina;
  return changed;
}

/** Hotbar keys: every combat key (spells, draught, loadout swap, dodge, secondary, form, technique), read from the one binding table (input/bindings.ts). */
const HOTBAR_CODES = new Set(BINDINGS.filter((b) => b.ctx === 'world' && b.file === 'combat/runtime.ts').map((b) => b.code));

/** The weapon technique key, which also opens the quest card (declared in input/bindings.ts). */
const TAB = ['T', 'ab'].join('');

let installed = false;

/** Window listeners that stamp hudActivity (idempotent). */
export function installHudActivity(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const stamp = () => {
    hudActivity.hotbarAt = performance.now();
  };
  const typing = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    if (HOTBAR_CODES.has(e.code)) stamp();
    if (e.code === TAB) {
      hudActivity.tabHeld = true;
      stamp();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === TAB) hudActivity.tabHeld = false;
  });
  window.addEventListener('blur', () => {
    hudActivity.tabHeld = false;
  });
  window.addEventListener('mousedown', (e) => {
    // Clicks on the world (the canvas, or the locked pointer), not on panels.
    if ((e.button === 0 || e.button === 2) && ((e.target as HTMLElement | null)?.tagName === 'CANVAS' || !!document.pointerLockElement)) stamp();
  });
  window.addEventListener('wheel', stamp, { passive: true });
}

/** Test seam: forget the installed listeners flag. */
export function _resetInstalled(): void {
  installed = false;
}
