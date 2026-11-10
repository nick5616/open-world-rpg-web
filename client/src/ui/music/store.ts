// Playtest 2 instruments (CR 028): play-mode state (the overlay's store,
// persisted choices) and note hits per player for the avatars (plain module
// state, read every frame).

import { create } from 'zustand';
import { CONTENT, type InstrumentDef } from '@lodestone/contracts';
import { clampOctave, defaultOctave, SCALES } from './theory';

export const SELF = -1;
const PREFS_KEY = 'lodestone.music.v1';

export interface JamState {
  /** Entity id of who set it (SELF: you, offline). */
  leader: number;
  leaderName: string;
  bpm: number;
  /** Server ms of a downbeat (offline: performance ms). */
  epoch: number;
  /** Local performance ms that epoch maps to (the clock offset at arrival). */
  epochLocal: number;
}

export interface MusicState {
  /** Play mode is up (keys are notes). */
  active: boolean;
  /** The instrument you play (content.yaml instruments id), 0 none chosen yet. */
  instrument: number;
  scale: string;
  root: number;
  /** Octave of the letter row (C4 = 60 at 4). */
  octave: number;
  dynamics: number;
  /** Keys held now: code -> MIDI note (the overlay lights them). */
  pressed: Record<string, number>;
  /** Your metronome click on (follows a jam when there is one). */
  click: boolean;
  bpm: number;
  jam: JamState | null;
  /** Notes you played this session (the overlay's counter). */
  played: number;
  lastSong: { notes: number; seconds: number; applause: number; line: string; at: number } | null;
  toast: { text: string; at: number } | null;
}

interface Prefs {
  instrument: number;
  scale: string;
  root: number;
  octaves: Record<number, number>;
  dynamics: number;
  bpm: number;
}

function loadPrefs(): Partial<Prefs> {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

const prefs = loadPrefs();
const octaves: Record<number, number> = typeof prefs.octaves === 'object' && prefs.octaves ? { ...prefs.octaves } : {};

export function instrumentDef(id: number): InstrumentDef | undefined {
  return CONTENT.instruments.list.find((i) => i.id === id);
}

export function instrumentOfItem(itemKey: string): InstrumentDef | undefined {
  return CONTENT.instruments.list.find((i) => i.item === itemKey);
}

/** The octave you last used on an instrument (its default the first time). */
export function octaveFor(id: number): number {
  const d = instrumentDef(id);
  const o = octaves[id];
  return clampOctave(typeof o === 'number' ? o : d ? defaultOctave(d.range) : 4);
}

export const useMusic = create<MusicState>(() => ({
  active: false,
  instrument: typeof prefs.instrument === 'number' && instrumentDef(prefs.instrument) ? prefs.instrument : 0,
  scale: SCALES.some((s) => s.key === prefs.scale) ? (prefs.scale as string) : 'major',
  root: typeof prefs.root === 'number' && prefs.root >= 0 && prefs.root < 12 ? prefs.root : 0,
  octave: typeof prefs.instrument === 'number' ? octaveFor(prefs.instrument) : 4,
  dynamics: typeof prefs.dynamics === 'number' ? Math.max(1, Math.min(7, prefs.dynamics)) : 5,
  pressed: {},
  click: false,
  bpm: typeof prefs.bpm === 'number' ? prefs.bpm : CONTENT.instruments.jam.defaultBpm,
  jam: null,
  played: 0,
  lastSong: null,
  toast: null,
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useMusic.subscribe((s, p) => {
  if (s.instrument && s.octave !== p.octave) octaves[s.instrument] = s.octave;
  if (s.instrument === p.instrument && s.scale === p.scale && s.root === p.root && s.octave === p.octave && s.dynamics === p.dynamics && s.bpm === p.bpm) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ instrument: s.instrument, scale: s.scale, root: s.root, octaves, dynamics: s.dynamics, bpm: s.bpm } satisfies Prefs));
    } catch {
      /* private window: choices last the session */
    }
  }, 400);
});

export function musicToast(text: string): void {
  useMusic.setState({ toast: { text, at: performance.now() } });
}

// ---- note hits per player (yours under SELF): the avatars strum, strike and blow on them.

export interface NoteHit {
  /** performance.now() when it sounds. */
  at: number;
  midi: number;
  vel: number;
}

const hits = new Map<number, NoteHit[]>();

/** A note someone plays at `at` (now or soon: the jitter buffer schedules remote notes ahead). */
/** Your newest note (the first-person instrument reads it without taking it from your avatar). */
export const selfHit = { at: -1e9, midi: 60, vel: 5, n: 0 };

export function addNoteHit(entity: number, midi: number, vel: number, at = performance.now()): void {
  if (entity === SELF) {
    selfHit.at = at;
    selfHit.midi = midi;
    selfHit.vel = vel;
    selfHit.n++;
  }
  let q = hits.get(entity);
  if (!q) hits.set(entity, (q = []));
  if (q.length > 24) q.splice(0, q.length - 24);
  let i = q.length;
  while (i > 0 && q[i - 1].at > at) i--; // kept in time order (remote notes arrive scheduled ahead)
  q.splice(i, 0, { at, midi, vel });
}

/** Take the hits of `entity` that are due by `now` (oldest first). */
export function takeNoteHits(entity: number, now = performance.now()): NoteHit[] {
  const q = hits.get(entity);
  if (!q || !q.length || q[0].at > now) return [];
  let i = 0;
  while (i < q.length && q[i].at <= now) i++;
  return q.splice(0, i);
}

export function clearNoteHits(): void {
  hits.clear();
}
