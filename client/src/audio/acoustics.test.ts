import { describe, expect, it } from 'vitest';
import { caveLeak, duckLevels, interiorMix, RainIntensity, Smooth, thunderFor, weatherMix } from './acoustics';

const OPEN = { roof: 0, indoors: 0 };
const PORCH = { roof: 0.7, indoors: 0 };
const INSIDE = { roof: 1, indoors: 1 };

describe('cave leak (surface weather heard in a cave)', () => {
  it('is everything on the surface', () => {
    expect(caveLeak(0, Infinity)).toBe(1);
    expect(caveLeak(0, 3)).toBe(1);
  });

  it('fades with the distance from the opening and with depth', () => {
    const mouth = caveLeak(0.25, 0);
    const in10 = caveLeak(0.3, 10);
    const in30 = caveLeak(0.6, 30);
    const deep = caveLeak(1, 80);
    expect(mouth).toBeGreaterThan(0.4);
    expect(mouth).toBeLessThan(1);
    expect(in10).toBeLessThan(mouth);
    expect(in30).toBeLessThan(0.05);
    expect(deep).toBeLessThan(1e-3);
    expect(caveLeak(0.5, Infinity)).toBeLessThan(1e-6);
  });

  it('blends in smoothly as `underground` eases up from 0', () => {
    let prev = 1;
    for (let u = 0; u <= 0.25; u += 0.01) {
      const l = caveLeak(u, 2);
      expect(l).toBeLessThanOrEqual(prev + 1e-12);
      prev = l;
    }
  });
});

describe('weather through the shelter', () => {
  it('in the open: the rain as it falls, unfiltered', () => {
    const w = weatherMix(0.8, OPEN, 1);
    expect(w.gain).toBe(1);
    expect(w.lowpassHz).toBeGreaterThan(15000);
    expect(w.rain).toBe(0.8);
    expect(w.roofRain).toBe(0);
  });

  it('under a porch: a little quieter and duller, and the roof drums', () => {
    const w = weatherMix(1, PORCH, 1);
    expect(w.gain).toBeLessThan(1);
    expect(w.gain).toBeGreaterThan(0.6);
    expect(w.lowpassHz).toBeLessThan(10000);
    expect(w.roofRain).toBeGreaterThan(0.2);
  });

  it('indoors: the open-air rain is quiet and muffled, rain on the roof takes over', () => {
    const w = weatherMix(1, INSIDE, 1);
    expect(w.gain).toBeLessThan(0.25);
    expect(w.lowpassHz).toBeLessThan(800);
    expect(w.roofRain).toBeGreaterThan(weatherMix(1, PORCH, 1).roofRain);
  });

  it('walking in is a monotonic crossfade (no jumps)', () => {
    let pg = 1;
    let plp = 1e9;
    let proof = -1;
    for (let k = 0; k <= 20; k++) {
      const s = { roof: Math.min(1, k / 10), indoors: Math.max(0, (k - 10) / 10) };
      const w = weatherMix(1, s, 1);
      expect(w.gain).toBeLessThanOrEqual(pg);
      expect(w.lowpassHz).toBeLessThanOrEqual(plp);
      expect(w.roofRain).toBeGreaterThanOrEqual(proof);
      expect(pg - w.gain).toBeLessThan(0.1);
      pg = w.gain;
      plp = w.lowpassHz;
      proof = w.roofRain;
    }
  });

  it('in a cave: weather fades and darkens with the leak; no roof drumming deep inside', () => {
    const mouth = weatherMix(1, OPEN, caveLeak(0.25, 1));
    const deep = weatherMix(1, OPEN, caveLeak(0.8, 40));
    expect(mouth.gain).toBeLessThan(1);
    expect(deep.gain).toBeLessThan(0.01);
    expect(deep.lowpassHz).toBeLessThan(mouth.lowpassHz);
    expect(deep.lowpassHz).toBeLessThan(400);
    expect(weatherMix(1, INSIDE, 0).roofRain).toBe(0);
  });

  it('no rain, no rain', () => {
    expect(weatherMix(0, INSIDE, 1).rain).toBe(0);
    expect(weatherMix(0, INSIDE, 1).roofRain).toBe(0);
  });
});

describe('interior acoustics', () => {
  it('outdoors is dry and open', () => {
    const m = interiorMix(OPEN, 4, 0, 8);
    expect(m.reverb).toBe(0);
    expect(m.busLowpassHz).toBe(20000);
  });

  it('indoors: a small-room reverb and gentle damping', () => {
    const m = interiorMix(INSIDE, 3.5, 0, 8);
    expect(m.reverb).toBeGreaterThan(0.2);
    expect(m.reverb).toBeLessThan(0.5);
    expect(m.radius).toBe(3.5);
    expect(m.busLowpassHz).toBeLessThan(15000);
    expect(m.busLowpassHz).toBeGreaterThan(9000);
    expect(interiorMix(INSIDE, 40, 0, 8).radius).toBe(6);
  });

  it('underground: the chamber reverb, darker', () => {
    const m = interiorMix(OPEN, 4, 0.9, 12);
    expect(m.reverb).toBeCloseTo(0.9);
    expect(m.radius).toBe(12);
    expect(m.busLowpassHz).toBeLessThan(interiorMix(INSIDE, 4, 0, 8).busLowpassHz);
  });
});

describe('rain intensity', () => {
  it('builds from a drizzle over ~15 s and dies away when it stops', () => {
    const r = new RainIntensity();
    const run = (raining: boolean, s: number, t0: number) => {
      for (let t = 0; t < s; t += 0.1) r.update(raining, 0.1, t0 + t);
      return r.value;
    };
    const after2 = run(true, 2, 0);
    expect(after2).toBeGreaterThan(0.05);
    expect(after2).toBeLessThan(0.45);
    const after20 = run(true, 18, 2);
    expect(after20).toBeGreaterThan(0.6);
    expect(after20).toBeLessThanOrEqual(1);
    const stopped = run(false, 25, 20);
    expect(stopped).toBe(0);
  });
});

describe('smoothing and ducking', () => {
  it('Smooth approaches its target at its time constant', () => {
    const s = new Smooth(0, 0.3);
    s.update(1, 0.3);
    expect(s.value).toBeCloseTo(1 - Math.exp(-1), 5);
    for (let i = 0; i < 50; i++) s.update(1, 0.1);
    expect(s.value).toBeCloseTo(1, 4);
  });

  it('voice chat keeps priority, stings duck music most, a hidden tab is silent (voice stays)', () => {
    expect(duckLevels({ speaking: false, sting: false, hidden: false })).toEqual({ music: 1, ambience: 1, sfx: 1 });
    // CR 028: instruments near you push the score back, nothing else.
    expect(duckLevels({ speaking: false, sting: false, hidden: false, instrument: true })).toEqual({ music: 0.3, ambience: 1, sfx: 1 });
    const sting = duckLevels({ speaking: false, sting: true, hidden: false });
    expect(sting.music).toBeLessThan(sting.ambience);
    expect(sting.ambience).toBeLessThan(1);
    expect(sting.sfx).toBe(1);
    const voice = duckLevels({ speaking: true, sting: true, hidden: false });
    expect(voice.music).toBeLessThan(sting.music);
    expect(duckLevels({ speaking: true, sting: true, hidden: true })).toEqual({ music: 0, ambience: 0, sfx: 0 });
  });
});

describe('thunder', () => {
  it('arrives at the speed of sound, quieter and darker the further the strike', () => {
    const near = thunderFor(700);
    const far = thunderFor(4500);
    expect(near.delayS).toBeCloseTo(700 / 343, 6);
    expect(far.delayS).toBeCloseTo(4500 / 343, 6);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.lowpassHz).toBeLessThan(near.lowpassHz);
    expect(far.attackS).toBeGreaterThan(near.attackS);
    expect(near.gain).toBeLessThanOrEqual(0.9);
  });
});
