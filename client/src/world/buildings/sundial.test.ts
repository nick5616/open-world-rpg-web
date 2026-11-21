import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_S } from '@lodestone/contracts';
import { sunDirection } from '../../scene/SkyAndSun';
import { skyLighting, makeSkyLighting } from '../sky/atmosphere';
import { DIAL_R, GNOMON_H, SUN_MIN_Y, arcAt, clockText, discHitsBox, hourMarks, readHour, shadowOf, sundialSpot } from './sundial';
import { DIAL_QUIET_OPACITY, dialOpacity } from '../../hud/immersive';
import { glyphAt, periodWord } from '../../hud/SundialClock';

const sunAt = (h: number) => sunDirection((h / 24) * DAY_LENGTH_S);

describe('the sundial shadow', () => {
  it('points west in the morning, north at noon, east at dusk (the renderer\'s own sun)', () => {
    const am = shadowOf(sunAt(8));
    const noon = shadowOf(sunAt(12.5)); // the sun peaks at 12:30 (sets at 19:00)
    const pm = shadowOf(sunAt(16));
    expect(am.lit && noon.lit && pm.lit).toBe(true);
    expect(am.dx).toBeLessThan(-0.5); // the sun is in +x, the shadow falls toward -x
    expect(noon.dz).toBeLessThan(-0.9); // the sun is a little south (+z), the shadow falls north
    expect(pm.dx).toBeGreaterThan(0.5);
    expect(am.phi).toBeGreaterThan(noon.phi);
    expect(noon.phi).toBeGreaterThan(pm.phi);
    expect(noon.phi).toBeCloseTo(Math.PI / 2, 1);
  });
  it('is shortest at noon, longer toward the ends of the day, and clamped to the plate', () => {
    const lens = [7, 9, 12, 15, 17].map((h) => shadowOf(sunAt(h)));
    expect(lens[2].rawLen).toBeLessThan(lens[1].rawLen);
    expect(lens[1].rawLen).toBeLessThan(lens[0].rawLen);
    expect(lens[2].len).toBeCloseTo((GNOMON_H * Math.hypot(sunAt(12).x, sunAt(12).z)) / sunAt(12).y, 5);
    for (const s of lens) expect(s.len).toBeLessThanOrEqual(DIAL_R + 1e-9);
  });
  it('follows the sun direction exactly: the shadow is opposite the sun in x and z', () => {
    for (const h of [7, 9.5, 12, 14.25, 17]) {
      const sun = sunAt(h);
      const s = shadowOf(sun);
      const hx = Math.hypot(sun.x, sun.z);
      expect(s.dx).toBeCloseTo(-sun.x / hx, 9);
      expect(s.dz).toBeCloseTo(-sun.z / hx, 9);
    }
  });
  it('has no shadow at night or at the very edge of dawn and dusk', () => {
    for (const h of [0, 3, 5.5, 19.6, 22]) expect(shadowOf(sunAt(h)).lit).toBe(false);
    expect(shadowOf({ x: 1, y: SUN_MIN_Y - 0.001, z: 0 }).lit).toBe(false);
    expect(shadowOf({ x: 1, y: SUN_MIN_Y + 0.01, z: 0 }).lit).toBe(true);
  });
  it('reads the hour: every carved mark is where the shadow falls at that hour, and between marks it interpolates', () => {
    const marks = hourMarks(sunAt);
    expect(marks.map((m) => m.hour)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    for (let i = 1; i < marks.length; i++) expect(marks[i].phi).toBeLessThan(marks[i - 1].phi);
    for (const h of [7, 8, 10, 12, 14, 16, 17]) expect(readHour(shadowOf(sunAt(h)).phi, marks)).toBeCloseTo(h, 5);
    for (const h of [7.5, 9.25, 13.5, 16.75]) expect(Math.abs((readHour(shadowOf(sunAt(h)).phi, marks) ?? -1) - h)).toBeLessThan(0.08);
    expect(readHour(-1, marks)).toBeNull();
  });
  it('uses the sun the lighting uses (skyLighting.sunDir)', () => {
    const L = skyLighting(10.5 * (DAY_LENGTH_S / 24), makeSkyLighting());
    const a = shadowOf(L.sunDir);
    const b = shadowOf(sunAt(10.5));
    expect(a.phi).toBeCloseTo(b.phi, 9);
  });
});

describe('the HUD sundial', () => {
  it('moves the sun over the arc from left at 06:00 to right at 19:00, the moon through the night', () => {
    expect(arcAt(6)).toEqual({ t: 0, sun: true });
    expect(arcAt(12.5).t).toBeCloseTo(0.5, 5);
    expect(arcAt(18.99).t).toBeGreaterThan(0.99);
    expect(arcAt(19).sun).toBe(false);
    expect(arcAt(0.5).t).toBeCloseTo(0.5, 5);
    expect(arcAt(5.99).sun).toBe(false);
    const noon = glyphAt(12.5);
    expect(noon.x).toBeCloseTo(48, 3);
    expect(noon.y).toBeLessThan(10);
    expect(glyphAt(6).x).toBeLessThan(15);
    expect(glyphAt(18.5).x).toBeGreaterThan(80);
  });
  it('names the time of day and tells it', () => {
    expect(periodWord(6)).toBe('Dawn');
    expect(periodWord(9)).toBe('Morning');
    expect(periodWord(12)).toBe('Midday');
    expect(periodWord(15)).toBe('Afternoon');
    expect(periodWord(18)).toBe('Dusk');
    expect(periodWord(21)).toBe('Evening');
    expect(periodWord(0)).toBe('Midnight');
    expect(periodWord(3)).toBe('Small hours');
    expect(clockText(0)).toBe('12:00 am');
    expect(clockText(13.5)).toBe('1:30 pm');
    expect(clockText(23.999)).toBe('11:59 pm');
  });
  it('rests soft when the HUD is immersive and brightens when the hour turns or Tab is held', () => {
    const base = { immersive: true, now: 100_000, hourAt: -1e9, tabHeld: false };
    expect(dialOpacity(base)).toBe(DIAL_QUIET_OPACITY);
    expect(dialOpacity({ ...base, hourAt: 99_000 })).toBe(1);
    expect(dialOpacity({ ...base, tabHeld: true })).toBe(1);
    expect(dialOpacity({ ...base, immersive: false })).toBe(1);
  });
});

describe('where the stone stands', () => {
  const wall = { x: 0, z: 0, c: 1, s: 0, hx: 4, hz: 2 };
  it('keeps a disc off a wall, with a margin, and respects the box turning', () => {
    expect(discHitsBox(6.2, 0, 1.7, wall)).toBe(false); // 2.2 m from the wall's end, clear of its 1.7 reach
    expect(discHitsBox(5, 0, 1.7, wall)).toBe(true);
    expect(discHitsBox(0, 3.5, 1.7, wall)).toBe(true);
    expect(discHitsBox(6, 0, 1.7, wall, 0.6)).toBe(true); // within the margin
    const turned = { ...wall, c: 0, s: 1 }; // long side along z
    expect(discHitsBox(5, 0, 1.7, turned)).toBe(false);
    expect(discHitsBox(0, 5, 1.7, turned)).toBe(true);
  });
  it('picks the first free spot on the rings, deterministically, and differs per town', () => {
    const free = () => true;
    expect(sundialSpot(100, 200, 7, free)).toEqual(sundialSpot(100, 200, 7, free));
    expect(sundialSpot(100, 200, 7, free)).not.toEqual(sundialSpot(100, 200, 8, free));
    // blocked near the square: it moves out a ring
    const s = sundialSpot(0, 0, 3, (x, z) => Math.hypot(x, z) > 8);
    expect(Math.hypot(s.x, s.z)).toBeGreaterThan(8);
    // nothing free: it still returns a spot
    expect(sundialSpot(0, 0, 3, () => false)).toEqual({ x: 5.5, z: 0, yaw: 0 });
  });
});
