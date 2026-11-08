// Screen flow and UI state that React renders from. Per-frame values
// (position, fps) never live here: they are written imperatively to
// state/live.ts so the HUD can show them without re-rendering React.

import { create } from 'zustand';
import { SOLO } from '../config';

/**
 * title -> account -> play. `account` is where WP04's sign-in / local-profile
 * screen (client/src/account/) mounts; until then screens/AccountSlot.tsx is a
 * placeholder. Solo builds skip it because there is no account service.
 */
export type Screen = 'title' | 'account' | 'play';

interface AppState {
  screen: Screen;
  pointerLocked: boolean;
  debugPanelOpen: boolean;
  hudVisible: boolean;
  setScreen: (s: Screen) => void;
  /** Title "Play": straight in when solo, through the account slot otherwise. */
  startFromTitle: () => void;
  setPointerLocked: (v: boolean) => void;
  setDebugPanelOpen: (v: boolean) => void;
  toggleHud: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
  screen: 'title',
  pointerLocked: false,
  debugPanelOpen: false,
  hudVisible: true,
  setScreen: (screen) => set({ screen }),
  startFromTitle: () => set({ screen: SOLO ? 'play' : 'account' }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setDebugPanelOpen: (debugPanelOpen) => set({ debugPanelOpen }),
  toggleHud: () => set((s) => ({ hudVisible: !s.hudVisible })),
}));
