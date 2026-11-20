import { describe, expect, it } from 'vitest';
import { declutterLabels } from './labelDeclutter';

describe('declutterLabels (playtest 6 polish)', () => {
  it('leaves labels apart where they are', () => {
    const out = declutterLabels([
      { x: 100, y: 300, w: 60, h: 30 },
      { x: 300, y: 300, w: 60, h: 30 },
    ]);
    expect(out).toEqual([
      { lift: 0, hidden: false },
      { lift: 0, hidden: false },
    ]);
  });

  it('lifts a farther label that would draw over a nearer one', () => {
    const [a, b] = declutterLabels([
      { x: 500, y: 300, w: 80, h: 30 },
      { x: 520, y: 296, w: 90, h: 30 },
    ]);
    expect(a).toEqual({ lift: 0, hidden: false });
    expect(b.hidden).toBe(false);
    // its bottom now sits above the nearer label's top (270) with a gap
    expect(296 - b.lift).toBeLessThanOrEqual(270);
  });

  it('stacks a third label above both, and hides one that would need a big lift', () => {
    const out = declutterLabels(
      [
        { x: 500, y: 300, w: 80, h: 30 },
        { x: 505, y: 300, w: 80, h: 30 },
        { x: 510, y: 300, w: 80, h: 30 },
      ],
      40,
    );
    expect(out[0].hidden).toBe(false);
    expect(out[1].hidden).toBe(false);
    expect(out[2].hidden).toBe(true);
  });

  it('never leaves two shown labels overlapping', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => ({ x: 400 + ((i * 37) % 120), y: 300 + ((i * 13) % 40), w: 70 + (i % 3) * 20, h: 28 }));
    const out = declutterLabels(boxes, 1000);
    const rects = boxes.map((b, i) => ({ l: b.x - b.w / 2, r: b.x + b.w / 2, b: b.y - out[i].lift, t: b.y - out[i].lift - b.h }));
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const p = rects[i];
        const q = rects[j];
        expect(p.l < q.r && p.r > q.l && p.t < q.b && p.b > q.t).toBe(false);
      }
  });

  it('keeps names off a speech bubble (hidden when the bubble is tall)', () => {
    const bubble = { x: 500, y: 290, w: 200, h: 50 };
    const [under, beside] = declutterLabels(
      [
        { x: 510, y: 300, w: 80, h: 30 },
        { x: 800, y: 300, w: 80, h: 30 },
      ],
      40,
      [bubble],
    );
    expect(under.hidden).toBe(true);
    expect(beside).toEqual({ lift: 0, hidden: false });
  });
});
