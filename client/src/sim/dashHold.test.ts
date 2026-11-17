// CR 021: the dash overhaul in the shared step (held dashes, jet flight, the
// per-element kinds). The cross-language golden (movement_wp13_*.json,
// replayed by server/pkg/movement/dash_golden_test.go) pins the same steps.
import { describe, expect, it } from 'vitest';
import { BASE_MOVE_SPEED, COMBAT, DASH_EXIT_SPEED, InputFlag as F, pitchToI16, SPRINT_MULTIPLIER, yawToU16 } from '@lodestone/contracts';
import { FlatGround, type GroundQuery } from './ground';
import { newMoveState, stepMovement, type MoveState } from './movement';
import { holding, invulnerable } from './dash';

const g = new FlatGround(0);
const byKey = (k: string) => COMBAT.dashes.find((d) => d.key === k)!;
const SPRINT = BASE_MOVE_SPEED * SPRINT_MULTIPLIER;
const stepP = (s: MoveState, flags: number, castSlot: number, yaw = 0, pitch = 0, gr: GroundQuery = g) => stepMovement(s, { flags, yaw: yawToU16(yaw), pitch: pitchToI16(pitch), castSlot }, gr);
const hold = (s: MoveState, id: number, n: number, flags = 0, yaw = 0, pitch = 0, gr: GroundQuery = g) => {
  for (let i = 0; i < n; i++) s = stepP(s, flags | F.channel, id, yaw, pitch, gr);
  return s;
};
const hspeed = (s: MoveState) => Math.hypot(s.vel.x, s.vel.z);

describe('held dashes (CR 021)', () => {
  it('every mobility dash peaks at several times sprint speed', () => {
    for (const d of COMBAT.dashes) {
      if (d.tierOf) continue; // CR 048: the lesser tiers are slower on purpose
      const peak = Math.max(d.speed, d.sustain?.speed ?? 0, d.sustain?.blinkSpeed ?? 0);
      expect(peak, d.key).toBeGreaterThanOrEqual(2.3 * SPRINT);
    }
  });

  it('magma dash flies where you look, straight up included, and thrust holds you up', () => {
    const jet = byKey('magma_dash');
    let s = stepP(newMoveState({ x: 100, y: 0, z: 100 }), F.dodge, jet.id, 0, Math.PI / 2);
    expect(s.vel.y).toBeGreaterThan(jet.speed * 0.95);
    s = hold(s, jet.id, 60, 0, 0, Math.PI / 2);
    expect(s.pos.y).toBeGreaterThan(25); // iron man: straight up
    expect(hspeed(s)).toBeLessThan(1);
    s = hold(s, jet.id, 90, 0, 1.0, 0); // level off
    const y0 = s.pos.y;
    s = hold(s, jet.id, 60, 0, 1.0, 0);
    expect(Math.abs(s.pos.y - y0)).toBeLessThan(2); // gravity cancelled while thrusting
    expect(hspeed(s)).toBeGreaterThan(jet.sustain!.speed * 0.95);
    expect(s.dash).toBe(jet.sustain!.carrySteps);
  });

  it('letting go carries the speed carrySteps, then clamps to the variant exitSpeed', () => {
    const jet = byKey('magma_dash');
    let s = stepP(newMoveState({ x: 100, y: 0, z: 100 }), F.dodge, jet.id, 0, 0.3);
    s = hold(s, jet.id, 40, 0, 0, 0.3);
    const sp = hspeed(s);
    for (let i = 0; i < jet.sustain!.carrySteps - 1; i++) {
      s = stepP(s, 0, jet.id);
      expect(hspeed(s)).toBeCloseTo(sp, 6); // the carry
    }
    s = stepP(s, 0, jet.id); // the last carry step
    expect(s.dash).toBe(0);
    expect(hspeed(s)).toBeLessThanOrEqual(jet.exitSpeed + 1e-6);
    expect(hspeed(s)).toBeGreaterThan(DASH_EXIT_SPEED);
  });

  it('only a running dash, the channel bit, its variant and no attack/dodge/cast hold it', () => {
    const d = byKey('sunstep');
    const fresh = newMoveState({ x: 100, y: 0, z: 100 });
    expect(hold(fresh, d.id, 5).dash).toBe(0); // nothing running: holding starts nothing
    const s = stepP(fresh, F.dodge, d.id);
    expect(holding(s, F.channel, d.id)).toBe(true);
    expect(holding(s, F.channel, 0)).toBe(false);
    expect(holding(s, F.channel | F.cast, d.id)).toBe(false);
    expect(holding(s, F.channel | F.attack, d.id)).toBe(false);
    expect(holding(s, 0, d.id)).toBe(false);
    expect(stepP(s, F.channel, 0).dash).toBe(d.steps - 1); // no variant named: counts down
    expect(stepP(s, F.channel | F.cast, d.id).dash).toBe(d.steps - 1);
    const h = hold(s, d.id, 100);
    expect(h.dash).toBe(d.sustain!.carrySteps);
    expect(hspeed(h)).toBeCloseTo(d.sustain!.speed, 6);
    expect(h.pos.z).toBeLessThan(100 - 100 * (d.sustain!.speed / 60) * 0.95); // straight ahead at sustain speed
  });

  it('the glacier skate runs over water; letting go drops you in', () => {
    const lake: GroundQuery = { heightAt: () => 0, waterAt: () => 2 };
    const ice = byKey('glacier_step');
    let s: MoveState = newMoveState({ x: 100, y: 2, z: 100 });
    s = stepP(s, F.dodge | F.forward, ice.id, 0, 0, lake);
    s = hold(s, ice.id, 60, F.forward, 0, 0, lake);
    expect(s.pos.y).toBe(2);
    expect(s.mode).toBe(0);
    for (let i = 0; i < 40; i++) s = stepP(s, F.forward, i < 6 ? ice.id : 0, 0, 0, lake);
    expect(s.mode).toBe(4); // swim
  });

  it('blink pulses at blinkSpeed every blinkEvery steps; phase keeps the i-frames; glide holds the fall', () => {
    const bl = byKey('static_step');
    let s = stepP(newMoveState({ x: 100, y: 0, z: 100 }), F.dodge, bl.id);
    let pulses = 0;
    for (let i = 0; i < 30; i++) {
      s = stepP(s, F.channel, bl.id);
      if (Math.abs(hspeed(s) - bl.sustain!.blinkSpeed) < 1e-6) pulses++;
    }
    expect(pulses).toBeGreaterThanOrEqual(5);
    const ph = byKey('skip');
    let p = stepP(newMoveState({ x: 100, y: 0, z: 100 }), F.dodge, ph.id);
    p = hold(p, ph.id, 60);
    expect(invulnerable(p)).toBe(true);
    const gl = byKey('updraft');
    let q = stepP(newMoveState({ x: 100, y: 0, z: 100 }), F.dodge, gl.id);
    q = hold(q, gl.id, 120);
    expect(q.vel.y).toBeGreaterThanOrEqual(-gl.sustain!.sink - 0.31); // the sink cap (plus one step of gravity)
    expect(q.pos.y).toBeGreaterThan(3); // still aloft after 2 s: a long glide
    expect(hspeed(q)).toBeCloseTo(gl.sustain!.speed, 6);
  });
});
