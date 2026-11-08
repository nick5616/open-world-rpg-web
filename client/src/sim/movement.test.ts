import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BASE_MOVE_SPEED,
  GROUND_ACCEL,
  GROUND_FRICTION,
  InputFlag as F,
  JUMP_FORCE,
  GRAVITY,
  SPRINT_MULTIPLIER,
  yawToU16,
} from '@lodestone/contracts';
import { FlatGround, PlaneGround, type GroundQuery } from './ground';
import {
  applyAirAccel,
  applyGroundAccel,
  applyGroundFriction,
  cloneMoveState,
  stepMovement,
  STEP_DT,
  wishDirFromFlags,
  type MoveInput,
  type MoveState,
} from './movement';
import { SCENARIOS, runScenario, type GoldenFile } from './golden/scenarios';
import { goldenPath } from './golden/io';

const flat = new FlatGround(0);
const at = (x = 0, y = 0, z = 0): MoveState => ({ pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, airJumps: 0 });
const inp = (flags: number, yawRad = 0): MoveInput => ({ flags, yaw: yawToU16(yawRad), pitch: 0 });
function run(s: MoveState, flags: number, steps: number, yawRad = 0, g: GroundQuery = flat) {
  for (let i = 0; i < steps; i++) s = stepMovement(s, inp(flags, yawRad), g);
  return s;
}
const hspeed = (s: MoveState) => Math.hypot(s.vel.x, s.vel.z);

describe('Source-style helpers (verbatim wizard-wars math)', () => {
  it('friction zeroes tiny speeds and uses STOP_SPEED as the floor', () => {
    const v = { x: 0.005, z: 0 };
    applyGroundFriction(v, 9, 2.5, STEP_DT);
    expect(v).toEqual({ x: 0, z: 0 });
    const w = { x: 1, z: 0 };
    applyGroundFriction(w, 9, 2.5, STEP_DT);
    expect(w.x).toBeCloseTo(1 - 2.5 * 9 * STEP_DT, 12);
  });
  it('ground accel never overshoots wish speed', () => {
    const v = { x: 7.9, z: 0 };
    applyGroundAccel(v, { x: 1, z: 0 }, 8, 5.5, STEP_DT);
    expect(v.x).toBe(8);
  });
  it('air accel caps the addSpeed check, not the rate (strafe gain)', () => {
    const v = { x: 10, z: 0 };
    applyAirAccel(v, { x: 0, z: 1 }, 8, 12, 1, STEP_DT);
    expect(v.x).toBe(10);
    expect(v.z).toBeCloseTo(1, 12); // min(12*dt*8 = 1.6, 1 - 0)
  });
});

describe('wish direction', () => {
  it('forward at yaw 0 is -Z, right is +X, diagonals are unit length', () => {
    const f = wishDirFromFlags(F.forward, 0);
    expect(f.z).toBe(-1);
    expect(Math.abs(f.x)).toBe(0);
    const r = wishDirFromFlags(F.right, 0);
    expect(r.x).toBeCloseTo(1, 15);
    const d = wishDirFromFlags(F.forward | F.right, 0.3);
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 15);
  });
  it('opposite keys cancel', () => {
    expect(wishDirFromFlags(F.forward | F.back, 1)).toEqual({ x: 0, z: 0 });
  });
});

describe('stepMovement', () => {
  it('is pure', () => {
    const s = at(1, 0, 1);
    const copy = cloneMoveState(s);
    stepMovement(s, inp(F.forward | F.jump), flat);
    expect(s).toEqual(copy);
  });

  it('walk and sprint converge to accel*wish/friction (wizard-wars top speeds)', () => {
    expect(hspeed(run(at(), F.forward, 600))).toBeCloseTo((GROUND_ACCEL * BASE_MOVE_SPEED) / GROUND_FRICTION, 6);
    expect(hspeed(run(at(), F.forward | F.sprint, 600))).toBeCloseTo((GROUND_ACCEL * BASE_MOVE_SPEED * SPRINT_MULTIPLIER) / GROUND_FRICTION, 6);
  });

  it('stops completely after release', () => {
    const s = run(run(at(), F.forward, 120), 0, 60);
    expect(hspeed(s)).toBe(0);
  });

  it('jumps to ~v^2/2g and lands back on the ground', () => {
    let s = stepMovement(at(), inp(F.jump | F.jump_edge), flat);
    expect(s.vel.y).toBe(JUMP_FORCE);
    let apex = 0;
    let steps = 1;
    while (s.pos.y > 0 && steps < 200) {
      s = stepMovement(s, inp(0), flat);
      apex = Math.max(apex, s.pos.y);
      steps++;
    }
    expect(apex).toBeGreaterThan((JUMP_FORCE * JUMP_FORCE) / (2 * -GRAVITY) - 0.05);
    expect(apex).toBeLessThan((JUMP_FORCE * JUMP_FORCE) / (2 * -GRAVITY) + 0.1);
    expect(s.pos.y).toBe(0);
    expect(s.vel.y).toBe(0);
    expect(s.airJumps).toBe(0);
  });

  it('double jump needs a fresh press (jump_edge); a held jump does not burn it', () => {
    let s = stepMovement(at(), inp(F.jump | F.jump_edge), flat);
    s = run(s, F.jump, 10); // holding space through the rise
    expect(s.airJumps).toBe(0);
    s = stepMovement(s, inp(F.jump | F.jump_edge), flat);
    expect(s.airJumps).toBe(1);
    expect(s.vel.y).toBe(JUMP_FORCE);
  });

  it('refuses a third jump (MAX_AIR_JUMPS = 1)', () => {
    let s = stepMovement(at(), inp(F.jump | F.jump_edge), flat);
    s = run(s, 0, 5);
    s = stepMovement(s, inp(F.jump_edge), flat);
    s = run(s, 0, 5);
    const vy = s.vel.y;
    s = stepMovement(s, inp(F.jump_edge), flat);
    expect(s.airJumps).toBe(1);
    expect(s.vel.y).toBeCloseTo(vy + GRAVITY * STEP_DT, 12);
  });

  it('held jump auto-hops on landing', () => {
    let s = run(at(), F.jump, 1);
    let jumps = 1;
    for (let i = 0; i < 200; i++) {
      const before = s.vel.y;
      s = stepMovement(s, inp(F.jump), flat);
      if (s.vel.y === JUMP_FORCE && before !== JUMP_FORCE) jumps++;
    }
    expect(jumps).toBeGreaterThan(3);
  });

  it('moves with the QUANTIZED yaw: inputs differing below one u16 LSB step identically', () => {
    const lsb = (Math.PI * 2) / 65536;
    const center = (10430 / 65536) * Math.PI * 2;
    const a = stepMovement(at(), inp(F.forward, center - lsb * 0.3), flat);
    const b = stepMovement(at(), inp(F.forward, center + lsb * 0.3), flat);
    expect(b).toEqual(a);
  });

  it('stays grounded walking down a slope (GROUND_SNAP_M) and follows it up', () => {
    const plane = new PlaneGround(0, 0.15, 0);
    // yaw pi/2 faces -X: downhill on this plane.
    let s = at(100, plane.heightAt(100, 0), 0);
    for (let i = 0; i < 120; i++) {
      s = stepMovement(s, inp(F.forward | F.sprint, Math.PI / 2), plane);
      expect(s.pos.y).toBe(plane.heightAt(s.pos.x, s.pos.z));
    }
    s = run(s, F.back | F.sprint, 120, Math.PI / 2, plane);
    expect(s.pos.y).toBe(plane.heightAt(s.pos.x, s.pos.z));
  });
});

describe('golden trajectories', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: stepMovement reproduces the committed golden bit-exactly`, () => {
      const file = JSON.parse(readFileSync(goldenPath(sc.name), 'utf8')) as GoldenFile;
      const fresh = runScenario(sc);
      expect(file.frames).toEqual(fresh.frames);
      expect(file.initial).toEqual(fresh.initial);
      for (let i = 0; i < fresh.states.length; i++) {
        // toEqual on numbers is Object.is: any last-bit change fails, by design.
        if (file.states[i].some((v, k) => v !== fresh.states[i][k])) {
          throw new Error(`step ${i + 1} differs: golden ${JSON.stringify(file.states[i])} vs now ${JSON.stringify(fresh.states[i])}. If the change is intended, run \`npm run golden -w client\` and update the Go port in the same change.`);
        }
      }
    });
  }
});
