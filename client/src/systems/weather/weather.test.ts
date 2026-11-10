// The weather is the same function on both sides: replay the vectors the
// Go twin wrote (server/pkg/weather/testdata/weather_vectors.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arrowAccel, Climate, CELLS_N, frontPhase, nextState, roll, stateAtStep, strikesBetween, tallSpot, W, WeatherField, windowAt } from './weather';

interface Vectors {
  climates: number[];
  states: { seed: string; k: number; states: number[]; details: { cx: number; cz: number; phase: number; w: number; roll: number; s: number; next: number; nextAt: number; climate: number }[] }[];
  moves: { seed: string; k: number; windDeg: number; override: number; xz: [number, number]; rain: boolean; speed: number; px: number; pz: number; ax: number; az: number; state: number }[];
  strikes: { seed: string; range: [number, number]; override: number; strikes: number[][] | null; tall: [number, number][] | null }[];
}


const v = JSON.parse(readFileSync(new URL('../../../../server/pkg/weather/testdata/weather_vectors.json', import.meta.url), 'utf8')) as Vectors;

/** The synthetic biome grid of states_test.go testBiomes. */
function testBiomes(): [number, number, Uint8Array] {
  const n = 129;
  const b = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let x = (Math.floor(i / 22) + 3 * Math.floor(j / 40)) % 6;
      if ((i * 31 + j * 17) % 23 === 0) x = (x + 3) % 6;
      b[j * n + i] = x;
    }
  }
  return [n, 32, b];
}

const testHeight = (x: number, z: number) => ((x * 0.37 + z * 0.61) % 17) + Math.abs(x - 2000) * 0.01;

describe('weather (Go twin vectors)', () => {
  const cl = Climate.fromBiomes(...testBiomes());

  it('votes the same climates', () => {
    expect([...cl.cells]).toEqual(v.climates);
  });

  it('replays every state, window and roll', () => {
    expect(v.states.length).toBeGreaterThan(30);
    for (const sv of v.states) {
      const seed = BigInt(sv.seed);
      const got: number[] = [];
      for (let cz = 0; cz < CELLS_N; cz++) for (let cx = 0; cx < CELLS_N; cx++) got.push(stateAtStep(seed, cl, cx, cz, sv.k));
      expect(got).toEqual(sv.states);
      for (const d of sv.details) {
        const [cx, cz] = [d.cx, d.cz];
        const w = windowAt(seed, cx, cz, sv.k);
        const nx = nextState(seed, cl, cx, cz, sv.k);
        expect([frontPhase(seed, cx, cz), w, roll(seed, cx, cz, w), stateAtStep(seed, cl, cx, cz, sv.k), nx.state, nx.at, cl.at(cx, cz)]).toEqual([d.phase, d.w, d.roll, d.s, d.next, d.nextAt, d.climate]);
      }
    }
  });

  it('builds the same movement field (rain, snow, glider push, arrow drift) to the bit', () => {
    for (const m of v.moves) {
      const f = new WeatherField(BigInt(m.seed), cl, m.windDeg, m.k, m.override);
      const mw = f.moveWeatherAt(m.xz[0], m.xz[1]);
      const st = f.stateAt(m.xz[0], m.xz[1]);
      const [ax, az] = arrowAccel(st, f.wind);
      expect([mw.rain, mw.speedMult, mw.pushX, mw.pushZ, ax, az, st]).toEqual([m.rain, m.speed, m.px, m.pz, m.ax, m.az, m.state]);
    }
  });

  it('schedules the same lightning and finds the same tall spots', () => {
    let n = 0;
    for (const sv of v.strikes) {
      const got: number[][] = [];
      const tall: [number, number][] = [];
      strikesBetween(BigInt(sv.seed), cl, sv.range[0], sv.range[1], sv.override, (s) => {
        got.push([s.id, s.step, s.x, s.z, s.cx, s.cz]);
        tall.push(tallSpot(testHeight, s.x, s.z));
      });
      expect(got).toEqual(sv.strikes ?? []);
      expect(tall).toEqual(sv.tall ?? []);
      n += got.length;
    }
    expect(n).toBeGreaterThan(20);
  });

  it('forces a state everywhere with an override', () => {
    const f = new WeatherField(1n, cl, 0, 1000, W.snowstorm);
    expect(f.stateAt(100, 3000)).toBe(W.snowstorm);
    expect(f.moveWeatherAt(100, 3000).speedMult).toBe(0.8);
  });
});
