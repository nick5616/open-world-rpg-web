// The bounty board's notices as papers pinned on the board (CR 052): one small
// paper per available bounty, instead of only a list in a panel. The count
// comes from what the zone last told this client about that town's board
// (Event 802: the bounties not yet taken); a board you have not opened shows
// DEFAULT_PAPERS (every surface town's board holds 3 or 4 a day). Pure layout
// here; BoardPapersLayer.tsx draws them.

import { create } from 'zustand';

/** What a board you have not opened yet shows (the zone's minimum for surface towns). */
export const DEFAULT_PAPERS = 3;
export const MAX_PAPERS = 6;

interface PaperState {
  /** Settlement index -> papers on its board. */
  counts: Record<number, number>;
}

export const useBoardPapers = create<PaperState>(() => ({ counts: {} }));

/** The zone listed `available` untaken bounties for a town's board. */
export function setBoardPapers(settlement: number, available: number): void {
  const n = Math.max(0, Math.min(MAX_PAPERS, Math.floor(available)));
  if (useBoardPapers.getState().counts[settlement] === n) return;
  useBoardPapers.setState((s) => ({ counts: { ...s.counts, [settlement]: n } }));
}

export function papersFor(settlement: number, counts: Record<number, number> = useBoardPapers.getState().counts): number {
  return counts[settlement] ?? DEFAULT_PAPERS;
}

export interface Paper {
  /** Position on the board face: u across (m from the centre), y up from the board's base. */
  u: number;
  y: number;
  /** Radians. */
  rot: number;
  w: number;
  h: number;
  /** 0..1 tint variation. */
  tint: number;
}

const hash = (a: number, b: number) => {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

/** Paper `i` of `count` on a board (stable per board index): a 3 x 2 grid with jitter and a slight tilt. */
export function paperLayout(board: number, count: number): Paper[] {
  const out: Paper[] = [];
  const n = Math.min(MAX_PAPERS, count);
  // Fill order: centre row first so three papers look like a posted set, not a corner.
  const cells = [1, 4, 0, 5, 2, 3];
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const col = c % 3;
    const row = Math.floor(c / 3);
    const r1 = hash(board, i * 3 + 1);
    const r2 = hash(board, i * 3 + 2);
    const r3 = hash(board, i * 3 + 3);
    out.push({
      u: (col - 1) * 0.5 + (r1 - 0.5) * 0.1,
      y: 1.0 + row * 0.5 + 0.2 + (r2 - 0.5) * 0.08,
      rot: (r3 - 0.5) * 0.22,
      w: 0.3 + r1 * 0.05,
      h: 0.38 + r2 * 0.05,
      tint: r3,
    });
  }
  return out;
}
