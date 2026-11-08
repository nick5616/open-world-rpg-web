// Mouth holes in terrain tiles (WP09, spec 7 "Cave mouths"): the overworld
// drops the heightfield triangles a cave volume replaces. At lod 0 this is
// exactly the collision rule (caveTriMasked: a 1 m triangle whose centroid
// is within r_mask of an opening), so what you see is what you walk on.
// Lod 1 tiles (2 m cells, drawn ~70-140 m out) drop their coarse triangles
// by the same centroid rule, so the hole doesn't close up a few steps
// before you reach the mouth; beyond that a mouth is a dark arch on the
// hillside (the rock-arch prop sits on top of the seam at every distance).

import type { CaveOpening } from '@lodestone/worldgen';
import { CELLS, tileIndex } from '../terrain/tileMesh';

/** The tile's index without masked triangles, or null if no mouth touches the tile. */
export function holeIndex(openings: readonly CaveOpening[], cx: number, cz: number, lod: number): Uint16Array | null {
  if (lod > 1 || openings.length === 0) return null;
  const step = 1 << lod;
  const x0 = cx * 64;
  const z0 = cz * 64;
  const size = 64 * step;
  const near = openings.filter((o) => o.x + o.rMask > x0 && o.x - o.rMask < x0 + size && o.z + o.rMask > z0 && o.z - o.rMask < z0 + size);
  if (near.length === 0) return null;
  const masked = (x: number, z: number) => {
    for (const o of near) {
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz < o.rMask * o.rMask) return true;
    }
    return false;
  };
  const base = tileIndex();
  const out = new Uint16Array(base.length);
  let n = 0;
  // Grid triangles come first in tileIndex: per cell (i, j) the pair
  // (a, c, b) = below the diagonal and (b, c, d) = above it.
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const o = (j * CELLS + i) * 6;
      const cxw = x0 + i * step;
      const czw = z0 + j * step;
      if (!masked(cxw + step / 3, czw + step / 3)) {
        out.set(base.subarray(o, o + 3), n);
        n += 3;
      }
      if (!masked(cxw + (2 * step) / 3, czw + (2 * step) / 3)) {
        out.set(base.subarray(o + 3, o + 6), n);
        n += 3;
      }
    }
  }
  const grid = CELLS * CELLS * 6;
  out.set(base.subarray(grid), n); // skirts unchanged
  n += base.length - grid;
  return out.slice(0, n);
}
