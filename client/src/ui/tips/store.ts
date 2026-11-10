// Playtest 2: the tips' shared state (the HUD shows them, the Esc menu
// switches them on/off or shows them again for this character).

import { create } from 'zustand';
import { browserKV, clearSeen, setTipsEnabled, tipsEnabled, type TipId } from './tips';

interface TipsState {
  enabled: boolean;
  /** The character whose seen-tips list is in use ('' before play). */
  character: string;
  current: { id: TipId; at: number } | null;
  /** Bumped by resetSeen so the HUD reloads the list. */
  epoch: number;
  setEnabled: (on: boolean) => void;
  resetSeen: () => void;
}

export const useTips = create<TipsState>()((set, get) => ({
  enabled: tipsEnabled(browserKV()),
  character: '',
  current: null,
  epoch: 0,
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
