// Playtest 2 damage numbers: element colours, crit pop, rise and fade, and
// the stacking that keeps simultaneous numbers from overlapping.
import { describe, expect, it } from 'vitest';
import { NUMBER_MS, NUMBER_PX, POP_SCALE, numberColor, numberMotion, numberText, stackNumbers } from './layout';
import { ELEMENT_COLORS } from '../events';

describe('damage number style', () => {
  it('colours your hits by element, physical white, crits gold; taken red, heals green', () => {
    expect(numberColor('dealt')).toBe('#ffffff');
    expect(numberColor('crit')).toBe('#ffd84a');
    expect(numberColor('dealt', 1)).toBe(ELEMENT_COLORS[1]); // ice is light already
    expect(numberColor('dealt', 6)).not.toBe(ELEMENT_COLORS[6]); // dark purple is lifted to read on dark ground
    expect(numberColor('crit', 0)).toBe(numberColor('dealt', 0));
    expect(numberColor('taken')).toBe('#ff5a50');
    expect(numberColor('heal')).toBe('#6cff8a');
    expect(numberColor('resist', 0)).not.toBe(numberColor('dealt', 0));
  });

  it('crits are the biggest, with a "!"; heals get a "+"', () => {
    for (const k of ['dealt', 'weak', 'resist', 'taken', 'heal', 'miss'] as const) expect(NUMBER_PX.crit).toBeGreaterThan(NUMBER_PX[k]);
    expect(NUMBER_PX.dealt).toBeLessThan(24); // small: the playtest found them huge
    expect(numberText('crit', 58)).toBe('58!');
    expect(numberText('heal', 12)).toBe('+12');
    expect(numberText('dealt', 12.6)).toBe('13');
    expect(numberText('miss', 0)).toBe('MISS');
  });

  it('pop on arrival (crits most), rise, then fade out by the end of the life', () => {
    const c0 = numberMotion('crit', 0);
    expect(c0.scale).toBeCloseTo(POP_SCALE);
    expect(numberMotion('dealt', 0).scale).toBeLessThan(c0.scale);
    expect(numberMotion('crit', 300).scale).toBe(1);
    const a = numberMotion('dealt', 100);
    const b = numberMotion('dealt', 600);
    expect(b.rise).toBeGreaterThan(a.rise);
    expect(a.alpha).toBe(1);
    expect(numberMotion('dealt', NUMBER_MS * 0.8).alpha).toBeLessThan(1);
    expect(numberMotion('dealt', NUMBER_MS).alpha).toBe(0);
  });
});

describe('stacking', () => {
  const run = (rects: [number, number, number, number][]) => {
    const n = rects.length;
    const order = rects.map((_, i) => i);
    const dy = new Float32Array(n);
    stackNumbers(
      n,
      order,
      rects.map((r) => r[0]),
      rects.map((r) => r[1]),
      rects.map((r) => r[2]),
      rects.map((r) => r[3]),
      dy,
    );
    return dy;
  };
  const overlaps = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) * 2 < a[2] + b[2] && Math.abs(a[1] - b[1]) * 2 < a[3] + b[3];

  it('moves a newer number up above an older one at the same spot', () => {
    const dy = run([
      [100, 200, 40, 20],
      [100, 200, 40, 20],
      [104, 198, 30, 20],
    ]);
    expect(dy[0]).toBe(0);
    expect(dy[1]).toBeGreaterThanOrEqual(20);
    expect(dy[2]).toBeGreaterThan(dy[1]);
  });

  it('leaves numbers that do not overlap alone', () => {
    const dy = run([
      [100, 200, 40, 20],
      [300, 200, 40, 20],
      [100, 100, 40, 20],
    ]);
    expect([...dy]).toEqual([0, 0, 0]);
  });

  it('no two stacked numbers overlap (a burst of 12)', () => {
    const rects: [number, number, number, number][] = [];
    for (let i = 0; i < 12; i++) rects.push([100 + ((i * 7) % 20), 200 + ((i * 5) % 12), 30 + (i % 3) * 10, 18 + (i % 2) * 8]);
    const dy = run(rects);
    const placed = rects.map((r, i) => [r[0], r[1] - dy[i], r[2], r[3]]);
    for (let i = 0; i < placed.length; i++) for (let j = 0; j < i; j++) expect(overlaps(placed[i], placed[j]), `${i} vs ${j}`).toBe(false);
  });
});
