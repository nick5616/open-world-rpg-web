// CR 030: the movement step under weather (snow, rain from the field, a
// gale under the glider). The goldens are cross-language: the Go replay is
// server/pkg/movement/weather_golden_test.go.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InputFlag, SNOWSTORM_MOVE_MULT, yawToU16 } from '@lodestone/contracts';
import { goldenPath } from './golden/io';
import { bandField, WEATHER_SCENARIOS, weatherRun, type WeatherGolden } from './golden/weather';
import { newMoveState, stepMovement, STEP_DT, type StepEnv } from './movement';
import { FlatGround } from './ground';

describe('weather goldens', () => {
  for (const sc of WEATHER_SCENARIOS) {
    it(`${sc.name} is unchanged`, () => {
      const file = JSON.parse(readFileSync(goldenPath(`pt2_${sc.name}`), 'utf8')) as WeatherGolden;
      const now = weatherRun(sc.name);
      expect(now.frames).toEqual(file.frames);
      for (let i = 0; i < file.states.length; i++) {
        if (JSON.stringify(file.states[i]) !== JSON.stringify(now.states[i])) throw new Error(`step ${i + 1} differs (npm run golden -w client, then the Go replay)`);
      }
    });
  }

  it('each scenario shows its weather', () => {
    const glide = weatherRun('weather_gale_glide');
    // A southerly gale with no steering pushes the glider to +z at the push speed.
    expect(glide.states.some((r) => r[7] === 3 && Math.abs(r[5] - 2.5) < 1e-9)).toBe(true);
    const climb = weatherRun('weather_storm_climb');
    expect(climb.states.filter((r) => r[7] === 2).length).toBeGreaterThan(300);
  });
});

describe('weather in the step', () => {
  const ground = new FlatGround(0);
  const run = (env: StepEnv, n: number) => {
    let s = newMoveState({ x: 100, y: 0, z: 100 });
    for (let i = 0; i < n; i++) s = stepMovement(s, { flags: InputFlag.forward, yaw: yawToU16(-Math.PI / 2), pitch: 0, castSlot: 0 }, ground, STEP_DT, env);
    return s;
  };

  it('a calm field is the old step; a snowstorm slows walking by its multiplier', () => {
    const calm = run({ raining: false, updraft: null }, 240);
    expect(run({ raining: false, updraft: null, weather: bandField([{ fromX: -1e9, rain: false, speedMult: 1, pushX: 0, pushZ: 0 }]) }, 240)).toEqual(calm);
    const snow = run({ raining: false, updraft: null, weather: bandField([{ fromX: -1e9, rain: false, speedMult: SNOWSTORM_MOVE_MULT, pushX: 0, pushZ: 0 }]) }, 240);
    expect(Math.hypot(snow.vel.x, snow.vel.z) / Math.hypot(calm.vel.x, calm.vel.z)).toBeCloseTo(SNOWSTORM_MOVE_MULT, 6);
  });
});
