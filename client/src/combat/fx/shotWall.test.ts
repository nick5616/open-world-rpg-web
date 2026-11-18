import { describe, expect, it } from 'vitest';
import { shotAtWall, type ShotLike } from './shotWall';

const shot = (x: number, over: Partial<ShotLike> = {}): ShotLike => ({ on: true, local: false, collide: 'players', x, y: 1.5, z: 0, ...over });

describe('shotAtWall (CR 056)', () => {
  it('picks the enemy shot nearest to the impact', () => {
    expect(shotAtWall([shot(2), shot(9), shot(30)], 10, 1.5, 0)).toBe(1);
  });
  it('ignores your own shots, shots that are off and shots at enemies', () => {
    expect(shotAtWall([shot(10, { local: true }), shot(10, { on: false }), shot(10, { collide: 'enemies' })], 10, 1.5, 0)).toBe(-1);
  });
  it('finds nothing when every shot is far from the impact', () => {
    expect(shotAtWall([shot(100)], 10, 1.5, 0)).toBe(-1);
  });
});
