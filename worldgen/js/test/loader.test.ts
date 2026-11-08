import { beforeAll, describe, expect, it } from 'vitest';
import { BIOMES, POI_KINDS, WorldgenError, chunkSurfaceHeight, fnv1a64, hex64, parseAtlas, type AtlasHandle, type Worldgen } from '../src/index';
import { hasWasm, worldgen } from './wasm';

describe('fnv1a64 (pure TS)', () => {
  it('matches known vectors', () => {
    expect(fnv1a64(new Uint8Array())).toBe(0xcbf29ce484222325n);
    expect(fnv1a64(new TextEncoder().encode('a'))).toBe(0xaf63dc4c8601ec8cn);
    expect(hex64(0xabn)).toBe('00000000000000ab');
  });
});

describe.skipIf(!hasWasm)('worldgen.wasm via the loader', () => {
  let wg: Worldgen;
  let atlas: AtlasHandle;
  beforeAll(async () => {
    wg = await worldgen();
    atlas = wg.buildAtlas(wg.specFromSeed(42n));
  });

  it('specFromSeed is deterministic and accepts all seed forms', () => {
    const a = wg.specFromSeed(42n);
    expect(wg.specFromSeed('42')).toEqual(a);
    expect(wg.specFromSeed(42)).toEqual(a);
    expect(a.seed).toBe('42');
    expect(wg.specFromSeed(2n ** 64n - 1n).seed).toBe('18446744073709551615');
  });

  it('hash_buffer equals the TS FNV-1a', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
    expect(wg.hash(bytes)).toBe(fnv1a64(bytes));
    expect(atlas.hash).toBe(fnv1a64(atlas.bytes()));
  });

  it('atlas holds a tower and a settlement per region, unique ids, every biome name valid', () => {
    const d = atlas.data;
    expect(d.genVersion).toBe(wg.genVersion);
    expect(d.seed).toBe(42n);
    expect(d.regions).toHaveLength(16);
    for (const r of d.regions) {
      expect(r.tower).toBeGreaterThanOrEqual(0);
      expect(d.sites[r.tower].kind).toBe('tower');
      expect(r.settlements).toBeGreaterThanOrEqual(1);
      expect(BIOMES).toContain(r.biome);
    }
    expect(new Set(d.sites.map((s) => s.id)).size).toBe(d.sites.length);
    for (const s of d.sites) if (s.category === 'poi') expect(POI_KINDS).toContain(s.kind);
    expect(d.params[19]).toBeGreaterThan(0.95); // 800 m coverage
  });

  it('loadAtlas round-trips cached bytes', () => {
    const copy = wg.loadAtlas(atlas.bytes());
    expect(copy.hash).toBe(atlas.hash);
    expect(wg.buildChunkBytes(copy, 30, 31)).toEqual(wg.buildChunkBytes(atlas, 30, 31));
    copy.free();
    const bad = atlas.bytes();
    bad[0] = 0;
    expect(() => wg.loadAtlas(bad)).toThrow(WorldgenError);
  });

  it('chunk heights equal collision heights, and the TS surface formula matches to the bit', () => {
    const c = wg.buildChunk(atlas, 33, 29);
    expect(c.heights[0]).toBe(wg.collisionHeight(atlas, 33 * 64, 29 * 64));
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 2000; i++) {
      const x = 33 * 64 + rnd() * 64;
      const z = 29 * 64 + rnd() * 64;
      expect(chunkSurfaceHeight(c, x, z)).toBe(wg.collisionHeight(atlas, x, z));
    }
    for (let i = 0; i < c.scatter.count; i++) {
      expect(c.scatter.y(i)).toBe(Math.fround(wg.collisionHeight(atlas, c.scatter.x(i), c.scatter.z(i))));
    }
  });

  it('LOD tiles share vertices with LOD 0 (seams match)', () => {
    const l0 = wg.buildChunk(atlas, 32, 32, 0);
    const l2 = wg.buildChunk(atlas, 32, 32, 2);
    expect(l2.step).toBe(4);
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) expect(l2.heights[j * 65 + i]).toBe(l0.heights[j * 4 * 65 + i * 4]);
    expect(l2.scatter.count).toBe(0);
    expect(() => wg.buildChunk(atlas, 33, 32, 2)).toThrow(/multiples of 4/);
  });

  it('splat weights sum to 255 and records carry stable ids', () => {
    const c = wg.buildChunk(atlas, 20, 40);
    for (let k = 0; k < 65 * 65; k++) {
      const sum = c.splatA[k * 4] + c.splatA[k * 4 + 1] + c.splatA[k * 4 + 2] + c.splatA[k * 4 + 3] + c.splatB[k * 4] + c.splatB[k * 4 + 1];
      expect(sum).toBe(255);
    }
    const again = wg.buildChunk(atlas, 20, 40);
    expect(again.scatter.count).toBe(c.scatter.count);
    for (let i = 0; i < c.scatter.count; i++) expect(again.scatter.id(i)).toBe(c.scatter.id(i));
  });

  it('ground normal and raycast agree with collision height', () => {
    const x = 2100.3;
    const z = 1890.7;
    const h = wg.collisionHeight(atlas, x, z);
    const n = wg.groundNormal(atlas, x, z);
    expect(Math.hypot(...n.normal)).toBeCloseTo(1, 12);
    expect(n.slopeDeg).toBeGreaterThanOrEqual(0);
    expect(n.slopeDeg).toBeLessThan(90);
    const t = wg.raycast(atlas, [x, h + 50, z], [0, -1, 0], 200);
    expect(t).not.toBeNull();
    expect(h + 50 - t!).toBeCloseTo(h, 6);
    expect(wg.raycast(atlas, [x, h + 50, z], [0, 1, 0], 200)).toBeNull();
    // A shallow ray toward the ground from far away hits it somewhere.
    const t2 = wg.raycast(atlas, [x - 300, h + 30, z], [1, -0.08, 0], 1024);
    expect(t2).not.toBeNull();
  });

  it('rejects bad specs with a readable error', () => {
    const bad = { ...wg.specFromSeed(1n), landFraction: 2 };
    expect(() => wg.buildAtlas(bad)).toThrow(/landFraction/);
  });

  it('parseAtlas reads the same data as the handle', () => {
    const d = parseAtlas(atlas.bytes());
    expect(d.sites.length).toBe(atlas.data.sites.length);
    expect(d.spec.name).toBe(atlas.data.spec.name);
  });
});
