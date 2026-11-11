// Playtest 2 vibe explorer, composer aids: the mapping editor's data. A
// mapping says "play this loaded file when the vibe is like this" (biome X at
// night, combat at tier Y, a story act...). Saved in localStorage, exported
// as JSON for wiring in permanently (client/src/audio/README.md "Composer
// mappings: the export format and wiring a file in"). Pure; tested in
// mapping.test.ts.

import type { MusicState } from '../music/director';
import { MUSIC_STATES, timeOfDay, type TimeOfDay, type VibeContext } from './override';

export const MAP_FORMAT = 'lodestone-music-map';
export const MAP_VERSION = 1;
export const MAP_STORAGE_KEY = 'lodestone.composer.map.v1';

export const TIMES: readonly TimeOfDay[] = ['dawn', 'day', 'dusk', 'night'];

/** When a mapping applies: every field given must hold (none = always). */
export interface MappingWhen {
  state?: MusicState;
  biome?: string;
  time?: TimeOfDay;
  weather?: string;
  /** Area tier index range (0 Haven .. 5 Deadlands), inclusive. */
  tierMin?: number;
  tierMax?: number;
  /** Main story act 1-6. */
  act?: number;
  combat?: boolean;
  /** Intensity range 0..1, inclusive. */
  intensityMin?: number;
  intensityMax?: number;
  /** CR 038: the vertical layer ('surface' | 'sky' | 'underground' | 'depths'). */
  layer?: string;
}

export interface MusicMapping {
  id: string;
  /** The loaded file's name ("forest_night_v2.wav"). */
  file: string;
  when: MappingWhen;
  /** Linear gain 0..2 (1 = as mastered). */
  gain: number;
  /** Loop the file while the vibe holds (else once, then the game's music). */
  loop: boolean;
  /** Crossfade in (s). */
  fadeIn: number;
  enabled: boolean;
  note?: string;
}

export interface MappingExport {
  format: typeof MAP_FORMAT;
  version: typeof MAP_VERSION;
  exportedAt: string;
  mappings: MusicMapping[];
}

let seq = 0;
export function newMappingId(): string {
  return `m${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** Does the mapping's condition hold in this context? */
export function mappingMatches(m: MusicMapping, c: VibeContext): boolean {
  const w = m.when;
  if (!m.enabled) return false;
  if (w.state !== undefined && w.state !== c.state) return false;
  if (w.biome !== undefined && w.biome !== c.biome) return false;
  if (w.time !== undefined && w.time !== (c.time ?? timeOfDay(c.hour))) return false;
  if (w.weather !== undefined && w.weather !== c.weather) return false;
  if (w.tierMin !== undefined && !(c.tierIndex >= w.tierMin)) return false;
  if (w.tierMax !== undefined && !(c.tierIndex >= 0 && c.tierIndex <= w.tierMax)) return false;
  if (w.act !== undefined && w.act !== c.act) return false;
  if (w.combat !== undefined && w.combat !== c.combat) return false;
  if (w.intensityMin !== undefined && c.intensity < w.intensityMin) return false;
  if (w.intensityMax !== undefined && c.intensity > w.intensityMax) return false;
  if (w.layer !== undefined && w.layer !== c.layer) return false;
  return true;
}

/** How specific a mapping is: the number of conditions (a tier range counts once). */
export function specificity(m: MusicMapping): number {
  const w = m.when;
  let n = 0;
  for (const k of ['state', 'biome', 'time', 'weather', 'act', 'combat', 'layer'] as const) if (w[k] !== undefined) n++;
  if (w.tierMin !== undefined || w.tierMax !== undefined) n++;
  if (w.intensityMin !== undefined || w.intensityMax !== undefined) n++;
  return n;
}

/** The mapping to play now: the most specific match, the earliest on ties; null = the game's music. */
export function resolveMapping(list: readonly MusicMapping[], c: VibeContext, loaded?: (file: string) => boolean): MusicMapping | null {
  let best: MusicMapping | null = null;
  let bs = -1;
  for (const m of list) {
    if (!mappingMatches(m, c) || (loaded && !loaded(m.file))) continue;
    const s = specificity(m);
    if (s > bs) {
      best = m;
      bs = s;
    }
  }
  return best;
}

/** One line for a condition ("night in forest, tier 2-5"). */
export function describeWhen(w: MappingWhen): string {
  const p: string[] = [];
  if (w.state) p.push(w.state);
  if (w.time) p.push(w.time);
  if (w.biome) p.push(`in ${w.biome}`);
  if (w.weather) p.push(`weather ${w.weather}`);
  if (w.tierMin !== undefined || w.tierMax !== undefined) p.push(`tier ${w.tierMin ?? 0}-${w.tierMax ?? 5}`);
  if (w.act !== undefined) p.push(`act ${w.act}`);
  if (w.combat !== undefined) p.push(w.combat ? 'in combat' : 'out of combat');
  if (w.intensityMin !== undefined || w.intensityMax !== undefined) p.push(`intensity ${w.intensityMin ?? 0}-${w.intensityMax ?? 1}`);
  return p.length ? p.join(', ') : 'always';
}

function num(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
}

/** Validate one mapping from untrusted JSON (null: unusable). */
export function cleanMapping(raw: unknown): MusicMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.file !== 'string' || !r.file.trim()) return null;
  const w = (r.when && typeof r.when === 'object' ? r.when : {}) as Record<string, unknown>;
  const when: MappingWhen = {};
  if (typeof w.state === 'string' && (MUSIC_STATES as readonly string[]).includes(w.state)) when.state = w.state as MusicState;
  if (typeof w.biome === 'string' && w.biome) when.biome = w.biome;
  if (typeof w.time === 'string' && (TIMES as readonly string[]).includes(w.time)) when.time = w.time as TimeOfDay;
  if (typeof w.weather === 'string' && w.weather) when.weather = w.weather;
  const tmin = num(w.tierMin, 0, 5);
  const tmax = num(w.tierMax, 0, 5);
  if (tmin !== undefined) when.tierMin = Math.round(tmin);
  if (tmax !== undefined) when.tierMax = Math.round(tmax);
  const act = num(w.act, 1, 6);
  if (act !== undefined) when.act = Math.round(act);
  if (typeof w.combat === 'boolean') when.combat = w.combat;
  const imin = num(w.intensityMin, 0, 1);
  const imax = num(w.intensityMax, 0, 1);
  if (imin !== undefined) when.intensityMin = imin;
  if (imax !== undefined) when.intensityMax = imax;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newMappingId(),
    file: r.file.trim(),
    when,
    gain: num(r.gain, 0, 2) ?? 1,
    loop: r.loop !== false,
    fadeIn: num(r.fadeIn, 0, 30) ?? 3,
    enabled: r.enabled !== false,
    ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
  };
}

/** The JSON to hand back (pretty, stable key order). */
export function exportMappings(list: readonly MusicMapping[], now = new Date()): string {
  const out: MappingExport = { format: MAP_FORMAT, version: MAP_VERSION, exportedAt: now.toISOString(), mappings: list.map((m) => cleanMapping(m)!).filter(Boolean) };
  return JSON.stringify(out, null, 2);
}

/** Read an export (or a bare array of mappings); invalid entries are dropped and counted. */
export function importMappings(json: string): { mappings: MusicMapping[]; dropped: number } | { error: string } {
  let j: unknown;
  try {
    j = JSON.parse(json);
  } catch {
    return { error: 'not JSON' };
  }
  let list: unknown[];
  if (Array.isArray(j)) list = j;
  else if (j && typeof j === 'object' && (j as { format?: unknown }).format === MAP_FORMAT) {
    const v = (j as { version?: unknown }).version;
    if (typeof v !== 'number' || v > MAP_VERSION) return { error: `unsupported version ${String(v)} (this build reads ${MAP_VERSION})` };
    list = Array.isArray((j as { mappings?: unknown }).mappings) ? ((j as { mappings: unknown[] }).mappings) : [];
  } else return { error: `not a ${MAP_FORMAT} export` };
  const mappings = list.map(cleanMapping).filter((m): m is MusicMapping => m !== null);
  return { mappings, dropped: list.length - mappings.length };
}

/** The saved list (localStorage); a broken blob is an empty list. */
export function loadStoredMappings(raw: string | null): MusicMapping[] {
  if (!raw) return [];
  const r = importMappings(raw);
  return 'error' in r ? [] : r.mappings;
}
