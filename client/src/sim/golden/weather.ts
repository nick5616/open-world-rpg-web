// CR 030 (playtest 2 weather) goldens: the movement step under a weather
// field (snow slows walking, rain from the field makes climbing slippery, a
// gale pushes a glider downwind). The field here is synthetic bands along x
// (the real one is server/pkg/weather Field = systems/weather/weather.ts
// WeatherField, pinned by their own vectors); the Go replay
// (server/pkg/movement/weather_golden_test.go) builds the same grounds and
// bands. Rows carry the whole carried state, like the ride goldens.

import { InputFlag as F, yawToU16 } from '@lodestone/contracts';
import type { GroundQuery } from '../ground';
import { newMoveState, stepMovement, STEP_DT, type MoveField, type MoveState, type MoveWeather, type StepEnv } from '../movement';
import type { RideRow } from './ride';

export interface WeatherBand {
  /** The band covers x >= fromX (until the next band). */
  fromX: number;
  rain: boolean;
  speedMult: number;
  pushX: number;
  pushZ: number;
}

export type WeatherGroundSpec = { kind: 'flat'; height: number } | { kind: 'mesa'; top: number; edgeX: number } | { kind: 'wall'; edgeX: number; grade: number; top: number };

export interface WeatherGolden {
  format: 'lodestone-movement-golden';
  version: 6;
  doc: string;
  scenario: string;
  dt: number;
  ground: WeatherGroundSpec;
  bands: WeatherBand[];
  initial: RideRow;
  frames: [number, number, number, number, number][];
  states: RideRow[];
}

const D = 0.7071067811865476;

export const WEATHER_SCENARIOS: { name: string; doc: string; ground: WeatherGroundSpec; bands: WeatherBand[]; start: { x: number; z: number } }[] = [
  {
    name: 'weather_snow_walk',
    doc: 'Walk and sprint east from calm ground into snow (x0.9) then a snowstorm (x0.8), jump in the storm, stop.',
    ground: { kind: 'flat', height: 0 },
    bands: [
      { fromX: -1e9, rain: false, speedMult: 1, pushX: 0, pushZ: 0 },
      { fromX: 1020, rain: false, speedMult: 0.9, pushX: 0, pushZ: 0 },
      { fromX: 1060, rain: false, speedMult: 0.8, pushX: 0, pushZ: 0 },
    ],
    start: { x: 1000, z: 1000 },
  },
  {
    name: 'weather_gale_glide',
    doc: 'Sprint off a 60 m mesa, open the glider, glide east through a southerly gale (push +z 2.5 m/s), then a diagonal one, steer, close and land.',
    ground: { kind: 'mesa', top: 60, edgeX: 1000 },
    bands: [
      { fromX: -1e9, rain: false, speedMult: 1, pushX: 0, pushZ: 0 },
      { fromX: 1005, rain: false, speedMult: 1, pushX: 0, pushZ: 2.5 },
      { fromX: 1040, rain: false, speedMult: 1, pushX: -1.25 * D, pushZ: 1.25 * D },
    ],
    start: { x: 980, z: 1000 },
  },
  {
    name: 'weather_storm_climb',
    doc: 'Climb a 71.6 degree wall where the field says it rains (half speed, slips), let go, walk off into the calm.',
    ground: { kind: 'wall', edgeX: 1000, grade: 3, top: 40 },
    bands: [
      { fromX: -1e9, rain: true, speedMult: 1, pushX: 1.25, pushZ: 0 },
      { fromX: 1002, rain: false, speedMult: 1, pushX: 0, pushZ: 0 },
    ],
    start: { x: 1001, z: 1000 },
  },
];

export function weatherGround(g: WeatherGroundSpec): GroundQuery {
  switch (g.kind) {
    case 'flat':
      return { heightAt: () => g.height };
    case 'mesa':
      return { heightAt: (x: number) => (x < g.edgeX ? g.top : 0) };
    case 'wall':
      return { heightAt: (x: number) => (x >= g.edgeX ? 0 : Math.min(g.top, (g.edgeX - x) * g.grade)) };
  }
}

/** The bands as a MoveField (Go twin: bandField). */
export function bandField(bands: WeatherBand[]): MoveField {
  return {
    moveWeatherAt(x: number): MoveWeather {
      let b = bands[0];
      for (const c of bands) if (x >= c.fromX) b = c;
      return { rain: b.rain, speedMult: b.speedMult, pushX: b.pushX, pushZ: b.pushZ };
    },
  };
}

const row = (s: MoveState): RideRow => [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.airJumps, s.mode, s.stamina, s.timer, s.lunge, s.flags];

export function weatherRun(name: string): WeatherGolden {
  const sc = WEATHER_SCENARIOS.find((s) => s.name === name)!;
  const ground = weatherGround(sc.ground);
  const env: StepEnv = { raining: false, updraft: null, weather: bandField(sc.bands) };
  let s = newMoveState({ x: sc.start.x, y: ground.heightAt(sc.start.x, sc.start.z), z: sc.start.z });
  const initial = row(s);
  const frames: [number, number, number, number, number][] = [];
  const states: RideRow[] = [];
  let seq = 0;
  const push = (n: number, flags: number, yaw: number) => {
    for (let i = 0; i < n; i++) {
      const f: [number, number, number, number, number] = [++seq, flags, yawToU16(yaw), 0, 0];
      frames.push(f);
      s = stepMovement(s, { flags, yaw: f[2], pitch: 0, castSlot: 0 }, ground, STEP_DT, env);
      states.push(row(s));
    }
  };
  const EAST = -Math.PI / 2;
  const WEST = Math.PI / 2;
  const fwd = F.forward;
  // Scripts read the state (walk until past a band), but the file stores the
  // frames they produced: the replay just applies them.
  const until = (cond: () => boolean, flags: number, yaw: number) => {
    for (let g = 0; g < 2000 && !cond(); g++) push(1, flags, yaw);
  };
  if (name === 'weather_snow_walk') {
    push(10, 0, EAST);
    until(() => s.pos.x > 1012, fwd, EAST);
    until(() => s.pos.x > 1072, fwd | F.sprint, EAST); // calm -> snow -> snowstorm
    push(1, fwd | F.jump | F.jump_edge, EAST);
    push(60, fwd, EAST);
    push(40, 0, EAST);
  } else if (name === 'weather_gale_glide') {
    until(() => s.pos.x > 999, fwd | F.sprint, EAST);
    push(1, fwd | F.jump | F.jump_edge, EAST); // off the edge
    push(15, fwd, EAST);
    push(1, fwd | F.jump_edge, EAST); // double jump
    until(() => s.vel.y < -1, fwd, EAST);
    push(1, fwd | F.jump_edge, EAST); // open the glider
    push(180, fwd, EAST); // into the southerly gale
    push(120, fwd | F.left, EAST);
    push(120, 0, EAST); // no input: the wind alone
    push(1, F.glide_toggle, EAST);
    push(200, 0, EAST);
  } else {
    push(10, 0, WEST);
    push(600, fwd, WEST);
    push(60, 0, WEST);
    push(1, F.back | F.jump | F.jump_edge, WEST); // kick off
    push(120, F.back, WEST);
  }
  return { format: 'lodestone-movement-golden', version: 6, doc: sc.doc, scenario: name, dt: STEP_DT, ground: sc.ground, bands: sc.bands, initial, frames, states };
}

export function weatherSummary(g: WeatherGolden): string {
  const modes = new Set(g.states.map((r) => r[7]));
  const last = g.states[g.states.length - 1];
  return `${g.states.length} steps, modes ${[...modes].join(',')}, end (${last[0].toFixed(2)}, ${last[1].toFixed(2)}, ${last[2].toFixed(2)})`;
}
