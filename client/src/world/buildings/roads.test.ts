// WP20 roads: ribbons are draped on the terrain (every vertex = ground +
// lift), as wide as the record says, and skip the stretch under a bridge.

import { beforeAll, describe, expect, it } from 'vitest';
import { parseTowns, townsBytes, type TownRoad, type Towns } from '@lodestone/worldgen';
import { hasWasm, testWorld } from '../testing/wasm';
import { MeshBuilder } from './meshBuilder';
import { buildRoadCells, drawRoad, LIFT, resample } from './roads';

const road = (pts: number[], width = 4, surface = 0): TownRoad => ({ index: 0, points: new Float32Array(pts), from: 0, to: 1, width, cls: 0, surface, settlement: -1, length: 0 });
const hill = (x: number, z: number) => 10 + Math.sin(x * 0.05) * 3 + z * 0.1;

describe('road ribbons', () => {
  it('resamples every ~2 m along the polyline', () => {
    const r = resample(road([0, 0, 0, 10, 0, 0, 10, 0, 6]));
    expect(r[0]).toEqual({ x: 0, z: 0, d: 0 });
    expect(r[r.length - 1].d).toBeCloseTo(16, 5);
    for (let i = 1; i < r.length; i++) expect(r[i].d - r[i - 1].d).toBeLessThanOrEqual(2.01);
  });

  it('drapes every vertex on the ground plus the lift, across the full width', () => {
    const mb = new MeshBuilder();
    const quads = drawRoad(mb, road([0, 0, 0, 40, 0, 0, 60, 0, 20], 4), hill, () => false, 0.07);
    expect(quads).toBeGreaterThan(0);
    const m = mb.data();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.position[i * 3];
      const y = m.position[i * 3 + 1];
      const z = m.position[i * 3 + 2];
      expect(y).toBeCloseTo(hill(x, z) + 0.07, 4);
      if (x < 30) {
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    expect(maxZ - minZ).toBeCloseTo(4, 3);
    // Faces point up.
    for (let i = 0; i < m.vertexCount; i++) expect(m.normal[i * 3 + 1]).toBeGreaterThan(80);
  });

  it('leaves out the stretch under a bridge', () => {
    const all = drawRoad(new MeshBuilder(), road([0, 0, 0, 100, 0, 0]), hill, () => false, 0.07);
    const cut = drawRoad(new MeshBuilder(), road([0, 0, 0, 100, 0, 0]), hill, (x) => x > 40 && x < 60, 0.07);
    expect(cut).toBeLessThan(all);
    expect(all - cut).toBeGreaterThanOrEqual(8 * 4); // ~20 m at 2 m x 4 columns
  });
});

describe.skipIf(!hasWasm)('the official road network', () => {
  let t: Towns;
  let height: (x: number, z: number) => number;
  beforeAll(async () => {
    const { wg, atlas } = await testWorld();
    t = parseTowns(townsBytes(wg, atlas));
    height = (x, z) => wg.collisionHeight(atlas, x, z);
  }, 60000);

  it('every decal vertex sits on the collision surface at one of the decal lifts', () => {
    const cells = buildRoadCells(t, height);
    expect(cells.length).toBeGreaterThan(4);
    const lifts = Object.values(LIFT);
    let n = 0;
    for (const c of cells) {
      const p = c.decal.position;
      for (let i = 0; i < c.decal.vertexCount; i += 7) {
        const d = p[i * 3 + 1] - height(p[i * 3], p[i * 3 + 2]);
        expect(lifts.some((l) => Math.abs(d - l) < 2e-3), `lift ${d}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
    // Bridges and signposts made it into the furniture meshes.
    expect(cells.reduce((a, c) => a + c.furniture.indexCount, 0)).toBeGreaterThan(t.bridges.length * 100);
  }, 60000);
});
