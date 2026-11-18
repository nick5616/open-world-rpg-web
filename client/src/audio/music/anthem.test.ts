import { describe, expect, it } from 'vitest';
import { arrivalAnthem, ARRIVAL_ANTHEM_S } from '../../ui/tips/firstHour';
import { DWELL_S, MusicDirector, type MusicInputs } from './director';

const base: MusicInputs = { playing: true, hour: 10, underground: 0, inTown: false, combat: false, voidMoment: false, timed: null };
const at = (p: Partial<MusicInputs>): MusicInputs => ({ ...base, ...p });

describe("the anthem (playtest 4: Nicole's main theme)", () => {
  it("plays during a new character's arrival instead of the day, town or night music", () => {
    const d = new MusicDirector();
    expect(d.wanted(at({ arrival: true }))).toBe('anthem');
    expect(d.wanted(at({ arrival: true, inTown: true }))).toBe('anthem');
    expect(d.wanted(at({ arrival: true, hour: 22 }))).toBe('anthem');
    // not outside the window
    expect(d.wanted(at({ arrival: false, inTown: true }))).toBe('town');
    expect(d.wanted(at({}))).toBe('day');
    expect(d.wanted(at({ playing: false, arrival: true }))).toBe('silence');
  });

  it('timed, void, cave and combat still beat it in the world', () => {
    const d = new MusicDirector();
    expect(d.wanted(at({ arrival: true, combat: true }))).toBe('combat');
    expect(d.wanted(at({ arrival: true, underground: 1 }))).toBe('cave');
    expect(d.wanted(at({ arrival: true, voidMoment: true }))).toBe('void');
    expect(d.wanted(at({ arrival: true, layer: 3 }))).toBe('void');
    expect(d.wanted(at({ arrival: true, timed: { key: 'a', secondsLeft: 10, urgent: false, intro: true } }))).toBe('timed');
  });

  it('starts at once, gives way to a fight at once, and comes back after the dwell', () => {
    const d = new MusicDirector();
    d.update(at({}), 0);
    expect(d.update(at({ arrival: true }), 1)).toMatchObject({ state: 'anthem', changed: true });
    expect(d.update(at({ arrival: true, combat: true }), 2).state).toBe('combat');
    expect(d.update(at({ arrival: true }), 3).state).toBe('combat');
    expect(d.update(at({ arrival: true }), 3 + DWELL_S).state).toBe('anthem');
    // the window closes: day after the dwell
    d.update(at({}), 20);
    expect(d.update(at({}), 20 + DWELL_S).state).toBe('day');
  });

  it('the ending and its credits are the anthem, over a fight, the dawn and the night', () => {
    const d = new MusicDirector();
    expect(d.wanted(at({ finale: 'ending' }))).toBe('anthem');
    expect(d.wanted(at({ finale: 'ending', hour: 22, combat: true }))).toBe('anthem');
    expect(d.wanted(at({ finale: 'ending', underground: 1 }))).toBe('anthem');
    // only a timed event (the endless night) outranks it
    expect(d.wanted(at({ finale: 'ending', timed: { key: 'n', secondsLeft: 20, urgent: false, intro: false } }))).toBe('timed');
    // and it takes over at once from the fight's void realm
    d.update(at({ finale: 'fight' }), 0);
    expect(d.update(at({ finale: 'ending' }), 1)).toMatchObject({ state: 'anthem', changed: true });
  });
});

describe('the arrival window', () => {
  const slimes = (talked: boolean) => [{ key: 'story:meadows', steps: [{ done: talked }, { done: false }, { done: false }] }];

  it("is a new character's first minutes, until the first talk step is done", () => {
    expect(arrivalAnthem(slimes(false), 0)).toBe(true);
    expect(arrivalAnthem(slimes(false), ARRIVAL_ANTHEM_S - 1)).toBe(true);
    expect(arrivalAnthem(slimes(false), ARRIVAL_ANTHEM_S)).toBe(false);
    expect(arrivalAnthem(slimes(true), 30)).toBe(false);
  });

  it('never for an old character (no first quest in the log) or other quests', () => {
    expect(arrivalAnthem([], 10)).toBe(false);
    expect(arrivalAnthem([{ key: 'story:errand:ore', steps: [{ done: false }] }], 10)).toBe(false);
    expect(arrivalAnthem([{ key: 'story:meadows' }], 10)).toBe(false);
  });
});
