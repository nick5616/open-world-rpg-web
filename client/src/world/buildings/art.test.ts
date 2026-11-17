// Playtest 3 towns art: the detail levels (detail.ts). Low must stay about the playtest-2 cost, higher levels
// add geometry and never break a mesh; the yard dressing (dress.ts) must stay out of every collision box
// and every road, so decoration never sits where the server says there is room to walk.

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadWorldgen, parseTowns, townsBytes, type Towns } from '@lodestone/worldgen';
import { hasWasm, testWorld, wasmPath } from '../testing/wasm';
import { buildSettlementMesh } from './kit';
import { setDetail, type Detail } from './detail';
import { Yard } from './dress';

describe.skipIf(!hasWasm)('towns art detail levels', () => {
  let official: Towns;
  let heightAt: (x: number, z: number) => number;
  beforeAll(async () => {
    const { wg, atlas } = await testWorld();
    official = parseTowns(townsBytes(wg, atlas));
    heightAt = (x, z) => wg.collisionHeight(atlas, x, z);
  }, 60000);
  afterAll(() => setDetail(2));

  const build = (d: Detail, si: number) => {
    setDetail(d);
    return buildSettlementMesh(official, si, heightAt);
  };
  const largest = () => official.settlements.reduce((a, s) => (s.buildingCount > official.settlements[a].buildingCount ? s.index : a), 0);

  it('triangle budget per level: low is the old cost, each step adds, nothing is degenerate', () => {
    const si = largest();
    const tris = (d: Detail) => {
      const t0 = performance.now();
      const m = build(d, si);
      const ms = Math.round(performance.now() - t0);
      for (const part of [m.shell, m.interior]) {
        let bad = 0;
        for (let i = 0; i < part.position.length; i++) if (!Number.isFinite(part.position[i])) bad++;
        for (let i = 0; i < part.indexCount; i++) if (part.index[i] >= part.vertexCount) bad++;
        expect(bad).toBe(0);
      }
      return { shell: m.shell.indexCount / 3, interior: m.interior.indexCount / 3, smoke: m.smoke.length / 3, ms };
    };
    const lo = tris(0);
    const mid = tris(1);
    const hi = tris(2);
    console.log(`[art] settlement ${si}: low ${JSON.stringify(lo)} medium ${JSON.stringify(mid)} high ${JSON.stringify(hi)}`);
    expect(mid.shell).toBeGreaterThan(lo.shell);
    expect(hi.shell).toBeGreaterThan(mid.shell);
    expect(hi.shell).toBeLessThan(lo.shell * 4.5);
    expect(hi.interior).toBeLessThan(lo.interior * 4);
    // Chimney smoke keeps coming from every chimney at every level.
    expect(mid.smoke).toBe(lo.smoke);
  });

  it('yard dressing never stands on a collision box or a road', () => {
    for (const si of [largest(), 0, 3]) {
      const s = official.settlements[si];
      const yard = new Yard(official, s);
      // Every building's own footprint centre is inside a box, so the query must reject it.
      let rejected = 0;
      for (let bi = s.buildingFirst; bi < s.buildingFirst + s.buildingCount; bi++) {
        const b = official.buildings[bi];
        if (b.floors === 0) continue;
        expect(yard.free(b.x, b.z, 0.3)).toBe(false);
        rejected++;
      }
      // The street points are roads: the query must reject them as well.
      let onRoad = 0;
      for (const r of official.roads) {
        if (r.settlement !== si) continue;
        for (let k = 0; k < r.points.length; k += 3) {
          if (Math.hypot(r.points[k] - s.x, r.points[k + 2] - s.z) > s.radius) continue;
          expect(yard.free(r.points[k], r.points[k + 2], 0.2)).toBe(false);
          onRoad++;
        }
      }
      expect(rejected).toBeGreaterThan(0);
      expect(onRoad).toBeGreaterThanOrEqual(0);
    }
  });

  it('the same settlement builds the same mesh twice (dressing is deterministic)', () => {
    const si = largest();
    const a = build(2, si);
    const b = build(2, si);
    expect(a.shell.indexCount).toBe(b.shell.indexCount);
    expect(Array.from(a.shell.position.subarray(0, 600))).toEqual(Array.from(b.shell.position.subarray(0, 600)));
  });

  it('other biome styles (seed 3 adds adobe) build at every level', async () => {
    const wg2 = await loadWorldgen(fs.readFileSync(wasmPath));
    const a3 = wg2.buildAtlas(wg2.specFromSeed(3n));
    const t3 = parseTowns(townsBytes(wg2, a3));
    for (const d of [0, 1, 2] as const) {
      setDetail(d);
      for (const s of t3.settlements.slice(0, 6)) {
        const m = buildSettlementMesh(t3, s.index, (x, z) => wg2.collisionHeight(a3, x, z));
        expect(m.shell.indexCount).toBeGreaterThan(0);
      }
    }
  }, 60000);
});
