// Playtest 2: the tips' shared state (the HUD shows them, the Esc menu
// switches them on/off or shows them again for this character).

import { create } from 'zustand';
import { browserKV, clearSeen, setTipsEnabled, tipsEnabled, type TipId } from './tips';
import { CONTROL_TOAST_S, CONTROL_TOASTS_MAX, groupTips, type ControlGroup, type ControlTip } from './controlTips';

/** CR 055: a controls toast (what they just talked about, the keys now). */
export interface ControlToast {
  id: number;
  title: string;
  tips: ControlTip[];
  at: number;
}

/** Which controls toast the pointer is over (its clock and bar stand still). */
export const controlHover = { id: 0 };
let controlId = 1;

interface TipsState {
  enabled: boolean;
  /** The character whose seen-tips list is in use ('' before play). */
  character: string;
  current: { id: TipId; at: number } | null;
  /** Bumped by resetSeen so the HUD reloads the list. */
  epoch: number;
  /** CR 055: the controls toasts up now (newest last). */
  controls: ControlToast[];
  pushControls: (g: ControlGroup, now?: number) => void;
  dropControl: (id: number) => void;
  /** Drop expired controls toasts; the one under the pointer keeps its time. */
  tickControls: (now: number, dtMs: number) => void;
  setEnabled: (on: boolean) => void;
  resetSeen: () => void;
}

export const useTips = create<TipsState>()((set, get) => ({
  enabled: tipsEnabled(browserKV()),
  character: '',
  current: null,
  epoch: 0,
  controls: [],
  pushControls: (g, now = performance.now()) =>
    set((s) => ({ controls: [...s.controls, { id: controlId++, title: g.title, tips: groupTips(g), at: now }].slice(-CONTROL_TOASTS_MAX) })),
  dropControl: (id) => set((s) => ({ controls: s.controls.filter((c) => c.id !== id) })),
  tickControls: (now, dtMs) =>
    set((s) => {
      if (!s.controls.length) return s;
      const keep = s.controls.map((c) => (c.id === controlHover.id ? { ...c, at: c.at + dtMs } : c)).filter((c) => now - c.at < CONTROL_TOAST_S * 1000);
      return keep.length === s.controls.length && keep.every((c, i) => c === s.controls[i]) ? s : { controls: keep };
    }),
  setEnabled: (on) => {
    setTipsEnabled(browserKV(), on);
    set({ enabled: on, current: on ? get().current : null });
  },
  resetSeen: () => {
    const c = get().character;
    if (c) clearSeen(browserKV(), c);
    set((s) => ({ epoch: s.epoch + 1, enabled: true }));
    setTipsEnabled(browserKV(), true);
  },
}));
