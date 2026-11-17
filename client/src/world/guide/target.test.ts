import { describe, expect, it } from 'vitest';
import { goalOf, pickGuideGoal } from './target';

describe('guide goal', () => {
  const me = { x: 0, z: 0 };
  it('prefers the nearest quest marker (by its edge), then your pin, then a party pin', () => {
    const g = pickGuideGoal(me, [{ x: 500, z: 0, label: 'Far' }, { x: 0, z: 300, r: 50, label: 'Near area' }], [{ x: 9, z: 9, party: false }]);
    expect(g).toMatchObject({ kind: 'quest', label: 'Near area' });
    expect(pickGuideGoal(me, [], [{ x: 40, z: 0, party: true }, { x: 90, z: 0, party: false }])).toMatchObject({ kind: 'pin', x: 90 });
    expect(pickGuideGoal(me, [], [{ x: 40, z: 0, party: true }])).toMatchObject({ kind: 'pin', x: 40 });
    expect(pickGuideGoal(me, [], [])).toBeNull();
  });
  it('leads into an area from the near side, and does nothing inside it', () => {
    const p = goalOf(me, { x: 0, z: 300, r: 50 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(280, 6);
    expect(goalOf({ x: 0, z: 290 }, { x: 0, z: 300, r: 50 })).toEqual({ x: 0, z: 290 });
    expect(goalOf(me, { x: 7, z: 8 })).toEqual({ x: 7, z: 8 });
  });
});
