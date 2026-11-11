import { describe, expect, it } from 'vitest';
import { anyVibe, describeVibe, packVibe, parseVibeFind, unpackVibe, VIBE_LANDMARKS, type VibeFilter } from './filters';
import { MUSIC_USAGE, parseMusic, parseVibe } from './commands';
import { nextTarget, VIBE_ACT, type VibeResult, type VibeState } from './store';
import { parseCommand } from '../commands';

const shrine = VIBE_LANDMARKS.indexOf('shrine') + 1;

describe('vibe filters', () => {
  it('packs like the zone (game.VibeFilter.Pack, the same vector in vibe_test.go)', () => {
    const f: VibeFilter = { biome: 1, landmark: shrine, region: 3, levelMin: 4, levelMax: 8, stamped: 1, distMin: 256, distMax: 2048, tier: 2, layer: 0, n: 12, offset: 5, go: true, random: false };
    const deep = packVibe({ ...f, layer: 4 });
    expect(deep.target).toBe(3659467292938450n | (4n << 54n));
    expect(unpackVibe(deep.target, deep.arg).layer).toBe(4);
    expect(parseVibeFind(['layer=depths', 'l=cenote'])).toMatchObject({ layer: 4, landmark: VIBE_LANDMARKS.indexOf('cenote') + 1 });
    const { target, arg } = packVibe(f);
    expect(target).toBe(3659467292938450n);
    expect(arg).toBe(1049868);
    expect(unpackVibe(target, arg)).toEqual(f);
    const any = packVibe(anyVibe());
    expect(unpackVibe(any.target, any.arg)).toEqual(anyVibe());
  });

  it('parses /vibe find arguments', () => {
    const f = parseVibeFind(['biome=forest', 'landmark=shrine', 'level=4-8', 'region=3', 'tier=wilds', 'stamped', 'dist=256-2048', '12']);
    expect(f).toEqual({ ...anyVibe(), biome: 1, landmark: shrine, region: 3, levelMin: 4, levelMax: 8, tier: 2, stamped: 1, distMin: 256, distMax: 2048, n: 12 });
    // Short keys, prefixes, open ranges, names with spaces, region names.
    expect(parseVibeFind(['b=snow', 'l=hot', 'lv=10-', 'unstamped'], [])).toMatchObject({ biome: 3, landmark: VIBE_LANDMARKS.indexOf('hot_spring') + 1, levelMin: 10, levelMax: 0, stamped: 2 });
    expect(parseVibeFind(['level=7'])).toMatchObject({ levelMin: 7, levelMax: 7 });
    expect(parseVibeFind(['level=9-3'])).toMatchObject({ levelMin: 3, levelMax: 9 });
    expect(parseVibeFind(['landmark=bandit-camp'])).toMatchObject({ landmark: VIBE_LANDMARKS.indexOf('bandit_camp') + 1 });
    expect(parseVibeFind(['region=hollow'], ['Ashfall Reach', 'The Hollow Meadows'])).toMatchObject({ region: 1 });
    expect(parseVibeFind(['n'].slice(1))).toEqual(anyVibe());
  });

  it('refuses bad filters with a reason', () => {
    expect(parseVibeFind(['biome=jungle'])).toHaveProperty('error', expect.stringContaining('no biome "jungle"'));
    expect(parseVibeFind(['landmark=camp'])).toHaveProperty('error', expect.stringContaining('could be'));
    expect(parseVibeFind(['level=high'])).toHaveProperty('error');
    expect(parseVibeFind(['region=hollow'])).toHaveProperty('error', expect.stringContaining('Vibe tab'));
    expect(parseVibeFind(['colour=red'])).toHaveProperty('error');
    expect(parseVibeFind(['shiny'])).toHaveProperty('error');
  });

  it('describes a filter', () => {
    expect(describeVibe(anyVibe())).toBe('anywhere');
    expect(describeVibe({ ...anyVibe(), biome: 1, landmark: shrine, levelMin: 4, levelMax: 8, region: 0 }, ['Ashfall Reach'])).toBe('forest, shrine, in Ashfall Reach, level 4-8');
  });
});

const res = (i: number, x = i * 10): VibeResult => ({ i, n: `place ${i}`, k: 'shrine', x, z: x, b: 'forest', r: 'R', ri: 0, c: 0, lv: 3, t: 'quiet', st: 'stamped', d: i, dy: i, near: null });
const vstate = (p: Partial<VibeState> = {}): Pick<VibeState, 'results' | 'total' | 'offset' | 'cursor' | 'regions' | 'filter' | 'here'> => ({ results: [res(0), res(1), res(2)], total: 5, offset: 0, cursor: -1, regions: [], filter: anyVibe(), here: null, ...p });

describe('/vibe commands', () => {
  it('find sends the packed filter and remembers it', () => {
    const r = parseVibe(['find', 'biome=forest', 'landmark=shrine'], vstate());
    expect(r).not.toHaveProperty('error');
    if ('error' in r) return;
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0].action).toBe(VIBE_ACT.find);
    expect(unpackVibe(r.sends[0].target, r.sends[0].arg)).toMatchObject({ biome: 1, landmark: shrine, go: false });
    expect(r.filter).toMatchObject({ biome: 1, landmark: shrine });
  });

  it('go next / prev / #n walk the listed matches; beyond the page the zone lists and goes', () => {
    expect(nextTarget(vstate(), 'next')).toEqual({ index: 0, result: res(0) });
    expect(nextTarget(vstate({ cursor: 0 }), 'next')?.index).toBe(1);
    expect(nextTarget(vstate({ cursor: 4 }), 'next')?.index).toBe(0); // wraps
    expect(nextTarget(vstate({ cursor: 0 }), 'prev')?.index).toBe(4);
    expect(nextTarget(vstate(), 7)).toBeNull();
    const g = parseVibe(['go', '2'], vstate());
    if ('error' in g) throw new Error(g.error);
    expect(g.cursor).toBe(1);
    expect(g.sends[0].action).toBe(VIBE_ACT.go);
    expect(Number(g.sends[0].target & 0xffffffffn)).toBe(1000); // x 10 m in cm
    const far = parseVibe(['go', '5'], vstate());
    if ('error' in far) throw new Error(far.error);
    expect(far.sends[0].action).toBe(VIBE_ACT.find);
    expect(unpackVibe(far.sends[0].target, far.sends[0].arg)).toMatchObject({ offset: 4, go: true });
    const rnd = parseVibe(['go', 'random'], vstate({ filter: { ...anyVibe(), biome: 2 } }));
    if ('error' in rnd) throw new Error(rnd.error);
    expect(unpackVibe(rnd.sends[0].target, rnd.sends[0].arg)).toMatchObject({ biome: 2, random: true, go: true, n: 1 });
    expect(parseVibe(['go', 'next'], vstate({ total: 0, results: [] }))).toHaveProperty('error');
  });

  it('level, spawn, freeze, demons, here', () => {
    const one = (args: string[]) => {
      const r = parseVibe(args, vstate());
      if ('error' in r) throw new Error(r.error);
      return r.sends[0];
    };
    expect(one(['level', '12'])).toMatchObject({ action: VIBE_ACT.level, arg: 12 });
    expect(one(['level', 'clear'])).toMatchObject({ action: VIBE_ACT.level, arg: 0 });
    expect(one(['level', 'clear', 'all'])).toMatchObject({ action: VIBE_ACT.level, arg: 0xffff });
    expect(one(['spawn', '4', '9'])).toMatchObject({ action: VIBE_ACT.spawn, arg: 4 | (9 << 8) });
    expect(one(['freeze'])).toMatchObject({ action: VIBE_ACT.freeze, arg: 1 });
    expect(parseVibe(['freeze'], vstate({ here: { frozen: true } as VibeState['here'] }))).toMatchObject({ sends: [{ arg: 0 }] });
    expect(one(['demons', 'off'])).toMatchObject({ action: VIBE_ACT.demons, arg: 1 });
    expect(one(['demons', 'on'])).toMatchObject({ action: VIBE_ACT.demons, arg: 2 });
    expect(one(['here'])).toMatchObject({ action: VIBE_ACT.here });
    expect(parseVibe(['level', '99'], vstate())).toHaveProperty('error');
    expect(parseVibe(['spawn', '40'], vstate())).toHaveProperty('error');
    expect(parseVibe(['dance'], vstate())).toHaveProperty('error');
  });

  it('/music parses into composer commands', () => {
    expect(parseMusic([])).toEqual({ op: 'now' });
    expect(parseMusic(['force', 'night', '0.7'])).toEqual({ op: 'force', target: 'night', intensity: 0.7 });
    expect(parseMusic(['force', 'future', 'land', '1'])).toEqual({ op: 'force', target: 'future land', intensity: 1 });
    expect(parseMusic(['force', 'my_track.wav'])).toEqual({ op: 'force', target: 'my_track.wav' });
    expect(parseMusic(['auto'])).toEqual({ op: 'force', target: 'auto' });
    expect(parseMusic(['intensity', 'auto'])).toEqual({ op: 'intensity', value: null });
    expect(parseMusic(['intensity', '0.4'])).toEqual({ op: 'intensity', value: 0.4 });
    expect(parseMusic(['solo', 'amb'])).toEqual({ op: 'solo', bus: 'ambience' });
    expect(parseMusic(['solo', 'off'])).toEqual({ op: 'solo', bus: null });
    expect(parseMusic(['mute', 'sfx', 'on'])).toEqual({ op: 'mute', bus: 'sfx', on: true });
    expect(parseMusic(['loop', '1:05', '1:20.5'])).toEqual({ op: 'loop', a: 65, b: 80.5 });
    expect(parseMusic(['loop', 'off'])).toEqual({ op: 'loopOff' });
    expect(parseMusic(['load'])).toEqual({ op: 'load' });
    expect(parseMusic(['export'])).toEqual({ op: 'export' });
    expect(parseMusic(['loop', '9', '3'])).toHaveProperty('error');
    expect(parseMusic(['intensity', '3'])).toHaveProperty('error');
    expect(parseMusic(['solo', 'voice'])).toHaveProperty('error');
    expect(parseMusic(['sing'])).toHaveProperty('error', `usage: ${MUSIC_USAGE}`);
  });

  it('the console line routes /vibe and /music', () => {
    const ctx = { flags: 0, places: [], quests: [], vibe: vstate() };
    const v = parseCommand('/vibe find biome=wetland 5', ctx);
    expect(v).toMatchObject({ vibe: { filter: { biome: 5, n: 5 } } });
    const m = parseCommand('/music solo music', ctx);
    expect(m).toEqual({ sends: [], music: { op: 'solo', bus: 'music' } });
    expect(parseCommand('/vibe go next', { flags: 0, places: [], quests: [] })).toHaveProperty('error');
  });
});
