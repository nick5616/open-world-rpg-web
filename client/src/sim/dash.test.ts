// WP13 dodge / dash rules in the shared step, plus the cross-language golden
// (the Go replay is server/pkg/movement/dash_golden_test.go).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMBAT, DASH_EXIT_SPEED, DODGE_DASH_STEPS, DODGE_IFRAME_STEPS, DODGE_SPEED, DODGE_STAMINA, InputFlag as F, STAMINA_FINE_PER_POINT, yawToU16 } from '@lodestone/contracts';
import { FlatGround } from './ground';
import { MoveFlag, newMoveState, stepMovement, type MoveState } from './movement';
import { invulnerable } from './dash';
import { goldenPath } from './golden/io';
import { runWp13, WP13_SCENARIOS, type Wp13Golden } from './golden/wp13';
import { fromSelf, packMoveExt } from './moveWire';

const g = new FlatGround(0);
const step = (s: MoveState, flags: number, castSlot = 0, yaw = 0) => stepMovement(s, { flags, yaw: yawToU16(yaw), pitch: 0, castSlot }, g);

describe('dodge', () => {
  it('gives exactly DODGE_IFRAME_STEPS invulnerable steps (150 ms) and costs DODGE_STAMINA', () => {
    let s = newMoveState({ x: 100, y: 0, z: 100 });
    s = step(s, F.dodge);
    let inv = invulnerable(s) ? 1 : 0;
    for (let i = 0; i < 30; i++) {
      s = step(s, 0);
      if (invulnerable(s)) inv++;
    }
    expect(inv).toBe(DODGE_IFRAME_STEPS);
    expect((DODGE_IFRAME_STEPS * 1000) / 60).toBe(150);
    // Regen waits STAMINA_REGEN_DELAY_S after the dodge, so the cost is still visible.
    expect(s.stamina).toBe(s.staminaMax - Math.round(DODGE_STAMINA * STAMINA_FINE_PER_POINT));
  });

  it('goes backwards with no key held, covers speed * steps, then stops crisply', () => {
    let s = newMoveState({ x: 100, y: 0, z: 100 });
    s = step(s, F.dodge);
    for (let i = 1; i < DODGE_DASH_STEPS; i++) s = step(s, 0);
    // yaw 0 faces -Z, so back is +Z
    expect(s.pos.z - 100).toBeCloseTo((DODGE_SPEED * DODGE_DASH_STEPS) / 60, 9);
    s = step(s, 0); // the exit clamp
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeLessThanOrEqual(DASH_EXIT_SPEED + 1e-9);
  });

  it('cannot start while exhausted or mid-dash; mobility dashes cost no stamina', () => {
    let s: MoveState = { ...newMoveState({ x: 0, y: 0, z: 0 }), stamina: 0, flags: MoveFlag.exhausted };
    s = step(s, F.dodge);
    expect(s.dash).toBe(0);
    s = step(newMoveState({ x: 0, y: 0, z: 0 }), F.dodge);
    const d1 = s.dash ?? 0;
    s = step(s, F.dodge);
    expect(s.dash).toBe(d1 - 1);
    const d = COMBAT.dashes[0];
    const fresh = newMoveState({ x: 0, y: 0, z: 0 });
    s = step(fresh, F.dodge, d.id);
    expect(s.stamina).toBe(fresh.stamina);
    expect(s.dash).toBe(d.steps);
  });

  it('round-trips the dash counters through SelfState.moveExt', () => {
    const s = step(newMoveState({ x: 0, y: 0, z: 0 }), F.dodge);
    const back = fromSelf({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, staminaMax: 1000, mode: 0, airJumps: 0, flags: 0, moveExt: packMoveExt(s) });
    expect(back.dash).toBe(s.dash);
    expect(back.iframes).toBe(s.iframes);
  });
});

describe('WP13 dash goldens', () => {
  for (const sc of WP13_SCENARIOS) {
    it(`${sc.name}: stepMovement reproduces the committed golden bit-exactly`, () => {
      const file = JSON.parse(readFileSync(goldenPath(`wp13_${sc.name}`), 'utf8')) as Wp13Golden;
      const fresh = runWp13(sc.name);
      expect(fresh.frames).toEqual(file.frames);
      for (let i = 0; i < file.states.length; i++) {
        if (JSON.stringify(file.states[i]) !== JSON.stringify(fresh.states[i])) {
          throw new Error(`step ${i + 1} differs: golden ${JSON.stringify(file.states[i])} vs now ${JSON.stringify(fresh.states[i])} (npm run golden -w client, then update the Go port)`);
        }
      }
    });
  }
});
