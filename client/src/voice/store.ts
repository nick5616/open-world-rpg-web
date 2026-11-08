// Voice UI state (zustand). Changes a few times per second at most (connect,
// subscribe, PTT press, mode switch); per-frame values (levels, positions)
// never come through here (levels.ts writes the DOM directly).

import { create } from 'zustand';
import type { VoiceMode } from './spatial';

export type VoiceStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'error';
/** idle = never asked (spec 10: the microphone is not requested until the first push). */
export type MicState = 'idle' | 'requesting' | 'ready' | 'denied';
export type TalkMode = 'ptt' | 'vad';

export interface SpeakerInfo {
  id: string; // LiveKit identity = character id
  name: string;
  mode: VoiceMode;
}

export interface VoicePrefs {
  talkMode: TalkMode;
  masterVolume: number;
  /** Per-player volume 0-2 by character name (1 = unchanged). */
  volumes: Record<string, number>;
  /** Players muted locally, by name (in addition to server-side /mute). */
  muted: Record<string, boolean>;
}

export interface VoiceState extends VoicePrefs {
  status: VoiceStatus;
  statusText: string;
  mic: MicState;
  listenOnly: boolean;
  transmitting: boolean;
  speakers: SpeakerInfo[];
  settingsOpen: boolean;
  set: (p: Partial<VoiceState>) => void;
  setPrefs: (p: Partial<VoicePrefs>) => void;
}

const PREFS_KEY = 'lodestone.voice.v1';

export const DEFAULT_PREFS: VoicePrefs = { talkMode: 'ptt', masterVolume: 1, volumes: {}, muted: {} };

/** Prefs from localStorage, validated (a hand-edited or old blob must not break voice). */
export function loadPrefs(raw: string | null): VoicePrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const p = JSON.parse(raw) as Partial<VoicePrefs>;
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const volumes: Record<string, number> = {};
    for (const [k, v] of Object.entries(p.volumes ?? {})) volumes[k] = num(v, 0, 2, 1);
    const muted: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p.muted ?? {})) if (v === true) muted[k] = true;
    return {
      // Voice activation is opt-in (spec 10); anything else means push-to-talk.
      talkMode: p.talkMode === 'vad' ? 'vad' : 'ptt',
      masterVolume: num(p.masterVolume, 0, 2, 1),
      volumes,
      muted,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function readPrefs(): VoicePrefs {
  try {
    return loadPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(p: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // private mode / storage blocked: prefs last for the session only
  }
}

export const useVoiceStore = create<VoiceState>()((set, get) => ({
  ...readPrefs(),
  status: 'off',
  statusText: '',
  mic: 'idle',
  listenOnly: false,
  transmitting: false,
  speakers: [],
  settingsOpen: false,
  set: (p) => set(p),
  setPrefs: (p) => {
    set(p);
    const s = get();
    writePrefs({ talkMode: s.talkMode, masterVolume: s.masterVolume, volumes: s.volumes, muted: s.muted });
  },
}));
