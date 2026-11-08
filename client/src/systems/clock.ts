// The world clock (WP15, CR 011): the TS twin of server/pkg/weather/clock.go.
// Spec 8: day, night and weather are functions of world time and the seed,
// so they need no sync beyond the clock. World time = the zone's server
// clock (ClockSync) + the world's offset, which the zone announces in Event
// 500 (world_clock). The sky, the moon, rain, the chemistry wind and the
// fire simulation all read this one clock; the zone's demons and NPC
// schedules read its Go twin. Both replay
// server/pkg/weather/testdata/clock_vectors.json (clock.test.ts).

import { CHEM_STEP_HZ, CHEM_WIND_WINDOW_S, DAWN_HOUR, DAY_LENGTH_S, DUSK_HOUR, MOON_CYCLE_NIGHTS, WEATHER_STUB_RAIN_PCT, WEATHER_STUB_WINDOW_S } from '@lodestone/contracts';
import { weatherHash } from '../sim/weather';

const HOUR_S = DAY_LENGTH_S / 24;

/** The clock state the zone announced (Event 500); offline: zero offset. */
export const worldClockState = {
  offsetS: 0,
  seed: 20261108n,
  /** WorldSpec windDirection (degrees the wind blows from). */
  windDeg: 0,
  demonIntensity: 0.5,
  /** Rain override from the zone (null = seeded). */
  rain: null as boolean | null,
  /** Has a zone announced it (online)? */
  announced: false,
};

export function worldTime(serverTimeMs: number, offsetS = worldClockState.offsetS): number {
  return serverTimeMs / 1000 + offsetS;
}

function mod(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r;
}

export function timeOfDayS(t: number): number {
  return mod(t, DAY_LENGTH_S);
}

export function hourOf(t: number): number {
  return timeOfDayS(t) / HOUR_S;
}

export function dayOf(t: number): number {
  return Math.floor(t / DAY_LENGTH_S);
}

export function isNight(t: number): boolean {
  const h = hourOf(t);
  return h >= DUSK_HOUR || h < DAWN_HOUR;
}

export function nightIndex(t: number): number {
  return Math.floor((t - DAWN_HOUR * HOUR_S) / DAY_LENGTH_S);
}

export function moonOffset(seed: bigint): number {
  return weatherHash(BigInt.asUintN(64, seed) ^ 0x6d6f6f6en, 0x4d4f4f4e) % MOON_CYCLE_NIGHTS;
}

export function moonPhase(seed: bigint, n: number): number {
  return mod(n + moonOffset(seed), MOON_CYCLE_NIGHTS);
}

export const MOON_NAMES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];

export function moonIllumination(phase: number): number {
  return (1 - Math.cos((2 * Math.PI * phase) / MOON_CYCLE_NIGHTS)) / 2;
}

/** The chemistry step at world time t. */
export function chemStep(t: number): number {
  return Math.floor(t * CHEM_STEP_HZ);
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Rain at a chemistry step (whole-step windows, like the zone). */
export function rainingAtStep(seed: bigint, step: number): boolean {
  if (worldClockState.rain !== null) return worldClockState.rain;
  return seededRainAtStep(seed, step);
}

export function seededRainAtStep(seed: bigint, step: number): boolean {
  return weatherHash(seed, floorDiv(step, WEATHER_STUB_WINDOW_S * CHEM_STEP_HZ)) % 100 < WEATHER_STUB_RAIN_PCT;
}

export interface Wind {
  /** 45-degree sector the wind blows from (0 = north, -z). */
  sector: number;
  dx: number;
  dz: number;
  strength: number;
}

const TOWARD: [number, number][] = [
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** The chemistry wind at a step (server/pkg/weather WindAt). */
export function windAtStep(seed: bigint, prevailingDeg: number, step: number): Wind {
  const h = weatherHash(BigInt.asUintN(64, seed) ^ 0x77696e64n, floorDiv(step, CHEM_WIND_WINDOW_S * CHEM_STEP_HZ));
  const base = mod(Math.floor((prevailingDeg * 2 + 45) / 90), 8);
  const s = mod(base + (h % 3) - 1, 8);
  return { sector: s, dx: TOWARD[s][0], dz: TOWARD[s][1], strength: 1 + ((h >>> 8) % 3) };
}
