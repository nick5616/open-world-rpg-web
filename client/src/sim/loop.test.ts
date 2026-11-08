import { describe, expect, it } from 'vitest';
import { InputFlag } from '@lodestone/contracts';
import { advanceFixedStep, MAX_MOVE_SUBSTEPS } from './fixedStep';
import { JumpEdgeLatch, makeMoveInput, NO_BUTTONS } from './inputFrame';
import { LocalSim } from './localSim';
import { FlatGround } from './ground';
import { newMoveState, STEP_DT } from './movement';
import { stepFly } from './fly';

function stepsOver(seconds: number, hz: number) {
  let accum = 0;
  let total = 0;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    const r = advanceFixedStep(accum, 1 / hz, STEP_DT);
    accum = r.accum;
    total += r.steps;
    expect(r.alpha).toBeGreaterThanOrEqual(0);
    expect(r.alpha).toBeLessThan(1);
  }
  return total;
}

describe('advanceFixedStep', () => {
  it('runs 60 steps per second at any display rate', () => {
    for (const hz of [30, 60, 75, 120, 144, 240]) expect(Math.abs(stepsOver(10, hz) - 600)).toBeLessThanOrEqual(1);
  });
  it('60 Hz display: exactly one step every frame (no skip/double from float drift)', () => {
    let accum = 0;
    for (let i = 0; i < 6000; i++) {
      const r = advanceFixedStep(accum, 1 / 60, STEP_DT);
      accum = r.accum;
      expect(r.steps).toBe(1);
    }
  });
  it('caps the backlog after a stall', () => {
    const r = advanceFixedStep(0, 5, STEP_DT);
    expect(r.steps).toBeLessThanOrEqual(MAX_MOVE_SUBSTEPS);
    expect(r.accum).toBeLessThan(STEP_DT);
  });
});

describe('JumpEdgeLatch', () => {
  it('fires once per press, even if released before the next step', () => {
    const l = new JumpEdgeLatch();
    l.sample(true);
    l.sample(false); // tap shorter than a step at 144 Hz
    expect(l.consume()).toBe(true);
    expect(l.consume()).toBe(false);
    l.sample(true);
    l.sample(true);
    expect(l.consume()).toBe(true);
    l.sample(true);
    expect(l.consume()).toBe(false); // still held: no new edge
  });
});

describe('makeMoveInput', () => {
  it('quantizes look and sets flags', () => {
    const m = makeMoveInput({ ...NO_BUTTONS, forward: true, sprint: true }, true, Math.PI, 0);
    expect(m.flags).toBe(InputFlag.forward | InputFlag.sprint | InputFlag.jump_edge);
    expect(m.yaw).toBe(32768);
    expect(m.pitch).toBe(0);
  });
});

describe('LocalSim (render loop driver)', () => {
  const ground = new FlatGround(0);
  it('render pose advances smoothly at 144 Hz (interpolated, never backwards, no frozen frames)', () => {
    const sim = new LocalSim(ground, { x: 0, y: 0, z: 0 });
    const held = { ...NO_BUTTONS, forward: true };
    // reach top speed first
    for (let i = 0; i < 144 * 2; i++) sim.frame(1 / 144, { held, yaw: 0, pitch: 0, fly: false });
    let prevZ = sim.frame(1 / 144, { held, yaw: 0, pitch: 0, fly: false }).z;
    const deltas: number[] = [];
    for (let i = 0; i < 144; i++) {
      const z = sim.frame(1 / 144, { held, yaw: 0, pitch: 0, fly: false }).z;
      deltas.push(prevZ - z);
      prevZ = z;
    }
    const expected = 4.889 / 144;
    for (const d of deltas) {
      expect(d).toBeGreaterThan(expected * 0.9);
      expect(d).toBeLessThan(expected * 1.1);
    }
  });

  it('a jump tap shorter than one step still double jumps', () => {
    const sim = new LocalSim(ground, { x: 0, y: 0, z: 0 });
    const f = (jump: boolean) => sim.frame(1 / 240, { held: { ...NO_BUTTONS, jump }, yaw: 0, pitch: 0, fly: false });
    f(true);
    for (let i = 0; i < 8; i++) f(true);
    for (let i = 0; i < 40; i++) f(false);
    expect(sim.state.airJumps).toBe(0);
    f(true); // 1/240 s tap: shorter than a 1/60 step
    f(false);
    for (let i = 0; i < 8; i++) f(false);
    expect(sim.state.airJumps).toBe(1);
  });

  it('teleport lands on the ground and resets velocity; seq counts steps', () => {
    const sim = new LocalSim(new FlatGround(12), { x: 0, y: 12, z: 0 });
    const steps: number[] = [];
    sim.onStep = (r) => steps.push(r.seq);
    sim.frame(1 / 30, { held: { ...NO_BUTTONS, forward: true }, yaw: 0, pitch: 0, fly: false });
    sim.teleport({ x: 500, z: -40 });
    expect(sim.state.pos).toEqual({ x: 500, y: 12, z: -40 });
    expect(sim.state.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(steps).toEqual([1, 2]);
  });
});

describe('stepFly', () => {
  it('flies along the view direction and ignores gravity', () => {
    const s0 = newMoveState({ x: 0, y: 50, z: 0 });
    const up = stepFly(s0, makeMoveInput({ ...NO_BUTTONS, forward: true }, false, 0, Math.PI / 4), 1);
    expect(up.pos.z).toBeLessThan(0);
    expect(up.pos.y).toBeGreaterThan(50);
    const hover = stepFly(s0, makeMoveInput(NO_BUTTONS, false, 0, 0), 1);
    expect(hover.pos).toEqual(s0.pos);
  });
});
