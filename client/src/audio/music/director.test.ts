import { describe, expect, it } from 'vitest';
import { CAVE_ENTER, CAVE_EXIT, DWELL_S, MusicDirector, isNightHour, type MusicInputs } from './director';

const base: MusicInputs = { playing: true, hour: 10, underground: 0, inTown: false, combat: false, voidMoment: false, timed: null };
const at = (p: Partial<MusicInputs>): MusicInputs => ({ ...base, ...p });

describe('music director', () => {
  it('is silent until the world is playing, then follows the clock', () => {
    const d = new MusicDirector();
    expect(d.update(at({ playing: false }), 0).state).toBe('silence');
    const r = d.update(at({}), 1);
    expect(r).toMatchObject({ state: 'day', changed: true });
    expect(d.update(at({}), 2).changed).toBe(false);
  });

  it('night falls at dusk and lifts at dawn (after the dwell)', () => {
    expect(isNightHour(18.4)).toBe(false);
    expect(isNightHour(18.5)).toBe(true);
    expect(isNightHour(5.9)).toBe(true);
    expect(isNightHour(6)).toBe(false);
    const d = new MusicDirector();
    d.update(at({ hour: 17 }), 0);
    // night outranks day: immediate
    expect(d.update(at({ hour: 19 }), 1).state).toBe('night');
    // back to day waits out the dwell
    expect(d.update(at({ hour: 6.1 }), 2).state).toBe('night');
    expect(d.update(at({ hour: 6.2 }), 2 + DWELL_S).state).toBe('day');
  });

  it('day rotates between its tracks each time it comes back', () => {
    const d = new MusicDirector();
    const r1 = d.update(at({}), 0).rotation;
    d.update(at({ hour: 20 }), 1);
    d.update(at({ hour: 7 }), 2);
    const r2 = d.update(at({ hour: 7 }), 2 + DWELL_S).rotation;
    expect(r2).toBe(r1 + 1);
    expect(d.advanceRotation()).toBe(r2 + 1);
  });

  it('caves latch with hysteresis so a cave mouth does not flap', () => {
    const d = new MusicDirector();
    d.update(at({}), 0);
    expect(d.update(at({ underground: CAVE_ENTER - 0.01 }), 1).state).toBe('day');
    expect(d.update(at({ underground: CAVE_ENTER }), 2).state).toBe('cave');
    // between exit and enter: still a cave
    expect(d.update(at({ underground: (CAVE_ENTER + CAVE_EXIT) / 2 }), 3).state).toBe('cave');
    expect(d.update(at({ underground: (CAVE_ENTER + CAVE_EXIT) / 2 }), 3 + DWELL_S + 1).state).toBe('cave');
    // out: back to the surface after the dwell
    d.update(at({ underground: CAVE_EXIT - 0.05 }), 10);
    expect(d.update(at({ underground: CAVE_EXIT - 0.05 }), 10 + DWELL_S).state).toBe('day');
  });

  it('priorities: timed > void > cave > combat > night > town > day', () => {
    const d = new MusicDirector();
    expect(d.wanted(at({ inTown: true }))).toBe('town');
    expect(d.wanted(at({ inTown: true, hour: 22 }))).toBe('night');
    expect(d.wanted(at({ inTown: true, combat: true }))).toBe('combat');
    expect(d.wanted(at({ combat: true, underground: 1 }))).toBe('cave');
    expect(d.wanted(at({ underground: 1, voidMoment: true }))).toBe('void');
    expect(d.wanted(at({ voidMoment: true, timed: { key: 'a', secondsLeft: 10, urgent: false, intro: true } }))).toBe('timed');
    expect(d.wanted(at({ playing: false, combat: true }))).toBe('silence');
  });

  it('a fight starts the combat music at once and lets go after the dwell', () => {
    const d = new MusicDirector();
    d.update(at({}), 0);
    expect(d.update(at({ combat: true }), 1)).toMatchObject({ state: 'combat', changed: true });
    expect(d.update(at({ combat: false }), 2).state).toBe('combat');
    // a new hit inside the dwell keeps it
    d.update(at({ combat: true }), 3);
    expect(d.update(at({ combat: false }), 3 + DWELL_S - 0.5).state).toBe('combat');
    // the dwell counts from when the fight went quiet (3 + DWELL_S - 0.5)
    expect(d.update(at({ combat: false }), 3 + 2 * DWELL_S - 0.6).state).toBe('combat');
    expect(d.update(at({ combat: false }), 3 + 2 * DWELL_S - 0.4).state).toBe('day');
  });

  it('timed events: intro, then loop, then the 5-seconds-left layer; never back to the intro', () => {
    const d = new MusicDirector();
    d.introSeconds = 28.7;
    d.update(at({}), 0);
    const t = (secondsLeft: number | null, urgent = false) => at({ timed: { key: 'defense:3', secondsLeft, urgent, intro: true } });
    expect(d.update(t(15), 10)).toMatchObject({ state: 'timed', timedPhase: 'intro', changed: true });
    expect(d.update(t(6), 19).timedPhase).toBe('intro');
    expect(d.update(t(5), 20).timedPhase).toBe('final');
    // the wave starts: no deadline any more, the loop plays (not the intro again)
    expect(d.update(t(null), 21).timedPhase).toBe('loop');
    expect(d.update(t(null, true), 30).timedPhase).toBe('final');
    expect(d.update(t(null), 31).timedPhase).toBe('loop');
    // the event ends: back to the world after the dwell
    d.update(at({}), 40);
    expect(d.update(at({}), 40 + DWELL_S).state).toBe('day');
  });

  it('joining a timed event mid-way skips the intro; a new event restarts it', () => {
    const d = new MusicDirector();
    d.update(at({}), 0);
    expect(d.update(at({ timed: { key: 'w2', secondsLeft: null, urgent: false, intro: false } }), 1).timedPhase).toBe('loop');
    expect(d.update(at({ timed: { key: 'w3', secondsLeft: 15, urgent: false, intro: true } }), 2).timedPhase).toBe('intro');
    expect(d.update(at({ timed: { key: 'w3', secondsLeft: null, urgent: false, intro: true } }), 2 + 28.8).timedPhase).toBe('loop');
  });
});

describe('the Heartfall (playtest 2 immersion pass)', () => {
  it('the Hush silences the music for its entrance, the fight plays the void, the dawn brings the day at once', () => {
    const d = new MusicDirector();
    d.update(at({ hour: 22 }), 0);
    expect(d.update(at({ hour: 22, combat: true, finale: 'intro' }), 1).state).toBe('silence');
    expect(d.update(at({ hour: 22, combat: true, finale: 'fight' }), 2).state).toBe('void');
    // the endless night's countdown outranks it
    expect(d.update(at({ hour: 22, finale: 'fight', timed: { key: 'n', secondsLeft: 20, urgent: false, intro: false } }), 3).state).toBe('timed');
    // won: day at once, not after the dwell (and not night, though it is 22:00)
    expect(d.update(at({ hour: 22, finale: 'won' }), 4).state).toBe('day');
  });
});
