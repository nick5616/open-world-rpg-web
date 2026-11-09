import { describe, expect, it } from 'vitest';
import { LookSpikeFilter } from './useMouseLook';

const run = (deltas: [number, number][]) => {
  const f = new LookSpikeFilter();
  let x = 0;
  let y = 0;
  for (const [dx, dy] of deltas) {
    const d = f.push(dx, dy);
    x += d.x;
    y += d.y;
  }
  return { x, y };
};

describe('LookSpikeFilter', () => {
  it('passes ordinary motion untouched', () => {
    const ds: [number, number][] = Array.from({ length: 50 }, (_, i) => [5 + (i % 3), -2]);
    expect(run(ds)).toEqual({ x: ds.reduce((s, d) => s + d[0], 0), y: -100 });
  });
  it('drops an isolated bogus jump between small deltas', () => {
    const ds: [number, number][] = [...Array(20).fill([4, 0]), [-600, 40], ...Array(20).fill([4, 0])];
    expect(run(ds)).toEqual({ x: 160, y: 0 });
  });
  it('keeps a genuine fast flick that starts abruptly', () => {
    const ds: [number, number][] = [...Array(5).fill([1, 0]), ...Array(10).fill([200, 0]), [0, 0]];
    expect(run(ds).x).toBe(5 + 2000);
  });
});
