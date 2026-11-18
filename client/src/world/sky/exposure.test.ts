import { describe, expect, it } from 'vitest';
import { BASE_ROOF_REACH_M, EXPOSURE_FADE_S, LIGHTNING_INDOORS, WeatherExposure, baseRoofCover, exposureTarget, lightningThrough, stepExposure } from './exposure';

describe('how much weather reaches the camera', () => {
  it('is everything in the open and nothing in a closed building', () => {
    expect(exposureTarget({ roof: 0, indoors: 0 })).toBe(1);
    expect(exposureTarget({ roof: 0.85, indoors: 1 })).toBe(0);
  });
  it('lets some through under a porch or an open-fronted forge, little under a roof alone', () => {
    const forge = exposureTarget({ roof: 0.6, indoors: 0.55 });
    expect(forge).toBeGreaterThan(0.3);
    expect(forge).toBeLessThan(0.5);
    const porch = exposureTarget({ roof: 0.4, indoors: 0 });
    expect(porch).toBeGreaterThan(0.6);
    expect(exposureTarget({ roof: 1, indoors: 0 })).toBeCloseTo(0.1, 5);
  });
  it('takes it all away underground, however open the sky above the cave mouth', () => {
    expect(exposureTarget({ roof: 0, indoors: 0 }, 1)).toBe(0);
    expect(exposureTarget({ roof: 0, indoors: 0 }, 0.5)).toBeCloseTo(0.5, 5);
  });
  it('counts the roof of a built base overhead', () => {
    expect(exposureTarget({ roof: 0, indoors: 0 }, 0, 1)).toBeCloseTo(0.1, 5);
    expect(exposureTarget({ roof: 0, indoors: 0 }, 0, 0.45)).toBeCloseTo(0.595, 5);
  });
});

describe('fading, not popping', () => {
  it('takes half a second for a full change, either way, and never overshoots', () => {
    let v = 1;
    let t = 0;
    while (v > 0) {
      v = stepExposure(v, 0, 1 / 60);
      t += 1 / 60;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(EXPOSURE_FADE_S + 0.05);
    }
    expect(t).toBeGreaterThan(EXPOSURE_FADE_S - 0.05);
    for (let i = 0; i < 60; i++) v = stepExposure(v, 1, 1 / 60);
    expect(v).toBe(1);
  });
  it('moves in even steps with no jump at any frame rate', () => {
    for (const dt of [1 / 144, 1 / 60, 1 / 20]) {
      const a = stepExposure(1, 0, dt);
      expect(1 - a).toBeCloseTo(dt / EXPOSURE_FADE_S, 9);
    }
    expect(stepExposure(0.5, 0.5, 0.016)).toBe(0.5);
    expect(stepExposure(0.5, 0, -1)).toBe(0.5); // a clock that went backwards changes nothing
  });
  it('the smoothed value follows a probe that is only asked every tenth of a second', () => {
    const ex = new WeatherExposure();
    let calls = 0;
    let target = 1;
    const probe = () => (calls++, target);
    for (let i = 0; i < 60; i++) ex.update(1 / 60, probe);
    expect(ex.value).toBe(1);
    expect(calls).toBeLessThanOrEqual(11);
    target = 0; // walked through the door
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) seen.push(ex.update(1 / 60, probe));
    expect(seen[0]).toBeGreaterThan(0.9); // no pop on the first frame
    expect(seen[59]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1] - seen[i]).toBeLessThan(0.04);
  });
});

describe('lightning through the walls', () => {
  it('is full outside and dim but not gone inside', () => {
    expect(lightningThrough(1)).toBe(1);
    expect(lightningThrough(0)).toBe(LIGHTNING_INDOORS);
    expect(lightningThrough(0.5)).toBeGreaterThan(LIGHTNING_INDOORS);
  });
});

describe('a built base\'s roof', () => {
  const roofs = [{ x: 10, y: 52, z: 10, roof: true }];
  it('covers a head under the tile, partly beside it, not far away', () => {
    expect(baseRoofCover(10.5, 51, 9.6, roofs)).toBe(1);
    expect(baseRoofCover(12.8, 51, 10, roofs)).toBe(0.45);
    expect(baseRoofCover(20, 51, 10, roofs)).toBe(0);
  });
  it('ignores tiles below the head or far above, and walls', () => {
    expect(baseRoofCover(10, 53, 10, roofs)).toBe(0); // the tile is under the head (standing on the roof)
    expect(baseRoofCover(10, 52 - BASE_ROOF_REACH_M - 1, 10, roofs)).toBe(0);
    expect(baseRoofCover(10, 51, 10, [{ x: 10, y: 52, z: 10, roof: false }])).toBe(0);
  });
});
