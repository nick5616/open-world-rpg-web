// Dynamic weather (playtest 2, CR 030): the TS twin of
// server/pkg/weather/states.go, line for line. Weather is a pure function of
// the seed, the chemistry step and the weather cell, so every client and the
// zone agree without anything on the wire (spec 8). Both replay
// server/pkg/weather/testdata/weather_vectors.json (weather.test.ts).
//
// The world is cut into WEATHER_CELL_M cells (8 x 8); each has a climate
// voted from its biomes. Cells group into fronts (2 x 2 = a region); a front
// keeps a severity roll for WEATHER_WINDOW_S from a seeded phase, nudged per
// cell, and the cell's climate table turns it into a state, fair to foul.

import {
  CHEM_STEP_HZ,
  LIGHTNING_SLOT_PCT,
  LIGHTNING_SLOT_S,
  LIGHTNING_TALL_PROBE_M,
  SNOW_MOVE_MULT,
  SNOWSTORM_MOVE_MULT,
  WEATHER_CELL_M,
  WEATHER_FRONT_CELLS,
  WEATHER_JITTER,
  WEATHER_WINDOW_S,
  WIND_ARROW_ACCEL,
  WIND_GLIDE_PUSH_MS,
  WORLD_SIZE_M,
} from '@lodestone/contracts';
import { weatherHash } from '../../sim/weather';
import { hourOf, windAtStep, type Wind } from '../clock';
import type { MoveField, MoveWeather } from '../../sim/movement';

export const W = {
  clear: 0,
  cloudy: 1,
  windy: 2,
  fog: 3,
  drizzle: 4,
  rain: 5,
  thunderstorm: 6,
  snow: 7,
  snowstorm: 8,
  heat_haze: 9,
  sandstorm: 10,
} as const;
export const NUM_STATES = 11;
export type WeatherKey = keyof typeof W;
export const STATE_KEYS: WeatherKey[] = ['clear', 'cloudy', 'windy', 'fog', 'drizzle', 'rain', 'thunderstorm', 'snow', 'snowstorm', 'heat_haze', 'sandstorm'];

export function stateByKey(key: string): number {
  return STATE_KEYS.indexOf(key as WeatherKey);
}

export const CLIMATE = { temperate: 0, wet: 1, highland: 2, cold: 3, arid: 4 } as const;
export const NUM_CLIMATES = 5;
export const CLIMATE_KEYS = ['temperate', 'wet', 'highland', 'cold', 'arid'] as const;

/** Atlas biome ids (0 meadow .. 5 wetland) to climates. */
const BIOME_CLIMATE = [CLIMATE.temperate, CLIMATE.temperate, CLIMATE.highland, CLIMATE.cold, CLIMATE.arid, CLIMATE.wet];

/** Each climate's states, fair to foul, with percent shares (sum 100). */
const TABLES: [number, number][][] = [
  [[W.clear, 34], [W.cloudy, 18], [W.windy, 8], [W.fog, 7], [W.drizzle, 11], [W.rain, 13], [W.thunderstorm, 9]],
  [[W.clear, 18], [W.cloudy, 16], [W.windy, 4], [W.fog, 18], [W.drizzle, 16], [W.rain, 17], [W.thunderstorm, 11]],
  [[W.clear, 28], [W.cloudy, 18], [W.windy, 17], [W.fog, 10], [W.drizzle, 6], [W.rain, 11], [W.thunderstorm, 10]],
  [[W.clear, 26], [W.cloudy, 18], [W.windy, 10], [W.fog, 8], [W.snow, 26], [W.snowstorm, 12]],
  [[W.clear, 32], [W.heat_haze, 24], [W.cloudy, 8], [W.windy, 14], [W.sandstorm, 14], [W.rain, 4], [W.thunderstorm, 4]],
];

export const CELLS_N = WORLD_SIZE_M / WEATHER_CELL_M;
export const FRONTS_N = CELLS_N / WEATHER_FRONT_CELLS;
export const WINDOW_STEPS = WEATHER_WINDOW_S * CHEM_STEP_HZ;
export const SLOT_STEPS = LIGHTNING_SLOT_S * CHEM_STEP_HZ;

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** A world's climate per weather cell (row-major, cz * CELLS_N + cx). */
export class Climate {
  readonly cells = new Uint8Array(CELLS_N * CELLS_N);

  static uniform(c: number): Climate {
    const cl = new Climate();
    cl.cells.fill(c);
    return cl;
  }

  /** Go NewClimate: a 4 x 4 vote per cell over the atlas biome grid (nearest node); 4+ snowpeak = cold, 5+ badlands = arid. */
  static fromBiomes(gridN: number, macroRes: number, biome: ArrayLike<number>): Climate {
    const cl = new Climate();
    if (gridN <= 0 || macroRes <= 0 || biome.length < gridN * gridN) return cl;
    const cell = WEATHER_CELL_M;
    const half = Math.floor(macroRes / 2);
    for (let cz = 0; cz < CELLS_N; cz++) {
      for (let cx = 0; cx < CELLS_N; cx++) {
        const counts = [0, 0, 0, 0, 0, 0];
        for (let sj = 0; sj < 4; sj++) {
          for (let si = 0; si < 4; si++) {
            const x = cx * cell + ((2 * si + 1) * cell) / 8;
            const z = cz * cell + ((2 * sj + 1) * cell) / 8;
            const i = Math.min(gridN - 1, Math.floor((x + half) / macroRes));
            const j = Math.min(gridN - 1, Math.floor((z + half) / macroRes));
            let b = biome[j * gridN + i];
            if (b > 5) b = 0;
            counts[b]++;
          }
        }
        let best = 0;
        for (let b = 1; b < 6; b++) if (counts[b] > counts[best]) best = b;
        // Peaks and badlands are small: a quarter of snow makes a cold cell, nearly a third of badlands an arid one.
        if (counts[3] >= 4) best = 3;
        else if (counts[4] >= 5) best = 4;
        cl.cells[cz * CELLS_N + cx] = BIOME_CLIMATE[best];
      }
    }
    return cl;
  }

  at(cx: number, cz: number): number {
    return this.cells[cz * CELLS_N + cx];
  }
}

function clampCell(v: number): number {
  if (!(v > 0)) return 0;
  if (v > CELLS_N - 1) return CELLS_N - 1;
  return v;
}

/** The weather cell under (x, z), clamped into the world. */
export function cellOf(x: number, z: number): [number, number] {
  return [clampCell(Math.floor(x / WEATHER_CELL_M)), clampCell(Math.floor(z / WEATHER_CELL_M))];
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function mix(h: number, v: number): number {
  return fmix((h ^ Math.imul(v >>> 0, 0xcc9e2d51)) >>> 0);
}

function frontIndex(cx: number, cz: number): number {
  return Math.floor(cz / WEATHER_FRONT_CELLS) * FRONTS_N + Math.floor(cx / WEATHER_FRONT_CELLS);
}

const salt = (seed: bigint, s: bigint) => BigInt.asUintN(64, seed) ^ s;

export function frontPhase(seed: bigint, cx: number, cz: number): number {
  return mix(weatherHash(salt(seed, 0x70686173n), 0x7068), frontIndex(cx, cz)) % WINDOW_STEPS;
}

export function windowAt(seed: bigint, cx: number, cz: number, k: number): number {
  return floorDiv(k + frontPhase(seed, cx, cz), WINDOW_STEPS);
}

export function windowStart(seed: bigint, cx: number, cz: number, w: number): number {
  return w * WINDOW_STEPS - frontPhase(seed, cx, cz);
}

export function roll(seed: bigint, cx: number, cz: number, w: number): number {
  const r = mix(weatherHash(salt(seed, 0x726f6c6cn), w), frontIndex(cx, cz)) % 100;
  const j = (mix(mix(weatherHash(salt(seed, 0x6a697474n), w), cx), cz) % (2 * WEATHER_JITTER + 1)) - WEATHER_JITTER;
  return Math.min(99, Math.max(0, r + j));
}

export function daytime(k: number): boolean {
  const h = hourOf(k / CHEM_STEP_HZ);
  return h >= 9 && h < 18;
}

export function stateFor(climate: number, r: number, k: number): number {
  const t = TABLES[climate] ?? TABLES[CLIMATE.temperate];
  let acc = 0;
  for (const [state, pct] of t) {
    acc += pct;
    if (r < acc) return state === W.heat_haze && !daytime(k) ? W.clear : state;
  }
  return W.clear;
}

export function stateAtStep(seed: bigint, c: Climate, cx: number, cz: number, k: number): number {
  return stateFor(c.at(cx, cz), roll(seed, cx, cz, windowAt(seed, cx, cz, k)), k);
}

/** The state cell (cx, cz) turns to at the end of its window, and the step it does. */
export function nextState(seed: bigint, c: Climate, cx: number, cz: number, k: number): { state: number; at: number } {
  const w = windowAt(seed, cx, cz, k) + 1;
  const at = windowStart(seed, cx, cz, w);
  return { state: stateFor(c.at(cx, cz), roll(seed, cx, cz, w), at), at };
}

export const isWet = (s: number) => s === W.drizzle || s === W.rain || s === W.thunderstorm;
export const isSnowing = (s: number) => s === W.snow || s === W.snowstorm;
export const isMurky = (s: number) => s === W.fog || s === W.snowstorm || s === W.sandstorm;

const WIND_LEVELS = [0, 1, 2, 0, 1, 1, 2, 1, 3, 0, 3];

export function windLevel(s: number): number {
  return WIND_LEVELS[s] ?? 0;
}

export function moveSpeedMult(s: number): number {
  return s === W.snow ? SNOW_MOVE_MULT : s === W.snowstorm ? SNOWSTORM_MOVE_MULT : 1;
}

const DIAG = 0.7071067811865476;

function windUnit(w: Wind): [number, number] {
  return w.dx !== 0 && w.dz !== 0 ? [w.dx * DIAG, w.dz * DIAG] : [w.dx, w.dz];
}

export function glidePush(s: number, w: Wind): [number, number] {
  const p = WIND_GLIDE_PUSH_MS * Math.max(0, windLevel(s) - 1);
  const [ux, uz] = windUnit(w);
  return [p * ux, p * uz];
}

export function arrowAccel(s: number, w: Wind): [number, number] {
  const a = WIND_ARROW_ACCEL * windLevel(s);
  const [ux, uz] = windUnit(w);
  return [a * ux, a * uz];
}

/** Every cell's weather at one chemistry step (Go weather.Field): the movement step's MoveField. */
export class WeatherField implements MoveField {
  readonly states = new Uint8Array(CELLS_N * CELLS_N);
  readonly moves: MoveWeather[] = [];
  readonly wind: Wind;

  constructor(
    seed: bigint,
    c: Climate,
    prevailingDeg: number,
    readonly step: number,
    override = -1,
  ) {
    this.wind = windAtStep(seed, prevailingDeg, step);
    for (let cz = 0; cz < CELLS_N; cz++) {
      for (let cx = 0; cx < CELLS_N; cx++) {
        const s = override >= 0 && override < NUM_STATES ? override : stateAtStep(seed, c, cx, cz, step);
        const i = cz * CELLS_N + cx;
        this.states[i] = s;
        const [px, pz] = glidePush(s, this.wind);
        this.moves[i] = { rain: isWet(s), speedMult: moveSpeedMult(s), pushX: px, pushZ: pz };
      }
    }
  }

  stateAt(x: number, z: number): number {
    const [cx, cz] = cellOf(x, z);
    return this.states[cz * CELLS_N + cx];
  }

  moveWeatherAt(x: number, z: number): MoveWeather {
    const [cx, cz] = cellOf(x, z);
    return this.moves[cz * CELLS_N + cx];
  }
}

// ---- lightning ----

export interface Strike {
  id: number;
  step: number;
  x: number;
  z: number;
  cx: number;
  cz: number;
}

export function strikeInSlot(seed: bigint, c: Climate, cx: number, cz: number, slot: number, override = -1): Strike | null {
  const k0 = slot * SLOT_STEPS;
  const s = override >= 0 && override < NUM_STATES ? override : stateAtStep(seed, c, cx, cz, k0);
  if (s !== W.thunderstorm) return null;
  const h = mix(mix(weatherHash(salt(seed, 0x626f6c74n), slot), cx), cz);
  if (h % 100 >= LIGHTNING_SLOT_PCT) return null;
  const span = WEATHER_CELL_M * 100;
  const off = (h >>> 8) % SLOT_STEPS;
  const x = cx * WEATHER_CELL_M + (mix(h, 0x78) % span) / 100;
  const z = cz * WEATHER_CELL_M + (mix(h, 0x7a) % span) / 100;
  const id = (Math.imul(slot >>> 0, 64) + cz * CELLS_N + cx) >>> 0;
  return { id, step: k0 + off, x, z, cx, cz };
}

/** Every seeded strike with k0 <= step < k1, in step order, then cell order. */
export function strikesBetween(seed: bigint, c: Climate, k0: number, k1: number, override: number, fn: (s: Strike) => void): void {
  if (k1 <= k0) return;
  for (let slot = floorDiv(k0, SLOT_STEPS); slot * SLOT_STEPS < k1; slot++) {
    const buf: Strike[] = [];
    for (let cz = 0; cz < CELLS_N; cz++) {
      for (let cx = 0; cx < CELLS_N; cx++) {
        const st = strikeInSlot(seed, c, cx, cz, slot, override);
        if (st && st.step >= k0 && st.step < k1) buf.push(st);
      }
    }
    for (let i = 1; i < buf.length; i++) {
      for (let j = i; j > 0 && buf[j].step < buf[j - 1].step; j--) [buf[j], buf[j - 1]] = [buf[j - 1], buf[j]];
    }
    for (const st of buf) fn(st);
  }
}

/** The highest of nine grid points around (x, z) (Go TallSpot): lightning finds peaks, towers and roofs. */
export function tallSpot(height: (x: number, z: number) => number, x: number, z: number): [number, number] {
  const d = LIGHTNING_TALL_PROBE_M;
  let bx = x;
  let bz = z;
  let bh = -Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const px = Math.min(WORLD_SIZE_M - 1, Math.max(0, x + i * d));
      const pz = Math.min(WORLD_SIZE_M - 1, Math.max(0, z + j * d));
      const h = height(px, pz);
      if (h > bh) {
        bx = px;
        bz = pz;
        bh = h;
      }
    }
  }
  return [bx, bz];
}
