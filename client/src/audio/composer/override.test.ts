import { describe, expect, it } from 'vitest';
import { MusicDirector, type MusicInputs } from '../music/director';
import { AUTO, computeIntensity, explain, inputsForState, MUSIC_STATES, reduceOverride, resolveForceTarget, timeOfDay, type MusicOverride, type OverrideCmd, type VibeContext } from './override';

const base: MusicInputs = { playing: true, hour: 13, underground: 0, inTown: false, combat: false, voidMoment: false, timed: null, finale: null };

function run(cmds: OverrideCmd[]): MusicOverride {
  let o: MusicOverride = { ...AUTO };
  for (const c of cmds) {
    const r = reduceOverride(o, c);
    if ('error' in r) throw new Error(r.error);
    o = r;
  }
  return o;
}

describe('music override state machine', () => {
  it('auto -> state -> track -> loop -> intensity -> auto', () => {
    let o = run([{ kind: 'state', state: 'night' }]);
    expect(o).toEqual({ mode: 'state', state: 'night', track: null, intensity: null, loop: null });
    o = run([{ kind: 'state', state: 'night', intensity: 0.4 }, { kind: 'track', track: 'music/future_land_1' }]);
    expect(o).toEqual({ mode: 'track', state: null, track: 'music/future_land_1', intensity: 0.4, loop: null });
    o = run([{ kind: 'track', track: 'file:a.wav' }, { kind: 'loop', a: 12, b: 20 }]);
    expect(o.loop).toEqual({ a: 12, b: 20 });
    // The same track keeps its loop; another track starts without one.
    expect(run([{ kind: 'track', track: 'file:a.wav' }, { kind: 'loop', a: 12, b: 20 }, { kind: 'track', track: 'file:a.wav' }]).loop).toEqual({ a: 12, b: 20 });
    expect(run([{ kind: 'track', track: 'file:a.wav' }, { kind: 'loop', a: 12, b: 20 }, { kind: 'track', track: 'file:b.wav' }]).loop).toBeNull();
    expect(run([{ kind: 'track', track: 'file:a.wav' }, { kind: 'loop', a: 1, b: 2 }, { kind: 'loopOff' }]).loop).toBeNull();
    o = run([{ kind: 'intensity', value: 1.7 }]);
    expect(o).toEqual({ ...AUTO, intensity: 1 }); // clamped, mode unchanged
    expect(run([{ kind: 'state', state: 'combat', intensity: 0.9 }, { kind: 'auto' }])).toEqual(AUTO);
    expect(run([{ kind: 'state', state: 'cave', intensity: 0.2 }, { kind: 'intensity', value: null }]).intensity).toBeNull();
  });

  it('refuses what makes no sense and keeps the override', () => {
    expect(reduceOverride(AUTO, { kind: 'loop', a: 1, b: 5 })).toHaveProperty('error');
    const t = run([{ kind: 'track', track: 'x' }]);
    expect(reduceOverride(t, { kind: 'loop', a: 5, b: 4 })).toHaveProperty('error');
    expect(reduceOverride(t, { kind: 'loop', a: -1, b: 4 })).toHaveProperty('error');
    expect(reduceOverride(AUTO, { kind: 'state', state: 'disco' as never })).toHaveProperty('error');
    expect(reduceOverride(AUTO, { kind: 'track', track: '' })).toHaveProperty('error');
    expect(reduceOverride(AUTO, { kind: 'intensity', value: Number.NaN })).toHaveProperty('error');
  });

  it('a forced state feeds the director inputs that land it there and hold it', () => {
    for (const s of MUSIC_STATES) {
      const d = new MusicDirector();
      const i = inputsForState(s, 0.5, { ...base, combat: true, hour: 3, underground: 0.9 });
      let st = d.update(i, 0).state;
      for (let t = 1; t < 20; t++) st = d.update(i, t).state;
      expect(st, s).toBe(s);
    }
    // Intensity picks the time crunch's part.
    const d = new MusicDirector();
    expect(d.update(inputsForState('timed', 0.95, base), 0).timedPhase).toBe('final');
    expect(new MusicDirector().update(inputsForState('timed', 0.1, base), 0).timedPhase).toBe('intro');
    expect(new MusicDirector().update(inputsForState('timed', 0.5, base), 0).timedPhase).toBe('loop');
  });

  it('time of day, intensity, explanations', () => {
    expect([3, 6.5, 12, 17.8, 19].map(timeOfDay)).toEqual(['night', 'dawn', 'day', 'dusk', 'night']);
    const c = { state: 'day' as const, biome: 'forest', hour: 12, weather: 'clear', tier: 'quiet', tierIndex: 1, areaLevel: 2, act: null, combat: false, boss: false, underground: 0, inTown: false, layer: 'surface', timedPhase: null };
    expect(computeIntensity(c)).toBe(0.29);
    expect(computeIntensity({ ...c, state: 'combat', tierIndex: 5, weather: 'thunderstorm', boss: true })).toBe(1);
    expect(computeIntensity({ ...c, state: 'timed', timedPhase: 'final' })).toBe(1);
    expect(computeIntensity({ ...c, state: 'silence', tierIndex: 5 })).toBe(0);
    const ctx: VibeContext = { ...c, time: 'day', intensity: 0.29 };
    expect(explain({ ...base, hour: 22 }, { ...ctx, state: 'night' }, AUTO)[0]).toMatch(/^night: 22:00 is after dusk/);
    expect(explain({ ...base, underground: 0.7 }, { ...ctx, state: 'cave' }, AUTO)[0]).toMatch(/^cave: underground 0.70/);
    const forced = explain(base, ctx, run([{ kind: 'track', track: 'file:a.wav' }, { kind: 'loop', a: 1, b: 9 }]));
    expect(forced[0]).toBe('forced: track file:a.wav, looping 1.0-9.0 s');
    expect(forced.join('\n')).toContain('biome forest · day · weather clear');
    expect(forced.join('\n')).toContain('area quiet level 2 (tier 1)');
  });

  it('resolves /music force targets: states, built-in tracks, loaded files', () => {
    const tracks = ['music/future_land_1', 'music/future_land_2', 'music/night', 'music/void_realm', 'music/combat'];
    const files = ['forest_night_v2.wav', 'boss_theme.mp3'];
    expect(resolveForceTarget('night', tracks, files)).toEqual({ kind: 'state', state: 'night' });
    expect(resolveForceTarget('auto', tracks, files)).toEqual({ kind: 'auto' });
    expect(resolveForceTarget('void_realm', tracks, files)).toEqual({ kind: 'track', track: 'music/void_realm' });
    expect(resolveForceTarget('future_land_2', tracks, files)).toEqual({ kind: 'track', track: 'music/future_land_2' });
    expect(resolveForceTarget('forest', tracks, files)).toEqual({ kind: 'track', track: 'file:forest_night_v2.wav' });
    expect(resolveForceTarget('boss_theme', tracks, files)).toEqual({ kind: 'track', track: 'file:boss_theme.mp3' });
    expect(resolveForceTarget('future', tracks, files)).toHaveProperty('error', expect.stringContaining('could be'));
    expect(resolveForceTarget('banjo', tracks, files)).toHaveProperty('error');
  });
});
