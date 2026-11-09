// The world clock is the same function on both sides: replay the vectors
// the Go twin wrote (server/pkg/weather/testdata/clock_vectors.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chemStep, hourOf, isNight, moonPhase, nightIndex, seededRainAtStep, windAtStep } from './clock';
import { isRaining } from '../sim/weather';

interface Vec {
  seed: string;
  t: number;
  hour: number;
  night: boolean;
  nightIndex: number;
  phase: number;
  step: number;
  rain: boolean;
  windDeg: number;
  sector: number;
  dx: number;
  dz: number;
  strength: number;
  rainStepVsT: boolean;
}

const vectors = JSON.parse(readFileSync(new URL('../../../server/pkg/weather/testdata/clock_vectors.json', import.meta.url), 'utf8')) as Vec[];

describe('world clock (Go twin vectors)', () => {
  it('replays every vector exactly', () => {
    expect(vectors.length).toBeGreaterThan(30);
    for (const v of vectors) {
      const seed = BigInt(v.seed);
      expect(hourOf(v.t)).toBe(v.hour);
      expect(isNight(v.t)).toBe(v.night);
      expect(nightIndex(v.t)).toBe(v.nightIndex);
      expect(moonPhase(seed, nightIndex(v.t))).toBe(v.phase);
      expect(chemStep(v.t)).toBe(v.step);
      expect(seededRainAtStep(seed, v.step)).toBe(v.rain);
      const w = windAtStep(seed, v.windDeg, v.step);
      expect([w.sector, w.dx, w.dz, w.strength]).toEqual([v.sector, v.dx, v.dz, v.strength]);
      expect(seededRainAtStep(seed, v.step) === isRaining(seed, v.t)).toBe(v.rainStepVsT);
    }
  });
});
