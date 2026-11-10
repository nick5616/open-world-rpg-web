// CR 027 (playtest 2 mounts): riding in the shared step, and the
// cross-language golden (the Go replay is server/pkg/movement/ride_golden_test.go).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InputFlag as F, MoveMode, RIDE_GALLOP_SPEED, RIDE_SPUR_MAX_SPEED, RIDE_TROT_SPEED, RIDE_WALK_SPEED, yawToU16 } from '@lodestone/contracts';
import { FlatGround } from './ground';
import { MoveFlag, newMoveState, stepMovement, type MoveState } from './movement';
import { GAIT, gaitOf, mounted, SPUR_COST } from './ride';
import { goldenPath } from './golden/io';
import { COURSE, RIDE_SCENARIOS, rideRun, rideSummary, type RideGolden } from './golden/ride';
import { fromSelf, packFlags, packMoveExt } from './moveWire';

const g = new FlatGround(0);
const step = (s: MoveState, flags: number, yaw = 0, ground = g as import('./ground').GroundQuery) => stepMovement(s, { flags, yaw: yawToU16(yaw), pitch: 0, castSlot: 0 }, ground);
const rider = (x = 100, z = 100): MoveState => {
  const s = newMoveState({ x, y: 0, z });
  s.flags |= MoveFlag.mounted;
  return s;
};
const speed = (s: MoveState) => Math.hypot(s.vel.x, s.vel.z);
const run = (s: MoveState, n: number, flags: number, yaw = 0, ground?: import('./ground').GroundQuery) => {
  for (let i = 0; i < n; i++) s = step(s, flags, yaw, ground);
  return s;
};

describe('riding', () => {
  it('trots with W, gallops after a spur, bursts on another, and the burst fades', () => {
    let s = run(rider(), 120, F.forward);
    expect(speed(s)).toBeCloseTo(RIDE_TROT_SPEED, 9);
    expect(mounted(s)).toBe(true);
    s = step(s, F.forward | F.sprint);
    expect(gaitOf(s)).toBe(GAIT.gallop);
    expect(s.stamina).toBe(s.staminaMax - SPUR_COST);
    s = run(s, 40, F.forward | F.sprint); // held Shift: no second spur (regen waits a second)
    expect(s.stamina).toBe(s.staminaMax - SPUR_COST);
    s = run(s, 60, F.forward);
    expect(speed(s)).toBeCloseTo(RIDE_GALLOP_SPEED, 9);
    s = step(s, F.forward | F.sprint);
    expect(speed(s)).toBeGreaterThan(RIDE_GALLOP_SPEED + 4);
    expect(speed(s)).toBeLessThanOrEqual(RIDE_SPUR_MAX_SPEED);
    s = run(s, 200, F.forward);
    expect(speed(s)).toBeCloseTo(RIDE_GALLOP_SPEED, 9);
  });

  it('turns no faster than the gait allows, and pivots from a stop', () => {
    let s = run(rider(), 200, F.forward);
    s = step(s, F.forward | F.sprint);
    s = run(s, 120, F.forward);
    const h0 = Math.atan2(s.vel.x, s.vel.z);
    s = run(s, 30, F.forward, Math.PI / 2); // look 90 degrees left for half a second
    const d = Math.atan2(s.vel.x, s.vel.z) - h0;
    const turned = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    expect(turned).toBeLessThan((75 * Math.PI) / 180 / 2 + 1e-6); // 75 deg/s at a gallop
    expect(turned).toBeGreaterThan(0.5);
    let p = run(rider(), 1, F.forward, Math.PI / 2); // from a stop: straight off where you look
    expect(p.vel.x).toBeLessThan(0);
    expect(Math.abs(p.vel.z)).toBeLessThan(1e-12);
    p = run(p, 30, F.right, Math.PI / 2);
    expect(speed(p)).toBeLessThanOrEqual(RIDE_WALK_SPEED + 1e-9);
  });

  it('S brakes then backs up away from the look; Space at a standstill hops off', () => {
    let s = run(rider(), 120, F.forward);
    s = run(s, 30, F.back);
    expect(gaitOf(s)).toBe(GAIT.walk);
    s = run(s, 60, F.back);
    expect(s.vel.z).toBeGreaterThan(1.5); // yaw 0 looks at -z: backing goes +z
    s = run(s, 60, 0);
    expect(speed(s)).toBe(0);
    s = step(s, F.jump | F.jump_edge);
    expect(mounted(s)).toBe(false);
    expect(s.lunge).toBe(0);
    expect(s.vel.y).toBeGreaterThan(0);
  });

  it('Space while moving jumps (no double jump), and riding never dashes', () => {
    let s = run(rider(), 60, F.forward);
    s = step(s, F.forward | F.jump | F.jump_edge);
    expect(s.mode).toBe(MoveMode.air);
    expect(mounted(s)).toBe(true);
    const vy = s.vel.y;
    s = step(s, F.forward | F.jump | F.jump_edge);
    expect(s.vel.y).toBeLessThan(vy); // no air jump
    const d = step(run(rider(), 60, F.forward), F.forward | F.dodge);
    expect(d.dash ?? 0).toBe(0);
    expect(d.iframes ?? 0).toBe(0);
  });

  it('never sets the mounted bit by itself, whatever the input', () => {
    let s = newMoveState({ x: 100, y: 0, z: 100 });
    for (let i = 0; i < 600; i++) {
      s = step(s, (i * 2654435761) & 0x7fff, i * 0.01);
      expect(s.flags & MoveFlag.mounted).toBe(0);
    }
  });

  it('a spur needs stamina; the gait rides through the SelfState round trip', () => {
    let s = rider();
    s.stamina = SPUR_COST - 1;
    s = run(s, 30, F.forward);
    s = step(s, F.forward | F.sprint);
    expect(gaitOf(s)).toBe(GAIT.trot);
    s.stamina = s.staminaMax;
    s = step(run(s, 2, F.forward), F.forward | F.sprint);
    const back = fromSelf({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, staminaMax: (s.staminaMax * 10) / 60, mode: s.mode, airJumps: 0, flags: packFlags(s), moveExt: packMoveExt(s) });
    expect(back.flags & MoveFlag.mounted).toBe(MoveFlag.mounted);
    expect(back.lunge).toBe(s.lunge);
    expect(gaitOf(back)).toBe(GAIT.gallop);
  });

  it('the course: the steed refuses deep water and a cliff, and a 10 m fall throws the rider', () => {
    const west = rideRun('ride_course_west');
    const east = rideRun('ride_course_east');
    const sw = rideSummary(west);
    const se = rideSummary(east);
    expect(sw.refusals).toBeGreaterThan(0);
    expect(se.jumps).toBeGreaterThan(0);
    expect(se.dismountAt).toBeGreaterThan(0);
    // never inside the building, never in the lake while mounted
    for (const r of east.states) if (r[11] & MoveFlag.mounted) expect(r[0] < 1059.6 + 1e-9 || r[0] > 1062.4 - 1e-9 || r[2] < 899.6 || r[2] > 1040.4).toBe(true);
    for (const r of west.states) if (r[11] & MoveFlag.mounted) expect(COURSE.waterAt!(r[0], r[2]) - COURSE.heightAt(r[0], r[2])).toBeLessThan(1.2);
  });
});

describe('ride goldens', () => {
  for (const sc of RIDE_SCENARIOS) {
    it(`${sc.name} reproduces bit for bit`, () => {
      const file = JSON.parse(readFileSync(goldenPath(`pt2_${sc.name}`), 'utf8')) as RideGolden;
      const now = rideRun(sc.name);
      expect(now.frames).toEqual(file.frames);
      // JSON has no -0: compare the serialized rows (bit-exact otherwise).
      for (let i = 0; i < file.states.length; i++) {
        if (JSON.stringify(file.states[i]) !== JSON.stringify(now.states[i])) throw new Error(`step ${i + 1} differs: golden ${JSON.stringify(file.states[i])} vs now ${JSON.stringify(now.states[i])} (npm run golden -w client, then update the Go port)`);
      }
      expect(now.states.length).toBe(file.states.length);
    });
  }
});
