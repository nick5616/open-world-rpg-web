// Voice UI state (zustand). Changes a few times per second at most (connect,
// subscribe, PTT press, mode switch); per-frame values (levels, positions)
// never come through here (levels.ts writes the DOM directly).
//
// Playtest 2 voice settings: the saved prefs grew (devices, input boost,
// browser processing, open-mic threshold, voice keys, mic mute, per-player
// volume by character id). Same localStorage key and blob: older blobs load
// with defaults for the new fields, and every field is validated, so a
// hand-edited or old blob can never break voice.

import { create } from 'zustand';
import type { VoiceMode } from './spatial';
import type { DevicePref } from './devices';
import { DEFAULT_MUTE_KEY, DEFAULT_PTT_KEY, sanitizeVoiceKey } from './keys';
import { DEFAULT_VAD, VAD_LIMITS } from './vad';

export type VoiceStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'error';
/** idle = never asked (spec 10: the microphone is not requested until the first push). */
export type MicState = 'idle' | 'requesting' | 'ready' | 'denied';
export type TalkMode = 'ptt' | 'vad';
/** Push to talk: hold the key, or tap once to start and once to stop. */
export type PttMode = 'hold' | 'toggle';

export interface SpeakerInfo {
  id: string; // LiveKit identity = character id
  name: string;
  mode: VoiceMode;
}

/** One player's local volume / mute, saved by character id (the name is for showing it). */
export interface PeerPref {
  name: string;
  volume: number;
  muted: boolean;
}

export interface VoicePrefs {
  talkMode: TalkMode;
  pttMode: PttMode;
  pttKey: string;
  muteKey: string;
  /** Your own microphone muted (nothing is sent, whatever the talk mode). */
  micMuted: boolean;
  masterVolume: number;
  /** Per-player prefs by character id (playtest 2 voice settings). */
  peers: Record<string, PeerPref>;
  /** Legacy (WP11): per-player volume 0-2 by character name; read when a player has no `peers` entry. */
  volumes: Record<string, number>;
  /** Legacy (WP11): players muted locally, by name. */
  muted: Record<string, boolean>;
  inputDevice: DevicePref | null;
  outputDevice: DevicePref | null;
  /** Input boost in dB (applied before sending and before the meter). */
  inputGainDb: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  vadThresholdDb: number;
  vadAttackMs: number;
  vadReleaseMs: number;
  /** Mic test: how late you hear yourself (ms). */
  loopbackDelayMs: number;
}

export interface VoiceState extends VoicePrefs {
  status: VoiceStatus;
  statusText: string;
  mic: MicState;
  listenOnly: boolean;
  transmitting: boolean;
  speakers: SpeakerInfo[];
  settingsOpen: boolean;
  /** The voice settings tab (remembered for this session). */
  settingsTab: SettingsTab;
  /** A short notice from the runtime (device unplugged, switched back...). */
  notice: string;
  set: (p: Partial<VoiceState>) => void;
  setPrefs: (p: Partial<VoicePrefs>) => void;
  resetPrefs: () => void;
}

export type SettingsTab = 'mic' | 'test' | 'players' | 'diag';

export const PREFS_KEY = 'lodestone.voice.v1';

export const INPUT_GAIN_LIMITS = [-20, 20] as const;
export const LOOPBACK_LIMITS = [0, 2000] as const;

export const DEFAULT_PREFS: VoicePrefs = {
  talkMode: 'ptt',
  pttMode: 'hold',
  pttKey: DEFAULT_PTT_KEY,
  muteKey: DEFAULT_MUTE_KEY,
  micMuted: false,
  masterVolume: 1,
  peers: {},
  volumes: {},
  muted: {},
  inputDevice: null,
  outputDevice: null,
  inputGainDb: 0,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  vadThresholdDb: DEFAULT_VAD.thresholdDb,
  vadAttackMs: DEFAULT_VAD.attackMs,
  vadReleaseMs: DEFAULT_VAD.releaseMs,
  loopbackDelayMs: 0,
};

const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof VoicePrefs)[];

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function device(v: unknown): DevicePref | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Partial<DevicePref>;
  if (typeof d.id !== 'string' || !d.id || d.id.length > 512) return null;
  return { id: d.id, label: typeof d.label === 'string' ? d.label.slice(0, 200) : '' };
}

/** Prefs from localStorage, validated (a hand-edited or old blob must not break voice). */
export function loadPrefs(raw: string | null): VoicePrefs {
  const fresh = (): VoicePrefs => ({ ...DEFAULT_PREFS, peers: {}, volumes: {}, muted: {} });
  if (!raw) return fresh();
  let p: Partial<Record<keyof VoicePrefs, unknown>>;
  try {
    p = JSON.parse(raw) as Partial<Record<keyof VoicePrefs, unknown>>;
    if (!p || typeof p !== 'object') return fresh();
  } catch {
    return fresh();
  }
  const volumes: Record<string, number> = {};
  for (const [k, v] of Object.entries((p.volumes as object) ?? {})) volumes[k] = num(v, 0, 2, 1);
  const muted: Record<string, boolean> = {};
  for (const [k, v] of Object.entries((p.muted as object) ?? {})) if (v === true) muted[k] = true;
  const peers: Record<string, PeerPref> = {};
  for (const [id, v] of Object.entries((p.peers as object) ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Partial<PeerPref>;
    peers[id] = { name: typeof e.name === 'string' ? e.name : id, volume: num(e.volume, 0, 2, 1), muted: e.muted === true };
  }
  const pttKey = sanitizeVoiceKey(p.pttKey, 'ptt', typeof p.muteKey === 'string' ? p.muteKey : DEFAULT_MUTE_KEY);
  const muteKey = sanitizeVoiceKey(p.muteKey, 'mute', pttKey);
  return {
    // Voice activation is opt-in (spec 10); anything else means push-to-talk.
    talkMode: p.talkMode === 'vad' ? 'vad' : 'ptt',
    pttMode: p.pttMode === 'toggle' ? 'toggle' : 'hold',
    pttKey,
    muteKey: muteKey === pttKey ? (pttKey === DEFAULT_MUTE_KEY ? DEFAULT_PTT_KEY : DEFAULT_MUTE_KEY) : muteKey,
    micMuted: p.micMuted === true,
    masterVolume: num(p.masterVolume, 0, 2, 1),
    peers,
    volumes,
    muted,
    inputDevice: device(p.inputDevice),
    outputDevice: device(p.outputDevice),
    inputGainDb: num(p.inputGainDb, INPUT_GAIN_LIMITS[0], INPUT_GAIN_LIMITS[1], 0),
    echoCancellation: bool(p.echoCancellation, true),
    noiseSuppression: bool(p.noiseSuppression, true),
    autoGainControl: bool(p.autoGainControl, true),
    vadThresholdDb: num(p.vadThresholdDb, VAD_LIMITS.thresholdDb[0], VAD_LIMITS.thresholdDb[1], DEFAULT_VAD.thresholdDb),
    vadAttackMs: num(p.vadAttackMs, VAD_LIMITS.attackMs[0], VAD_LIMITS.attackMs[1], DEFAULT_VAD.attackMs),
    vadReleaseMs: num(p.vadReleaseMs, VAD_LIMITS.releaseMs[0], VAD_LIMITS.releaseMs[1], DEFAULT_VAD.releaseMs),
    loopbackDelayMs: num(p.loopbackDelayMs, LOOPBACK_LIMITS[0], LOOPBACK_LIMITS[1], 0),
  };
}

/** Just the saved fields of a state. */
export function pickPrefs(s: VoicePrefs): VoicePrefs {
  const out = {} as Record<keyof VoicePrefs, unknown>;
  for (const k of PREF_KEYS) out[k] = s[k];
  return out as unknown as VoicePrefs;
}

/** A player's volume / mute: by character id, else the WP11 entry by name, else unchanged. */
export function peerPref(p: Pick<VoicePrefs, 'peers' | 'volumes' | 'muted'>, id: string, name: string): PeerPref {
  const e = p.peers[id];
  if (e) return e;
  return { name, volume: p.volumes[name] ?? 1, muted: p.muted[name] === true };
}

/** Saves a player's volume / mute by id (and drops the WP11 by-name entries it replaces). */
export function withPeer(p: Pick<VoicePrefs, 'peers' | 'volumes' | 'muted'>, id: string, name: string, change: Partial<Omit<PeerPref, 'name'>>): Pick<VoicePrefs, 'peers' | 'volumes' | 'muted'> {
  const cur = peerPref(p, id, name);
  const next: PeerPref = { name, volume: num(change.volume ?? cur.volume, 0, 2, 1), muted: change.muted ?? cur.muted };
  const peers = { ...p.peers };
  if (next.volume === 1 && !next.muted) delete peers[id];
  else peers[id] = next;
  const volumes = { ...p.volumes };
  const muted = { ...p.muted };
  delete volumes[name];
  delete muted[name];
  return { peers, volumes, muted };
}

function readPrefs(): VoicePrefs {
  try {
    return loadPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY));
  } catch {
    return loadPrefs(null);
  }
}

function writePrefs(p: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(pickPrefs(p)));
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
  settingsTab: 'mic',
  notice: '',
  set: (p) => set(p),
  setPrefs: (p) => {
    set(p);
    writePrefs(get());
  },
  resetPrefs: () => {
    // Per-player volumes survive a reset of the microphone settings.
    const s = get();
    set({ ...DEFAULT_PREFS, peers: s.peers, volumes: s.volumes, muted: s.muted });
    writePrefs(get());
  },
}));
