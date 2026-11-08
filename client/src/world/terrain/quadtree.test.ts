import { describe, expect, it } from 'vitest';
import { childrenOf, coarserEdges, DOMAIN_CHUNKS, keyOf, leafAt, parentOf, resolveDrawn, selectTiles, tileSize, type TileId } from './quadtree';

const flat = () => [0, 10] as [number, number];
const sel = (x: number, z: number, split = 1.3, y = 50, viewDistance = 1e9) => selectTiles({ x, y, z, split, viewDistance, heightBounds: flat });

/** Every chunk cell of the domain is covered by exactly one leaf. */
function coverage(leaves: Map<string, TileId>): Int32Array {
  const n = DOMAIN_CHUNKS;
  const c = new Int32Array(n * n);
  for (const t of leaves.values()) {
    const s = 1 << t.lod;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) c[(t.cz + 64 + j) * n + t.cx + 64 + i]++;
  }
  return c;
}

describe('quadtree selection', () => {
  it('tiles the whole domain exactly once, finest at the camera', () => {
    const { leaves } = sel(1920.5, 2272.5);
    const c = coverage(leaves);
    expect(Math.min(...c)).toBe(1);
    expect(Math.max(...c)).toBe(1);
    expect(leafAt(leaves, 1920.5 / 64, 2272.5 / 64)!.lod).toBe(0);
    // Far corner of the domain stays coarse.
    expect(leafAt(leaves, 120, 120)!.lod).toBeGreaterThanOrEqual(5);
  });

  it('is balanced: neighbouring leaves differ by at most one level', () => {
    for (const [x, z, split] of [
      [1920, 2272, 1.3],
      [10, 4000, 0.9],
      [3000, 100, 1.6],
      [2048, 2048, 0.5],
    ]) {
      const { leaves } = sel(x, z, split);
      for (const t of leaves.values()) {
        const s = 1 << t.lod;
        for (const [px, pz] of [
          [t.cx - 0.5, t.cz + s / 2],
          [t.cx + s + 0.5, t.cz + s / 2],
          [t.cx + s / 2, t.cz - 0.5],
          [t.cx + s / 2, t.cz + s + 0.5],
        ]) {
          const n = leafAt(leaves, px, pz);
          if (n) expect(Math.abs(n.lod - t.lod)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('a higher split factor gives more (finer) tiles; altitude gives fewer', () => {
    expect(sel(1920, 2272, 1.6).leaves.size).toBeGreaterThan(sel(1920, 2272, 0.9).leaves.size);
    expect(sel(1920, 2272, 1.3, 2000).leaves.size).toBeLessThan(sel(1920, 2272, 1.3, 50).leaves.size);
  });

  it('hysteresis: a tile split last time stays split slightly past its threshold', () => {
    // Find a camera distance just past lod-1's split threshold for one tile.
    const t: TileId = { cx: 30, cz: 34, lod: 1 };
    const limit = 1.3 * tileSize(1);
    const z = t.cz * 64 + 128 + limit + 5; // 5 m beyond the plain threshold, below the 10 % hysteresis
    const fresh = selectTiles({ x: t.cx * 64 + 64, y: 5, z, split: 1.3, viewDistance: 1e9, heightBounds: flat });
    expect(fresh.leaves.has(keyOf(t))).toBe(true);
    const held = selectTiles({ x: t.cx * 64 + 64, y: 5, z, split: 1.3, viewDistance: 1e9, heightBounds: flat, wasSplit: new Set([keyOf(t)]) });
    expect(held.leaves.has(keyOf(t))).toBe(false);
  });

  it('view distance drops far tiles (the horizon mesh draws there)', () => {
    const { leaves } = sel(1920, 2272, 1.3, 50, 2000);
    for (const t of leaves.values()) {
      const s = tileSize(t.lod);
      const dx = Math.max(t.cx * 64 - 1920, 0, 1920 - (t.cx * 64 + s));
      const dz = Math.max(t.cz * 64 - 2272, 0, 2272 - (t.cz * 64 + s));
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(2000);
    }
  });
});

describe('parent / children', () => {
  it('round-trips, including negative chunk ids', () => {
    for (const t of [
      { cx: -64, cz: -64, lod: 6 },
      { cx: -8, cz: 16, lod: 3 },
      { cx: 33, cz: 34, lod: 0 },
    ]) {
      for (const c of childrenOf(t)) expect(parentOf(c)).toEqual(t);
    }
    expect(parentOf({ cx: -1, cz: -3, lod: 0 })).toEqual({ cx: -2, cz: -4, lod: 1 });
  });
});

describe('resolveDrawn', () => {
  it('draws the nearest loaded ancestor while children load, never overlapping', () => {
    const parent: TileId = { cx: 32, cz: 32, lod: 2 };
    const kids = childrenOf(parent);
    const wanted = new Map(kids.map((k) => [keyOf(k), k]));
    // Only one child loaded, plus the parent: the parent covers all four.
    const loaded = new Set([keyOf(kids[0]), keyOf(parent)]);
    const drawn = resolveDrawn(wanted, (k) => loaded.has(k));
    expect([...drawn.keys()]).toEqual([keyOf(parent)]);
    // All children loaded: children only.
    for (const k of kids) loaded.add(keyOf(k));
    expect([...resolveDrawn(wanted, (k) => loaded.has(k)).keys()].sort()).toEqual(kids.map(keyOf).sort());
  });
  it('draws nothing where nothing is loaded (the horizon shows instead)', () => {
    const t: TileId = { cx: 0, cz: 0, lod: 0 };
    expect(resolveDrawn(new Map([[keyOf(t), t]]), () => false).size).toBe(0);
  });
});

describe('coarserEdges', () => {
  it('flags exactly the edges that touch a coarser tile', () => {
    const fine: TileId = { cx: 2, cz: 0, lod: 1 };
    const west: TileId = { cx: 0, cz: 0, lod: 1 };
    const east: TileId = { cx: 4, cz: 0, lod: 2 };
    const drawn = new Map([fine, west, east].map((t) => [keyOf(t), t]));
    expect(coarserEdges(drawn, fine)).toBe(0b0010); // east only
    expect(coarserEdges(drawn, west)).toBe(0);
  });
});
