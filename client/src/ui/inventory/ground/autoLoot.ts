// The "auto-collect" setting (playtest 2 ground loot): walking over common
// and uncommon materials, food, potions, arrows, ore and gems picks them up
// without E (gold always does; gear, tomes, blueprints and anything rare or
// better always need E). On by default, kept per browser. The zone holds the
// authoritative copy (Interact 21/10) and echoes it in every Event 400
// ("auto"); whenever the echo differs from this setting (a fresh zone after
// a handoff starts with it off), the client sends it again, at most every
// RESEND_MS.

import { create } from 'zustand';

const STORAGE_KEY = 'lodestone_auto_loot';
export const RESEND_MS = 4000;

function load(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === null || v === undefined ? true : v === '1';
  } catch {
    return true;
  }
}

interface AutoLootState {
  on: boolean;
  set: (on: boolean) => void;
}

export const useAutoLoot = create<AutoLootState>()((set) => ({
  on: load(),
  set: (on) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* private window: this session only */
    }
    set({ on });
  },
}));

/** Whether to (re)send the setting: the zone's echo differs and the last send was long enough ago. Pure. */
export function shouldSendAutoLoot(zoneHas: boolean | undefined, want: boolean, lastSentMs: number, nowMs: number): boolean {
  return (zoneHas ?? false) !== want && nowMs - lastSentMs >= RESEND_MS;
}
