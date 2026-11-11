import { describe, expect, it } from 'vitest';
import { shelteredField } from './shelter';

describe('tower shelter (playtest 2 co-op)', () => {
  const wet = { moveWeatherAt: () => ({ rain: true, speedMult: 0.8, pushX: 1, pushZ: 0 }) };
  it('keeps a tower wall dry and leaves the rest of the weather', () => {
    const f = shelteredField(wet, [{ x: 100, z: 100, r: 13 }]);
    expect(f.moveWeatherAt(110, 105)).toEqual({ rain: false, speedMult: 0.8, pushX: 1, pushZ: 0 });
    expect(f.moveWeatherAt(120, 100).rain).toBe(true);
  });
  it('is the field itself with no towers', () => {
    expect(shelteredField(wet, [])).toBe(wet);
  });
});
