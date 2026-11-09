// Camera view (playtest 2: "Need third person mode"): first person or an
// over-the-shoulder third-person camera, which shoulder, and how far back.
// Persisted per browser like the quality setting. The player controller
// reads it with getState() inside useFrame; the settings UI and the T key
// write it.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'first' | 'third';

/** Boom length limits (m); the default sits where the whole avatar fits the frame. */
export const VIEW_DISTANCE = { min: 1.8, max: 6, default: 3.4 } as const;

interface ViewState {
  mode: ViewMode;
  /** Over which shoulder the third-person camera looks: 1 right, -1 left. */
  shoulder: 1 | -1;
  /** Third-person boom length (m) before collision pulls it in. */
  distance: number;
  setMode: (m: ViewMode) => void;
  toggle: () => void;
  setShoulder: (s: 1 | -1) => void;
  setDistance: (d: number) => void;
}

/** ?view=third|first overrides the stored choice for one session (headless captures, benches). */
function urlMode(): ViewMode | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('view');
  return v === 'third' || v === 'first' ? v : null;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set, get) => ({
      mode: 'first',
      shoulder: 1,
      distance: VIEW_DISTANCE.default,
      setMode: (mode) => set({ mode }),
      toggle: () => set({ mode: get().mode === 'first' ? 'third' : 'first' }),
      setShoulder: (shoulder) => set({ shoulder }),
      setDistance: (d) => set({ distance: Math.max(VIEW_DISTANCE.min, Math.min(VIEW_DISTANCE.max, d)) }),
    }),
    {
      name: 'lodestone_view_settings',
      partialize: (s) => ({ mode: s.mode, shoulder: s.shoulder, distance: s.distance }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ViewState>;
        const mode = urlMode() ?? (p.mode === 'third' ? 'third' : 'first');
        const shoulder = p.shoulder === -1 ? -1 : 1;
        const distance = typeof p.distance === 'number' && Number.isFinite(p.distance) ? Math.max(VIEW_DISTANCE.min, Math.min(VIEW_DISTANCE.max, p.distance)) : current.distance;
        return { ...current, mode, shoulder, distance };
      },
    },
  ),
);
