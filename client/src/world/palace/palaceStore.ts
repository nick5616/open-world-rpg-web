// CR 044: the live state of the sky palace you are in or near (Event 1704,
// per character, on change) for the HUD and the palace's wards, chest and
// doors. Written by world/vertical/events.ts, read by PalaceHud and
// PalaceViews (per frame, through getState: no re-render).
import { create } from 'zustand';

export interface PalaceState {
  /** Atlas site of the palace this state is for (-1 none heard yet). */
  site: number;
  name: string;
  /** 0 asleep, 1 trial, 2 guardian awake, 3 cleared. */
  phase: number;
  wards: [boolean, boolean, boolean];
  /** Guardian health %, -1 not awake. */
  boss: number;
  /** Your chest for this window is already taken. */
  opened: boolean;
  /** When the state last arrived (performance.now). */
  at: number;
  /** You are in or at the palace (the HUD shows its panel). */
  near: boolean;
}

export const usePalace = create<PalaceState>(() => ({ site: -1, name: '', phase: 0, wards: [false, false, false], boss: -1, opened: false, at: 0, near: false }));

export interface PalaceWire {
  site: number;
  name: string;
  phase: number;
  wards: [boolean, boolean, boolean];
  boss: number;
  opened: boolean;
}

export function applyPalaceWire(w: PalaceWire): void {
  usePalace.setState({ site: w.site, name: w.name, phase: w.phase, wards: w.wards, boss: w.boss, opened: w.opened, at: performance.now() });
}
