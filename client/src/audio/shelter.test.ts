import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOX_FLAG, BOX_KINDS, BUILDING_FLAG, BUILDING_ROLES, parseTowns, ROOF_KINDS, TownCollision, townsBytes, type TownBoxes } from '@lodestone/worldgen';
import { loadWorldgenGround } from '../sim/worldgenGround';
import { repoRoot } from '../sim/dev/traversalRun';
import { enclosed, HEAD_M, ShelterIndex, type ShelterBuilding } from './shelter';
import { SPACE_OUTDOORS } from './spatial';

const K = (k: (typeof BOX_KINDS)[number]) => BOX_KINDS.indexOf(k);

/** Boxes from [kind, flags, cx, cz, hx, hz, y0, top] (axis-aligned, flat tops). */
function boxes(list: [(typeof BOX_KINDS)[number], number, number, number, number, number, number, number][]): TownBoxes {
  const f = new Float64Array(list.length * 9);
  const kind = new Uint8Array(list.length);
  const flags = new Uint8Array(list.length);
  list.forEach(([k, fl, cx, cz, hx, hz, y0, top], i) => {
    f.set([cx, cz, 1, 0, hx, hz, y0, top, top], i * 9);
    kind[i] = K(k);
    flags[i] = fl;
  });
  return { count: list.length, f, kind, flags, owner: new Uint16Array(list.length) };
}

const house = (x: number, z: number, extra: Partial<ShelterBuilding> = {}): ShelterBuilding => ({ x, z, c: 1, s: 0, hx: 3, hz: 4, floorY: 0, baseY: 0, storey: 3, floors: 1, roof: ROOF_KINDS.indexOf('gable'), role: BUILDING_ROLES.indexOf('house'), flags: 0, ...extra });

const W = BOX_FLAG.walk;
const S = BOX_FLAG.solid;
// A house at (0, 0): floor, four walls, roof from 3 m; an open-fronted forge
// at (40, 0); a lone porch roof at (20, 0); a bridge deck 30 m up at (60, 0);
// a high shelf at (10, 10).
const B = boxes([
  ['floor', W | S, 0, 0, 3, 4, -0.3, 0],
  ['wall', S, -3, 0, 0.1, 4, 0, 3],
  ['wall', S, 3, 0, 0.1, 4, 0, 3],
  ['wall', S, 0, 4, 3, 0.1, 0, 3],
  ['wall', S, 0, -4, 3, 0.1, 0, 3],
  ['roof', S | W, 0, 0, 3.3, 4.3, 3, 4.5],
  ['floor', W | S, 40, 0, 3, 4, -0.3, 0],
  ['roof', S | W, 40, 0, 3.3, 4.3, 3, 4.5],
  ['roof', S, 20, 0, 2, 2, 2.6, 2.8],
  ['deck', W | S, 60, 0, 2, 6, 30, 30.4],
  ['furniture', S, 10, 10, 0.5, 0.5, 2.2, 2.4],
]);
const buildings = [house(0, 0), house(40, 0, { role: BUILDING_ROLES.indexOf('forge'), flags: BUILDING_FLAG.openFront }), house(80, 0, { role: BUILDING_ROLES.indexOf('stall'), floors: 0, roof: ROOF_KINDS.indexOf('none') })];
const idx = new ShelterIndex(buildings, new TownCollision(B));

describe('shelter: roofs and walls around the listener', () => {
  it('inside a closed house: indoors, covered, in that building', () => {
    const p = idx.probe(0.5, 0, 0.5);
    expect(p.indoors).toBe(1);
    expect(p.roof).toBeGreaterThanOrEqual(0.85);
    expect(p.building).toBe(0);
    expect(p.roomRadius).toBeCloseTo(Math.sqrt(12));
    expect(idx.spaceAt(0.5, 0.5, 0.5)).toBe(0);
  });

  it('in the open: nothing', () => {
    const p = idx.probe(10, 0, 10);
    expect(p).toEqual({ roof: 0, indoors: 0, building: SPACE_OUTDOORS, roomRadius: 4 });
  });

  it('under a lone porch roof: covered, not indoors; at its edge, partly', () => {
    const under = idx.probe(20, 0, 0);
    expect(under.roof).toBeCloseTo(1);
    expect(under.indoors).toBe(0);
    const edge = idx.probe(21.8, 0, 0);
    expect(edge.roof).toBeGreaterThan(0);
    expect(edge.roof).toBeLessThan(under.roof);
    expect(idx.probe(24, 0, 0).roof).toBe(0);
  });

  it('a roof 30 m up (a bridge) is not over you; furniture never is', () => {
    expect(idx.roofOver(60, HEAD_M, 0)).toBe(false);
    expect(idx.roofOver(60, 20, 0)).toBe(true);
    // a shelf above head height at (10, 10) is furniture, not a roof
    expect(idx.roofOver(10, HEAD_M, 10)).toBe(false);
  });

  it('an open-fronted forge is half indoors and acoustically outdoors', () => {
    const p = idx.probe(40, 0, 0);
    expect(p.indoors).toBeCloseTo(0.55);
    expect(p.building).toBe(SPACE_OUTDOORS);
    expect(idx.buildingAt(40, 0.5, 0)).toBe(1);
    expect(idx.spaceAt(40, 0.5, 0)).toBe(SPACE_OUTDOORS);
  });

  it('stalls and fields are not buildings you are inside; standing on a roof is not inside', () => {
    expect(enclosed(buildings[2])).toBe(false);
    expect(idx.buildingAt(80, 0.5, 0)).toBe(SPACE_OUTDOORS);
    expect(idx.buildingAt(0, 4.5, 0)).toBe(SPACE_OUTDOORS);
    expect(idx.probe(0, 4.5, 0).roof).toBe(0);
  });

  it('what is underfoot', () => {
    expect(idx.surfaceUnder(0, 0, 0)).toBe('floor');
    expect(idx.surfaceUnder(60, 30.4, 0)).toBe('deck');
    expect(idx.surfaceUnder(10, 0, 10)).toBeNull();
    expect(idx.surfaceUnder(0, 1.5, 0)).toBeNull();
  });

  it('works without collision (towns but no boxes)', () => {
    const bare = new ShelterIndex(buildings, null);
    expect(bare.roofOver(0, HEAD_M, 0)).toBe(false);
    expect(bare.probe(0, 0, 0).indoors).toBe(1);
    expect(bare.surfaceUnder(0, 0, 0)).toBeNull();
  });
});

const wasm = path.join(repoRoot, 'worldgen', 'pkg', 'worldgen.wasm');

describe.skipIf(!fs.existsSync(wasm))('shelter on the official world', () => {
  it('every closed building has a roof over its middle; its door step outside is not inside', async () => {
    const g = await loadWorldgenGround(fs.readFileSync(wasm), 20261108n);
    const t = parseTowns(townsBytes(g.wg, g.atlas));
    const si = new ShelterIndex(t.buildings, new TownCollision(t.boxes));
    let n = 0;
    let covered = 0;
    let outside = 0;
    for (const [i, b] of t.buildings.entries()) {
      if (!enclosed(b) || (b.flags & BUILDING_FLAG.openFront) !== 0) continue;
      n++;
      const p = si.probe(b.x, b.floorY, b.z);
      expect(p.indoors).toBe(1);
      expect(p.building).toBe(i);
      if (si.roofOver(b.x, b.floorY + HEAD_M, b.z)) covered++;
      // 2.5 m in front of the door (local -v)
      const fx = b.x + b.s * (b.hz + 2.5);
      const fz = b.z - b.c * (b.hz + 2.5);
      if (si.buildingAt(fx, b.floorY + 0.5, fz) !== i) outside++;
      if (n >= 400) break;
    }
    expect(n).toBeGreaterThan(50);
    expect(covered / n).toBeGreaterThan(0.95);
    expect(outside).toBe(n);
  }, 60000);
});
