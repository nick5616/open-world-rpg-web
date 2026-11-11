// Accessibility settings (playtest 2 "calm kills"): persisted on this device
// under `lodestone_accessibility`. Shown in the Graphics screen.
//
//   reduceFlashing  ON by default. Hit feedback is a soft, capped tint that
//                   never re-triggers faster than ~2 times a second per enemy,
//                   deaths are a calm fade, FX flashes ease in and stay under
//                   the bloom threshold, lights ramp. OFF allows slightly
//                   punchier hit feedback that still stays within WCAG 2.3.1
//                   (at most 3 flashes a second anywhere). Either way
//                   `prefers-reduced-motion: reduce` forces the calm rules
//                   (combat/flashSafety.ts).

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';

export const ACCESSIBILITY_STORAGE_KEY = 'lodestone_accessibility';

interface AccessibilityState {
  reduceFlashing: boolean;
  setReduceFlashing: (v: boolean) => void;
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

export const useAccessibility = create<AccessibilityState>()(
  persist(
    (set) => ({
      reduceFlashing: true,
      setReduceFlashing: (reduceFlashing) => set({ reduceFlashing }),
    }),
    {
      name: ACCESSIBILITY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ reduceFlashing: s.reduceFlashing }),
      merge: (persisted, current) => ({ ...current, reduceFlashing: typeof (persisted as { reduceFlashing?: unknown } | null)?.reduceFlashing === 'boolean' ? (persisted as { reduceFlashing: boolean }).reduceFlashing : true }),
    },
  ),
);
