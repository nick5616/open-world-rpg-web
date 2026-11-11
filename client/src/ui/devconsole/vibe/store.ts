// Playtest 2 vibe explorer: what the zone answered (Events 1403 search
// results, 1404 the area you stand in) and the tab's own state (the last
// filter, which result "next" goes to).

import { create } from 'zustand';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { anyVibe, type VibeFilter } from './filters';

export const VIBE_EV = { find: 1403, here: 1404 } as const;

/** Interact 250 actions of the vibe explorer (the zone's game.DevActVibe*). */
export const VIBE_ACT = { find: 29, go: 30, level: 31, spawn: 32, freeze: 33, demons: 34, here: 35 } as const;

/** One match (the zone's game.VibeResult). */
export interface VibeResult {
  i: number;
  n: string;
  k: string;
  x: number;
  z: number;
  b: string;
  r: string;
  ri: number;
  c: number;
  lv: number;
  t: string;
  /** haven | stamped | provisional | override | unstamped (lv: what you would stamp) | off */
  st: string;
  d: number;
  dy: number;
  near: string[] | null;
}

export interface VibeHere {
  spot: VibeResult;
  weather: string;
  hour: number;
  frozen: boolean;
  demons: boolean;
  invuln: number;
  overrides: { c: number; lv: number; was: string; x: number; z: number }[];
}

export interface VibeState {
  filter: VibeFilter;
  results: VibeResult[];
  total: number;
  offset: number;
  regions: string[];
  /** The result "next" went to last (index in the full match list; -1 none). */
  cursor: number;
  here: VibeHere | null;
  /** Searches answered (tests wait on it). */
  answers: number;
  /** The composer's code has been loaded (the pinned now-playing box may show). */
  composer: boolean;
}

export const useVibe = create<VibeState>(() => ({ filter: anyVibe(), results: [], total: 0, offset: 0, regions: [], cursor: -1, here: null, answers: 0, composer: false }));

/** Events 1403 and 1404. */
export function applyVibeEvent(ev: ZoneEvent): void {
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(ev.data));
  } catch {
    return;
  }
  if (ev.kind === VIBE_EV.find) {
    const f = j as { total: number; offset: number; results: VibeResult[]; regions: string[]; went: number };
    useVibe.setState((s) => ({
      total: f.total,
      offset: f.offset,
      results: f.results ?? [],
      regions: f.regions?.length ? f.regions : s.regions,
      cursor: f.went >= 0 ? f.went : s.cursor,
      answers: s.answers + 1,
    }));
  } else if (ev.kind === VIBE_EV.here) useVibe.setState({ here: j as VibeHere });
}

/**
 * `/vibe go next` / `random` / `<n>`: which match to go to. A match inside the
 * listed page goes straight there (its coordinates); one beyond it needs the
 * zone to list it (offset) and go.
 */
export function nextTarget(s: Pick<VibeState, 'results' | 'total' | 'offset' | 'cursor'>, how: 'next' | 'prev' | number): { index: number; result: VibeResult | null } | null {
  if (s.total === 0) return null;
  let i: number;
  if (how === 'next') i = s.cursor < 0 ? 0 : (s.cursor + 1) % s.total;
  else if (how === 'prev') i = s.cursor <= 0 ? s.total - 1 : s.cursor - 1;
  else i = how;
  if (i < 0 || i >= s.total) return null;
  const r = s.results.find((x) => x.i === i) ?? null;
  return { index: i, result: r };
}
