import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorldGround } from '../core/ground';
import { hasWasm, testWorld } from '../testing/wasm';
import { decodeEntries, encodeEntries, lift, MAX_DELTA, surface, TerrainOverlay } from './overlay';

const goldenPath = fileURLToPath(new URL('../../../../contracts/golden/world_edits.json', import.meta.url));

function bits(v: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v);
  return dv.getBigUint64(0).toString(16);
}

describe('terrain overlay codec and store', () => {
  it('round-trips entries and clamps to +-6 m', () => {
    const es = [
      { i: 0, d: -5 },
      { i: 4095, d: 24 },
      { i: 70, d: -24 },
    ];
    expect(decodeEntries(encodeEntries(es))).toEqual(es);
    const o = new TerrainOverlay();
    o.setEntries(1, 1, [{ i: 5, d: 100 }, { i: 6, d: -100 }]);
    expect(o.delta(64 + 5, 64)).toBe(MAX_DELTA);
    expect(o.delta(64 + 6, 64)).toBe(-MAX_DELTA);
    expect(o.any).toBe(true);
    o.setEntries(1, 1, [{ i: 5, d: 0 }, { i: 6, d: 0 }]);
    expect(o.any).toBe(false);
  });

  it('notifies listeners with the changed vertex bounds, once per real change', () => {
    const o = new TerrainOverlay();
    const seen: number[][] = [];
    o.listeners.add((a, b, c, d) => seen.push([a, b, c, d]));
    o.setVertex(100, 200, 3);
    o.setVertex(100, 200, 3); // no change
    o.setVertex(101, 203, -2);
    expect(seen).toEqual([[100, 200, 100, 200], [101, 203, 101, 203]]);
    expect(Array.from(o.collect(99, 199, 101, 203)!)).toEqual([100, 200, 3, 101, 203, -2]);
    expect(o.collect(0, 0, 10, 10)).toBeNull();
    expect(o.vertices()).toBe(2);
  });

  it('lift and surface follow the collision formula', () => {
    expect(lift(10.1, -3)).toBe(Math.fround(Math.fround(10.1) - 0.75));
    expect(surface(0, 4, 8, 12, 0.5, 0.5)).toBeCloseTo(6, 12);
    expect(surface(0, 4, 8, 12, 1, 1)).toBe(12);
    expect(surface(10, 10, 10, 10, 0.3, 0.9)).toBe(10);
  });
});

describe.skipIf(!hasWasm)('terrain overlay on the real world', () => {
  it('reproduces the Go twin bit for bit (contracts/golden/world_edits.json)', async () => {
    const g = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as { edits: { X: number; Z: number; D: number }[]; samples: { X: number; Z: number; H: string }[] };
    const { wg, atlas } = await testWorld();
    const ground = new WorldGround(wg, atlas);
    // Unedited, the ground is exactly the wasm collision surface.
    for (const s of g.samples.slice(0, 50)) expect(bits(ground.heightAt(s.X, s.Z))).toBe(bits(wg.exports.collision_height(atlas.ptr, s.X, s.Z)));
    for (const e of g.edits) ground.edits.setVertex(e.X, e.Z, e.D);
    let changed = 0;
    for (const s of g.samples) {
      const h = ground.heightAt(s.X, s.Z);
      if (h !== wg.exports.collision_height(atlas.ptr, s.X, s.Z)) changed++;
      expect(bits(h), `(${s.X}, ${s.Z})`).toBe(s.H);
    }
    expect(changed).toBeGreaterThan(g.samples.length / 3);
    // Clearing every edit restores the generated surface.
    for (const e of g.edits) ground.edits.setVertex(e.X, e.Z, 0);
    expect(ground.edits.any).toBe(false);
    for (const s of g.samples.slice(0, 50)) expect(bits(ground.heightAt(s.X, s.Z))).toBe(bits(wg.exports.collision_height(atlas.ptr, s.X, s.Z)));
  });
});
