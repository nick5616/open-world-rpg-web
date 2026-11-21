// Playtest 2 "dusk is golden": the sun sets at 19:00, not 18:00, and still rises at 06:00.
import { describe, expect, it } from 'vitest';
import { DAWN_HOUR, DAY_LENGTH_S, DUSK_HOUR } from '@lodestone/contracts';
import { SUNRISE_HOUR, SUNSET_HOUR, sunAngle, sunDirection } from './SkyAndSun';
import { makeSkyLighting, skyLighting, sunVisibility } from '../world/sky/atmosphere';

const at = (hour: number) => (hour / 24) * DAY_LENGTH_S;
const sunY = (hour: number) => sunDirection(at(hour)).y;

describe('sun curve', () => {
  it('rises at 06:00 and sets at 19:00', () => {
    expect(SUNRISE_HOUR).toBe(DAWN_HOUR);
    expect(SUNSET_HOUR).toBeGreaterThan(DUSK_HOUR);
    expect(Math.abs(sunY(6))).toBeLessThan(1e-9);
    expect(Math.abs(sunY(19))).toBeLessThan(1e-9);
    expect(sunY(6.25)).toBeGreaterThan(0);
    expect(sunY(5.75)).toBeLessThan(0);
    expect(sunY(18.5)).toBeGreaterThan(0.05); // demons rise in a low sun
    expect(sunY(19.75)).toBeLessThan(-0.15); // full night by ~19:40
  });

  it('peaks at 12:30 and is lowest in the small hours', () => {
    let best = -Infinity;
    let bestH = 0;
    for (let h = 0; h < 24; h += 1 / 60) {
      const y = sunY(h);
      if (y > best) [best, bestH] = [y, h];
    }
    expect(bestH).toBeCloseTo(12.5, 1);
    expect(sunAngle(12.5)).toBeCloseTo(Math.PI / 2, 9);
    expect(sunY(0.5)).toBeLessThan(-0.9);
  });

  it('is continuous all day, including midnight', () => {
    const step = 1 / 600; // 6 s of game hour
    for (let h = 0; h < 24; h += step) {
      const a = sunDirection(at(h));
      const b = sunDirection(at((h + step) % 24));
      expect(a.distanceTo(b)).toBeLessThan(0.002);
    }
    expect(sunDirection(at(0)).distanceTo(sunDirection(at(24)))).toBeLessThan(1e-9);
  });

  it('18:00-19:00 is golden light and the sky is dark by 19:45', () => {
    const L = makeSkyLighting();
    skyLighting(at(18), L);
    expect(L.golden).toBeGreaterThan(0.05); // the gold comes on at 18:00
    for (const h of [18.5, 18.9]) {
      skyLighting(at(h), L);
      expect(L.golden).toBeGreaterThan(0.5);
      expect(sunVisibility(L.sunDir.y)).toBeGreaterThan(0.9);
    }
    skyLighting(at(17), L);
    expect(L.golden).toBe(0); // the afternoon is still plain day
    skyLighting(at(19.75), L);
    expect(L.golden).toBe(0);
    expect(L.day).toBeLessThan(0.01);
  });
});
