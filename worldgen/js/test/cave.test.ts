// Cave exports and the pure-TS cave queries (WP09).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CaveGroundCore,
  caveCellBytes,
  caveFloorAt,
  caveGraphBytes,
  caveMaskBytes,
  caveMasked,
  caveSystemAt,
  caveSystemAtWasm,
  parseCaveCell,
  parseCaveGraph,
  caveCellKey,
  type AtlasHandle,
  type CaveCell,
  type CaveGraph,
  type Worldgen,
} from '../src/index';
import { hasWasm, worldgen } from './wasm';

describe.skipIf(!hasWasm)('caves via worldgen.wasm', () => {
  let wg: Worldgen;
  let atlas: AtlasHandle;
  let graph: CaveGraph;
  beforeAll(async () => {
    wg = await worldgen();
    atlas = wg.buildAtlas(wg.specFromSeed(20261108n));
    graph = parseCaveGraph(caveGraphBytes(wg, atlas));
  });

  it('graph: a system per mouth, chambers, openings, veins', () => {
    const mouths = atlas.data.sites.filter((s) => s.kind === 'cave_mouth');
    expect(graph.systems.length).toBeGreaterThan(8);
    expect(graph.systems.length).toBeLessThanOrEqual(mouths.length);
    for (const s of graph.systems) {
      expect(s.chamberCount).toBeGreaterThanOrEqual(3);
      expect(graph.openings[s.firstOpening].kind).toBe('mouth');
      expect(graph.chambers[s.firstChamber + s.deepest].flags & 8).toBe(8);
      expect(mouths.some((m) => m.id === s.id)).toBe(true);
    }
    expect(graph.veins.length).toBeGreaterThan(100);
    // Every vein id is unique.
    expect(new Set(graph.veins.map((v) => v.id)).size).toBe(graph.veins.length);
  });

  it('cells: mesh in the deepest chamber, veins owned once, deterministic', () => {
    const s = graph.systems[0];
    const ch = graph.chambers[s.firstChamber + s.deepest];
    const [cx, cy, cz] = [Math.floor(ch.x / 64), Math.floor(ch.y / 32), Math.floor(ch.z / 64)];
    const a = caveCellBytes(wg, atlas, cx, cy, cz);
    const b = caveCellBytes(wg, atlas, cx, cy, cz);
    expect(wg.hash(a)).toBe(wg.hash(b));
    const c = parseCaveCell(a);
    expect(c.triangleCount).toBeGreaterThan(50);
    expect(c.system).toBe(0);
    // Floor under the chamber center is near its planned floor.
    const cells = new Map<number, CaveCell>([[caveCellKey(cx, cy, cz), c]]);
    const src = { cell: (x: number, y: number, z: number) => cells.get(caveCellKey(x, y, z)) };
    for (const [ox, oz] of [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1], [cx, cz]]) {
      for (const oy of [cy - 1, cy, cy + 1]) cells.set(caveCellKey(ox, oy, oz), parseCaveCell(caveCellBytes(wg, atlas, ox, oy, oz)));
    }
    const f = caveFloorAt(src, ch.x, ch.floor + 1, ch.z);
    expect(Math.abs(f - ch.floor)).toBeLessThan(1.2);
  });

  it('edits: carved cell differs and flags the vein', () => {
    const v = graph.veins[0];
    const [cx, cy, cz] = [Math.floor(v.x / 64), Math.floor(v.y / 32), Math.floor(v.z / 64)];
    const plain = caveCellBytes(wg, atlas, cx, cy, cz);
    const edited = caveCellBytes(wg, atlas, cx, cy, cz, [{ veinId: v.id, x: v.x, y: v.y, z: v.z, r: 1.5 }]);
    expect(wg.hash(plain)).not.toBe(wg.hash(edited));
    const pv = parseCaveCell(edited).veins.find((x) => x.id === v.id);
    expect(pv && pv.flags & 2).toBe(2);
  });

  it('mask: wasm cave_mask bits equal the analytic rule', () => {
    const o = graph.openings[0];
    const [cx, cz] = [Math.floor(o.x / 64), Math.floor(o.z / 64)];
    const m = caveMaskBytes(wg, atlas, cx, cz);
    const count = new DataView(m.buffer).getUint32(16, true);
    expect(count).toBeGreaterThan(20);
    let n = 0;
    for (let z = 0; z < 64; z++) {
      for (let x = 0; x < 64; x++) {
        for (const tri of [0, 1]) {
          const bit = ((z * 64 + x) << 1) | tri;
          const set = (m[24 + (bit >> 3)] >> (bit & 7)) & 1;
          // Sample a point inside triangle `tri`.
          const px = cx * 64 + x + (tri === 0 ? 0.25 : 0.75);
          const pz = cz * 64 + z + (tri === 0 ? 0.25 : 0.75);
          expect(set === 1).toBe(caveMasked(graph.openings, px, pz));
          n += set;
        }
      }
    }
    expect(n).toBe(count);
  });

  it('system query: TS equals wasm, chambers inside, sky outside', () => {
    for (const s of graph.systems.slice(0, 6)) {
      for (let k = 0; k < s.chamberCount; k++) {
        const c = graph.chambers[s.firstChamber + k];
        expect(caveSystemAt(graph, c.x, c.floor + 1, c.z)).toBe(s.index);
        expect(caveSystemAtWasm(wg, atlas, c.x, c.floor + 1, c.z)).toBe(s.index);
      }
      expect(caveSystemAt(graph, s.bbox[0] - 5, s.mouthY, s.bbox[2] - 5)).toBe(-1);
    }
  });

  it('ground: heightfield outside caves, cave floor in the mouth hole', () => {
    const o = graph.openings[0];
    const cells = new Map<number, CaveCell>();
    const src = {
      cell: (x: number, y: number, z: number) => {
        const k = caveCellKey(x, y, z);
        if (!cells.has(k)) cells.set(k, parseCaveCell(caveCellBytes(wg, atlas, x, y, z)));
        return cells.get(k);
      },
    };
    const g = new CaveGroundCore((x, z) => wg.collisionHeight(atlas, x, z), graph.openings, src);
    const far = [o.x + 40, o.z + 40] as const;
    expect(g.floorAt(far[0], wg.collisionHeight(atlas, far[0], far[1]), far[1])).toBe(wg.collisionHeight(atlas, far[0], far[1]));
    // At the opening center the cave floor is below the old surface (the hole).
    const surface = wg.collisionHeight(atlas, o.x, o.z);
    const f = g.floorAt(o.x, surface + 0.5, o.z);
    expect(f).toBeLessThan(surface + 0.6);
    expect(f).toBeGreaterThan(surface - 12);
  });
});
