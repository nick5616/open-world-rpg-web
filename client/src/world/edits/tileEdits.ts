// Terrain edits in a tile build (CR 040), pure TS so the worker and the tests
// share it: the deltas of the closed box around a tile (flat [x, z, d]
// triples from TerrainOverlay.collect) are added to the generated lattice
// before the mesh is built, the same lift the collision uses
// (overlay.ts lift), so the mesh stays exactly the collision surface at LOD 0.
// Edited ground also turns to bare soil in the splat weights.
import type { ChunkData } from '@lodestone/worldgen';
import { lift, MAX_DELTA, STEP_M } from './overlay';

/** How far an edit reaches past a tile (m): edge normals look one sample out, coarse normals two. */
export const EDIT_PAD_STEPS = 2;

/** A height function over integer coordinates with the edits added (the tile's "outside" lookup). */
export function editedOutside(base: (x: number, z: number) => number, edits: Int32Array): (x: number, z: number) => number {
  const m = new Map<number, number>();
  for (let i = 0; i < edits.length; i += 3) m.set(edits[i + 1] * 65536 + edits[i], edits[i + 2]);
  return (x, z) => {
    const h = base(x, z);
    const d = Number.isInteger(x) && Number.isInteger(z) ? m.get(z * 65536 + x) : undefined;
    return d ? lift(h, d) : h;
  };
}

/** How much of a dug vertex's soil is bedrock: 0 down to a third of the dig cap, 1 at the cap (delta -MAX_DELTA). */
export function bedrockShare(d: number): number {
  if (d >= 0) return 0;
  return Math.min(1, Math.max(0, (-d - MAX_DELTA / 3) / ((MAX_DELTA * 2) / 3)));
}

/**
 * Add the edits to a chunk's lattice in place. Vertices not on this tile's
 * lattice (coarser LODs sample every 2^lod m) are skipped. Returns the
 * number of vertices changed.
 */
export function applyTileEdits(c: ChunkData, edits: Int32Array): number {
  const S = c.samples;
  const step = c.step;
  const x0 = c.cx * 64;
  const z0 = c.cz * 64;
  let n = 0;
  let lo = c.minHeight;
  let hi = c.maxHeight;
  for (let k = 0; k < edits.length; k += 3) {
    const dx = edits[k] - x0;
    const dz = edits[k + 1] - z0;
    if (dx < 0 || dz < 0 || dx % step || dz % step) continue;
    const i = dx / step;
    const j = dz / step;
    if (i >= S || j >= S) continue;
    const d = edits[k + 2];
    const v = j * S + i;
    const h = lift(c.heights[v], d);
    c.heights[v] = h;
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
    // Bare soil: scale every other weight down and give the dirt channel the rest (the six weights keep summing to 255).
    const t = Math.min(1, 0.6 + 0.1 * Math.abs(d));
    const a = v * 4;
    const g = Math.round(c.splatA[a] * (1 - t));
    // Bedrock (playtest 5): the last third of the dig depth turns the bare soil to rock, all of it at the cap, so the bottom of a pit is a
    // visible floor with a name, not an invisible plane in dirt.
    const bed = bedrockShare(d);
    const rockIn = Math.round(c.splatA[a + 2] * (1 - t));
    const sn = Math.round(c.splatA[a + 3] * (1 - t));
    const sa = Math.round(c.splatB[a] * (1 - t));
    const mu = Math.round(c.splatB[a + 1] * (1 - t));
    const soil = Math.max(0, 255 - g - rockIn - sn - sa - mu);
    const toRock = Math.round(soil * bed);
    const r = rockIn + toRock;
    c.splatA[a] = g;
    c.splatA[a + 1] = soil - toRock;
    c.splatA[a + 2] = r;
    c.splatA[a + 3] = sn;
    c.splatB[a] = sa;
    c.splatB[a + 1] = mu;
    n++;
  }
  c.minHeight = lo;
  c.maxHeight = hi;
  return n;
}

export { STEP_M };
