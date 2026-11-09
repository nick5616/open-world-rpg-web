// Sound settings (volume per bus + mute), persisted in localStorage.
// Same validation idea as voice/store.ts loadPrefs: a hand-edited or old blob
// must never break audio, it just falls back to defaults.

import { create } from 'zustand';

export const BUSES = ['master', 'music', 'sfx', 'ambience', 'ui', 'voice'] as const;
export type BusName = (typeof BUSES)[number];

export interface AudioPrefs {
  muted: boolean;
  volumes: Record<BusName, number>;
}

export const AUDIO_PREFS_KEY = 'lodestone.audio.v1';

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  muted: false,
  volumes: { master: 0.8, music: 0.55, sfx: 0.8, ambience: 0.7, ui: 0.6, voice: 1 },
};

export function loadAudioPrefs(raw: string | null): AudioPrefs {
  const out: AudioPrefs = { muted: DEFAULT_AUDIO_PREFS.muted, volumes: { ...DEFAULT_AUDIO_PREFS.volumes } };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    out.muted = p.muted === true;
    for (const b of BUSES) {
      const v = p.volumes?.[b];
      if (typeof v === 'number' && Number.isFinite(v)) out.volumes[b] = Math.min(1, Math.max(0, v));
    }
  } catch {
    /* defaults */
  }
  return out;
}

function readStored(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(AUDIO_PREFS_KEY);
  } catch {
    return null;
  }
}

interface AudioSettingsState extends AudioPrefs {
  panelOpen: boolean;
  setVolume: (bus: BusName, v: number) => void;
  setMuted: (m: boolean) => void;
  setPanelOpen: (o: boolean) => void;
  reset: () => void;
}

function persist(p: AudioPrefs): void {
  try {
    localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify({ muted: p.muted, volumes: p.volumes }));
  } catch {
    /* private mode: settings live for this session only */
  }
}

export const useAudioSettings = create<AudioSettingsState>((set, get) => ({
  ...loadAudioPrefs(readStored()),
  panelOpen: false,
  setVolume: (bus, v) => {
    set({ volumes: { ...get().volumes, [bus]: Math.min(1, Math.max(0, v)) } });
    persist(get());
  },
  setMuted: (muted) => {
    set({ muted });
    persist(get());
  },
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  reset: () => {
    set({ muted: false, volumes: { ...DEFAULT_AUDIO_PREFS.volumes } });
    persist(get());
  },
}));
