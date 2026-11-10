// CR 030: the client's weather blending (time, space, ground memory,
// rainbows, the forecast line) and the runtime's overrides and field cache.
import { describe, expect, it } from 'vitest';
import { CHEM_STEP_HZ, WEATHER_BLEND_S, WEATHER_CELL_M } from '@lodestone/contracts';
import { accumulate, cellMix, EDGE_M, forecast, forecastLine, mixAt, rainbowAt, STATE_MIX, sinceRainS, zeroMix, easeMix } from './blend';
import { Climate, CLIMATE, NUM_STATES, stateAtStep, W, windowAt, windowStart } from './weather';
import { weatherClient, weatherField, weatherOverride } from './runtime';

const seed = 20261108n;
const cl = Climate.uniform(CLIMATE.temperate);

/** The world time (s) of window w's change for cell (cx, cz). */
const changeAt = (cx: number, cz: number, w: number) => windowStart(seed, cx, cz, w) / CHEM_STEP_HZ;

/** A window whose state differs from the one before it. */
function aChange(cx: number, cz: number): number {
  for (let w = 100; w < 400; w++) {
    const t = changeAt(cx, cz, w);
    if (stateAtStep(seed, cl, cx, cz, Math.floor(t * CHEM_STEP_HZ)) !== stateAtStep(seed, cl, cx, cz, Math.floor(t * CHEM_STEP_HZ) - 1)) return w;
  }
  throw new Error('no change');
}

describe('weather blending', () => {
  it('every state has a full intensity vector', () => {
    expect(STATE_MIX.length).toBe(NUM_STATES);
    expect(STATE_MIX[W.thunderstorm].storm).toBe(1);
    expect(STATE_MIX[W.snowstorm].snow).toBe(1);
    expect(STATE_MIX[W.fog].fog).toBe(1);
    expect(STATE_MIX[W.clear].rain).toBe(0);
  });

  it('crossfades a front change over WEATHER_BLEND_S, half and half at the change, whole outside', () => {
    const w = aChange(3, 3);
    const t0 = changeAt(3, 3, w);
    const before = stateAtStep(seed, cl, 3, 3, Math.floor(t0 * CHEM_STEP_HZ) - 1);
    const after = stateAtStep(seed, cl, 3, 3, Math.floor(t0 * CHEM_STEP_HZ));
    const atChange = cellMix(seed, cl, 3, 3, t0 + 1e-6);
    const half = zeroMix();
    for (const k of Object.keys(half) as (keyof typeof half)[]) half[k] = (STATE_MIX[before][k] + STATE_MIX[after][k]) / 2;
    for (const k of Object.keys(half) as (keyof typeof half)[]) expect(atChange[k]).toBeCloseTo(half[k], 2);
    expect(cellMix(seed, cl, 3, 3, t0 - WEATHER_BLEND_S)).toEqual(STATE_MIX[before]);
    expect(cellMix(seed, cl, 3, 3, t0 + WEATHER_BLEND_S)).toEqual(STATE_MIX[after]);
    // Continuous across the change.
    const a = cellMix(seed, cl, 3, 3, t0 - 0.2);
    const b = cellMix(seed, cl, 3, 3, t0 + 0.2);
    for (const k of Object.keys(a) as (keyof typeof a)[]) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.02);
  });

  it('bleeds the neighbour in near a cell border only', () => {
    const t = changeAt(2, 2, 200) + 200;
    const mid = mixAt(seed, cl, 2 * WEATHER_CELL_M + 256, 2 * WEATHER_CELL_M + 256, t);
    expect(mid).toEqual(cellMix(seed, cl, 2, 2, t));
    const border = mixAt(seed, cl, 3 * WEATHER_CELL_M - 0.01, 2 * WEATHER_CELL_M + 256, t);
    const a = cellMix(seed, cl, 2, 2, t);
    const b = cellMix(seed, cl, 3, 2, t);
    for (const k of Object.keys(a) as (keyof typeof a)[]) expect(border[k]).toBeCloseTo((a[k] + b[k]) / 2, 3);
    expect(mixAt(seed, cl, 3 * WEATHER_CELL_M - EDGE_M - 1, 2 * WEATHER_CELL_M + 256, t)).toEqual(a);
  });

  it('an override is that state everywhere', () => {
    expect(mixAt(seed, cl, 100, 100, 5, W.sandstorm)).toEqual(STATE_MIX[W.sandstorm]);
  });

  it('eases toward the target and the ground remembers rain and snow', () => {
    const cur = zeroMix();
    easeMix(cur, STATE_MIX[W.rain], 2.5);
    expect(cur.rain).toBeCloseTo(STATE_MIX[W.rain].rain * (1 - Math.exp(-1)), 5);
    const g = { wet: 0, snowCover: 0 };
    for (let i = 0; i < 300; i++) accumulate(g, STATE_MIX[W.rain], 0.1);
    expect(g.wet).toBeGreaterThan(0.95);
    for (let i = 0; i < 300; i++) accumulate(g, STATE_MIX[W.clear], 0.1);
    expect(g.wet).toBeGreaterThan(0.3); // still damp 30 s after the rain stopped
    for (let i = 0; i < 1200; i++) accumulate(g, STATE_MIX[W.snowstorm], 0.1);
    expect(g.snowCover).toBeGreaterThan(0.95);
  });

  it('rainbows only after a shower clears, with a low sun, on about half the clearings', () => {
    let clearings = 0;
    let bows = 0;
    for (let w = 50; w < 1500; w++) {
      const t = changeAt(1, 1, w) + 60;
      if (!Number.isFinite(sinceRainS(seed, cl, 1, 1, t))) {
        expect(rainbowAt(seed, cl, 600, 600, t, 0.3)).toBe(0);
        continue;
      }
      clearings++;
      expect(rainbowAt(seed, cl, 600, 600, t, 1.2)).toBe(0); // sun too high
      expect(rainbowAt(seed, cl, 600, 600, t, -0.1)).toBe(0); // night
      if (rainbowAt(seed, cl, 600, 600, t, 0.3) > 0.5) bows++;
    }
    expect(clearings).toBeGreaterThan(50);
    expect(bows / clearings).toBeGreaterThan(0.35);
    expect(bows / clearings).toBeLessThan(0.75);
  });

  it('forecasts the next state and when; the line reads like weather', () => {
    const t = changeAt(4, 4, 300) - 50;
    const f = forecast(seed, cl, 4 * 512 + 10, 4 * 512 + 10, t);
    expect(f.inS).toBeCloseTo(50, 5);
    expect(f.next).toBe(stateAtStep(seed, cl, 4, 4, windowStart(seed, 4, 4, 300)));
    expect(forecastLine(W.clear, W.thunderstorm, 30)).toBe('Storm rolling in soon');
    expect(forecastLine(W.rain, W.cloudy, 150)).toBe('Clearing in 3 min');
    expect(forecastLine(W.cloudy, W.snow, 90)).toBe('Snow in 2 min');
    expect(forecastLine(W.clear, W.clear, 30)).toBe('');
    expect(forecastLine(W.clear, W.rain, 600)).toBe('');
    expect(windowAt(seed, 4, 4, Math.floor(t * CHEM_STEP_HZ))).toBe(299);
  });
});

describe('weather runtime', () => {
  it('overrides: dev handle, then the zone, then the WP10 rain byte', () => {
    weatherClient.devOverride = W.snow;
    expect(weatherOverride()).toBe(W.snow);
    weatherClient.devOverride = null;
    weatherClient.zoneOverride = W.fog;
    expect(weatherOverride()).toBe(W.fog);
    weatherClient.zoneOverride = -1;
    expect(weatherOverride()).toBe(-1);
  });

  it('builds the shared field once per step and none without a climate or dynamic weather', () => {
    weatherClient.climate = null;
    expect(weatherField(seed, 10)).toBeNull();
    weatherClient.climate = cl;
    weatherClient.dynamic = true;
    const f = weatherField(seed, 10);
    expect(f).not.toBeNull();
    expect(weatherField(seed, 10)).toBe(f);
    expect(weatherField(seed, 11)).not.toBe(f);
    weatherClient.dynamic = false;
    expect(weatherField(seed, 12)).toBeNull();
    weatherClient.dynamic = true;
    weatherClient.climate = null;
  });
});
