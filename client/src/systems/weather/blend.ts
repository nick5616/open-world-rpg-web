// Client weather blending (playtest 2, CR 030): what the weather looks and
// sounds like where you are. Pure functions of the shared weather states
// (weather.ts), so every client sees the same storm roll in at the same
// moment: each state is a vector of intensities; a front's change crossfades
// over WEATHER_BLEND_S centred on the change (the gameplay state switches at
// the middle), and near a cell border the neighbour bleeds in over EDGE_M, so
// walking out of a storm is a gradient, not a wall.

import { CHEM_STEP_HZ, WEATHER_BLEND_S, WEATHER_CELL_M } from '@lodestone/contracts';
import { CELLS_N, cellOf, type Climate, nextState, roll, stateAtStep, stateFor, W, windowAt, windowStart } from './weather';
import { weatherHash } from '../../sim/weather';

export interface WeatherMix {
  /** Cloud cover 0..1. */
  cloud: number;
  /** Rain 0..1 (drizzle ~0.35). */
  rain: number;
  /** Falling snow 0..1. */
  snow: number;
  /** Fog bank 0..1. */
  fog: number;
  /** Wind 0..1 (gale = 1). */
  wind: number;
  /** Blowing sand 0..1. */
  dust: number;
  /** Heat shimmer 0..1. */
  haze: number;
  /** Thunderstorm darkness 0..1. */
  storm: number;
}

export const MIX_KEYS: (keyof WeatherMix)[] = ['cloud', 'rain', 'snow', 'fog', 'wind', 'dust', 'haze', 'storm'];

const m = (cloud: number, rain: number, snow: number, fog: number, wind: number, dust: number, haze: number, storm: number): WeatherMix => ({ cloud, rain, snow, fog, wind, dust, haze, storm });

/** Each state as intensities (W order). */
export const STATE_MIX: WeatherMix[] = [
  m(0.1, 0, 0, 0, 0.15, 0, 0, 0), // clear
  m(0.72, 0, 0, 0, 0.3, 0, 0, 0.1), // cloudy
  m(0.4, 0, 0, 0, 0.8, 0, 0, 0), // windy
  m(0.55, 0, 0, 1, 0.05, 0, 0, 0.1), // fog
  m(0.78, 0.35, 0, 0.2, 0.3, 0, 0, 0.2), // drizzle
  m(0.9, 0.8, 0, 0.15, 0.45, 0, 0, 0.45), // rain
  m(1, 1, 0, 0.1, 0.75, 0, 0, 1), // thunderstorm
  m(0.82, 0, 0.6, 0.25, 0.3, 0, 0, 0.25), // snow
  m(1, 0, 1, 0.55, 1, 0, 0, 0.5), // snowstorm
  m(0, 0, 0, 0, 0.1, 0, 1, 0), // heat haze
  m(0.35, 0, 0, 0.35, 1, 1, 0, 0.2), // sandstorm
];

export function zeroMix(): WeatherMix {
  return m(0, 0, 0, 0, 0, 0, 0, 0);
}

export function addScaled(out: WeatherMix, a: WeatherMix, k: number): WeatherMix {
  for (const key of MIX_KEYS) out[key] += a[key] * k;
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * One cell's mix at world time t: the state, crossfaded with the previous
 * window's in the first half-blend after a change and with the next one's in
 * the last half-blend before it.
 */
export function cellMix(seed: bigint, c: Climate, cx: number, cz: number, t: number, override = -1): WeatherMix {
  if (override >= 0) return { ...STATE_MIX[override] };
  const stepF = t * CHEM_STEP_HZ;
  const k = Math.floor(stepF);
  const w = windowAt(seed, cx, cz, k);
  const s = stateAtStep(seed, c, cx, cz, k);
  const start = windowStart(seed, cx, cz, w);
  const end = windowStart(seed, cx, cz, w + 1);
  const half = WEATHER_BLEND_S / 2;
  const sinceS = (stepF - start) / CHEM_STEP_HZ;
  const untilS = (end - stepF) / CHEM_STEP_HZ;
  const out = zeroMix();
  if (sinceS < half) {
    const prev = stateFor(c.at(cx, cz), roll(seed, cx, cz, w - 1), start - 1);
    const f = smooth(0.5 + sinceS / WEATHER_BLEND_S);
    addScaled(out, STATE_MIX[s], f);
    return addScaled(out, STATE_MIX[prev], 1 - f);
  }
  if (untilS < half) {
    const next = stateFor(c.at(cx, cz), roll(seed, cx, cz, w + 1), end);
    const f = smooth(0.5 + untilS / WEATHER_BLEND_S);
    addScaled(out, STATE_MIX[s], f);
    return addScaled(out, STATE_MIX[next], 1 - f);
  }
  return addScaled(out, STATE_MIX[s], 1);
}

/** Width of the border band where a neighbouring cell's weather bleeds in. */
export const EDGE_M = 90;

/**
 * The mix at (x, z): the cell's, with each neighbour across a border closer
 * than EDGE_M weighted in (half at the border itself).
 */
export function mixAt(seed: bigint, c: Climate, x: number, z: number, t: number, override = -1): WeatherMix {
  const [cx, cz] = cellOf(x, z);
  if (override >= 0) return { ...STATE_MIX[override] };
  const fx = x - cx * WEATHER_CELL_M;
  const fz = z - cz * WEATHER_CELL_M;
  const side = (f: number, n: number): [number, number] => {
    if (f < EDGE_M && n > 0) return [-1, 0.5 * (1 - smooth(f / EDGE_M))];
    if (f > WEATHER_CELL_M - EDGE_M && n < CELLS_N - 1) return [1, 0.5 * (1 - smooth((WEATHER_CELL_M - f) / EDGE_M))];
    return [0, 0];
  };
  const [dx, wx] = side(fx, cx);
  const [dz, wz] = side(fz, cz);
  const out = zeroMix();
  const add = (ox: number, oz: number, k: number) => {
    if (k > 1e-4) addScaled(out, cellMix(seed, c, cx + ox, cz + oz, t), k);
  };
  add(0, 0, (1 - wx) * (1 - wz));
  if (dx) add(dx, 0, wx * (1 - wz));
  if (dz) add(0, dz, (1 - wx) * wz);
  if (dx && dz) add(dx, dz, wx * wz);
  return out;
}

/** Ease `cur` toward `target` (time constant tau seconds). */
export function easeMix(cur: WeatherMix, target: WeatherMix, dt: number, tau = 2.5): WeatherMix {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  for (const key of MIX_KEYS) cur[key] += (target[key] - cur[key]) * k;
  return cur;
}

/**
 * Ground that remembers the weather: it gets wet over ~20 s of rain and dries
 * over ~2 min; snow settles over ~1 min of snowfall and melts over ~3 min.
 */
export function accumulate(cur: { wet: number; snowCover: number }, mix: WeatherMix, dt: number): void {
  const wetT = Math.min(1, mix.rain * 1.4);
  cur.wet += (wetT - cur.wet) * (1 - Math.exp(-dt / (wetT > cur.wet ? 7 : 40)));
  const snowT = Math.min(1, mix.snow * 1.3);
  cur.snowCover += (snowT - cur.snowCover) * (1 - Math.exp(-dt / (snowT > cur.snowCover ? 20 : 60)));
}

/** Seconds since the cell's weather turned from wet to dry (Infinity if it has not, this window). */
export function sinceRainS(seed: bigint, c: Climate, cx: number, cz: number, t: number): number {
  const k = Math.floor(t * CHEM_STEP_HZ);
  const w = windowAt(seed, cx, cz, k);
  const start = windowStart(seed, cx, cz, w);
  const now = stateAtStep(seed, c, cx, cz, k);
  const prev = stateFor(c.at(cx, cz), roll(seed, cx, cz, w - 1), start - 1);
  const wet = (s: number) => s === W.drizzle || s === W.rain || s === W.thunderstorm;
  return wet(prev) && !wet(now) ? (k - start) / CHEM_STEP_HZ : Infinity;
}

/**
 * Rainbow strength 0..1: after a shower clears (the first 4 minutes of the
 * dry window), with the sun up but lower than 42 degrees (a bow needs it
 * behind you and low), on about half the clearings (seeded per window).
 */
export function rainbowAt(seed: bigint, c: Climate, x: number, z: number, t: number, sunElevationRad: number): number {
  const [cx, cz] = cellOf(x, z);
  const since = sinceRainS(seed, c, cx, cz, t);
  if (!Number.isFinite(since) || since > 240) return 0;
  if (sunElevationRad <= 0.02 || sunElevationRad > 0.72) return 0;
  const w = windowAt(seed, cx, cz, Math.floor(t * CHEM_STEP_HZ));
  if (weatherHash(BigInt.asUintN(64, seed) ^ 0x7261696e626f77n, w + cx * 131 + cz * 977) % 100 >= 55) return 0;
  const fadeIn = smooth(since / 25);
  const fadeOut = 1 - smooth((since - 150) / 90);
  const sun = smooth((sunElevationRad - 0.02) / 0.1) * (1 - smooth((sunElevationRad - 0.6) / 0.12));
  return fadeIn * fadeOut * sun;
}

/** Forecast for the HUD: the state now, the next one and the seconds until it. */
export function forecast(seed: bigint, c: Climate, x: number, z: number, t: number, override = -1): { now: number; next: number; inS: number } {
  const [cx, cz] = cellOf(x, z);
  const k = Math.floor(t * CHEM_STEP_HZ);
  if (override >= 0) return { now: override, next: override, inS: Infinity };
  const n = nextState(seed, c, cx, cz, k);
  return { now: stateAtStep(seed, c, cx, cz, k), next: n.state, inS: (n.at - t * CHEM_STEP_HZ) / CHEM_STEP_HZ };
}

const NAMES = ['Clear', 'Cloudy', 'Windy', 'Fog', 'Drizzle', 'Rain', 'Thunderstorm', 'Snow', 'Snowstorm', 'Heat haze', 'Sandstorm'];
const ICONS = ['☀️', '☁️', '\u{1F32C}️', '\u{1F32B}️', '\u{1F326}️', '\u{1F327}️', '⛈️', '\u{1F328}️', '❄️', '\u{1F525}', '\u{1F3DC}️'];

export const weatherName = (s: number) => NAMES[s] ?? 'Clear';
export const weatherIcon = (s: number) => ICONS[s] ?? ICONS[0];

const isWetS = (s: number) => s === W.drizzle || s === W.rain || s === W.thunderstorm;
const isSnowS = (s: number) => s === W.snow || s === W.snowstorm;

/** A short forecast line: "Storm rolling in", "Clearing soon", "Snow easing". */
export function forecastLine(now: number, next: number, inS: number): string {
  if (!Number.isFinite(inS) || next === now || inS > 240) return '';
  const soon = inS < 60 ? 'soon' : `in ${Math.max(1, Math.round(inS / 60))} min`;
  if (next === W.thunderstorm) return `Storm rolling in ${soon}`;
  if (next === W.snowstorm) return `Blizzard coming ${soon}`;
  if (next === W.sandstorm) return `Sandstorm coming ${soon}`;
  if (next === W.fog) return `Fog rolling in ${soon}`;
  if (isWetS(next) && !isWetS(now)) return `Rain ${soon}`;
  if (isSnowS(next) && !isSnowS(now)) return `Snow ${soon}`;
  if (isWetS(now) && !isWetS(next)) return `Clearing ${soon}`;
  if (isSnowS(now) && !isSnowS(next)) return `Snow easing ${soon}`;
  if (now === W.thunderstorm) return `Storm easing ${soon}`;
  if (next === W.clear) return `Clearing ${soon}`;
  return `${weatherName(next)} ${soon}`;
}
