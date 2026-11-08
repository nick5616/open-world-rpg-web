// The structure overlay must give the zone's exact bits (prediction vs
// server validation on a tower wall). Replays the Go-generated golden file
// server/pkg/structures/testdata/golden.json: same towers (top height and
// footprint), same combined ground height, same structure index and normal
// at ~4,400 points, compared as float64 bit patterns.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlaneGround, FlatGround } from '../../sim/ground';
import { WorldGround } from '../core/ground';
import { hasWasm, testWorld } from '../testing/wasm';
import { StructureGround, StructureOverlay } from './overlay';
import { newTower, towerBottom, towerProfile, towersFromAtlas, TOWER_HEIGHT, TOWER_UPPER_DROP } from './towers';

interface GoldenPoint {
  X: number;
  Z: number;
  H: string;
  S: number;
  N?: [string, string, string];
}
interface GoldenCase {
  Name: string;
  Base: string;
  Towers: { CX: number; CZ: number; TopY: string; MaxR: string }[];
  Points: GoldenPoint[];
}
interface GoldenFile {
  Profile: { R: number[]; Drop: number[] };
  Cases: GoldenCase[];
}

const golden = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../../server/pkg/structures/testdata/golden.json', import.meta.url)), 'utf8')) as GoldenFile;

const buf = new DataView(new ArrayBuffer(8));
function bits(f: number): string {
  buf.setFloat64(0, f);
  return buf.getBigUint64(0).toString(16).padStart(16, '0');
}

function replay(c: GoldenCase, ground: StructureGround, towers: { cx: number; cz: number; topY: number; maxR: number }[]) {
  expect(towers.length).toBe(c.Towers.length);
  towers.forEach((t, i) => {
    const g = c.Towers[i];
    expect({ cx: t.cx, cz: t.cz, top: bits(t.topY), maxR: bits(t.maxR) }).toEqual({ cx: g.CX, cz: g.CZ, top: g.TopY, maxR: g.MaxR });
  });
  let bad = 0;
  const firstBad: unknown[] = [];
  for (const p of c.Points) {
    const h = bits(ground.heightAt(p.X, p.Z));
    const s = ground.structureAt(p.X, p.Z);
    let ok = h === p.H && s === p.S;
    if (ok && p.S >= 0 && p.N) {
      const n = ground.normalAt(p.X, p.Z);
      ok = bits(n.x) === p.N[0] && bits(n.y) === p.N[1] && bits(n.z) === p.N[2];
    }
    if (!ok) {
      bad++;
      if (firstBad.length < 3) firstBad.push({ p, h, s });
    }
  }
  expect({ bad, firstBad }).toEqual({ bad: 0, firstBad: [] });
}

describe('structure overlay golden (Go twin)', () => {
  it('tower profile matches', () => {
    const { r, drop } = towerProfile();
    expect(r).toEqual(golden.Profile.R);
    expect(drop).toEqual(golden.Profile.Drop);
  });

  it('synthetic plane case is bit-identical', () => {
    const c = golden.Cases.find((x) => x.Name === 'plane')!;
    const [b, sx, sz] = c.Base.slice('plane:'.length).split(',').map(Number);
    const base = new PlaneGround(b, sx, sz);
    const overlay = new StructureOverlay();
    const towers = c.Towers.map((t) => newTower(base, t.CX, t.CZ));
    towers.forEach((t) => overlay.add(t));
    replay(c, new StructureGround(base, overlay), towers);
  });

  it.skipIf(!hasWasm)('real world (seed 20261108) towers over wasm terrain are bit-identical', async () => {
    const c = golden.Cases.find((x) => x.Name === 'world');
    expect(c, 'golden has the world case (regenerate with go test ./structures -run Golden -update)').toBeTruthy();
    const { wg, atlas } = await testWorld();
    const base = new WorldGround(wg, atlas);
    const set = towersFromAtlas(atlas.data, base);
    // Every region's tower is in the set.
    for (const r of atlas.data.regions) expect(set.sites.some((s) => s.index === r.tower)).toBe(true);
    replay(c!, new StructureGround(base, set.overlay), set.towers);
  }, 60000);
});

describe('tower shape', () => {
  it('stands TOWER_HEIGHT above flat ground with a ledge and 80 degree walls', () => {
    const t = newTower(new FlatGround(50), 100, 100);
    expect(t.topY).toBe(50 + TOWER_HEIGHT);
    const o = new StructureOverlay();
    o.add(t);
    const g = new StructureGround(new FlatGround(50), o);
    expect(g.heightAt(100, 100)).toBe(t.topY);
    expect(g.slopeAt(100 + 5, 100)).toBeCloseTo(80, 9);
    expect(g.heightAt(100 + t.r[1] + 0.5, 100)).toBeCloseTo(t.topY - TOWER_UPPER_DROP, 12);
    expect(g.slopeAt(100 + t.r[1] + 0.5, 100)).toBe(0);
    expect(towerBottom(t)).toBeCloseTo(47, 9);
    expect(g.heightAt(100 + t.maxR + 1, 100)).toBe(50);
    expect(g.structureAt(100 + t.maxR + 1, 100)).toBe(-1);
  });
});
