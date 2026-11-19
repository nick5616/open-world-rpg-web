// Playtest 2 co-op polish: the rider who fell 330 m. A gallop into a cliff
// over open cave air went into the hill (the level view reads the cave
// rules one fast step ahead); surfaceGuard stops it at the face. Twin of
// server/pkg/movement/surface_guard_test.go: the same fake ground and
// inputs end on the same bits.
import { describe, expect, it } from 'vitest';
import { InputFlag as F, MoveMode, yawToU16 } from '@lodestone/contracts';
import type { GroundQuery } from './ground';
import { FlatGround } from './ground';
import { MoveFlag, newMoveState, stepMovement, type MoveState } from './movement';
import { surfaceGuard, SURFACE_GUARD_M } from './caves';

const cliffH = (x: number) => (x < 50 ? 100 : 100 + (x - 50) * 6);
const cliffCave: GroundQuery = {
  heightAt: (x) => cliffH(x),
  atLevel: (y) => ({ heightAt: (x) => (y < cliffH(x) - 1 ? y - 36 : cliffH(x)) }),
};

describe('surface guard (co-op polish)', () => {
  it('stops a gallop at a cliff over a cave instead of going into the hill', () => {
    let s: MoveState = newMoveState({ x: 40, y: 100, z: 10 });
    s.flags |= MoveFlag.mounted;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      const flags = F.forward | (i % 40 === 0 ? F.sprint : 0);
      s = stepMovement(s, { flags, yaw: yawToU16((3 * Math.PI) / 2), pitch: 0, castSlot: 0 }, cliffCave);
      worst = Math.max(worst, cliffH(s.pos.x) - s.pos.y);
    }
    expect(worst).toBeLessThanOrEqual(SURFACE_GUARD_M);
    expect(s.flags & MoveFlag.mounted).not.toBe(0);
    // The Go twin's end state, bit for bit.
    expect(s.pos.x).toBe(52.19337192426016);
    expect(s.pos.y).toBe(113.16023154556098);
    expect(s.pos.z).toBe(10);
    expect(s.vel.x).toBe(1.5430898669972009);
    expect(s.mode).toBe(MoveMode.ground);
  });

  it('never touches a ground without levels', () => {
    const flat = new FlatGround(3);
    const a = newMoveState({ x: 1, y: 3, z: 1 });
    expect(surfaceGuard(flat, flat, a, a, 1e-4)).toBe(a);
  });
});
