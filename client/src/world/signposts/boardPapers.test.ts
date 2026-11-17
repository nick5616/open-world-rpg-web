import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAPERS, MAX_PAPERS, paperLayout, papersFor, setBoardPapers, useBoardPapers } from './boardPapers';

describe('bounty board papers', () => {
  beforeEach(() => useBoardPapers.setState({ counts: {} }));
  it('shows the default until the zone says how many bounties are up, then exactly that many', () => {
    expect(papersFor(4)).toBe(DEFAULT_PAPERS);
    setBoardPapers(4, 4);
    expect(papersFor(4)).toBe(4);
    setBoardPapers(4, 1); // you took three
    expect(papersFor(4)).toBe(1);
    setBoardPapers(4, 0);
    expect(papersFor(4)).toBe(0);
    expect(papersFor(5)).toBe(DEFAULT_PAPERS);
    setBoardPapers(6, 99);
    expect(papersFor(6)).toBe(MAX_PAPERS);
  });
  it('lays one paper per bounty, the same every time, inside the board, without stacking', () => {
    for (const n of [0, 1, 3, 4, 6]) expect(paperLayout(7, n)).toHaveLength(n);
    expect(paperLayout(7, 4)).toEqual(paperLayout(7, 4));
    expect(paperLayout(7, 4)).not.toEqual(paperLayout(8, 4));
    const ps = paperLayout(3, 6);
    for (const p of ps) {
      expect(Math.abs(p.u) + p.w / 2).toBeLessThan(0.9); // board half width
      expect(p.y - p.h / 2).toBeGreaterThan(0.9);
      expect(p.y + p.h / 2).toBeLessThan(2.0);
    }
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) expect(Math.abs(ps[i].u - ps[j].u) > 0.28 || Math.abs(ps[i].y - ps[j].y) > 0.36).toBe(true);
  });
});
