import { describe, expect, it } from 'vitest';
import { layoutBoards } from './boards';
import type { Signpost } from './placement';

const board = (name: string, dx: number, dz: number) => ({ name, dist: 100, dx, dz, kind: 'town' as const });
const fork: Signpost = { id: 'f:1', kind: 'fork', x: 10, z: 20, y: 5, yaws: [0, Math.PI / 2], armIndex: [0, 2], roadDir: null, settlement: -1, boards: [board('East', 1, 0), board('South', 0, 1)] };
const exit: Signpost = { id: 'x:0:0', kind: 'exit', x: 70, z: 5, y: NaN, yaws: [], armIndex: [], roadDir: { x: 1, z: 0 }, settlement: 0, boards: [board('Fenmoor', 1, 0), board('Old Weir', 0.8, -0.6)] };

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe('board layout', () => {
  it('every face is a quad wound to face its reader, with the text running left to right for them', () => {
    for (const p of [fork, exit]) {
      for (const b of layoutBoards(p, 3)) {
        expect(b.faces).toHaveLength(2);
        for (const f of b.faces) {
          const [bl, br, tr] = f.c;
          const n = cross(sub(br, bl), sub(tr, br));
          const len = Math.hypot(n[0], n[1], n[2]);
          expect(n[0] / len).toBeCloseTo(f.nx, 6);
          expect(n[2] / len).toBeCloseTo(f.nz, 6);
          expect(br[1]).toBeCloseTo(bl[1], 9);
          expect(tr[1]).toBeGreaterThan(br[1]);
        }
        // the two faces look opposite ways
        expect(b.faces[0].nx).toBeCloseTo(-b.faces[1].nx, 9);
        expect(b.faces[0].nz).toBeCloseTo(-b.faces[1].nz, 9);
      }
    }
  });
  it('fork boards sit on the towns buffer arms: height by the arm index, along its yaw', () => {
    const [a, c] = layoutBoards(fork, 0);
    expect(a.cy).toBeCloseTo(5 + 2.35 + 0.12, 6);
    expect(c.cy).toBeCloseTo(5 + 2.35 - 2 * 0.34 + 0.12, 6);
    expect(a.cx).toBeCloseTo(10.52, 6); // arm 0 points +x
    expect(a.cz).toBeCloseTo(20, 6);
    expect(c.cx).toBeCloseTo(10, 6); // arm 2 points +z (yaw 90 degrees)
    expect(c.cz).toBeCloseTo(20.52, 6);
  });
  it('exit boards stack on the post, running from it toward the road', () => {
    const [a, b] = layoutBoards(exit, 12);
    expect(a.cy).toBeGreaterThan(b.cy);
    expect(a.cy).toBeCloseTo(12 + 2.55, 6);
    // road runs +x; the post is on its right (+z side), so the boards run toward -z
    expect(a.cz).toBeLessThan(exit.z);
    expect(Math.abs(a.cx - exit.x)).toBeLessThan(1e-9);
  });
  it('arrows read from the reader side: a road ahead is "up" on the face looking down the road', () => {
    const [a] = layoutBoards(exit, 0);
    // face 0 has normal +x (toward travellers coming back along the road): reader looks -x; Fenmoor lies +x: behind them.
    expect(Math.abs(a.faces[0].arrow)).toBeCloseTo(Math.PI, 6);
    // face 1 has normal -x: reader looks +x, Fenmoor straight ahead.
    expect(a.faces[1].arrow).toBeCloseTo(0, 6);
  });
});
