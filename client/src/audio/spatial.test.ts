import { describe, expect, it } from 'vitest';
import { airLowpassHz, distanceGain, FADE_TAIL, LOOP_PROFILES, occlusion, SPACE_CAVE, SPACE_OUTDOORS } from './spatial';

describe('distance attenuation', () => {
  const f = { ref: 3, max: 45 };

  it('is full inside the reference distance and silent at and beyond the range', () => {
    expect(distanceGain(0, f)).toBe(1);
    expect(distanceGain(3, f)).toBe(1);
    expect(distanceGain(45, f)).toBe(0);
    expect(distanceGain(80, f)).toBe(0);
    expect(distanceGain(-2, f)).toBe(1);
    expect(distanceGain(Number.NaN, f)).toBe(1);
  });

  it('falls monotonically and continuously (no step where the tail starts)', () => {
    let prev = 1;
    for (let d = 0; d <= 46; d += 0.05) {
      const g = distanceGain(d, f);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      expect(prev - g).toBeLessThan(0.02);
      prev = g;
    }
  });

  it('is the Web Audio inverse model before the tail', () => {
    const tailStart = 45 - (45 - 3) * FADE_TAIL;
    for (const d of [5, 10, 20, tailStart - 0.01]) expect(distanceGain(d, f)).toBeCloseTo(3 / (3 + (d - 3)), 6);
    expect(distanceGain(13, { ...f, rolloff: 2 })).toBeCloseTo(3 / (3 + 2 * 10), 6);
  });

  it('a campfire is louder at 10 m than a torch, and a torch is gone by 12 m', () => {
    const at = (k: keyof typeof LOOP_PROFILES, d: number) => LOOP_PROFILES[k].level * distanceGain(d, LOOP_PROFILES[k]);
    expect(at('campfire', 10)).toBeGreaterThan(at('torch', 10));
    expect(at('torch', 12)).toBe(0);
    expect(at('wildfire', 50)).toBeGreaterThan(0);
    for (const p of Object.values(LOOP_PROFILES)) expect(p.ref).toBeLessThan(p.max);
  });
});

describe('air absorption', () => {
  it('darkens with distance, never below 1.8 kHz', () => {
    expect(airLowpassHz(0)).toBe(20000);
    expect(airLowpassHz(10)).toBeGreaterThan(15000);
    expect(airLowpassHz(60)).toBeLessThan(6000);
    expect(airLowpassHz(500)).toBe(1800);
    expect(airLowpassHz(30)).toBeLessThan(airLowpassHz(20));
  });
});

describe('occlusion', () => {
  it('nothing between two points in the same space', () => {
    expect(occlusion(SPACE_OUTDOORS, SPACE_OUTDOORS)).toEqual({ gain: 1, lowpassHz: 20000 });
    expect(occlusion(4, 4)).toEqual({ gain: 1, lowpassHz: 20000 });
  });

  it('one wall muffles, two walls more', () => {
    const one = occlusion(SPACE_OUTDOORS, 4);
    const back = occlusion(4, SPACE_OUTDOORS);
    const two = occlusion(3, 4);
    expect(one).toEqual(back);
    expect(one.gain).toBeLessThan(0.5);
    expect(one.lowpassHz).toBeLessThan(1500);
    expect(two.gain).toBeLessThan(one.gain);
    expect(two.lowpassHz).toBeLessThan(one.lowpassHz);
  });

  it('in a cave, the surface comes through as much as leaks in', () => {
    const mouth = occlusion(SPACE_CAVE, SPACE_OUTDOORS, 0.8);
    const deep = occlusion(SPACE_CAVE, SPACE_OUTDOORS, 0.02);
    expect(mouth.gain).toBeCloseTo(0.8);
    expect(deep.gain).toBeCloseTo(0.02);
    expect(deep.lowpassHz).toBeLessThan(mouth.lowpassHz);
    // and caves are barely heard from above
    expect(occlusion(SPACE_OUTDOORS, SPACE_CAVE).gain).toBeLessThan(0.2);
  });
});
