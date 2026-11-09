import { describe, expect, it } from 'vitest';
import { EXPLORE_CELL_M, anyExploredIn, createExplored, isExplored, markExplored } from './explored';

describe('explored cells (map sketch of where you walked)', () => {
  it('marks a circle around the player once', () => {
    const e = createExplored('k', 4096);
    expect(markExplored(e, 1000, 1000, 96)).toBe(true);
    const c = Math.floor(1000 / EXPLORE_CELL_M);
    expect(isExplored(e, c, c)).toBe(true);
    expect(isExplored(e, c + 2, c)).toBe(true); // 64 m away
    expect(isExplored(e, c + 4, c)).toBe(false); // 128 m away
    expect(isExplored(e, c + 3, c + 3)).toBe(false); // corner of the square, outside the circle
    const v = e.version;
    expect(markExplored(e, 1000, 1000, 96)).toBe(false);
    expect(e.version).toBe(v);
  });
  it('clips at the world edge and answers region queries', () => {
    const e = createExplored('k', 4096);
    markExplored(e, 5, 5, 96);
    expect(isExplored(e, 0, 0)).toBe(true);
    expect(isExplored(e, -1, 0)).toBe(false);
    expect(anyExploredIn(e, 0, 0, 1024)).toBe(true);
    expect(anyExploredIn(e, 1024, 1024, 1024)).toBe(false);
  });
});
