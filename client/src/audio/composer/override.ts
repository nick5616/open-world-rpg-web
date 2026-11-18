// Playtest 2 vibe explorer, composer aids (docs/cr/036-vibe-explorer.md):
// the manual music override as a pure state machine, the "vibe context" the
// readout and the mapping editor work from, the intensity number and the
// "why is this playing" lines. No Web Audio here (unit-tested:
// override.test.ts); composer.ts runs it.
//
// Modes:
//   auto   the game decides (director.ts), mappings may swap in a loaded file
//   state  the director is fed inputs that land it in one state (day, night,
//          town, cave, void, combat, timed, silence) and holds there
//   track  one track plays, through the composer's own deck on the music bus
//          (a built-in asset like "music/future_land_1" or a loaded file
//          "file:<name>"); a loop section [a, b) can repeat inside it
// An intensity can be forced in any mode (null = computed from the world).

import { DAWN_HOUR, DUSK_HOUR } from '@lodestone/contracts';
import { isNightHour, type MusicInputs, type MusicState } from '../music/director';

export const MUSIC_STATES: readonly MusicState[] = ['day', 'night', 'town', 'cave', 'void', 'combat', 'anthem', 'timed', 'silence'];

export interface LoopSection {
  /** Seconds into the track. */
  a: number;
  b: number;
}

export interface MusicOverride {
  mode: 'auto' | 'state' | 'track';
  state: MusicState | null;
  track: string | null;
  /** 0..1, null = computed (computeIntensity). */
  intensity: number | null;
  loop: LoopSection | null;
}

export const AUTO: MusicOverride = Object.freeze({ mode: 'auto', state: null, track: null, intensity: null, loop: null }) as MusicOverride;

export type OverrideCmd =
  | { kind: 'auto' }
  | { kind: 'state'; state: MusicState; intensity?: number | null }
  | { kind: 'track'; track: string; intensity?: number | null }
  | { kind: 'intensity'; value: number | null }
  | { kind: 'loop'; a: number; b: number }
  | { kind: 'loopOff' };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** One step of the override machine; an error leaves the override as it was. */
export function reduceOverride(o: MusicOverride, cmd: OverrideCmd): MusicOverride | { error: string } {
  switch (cmd.kind) {
    case 'auto':
      return { ...AUTO };
    case 'state':
      if (!MUSIC_STATES.includes(cmd.state)) return { error: `no music state "${cmd.state}"` };
      return { mode: 'state', state: cmd.state, track: null, loop: null, intensity: cmd.intensity === undefined ? o.intensity : cmd.intensity === null ? null : clamp01(cmd.intensity) };
    case 'track':
      if (!cmd.track) return { error: 'which track?' };
      // A new track starts without a loop; the same track keeps it.
      return { mode: 'track', state: null, track: cmd.track, loop: o.track === cmd.track ? o.loop : null, intensity: cmd.intensity === undefined ? o.intensity : cmd.intensity === null ? null : clamp01(cmd.intensity) };
    case 'intensity':
      if (cmd.value !== null && !Number.isFinite(cmd.value)) return { error: 'intensity 0-1 (or auto)' };
      return { ...o, intensity: cmd.value === null ? null : clamp01(cmd.value) };
    case 'loop':
      if (o.mode !== 'track') return { error: 'loop a section of a forced track: /music force <track> first' };
      if (!(cmd.a >= 0) || !(cmd.b > cmd.a + 0.05)) return { error: 'loop <a> <b>: seconds, b after a' };
      return { ...o, loop: { a: cmd.a, b: cmd.b } };
    case 'loopOff':
      return { ...o, loop: null };
  }
}

/** The director inputs that land it in `state` (and hold it there). */
export function inputsForState(state: MusicState, intensity: number | null, base: MusicInputs): MusicInputs {
  const calm: MusicInputs = { ...base, playing: true, hour: 12, underground: 0, inTown: false, combat: false, voidMoment: false, timed: null, finale: null, arrival: false };
  switch (state) {
    case 'silence':
      return { ...calm, playing: false };
    case 'day':
      return calm;
    case 'town':
      return { ...calm, inTown: true };
    case 'night':
      return { ...calm, hour: 22 };
    case 'cave':
      return { ...calm, underground: 1 };
    case 'void':
      return { ...calm, voidMoment: true };
    case 'anthem':
      return { ...calm, arrival: true };
    case 'combat':
      return { ...calm, combat: true };
    case 'timed': {
      const i = intensity ?? 0.6;
      // Intensity picks the time crunch's part: < 0.3 the intro, >= 0.85 "5 sec left", else the loop.
      return { ...calm, timed: { key: 'composer', secondsLeft: null, urgent: i >= 0.85, intro: i < 0.3 } };
    }
  }
}

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

/** Dawn: the 90 minutes after DAWN_HOUR; dusk: the hour before DUSK_HOUR; night: the director's night. */
export function timeOfDay(hour: number): TimeOfDay {
  if (isNightHour(hour)) return 'night';
  if (hour < DAWN_HOUR + 1.5) return 'dawn';
  if (hour >= DUSK_HOUR - 1) return 'dusk';
  return 'day';
}

/** Where the music is (what the readout shows and the mappings match on). */
export interface VibeContext {
  /** The director's state now. */
  state: MusicState;
  biome: string | null;
  hour: number;
  time: TimeOfDay;
  weather: string;
  /** combat.yaml tier key and index, area level (null: not known yet). */
  tier: string | null;
  tierIndex: number;
  areaLevel: number | null;
  /** Main story act (1-6; null before the story starts). */
  act: number | null;
  combat: boolean;
  boss: boolean;
  underground: number;
  inTown: boolean;
  /** CR 038: 'surface' | 'sky' | 'underground' | 'depths'. */
  layer: string;
  /** Timed objective: its phase. */
  timedPhase: 'intro' | 'loop' | 'final' | null;
  /** 0..1 */
  intensity: number;
}

const STATE_BASE: Record<MusicState, number> = { silence: 0, day: 0.25, town: 0.2, night: 0.35, cave: 0.45, void: 0.75, combat: 0.75, anthem: 0.4, timed: 0.9 };
const ROUGH_WEATHER: Record<string, number> = { thunderstorm: 0.1, snowstorm: 0.1, sandstorm: 0.1, rain: 0.05, windy: 0.05, fog: 0.05 };

/**
 * The music's intensity, 0..1: the state's base (day 0.25, town 0.2, night
 * 0.35, cave 0.45, combat and void 0.75, timed 0.9), plus 0.04 per area tier
 * above the Haven (Deadlands +0.2), plus rough weather (storms +0.1; rain,
 * wind, fog +0.05), plus a boss +0.1; a timed objective's last seconds are 1.
 */
export function computeIntensity(c: Omit<VibeContext, 'intensity' | 'time'>): number {
  if (c.state === 'timed' && c.timedPhase === 'final') return 1;
  let v = STATE_BASE[c.state] ?? 0;
  if (c.state !== 'silence') {
    v += Math.max(0, c.tierIndex) * 0.04;
    v += ROUGH_WEATHER[c.weather] ?? 0;
    if (c.boss) v += 0.1;
  }
  return Math.round(clamp01(v) * 100) / 100;
}

/** Plain lines: why this state (and what around it shapes the vibe). */
export function explain(i: MusicInputs, c: VibeContext, o: MusicOverride): string[] {
  const out: string[] = [];
  const hh = `${String(Math.floor(i.hour) % 24).padStart(2, '0')}:${String(Math.floor((i.hour % 1) * 60)).padStart(2, '0')}`;
  if (o.mode === 'state') out.push(`forced: state ${o.state} (/music force auto to let the game decide)`);
  if (o.mode === 'track') out.push(`forced: track ${o.track}${o.loop ? `, looping ${o.loop.a.toFixed(1)}-${o.loop.b.toFixed(1)} s` : ''}`);
  if (!i.playing) out.push('silence: not in the world yet');
  else if (i.finale === 'intro') out.push('silence: the Hush\'s entrance (the silence is the music)');
  else if (i.timed) out.push(`timed: ${i.timed.key}${i.timed.secondsLeft !== null ? `, ${Math.ceil(i.timed.secondsLeft)} s left` : ''}${i.timed.urgent ? ', urgent' : ''} (time crunch ${c.timedPhase ?? ''})`);
  else if (i.finale === 'fight') out.push('void: the Heartfall fight');
  else if (i.voidMoment) out.push('void: a Void magic moment (a domain, a void lord)');
  else if (c.state === 'cave') out.push(`cave: underground ${i.underground.toFixed(2)} (enters at 0.55, leaves under 0.35)`);
  else if (i.combat) out.push(`combat: ${c.boss ? 'a boss bar is up' : 'hits or telegraphs in the last few seconds'}`);
  else if (isNightHour(i.hour)) out.push(`night: ${hh} is after dusk (${DUSK_HOUR}) and before dawn (${DAWN_HOUR})`);
  else if (i.inTown) out.push(`town: inside a settlement by day (${hh})`);
  else out.push(`day: ${hh}, outdoors, nothing more urgent`);
  if (c.state !== (o.mode === 'state' ? o.state : c.state)) out.push(`(the director is still crossfading or waiting out its ${4} s dwell)`);
  out.push(`biome ${c.biome ?? 'unknown'} · ${c.time} · weather ${c.weather}`);
  out.push(c.tier ? `area ${c.tier}${c.areaLevel ? ` level ${c.areaLevel}` : ''} (tier ${c.tierIndex})` : 'area not stamped yet');
  if (c.act) out.push(`story act ${c.act}`);
  out.push(`intensity ${c.intensity.toFixed(2)}${o.intensity !== null ? ' (forced)' : ''}`);
  return out;
}

/** What `/music force <x>` names: a state, a built-in track, or a loaded file. */
export function resolveForceTarget(q: string, builtIn: readonly string[], files: readonly string[]): { kind: 'auto' } | { kind: 'state'; state: MusicState } | { kind: 'track'; track: string } | { error: string } {
  const s = q.trim().toLowerCase();
  if (!s) return { error: 'force what? a state (day, night, town, cave, void, combat, timed, silence), a track or a loaded file' };
  if (s === 'auto' || s === 'off' || s === 'game') return { kind: 'auto' };
  const st = MUSIC_STATES.find((m) => m === s);
  if (st) return { kind: 'state', state: st };
  const name = (t: string) => t.toLowerCase();
  const fileHit = files.filter((f) => name(f) === s || name(f).startsWith(s) || name(f).replace(/\.[a-z0-9]+$/, '') === s);
  const trackHit = builtIn.filter((t) => name(t) === s || name(t) === `music/${s}` || name(t).replace(/^music\//, '').startsWith(s));
  if (fileHit.length === 1 && (trackHit.length === 0 || name(fileHit[0]).startsWith(s))) return { kind: 'track', track: `file:${fileHit[0]}` };
  if (trackHit.length === 1) return { kind: 'track', track: trackHit[0] };
  const all = [...trackHit, ...fileHit];
  if (all.length > 1) return { error: `"${q}" could be ${all.join(', ')}` };
  return { error: `no state, track or loaded file "${q}" (tracks: ${builtIn.map((t) => t.replace(/^music\//, '')).join(', ')})` };
}
