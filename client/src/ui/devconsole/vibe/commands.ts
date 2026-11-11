// Playtest 2 vibe explorer: the /vibe and /music command lines. Pure: /vibe
// parses into Interact 250 sends (or a "go to match i" the console resolves
// against the listed results); /music parses into a MusicCmd the composer
// runs in the browser (nothing goes to the zone).

import { send, teleportSend, type DevSend } from '../events';
import { describeVibe, packVibe, parseVibeFind, type VibeFilter } from './filters';
import { nextTarget, VIBE_ACT, type VibeState } from './store';

/** filter: a new search (the console remembers it); cursor: the match "go" went to. */
export type VibeCmdResult = { sends: DevSend[]; note?: string; filter?: VibeFilter; cursor?: number } | { error: string };

const on = (w: string | undefined): boolean | undefined => (w === undefined ? undefined : ['on', '1', 'yes', 'true'].includes(w.toLowerCase()) ? true : ['off', '0', 'no', 'false'].includes(w.toLowerCase()) ? false : undefined);

export const VIBE_USAGE = '/vibe find biome=<b> landmark=<l> level=<a-b> [region=<r>] [tier=<t>] [stamped|unstamped] [dist=<a-b>] [n] | go <#|next|prev|random> | level <n|clear|clear all> | spawn [count] [level] | freeze [on|off] | demons <on|off> | here';
export const MUSIC_USAGE = '/music now | force <state|track|file|auto> [intensity 0-1] | intensity <0-1|auto> | solo <music|sfx|ambience|ui|off> | mute <bus> [on|off] | loop <a> <b> | loop off | load | export | import | pin';

/** `/vibe ...` (s: the vibe store, for go next/random and region names). */
export function parseVibe(args: readonly string[], s: Pick<VibeState, 'results' | 'total' | 'offset' | 'cursor' | 'regions' | 'filter' | 'here'>): VibeCmdResult {
  const sub = (args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  switch (sub) {
    case 'find':
    case 'search': {
      const f = parseVibeFind(rest, s.regions);
      if ('error' in f) return f;
      const { target, arg } = packVibe(f);
      return { sends: [send(VIBE_ACT.find, target, arg)], note: `find: ${describeVibe(f, s.regions)}`, filter: f };
    }
    case 'go':
    case 'tp': {
      const w = (rest[0] ?? 'next').toLowerCase();
      if (w === 'random' || w === 'any') {
        const f = { ...s.filter, random: true, go: true, n: 1, offset: 0 };
        const { target, arg } = packVibe(f);
        return { sends: [send(VIBE_ACT.find, target, arg)], note: `a random match: ${describeVibe(s.filter, s.regions)}` };
      }
      const how = w === 'next' || w === 'n' ? 'next' : w === 'prev' || w === 'back' ? 'prev' : /^\d+$/.test(w) ? Number(w) - 1 : null;
      if (how === null) return { error: 'usage: /vibe go <#|next|prev|random>' };
      if (s.total === 0) return { error: 'no matches yet: /vibe find ... first' };
      const t = nextTarget(s, how);
      if (!t) return { error: `no match #${typeof how === 'number' ? how + 1 : how} (${s.total} matches)` };
      if (t.result) return { sends: [send(VIBE_ACT.go, teleportSend(t.result.x, t.result.z).target, 0)], note: `#${t.index + 1} ${t.result.n} (${t.result.k}, ${t.result.b}, level ${t.result.lv})`, cursor: t.index };
      // Beyond the listed page: the zone lists from there and goes.
      const { target, arg } = packVibe({ ...s.filter, offset: t.index, n: 20, go: true, random: false });
      return { sends: [send(VIBE_ACT.find, target, arg)], note: `#${t.index + 1}` };
    }
    case 'level':
    case 'lvl': {
      const a = (rest[0] ?? '').toLowerCase();
      if (a === 'clear' || a === 'reset' || a === 'off') {
        if ((rest[1] ?? '').toLowerCase() === 'all') return { sends: [send(VIBE_ACT.level, 0, 0xffff)] };
        return { sends: [send(VIBE_ACT.level, 0, 0)] };
      }
      const n = Number(a);
      if (!/^\d+$/.test(a) || n < 1 || n > 60) return { error: 'usage: /vibe level <1-60|clear|clear all> (the area you stand in)' };
      return { sends: [send(VIBE_ACT.level, 0, n)] };
    }
    case 'spawn': {
      const nums = rest.map(Number);
      if (nums.some((v) => !Number.isInteger(v) || v < 0 || v > 255) || (nums[0] ?? 0) > 20) return { error: 'usage: /vibe spawn [count 0-20] [level]' };
      return { sends: [send(VIBE_ACT.spawn, 0, ((nums[0] ?? 0) & 0xff) | (((nums[1] ?? 0) & 0xff) << 8))] };
    }
    case 'freeze': {
      const o = on(rest[0]);
      const now = o ?? !s.here?.frozen;
      return { sends: [send(VIBE_ACT.freeze, 0, now ? 1 : 0)] };
    }
    case 'demons': {
      const o = on(rest[0]);
      if (o === undefined) return { error: 'usage: /vibe demons <on|off>' };
      return { sends: [send(VIBE_ACT.demons, 0, o ? 2 : 1)] };
    }
    case 'here':
    case '':
      return { sends: [send(VIBE_ACT.here)] };
  }
  return { error: `usage: ${VIBE_USAGE}` };
}

export type MusicBus = 'music' | 'sfx' | 'ambience' | 'ui';
export const MUSIC_BUSES: readonly MusicBus[] = ['music', 'sfx', 'ambience', 'ui'];

export type MusicCmd =
  | { op: 'now' }
  | { op: 'force'; target: string; intensity?: number }
  | { op: 'intensity'; value: number | null }
  | { op: 'solo'; bus: MusicBus | null }
  | { op: 'mute'; bus: MusicBus; on?: boolean }
  | { op: 'loop'; a: number; b: number }
  | { op: 'loopOff' }
  | { op: 'load' }
  | { op: 'export' }
  | { op: 'import' }
  | { op: 'pin'; on?: boolean };

const busOf = (w: string | undefined): MusicBus | null => {
  const b = (w ?? '').toLowerCase();
  if (b === 'amb' || b === 'ambient') return 'ambience';
  if (b === 'fx' || b === 'effects') return 'sfx';
  return (MUSIC_BUSES as readonly string[]).includes(b) ? (b as MusicBus) : null;
};

/** `/music ...` */
export function parseMusic(args: readonly string[]): MusicCmd | { error: string } {
  const sub = (args[0] ?? 'now').toLowerCase();
  const rest = args.slice(1);
  switch (sub) {
    case 'now':
    case 'status':
      return { op: 'now' };
    case 'force':
    case 'play': {
      if (!rest.length) return { error: 'usage: /music force <state|track|file|auto> [intensity 0-1]' };
      const last = rest[rest.length - 1];
      const hasI = rest.length > 1 && /^(0|1|0?\.\d+|1\.0+)$/.test(last);
      const target = (hasI ? rest.slice(0, -1) : rest).join(' ');
      return hasI ? { op: 'force', target, intensity: Number(last) } : { op: 'force', target };
    }
    case 'auto':
      return { op: 'force', target: 'auto' };
    case 'intensity': {
      const v = (rest[0] ?? '').toLowerCase();
      if (v === 'auto' || v === 'off') return { op: 'intensity', value: null };
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 0 || n > 1) return { error: 'usage: /music intensity <0-1|auto>' };
      return { op: 'intensity', value: n };
    }
    case 'solo': {
      const w = (rest[0] ?? '').toLowerCase();
      if (w === 'off' || w === 'none' || w === 'all') return { op: 'solo', bus: null };
      const b = busOf(w);
      if (!b) return { error: 'usage: /music solo <music|sfx|ambience|ui|off>' };
      return { op: 'solo', bus: b };
    }
    case 'mute': {
      const b = busOf(rest[0]);
      if (!b) return { error: 'usage: /music mute <music|sfx|ambience|ui> [on|off]' };
      const o = on(rest[1]);
      return o === undefined ? { op: 'mute', bus: b } : { op: 'mute', bus: b, on: o };
    }
    case 'loop': {
      if (['off', 'none', 'stop'].includes((rest[0] ?? '').toLowerCase())) return { op: 'loopOff' };
      const t = (w: string | undefined) => {
        const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(w ?? '');
        return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
      };
      const a = t(rest[0]);
      const b = t(rest[1]);
      if (!(a >= 0) || !(b > a)) return { error: 'usage: /music loop <a> <b> (seconds or m:ss, b after a) | loop off' };
      return { op: 'loop', a, b };
    }
    case 'load':
    case 'open':
      return { op: 'load' };
    case 'export':
      return { op: 'export' };
    case 'import':
      return { op: 'import' };
    case 'pin': {
      const o = on(rest[0]);
      return o === undefined ? { op: 'pin' } : { op: 'pin', on: o };
    }
  }
  return { error: `usage: ${MUSIC_USAGE}` };
}
